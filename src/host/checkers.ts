/**
 * L0 static checkers — file-system level, no loading, no boot.
 * Each checker is a pure function over (home, profileDir, pluginRow) that
 * returns structured findings. Every finding carries a deterministic repair
 * action or a prepared prompt (see core/types).
 * @module dsh-plugin-healthcheck/host/checkers
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CheckFinding, RepairAction } from '../core/types.ts'
import { HIGH_RISK_PACKAGES, resolveHomePatch, type PluginRow } from './env.ts'

/**
 * Packages the DSH runtime injects as externals. They never land in the profile
 * tree (the host resolves `@deepseek-ai/*` for plugin code, and the client
 * `__ModuleLoader__` `require` shim supplies react), so a bare-specifier
 * resolution check must skip them or every plugin reports a false positive.
 */
const HOST_PROVIDED: RegExp[] = [
  /^@deepseek-ai\//,
  /^react$/,
  /^react-dom(\/.*)?$/,
  /^react\/.*$/,
  /^@opencode(?:-ai)?\/plugin$/,
]

/** Context handed to every checker. */
export interface CheckerContext {
  home: string
  profileDir: string
  profile: string
}

/** The repair prompt header shared by every LLM-guided fix. */
const PROMPT_HEADER = `你是 DSH 插件的修复助手。铁律（违反即失败）：
1. 严禁修改 harness 源码层（DSH 安装目录内的 node_modules、GitHub deepseek-harness）；
2. 只允许修改插件代码与配置层（~/.dsh/plugins/**、~/.dsh/profiles/**、~/.dsh/cordis.patch.yml）；
3. 修完用「插件检测」重新验证，确认无 error 才算完成。`

/** Build the plugin source package.json repair action. */
function repairFilesWhitelist(packageJsonPath: string): RepairAction {
  return {
    kind: 'files-whitelist',
    path: packageJsonPath,
    description: `把 ${packageJsonPath} 的 files 白名单改为 lib/*.js 通配（含代码分割 chunk）`,
  }
}

/** Read a plugin's package.json from its source dir ('' = unreadable). */
function readPluginManifest(row: PluginRow): Record<string, unknown> | null {
  const root = row.sourceDir ?? row.installedDir
  if (root === '') return null
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Whether pnpm is configured to auto-install peer dependencies in this
 * profile. The dsh profile template ships `autoInstallPeers: false`; when it
 * is absent (older/newer profiles, or explicitly true), peers may be
 * materialized as nested copies.
 */
function autoInstallPeersEnabled(profileDir: string): boolean {
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    // No workspace config at all: pnpm defaults to auto-installing peers.
    return true
  }
  try {
    const text = readFileSync(workspacePath, 'utf8')
    // autoInstallPeers: false is the only value that disables it.
    return !/^\s*autoInstallPeers\s*:\s*false\s*$/m.test(text)
  } catch {
    return true
  }
}

/**
 * C1 — files 白名单完整性（防 dsh-pet 复发）。
 * 多入口构建 + 固定文件名白名单 → 带哈希 chunk 被过滤 → ERR_MODULE_NOT_FOUND。
 */
export function checkFilesWhitelist(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  const manifest = readPluginManifest(row)
  if (manifest === null) return []
  const files = manifest.files
  if (!Array.isArray(files) || files.length === 0) return []
  const root = row.sourceDir ?? row.installedDir
  const libDir = join(root, 'lib')
  if (!existsSync(libDir)) return []
  const findings: CheckFinding[] = []

  // Fixed file names (no glob chars) signal the latent hazard.
  const fixed = files.filter((f): f is string => typeof f === 'string' && /^lib\/[^*/]+\.[a-z]+$/.test(f))
  const hasGlob = files.some((f) => typeof f === 'string' && f.includes('*'))
  if (fixed.length > 0 && !hasGlob) {
    // Deep check: does lib/ contain a hashed chunk imported by an entry?
    const missing = missingLocalImports(libDir, files)
    if (missing.length > 0) {
      findings.push({
        layer: 'l0', code: 'files-missing-chunk', severity: 'error', plugin: row.name,
        message: `${row.name} 的 files 白名单漏掉了代码分割 chunk：${missing.join(', ')} — 安装时会被 pnpm 打包过滤，启动报 ERR_MODULE_NOT_FOUND`,
        evidence: missing.map((f) => join(libDir, f)),
        fixKind: 'auto',
        repair: row.sourceDir !== undefined ? repairFilesWhitelist(join(root, 'package.json')) : undefined,
        prompt: row.sourceDir === undefined
          ? `${PROMPT_HEADER}\n\n问题：${row.name}（registry 安装）的 files 白名单是固定文件名，漏掉了 ${missing.join(', ')}。\n修复：向该插件上游提交 PR 把 files 改为 ["lib/*.js", ...]。`
          : undefined,
      })
    } else {
      findings.push({
        layer: 'l0', code: 'files-fixed-entries', severity: 'warn', plugin: row.name,
        message: `${row.name} 的 files 用固定文件名（${fixed.join(', ')}）— 多入口构建一旦产生代码分割 chunk 就会复发 dsh-pet 式错误`,
        evidence: fixed.map((f) => join(root, f)),
        fixKind: 'auto',
        repair: row.sourceDir !== undefined ? repairFilesWhitelist(join(root, 'package.json')) : undefined,
      })
    }
  }
  return findings
}

/** Collect local imports (./x.js, ./sub/y.js) in lib/ that are not covered by `files`. */
function missingLocalImports(libDir: string, files: string[]): string[] {
  const missing: string[] = []
  const covered = (rel: string): boolean =>
    files.some((f) => typeof f !== 'string' || f === 'lib' || f === 'lib/' || f.startsWith('lib/*.js') || f === `lib/${rel}`)
  const jsFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.js')) jsFiles.push(p)
    }
  }
  walk(libDir)
  for (const file of jsFiles) {
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(/(?:from\s+|import\s*\()\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      const rel = match[1].replace(/^\.\//, '')
      if (covered(rel)) continue
      const abs = resolve(dirname(file), match[1])
      if (!existsSync(abs) && !missing.includes(rel)) missing.push(rel)
    }
  }
  return missing
}

/**
 * C2 — 依赖声明审计（防 link:/file: 坑）。
 */
export function checkDependencySpec(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  const findings: CheckFinding[] = []
  const manifest = readPluginManifest(row)
  if (manifest === null) return findings
  const deps = Object.keys(manifest.dependencies ?? {})
  const peers = Object.keys(manifest.peerDependencies ?? {})

  if (row.spec.startsWith('link:') && deps.length > 0) {
    findings.push({
      layer: 'l0', code: 'link-deps', severity: 'error', plugin: row.name,
      message: `${row.name} 是 link: 依赖且声明运行时依赖（${deps.join(', ')}）— Node 从源码目录解析依赖、绕过 profile 的 node_modules，会报 ERR_MODULE_NOT_FOUND`,
      evidence: [`specifier: ${row.spec}`, `dependencies: ${deps.join(', ')}`],
      fixKind: 'auto',
      repair: {
        kind: 'none',
        description: '需要 pnpm remove + add file:（见 prompt）',
      },
      prompt: `${PROMPT_HEADER}\n\n问题：${row.name} 登记为 link: 但有运行时依赖。\n修复：\n  cd ${ctx.profileDir}\n  pnpm remove ${row.name}\n  pnpm add "file:${ctx.home}/plugins/${basename(row.sourceDir ?? row.name)}"\n注意：直接改 package.json 再 pnpm install 不生效（lockfile 残留 link:），必须 remove + add。`,
    })
  }
  if (row.spec.startsWith('file:') && peers.some((p) => HIGH_RISK_PACKAGES.some((h) => p === `@deepseek-ai/${h}`))) {
    const corePeers = peers.filter((p) => HIGH_RISK_PACKAGES.some((h) => p === `@deepseek-ai/${h}`))
    // pnpm only materializes peer copies when autoInstallPeers is NOT
    // explicitly disabled. The dsh profile template ships
    // `autoInstallPeers: false`, in which case peers never become nested
    // copies — the healthy state. Whether copies actually exist is C3's
    // job (it scans the tree); C2 must not warn on a configuration that
    // cannot produce them.
    if (autoInstallPeersEnabled(ctx.profileDir)) {
      findings.push({
        layer: 'l0', code: 'file-peer-copies', severity: 'warn', plugin: row.name,
        message: `${row.name} 的 peer 依赖包含 harness 核心包（${corePeers.join(', ')}），且该 profile 未禁用 autoInstallPeers — file: 安装可能把它们装成嵌套副本，引发模块双实例（prepare undefined）`,
        evidence: [`peer: ${corePeers.join(', ')}`, 'autoInstallPeers: 未显式禁用'],
        fixKind: 'prompt',
        prompt: `${PROMPT_HEADER}\n\n问题：${row.name} 的 peerDependencies 引用了 harness 核心包（${corePeers.join(', ')}），且 profile 的 pnpm-workspace.yaml 未设置 autoInstallPeers: false — file: 安装可能把它们装成独立副本，导致 Symbol/类身份错位（Cannot read properties of undefined (reading 'prepare')）。\n修复方向：\n1. 首选：在 profile 的 pnpm-workspace.yaml 加 autoInstallPeers: false（dsh 模板默认配置，peer 永不自动装副本）；\n2. 或插件改用 link:，依赖从共享层解析；\n3. 若副本已出现：删除副本 rm -rf ${ctx.profileDir}/node_modules/@deepseek-ai/{cordis,cosmokit,dsh-credentials,dsh-home-paths,dsh-tools,schemastery}`,
      })
    }
  }
  return findings
}

/**
 * C3 — 高危副本检测（防模块双实例）。
 */
export function checkHighRiskCopies(ctx: CheckerContext, _row: PluginRow): CheckFinding[] {
  const findings: CheckFinding[] = []
  const scopeDir = join(ctx.profileDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) return findings
  // Deleting a real copy only helps when a shared layer can take over the
  // resolution. Without ~/.dsh/profiles/node_modules the package would simply
  // become unresolvable — worse than a latent dual-instance risk — so the
  // destructive auto-fix is only offered when that layer exists.
  const sharedLayer = join(ctx.home, 'profiles', 'node_modules')
  const sharedLayerExists = existsSync(sharedLayer)
  for (const pkg of HIGH_RISK_PACKAGES) {
    const path = join(scopeDir, pkg)
    try {
      const stat = lstatSync(path)
      if (!stat.isSymbolicLink()) {
        findings.push({
          layer: 'l0', code: 'harness-copy', severity: 'error', plugin: `@deepseek-ai/${pkg}`,
          message: `检测到 harness 核心包独立副本 @deepseek-ai/${pkg}（真实目录，非软链）— 与安装本体形成模块双实例，Symbol/类身份错位会导致工具取不到（prepare undefined）`,
          evidence: sharedLayerExists ? [path, `shared layer: ${sharedLayer}`] : [path, `missing shared layer: ${sharedLayer}`],
          ...(sharedLayerExists
            ? {
                fixKind: 'auto' as const,
                repair: {
                  kind: 'remove-copies' as const,
                  path,
                  description: `删除危险副本 ${path}（插件将从共享层 ~/.dsh/profiles/node_modules 软链解析）`,
                },
              }
            : {
                fixKind: 'prompt' as const,
                prompt: `${PROMPT_HEADER}\n\n问题：${path} 是 @deepseek-ai/ 核心包的真实副本，与安装本体可能形成模块双实例（Symbol/类身份错位，症状如 Cannot read properties of undefined (reading 'prepare')）。\n但本机没有共享层 ${sharedLayer}，删掉副本会让这个包彻底无法解析——比潜在的双实例风险更糟，所以这里不提供一键删除。\n正确处理顺序：\n1. 先只确认版本：读 harness 本体（resources/app.asar/dsh/node_modules/@deepseek-ai/${pkg}/package.json）里的版本，和副本比对；\n2. 版本不一致 → 双实例是预期状态，不要动；\n3. 版本一致且真的出现 Symbol/类身份错位 → 才考虑把副本换成指向本体的软链；\n4. 没有故障症状时，什么都不做。`,
              }),
        })
      }
    } catch {
      // absent — the healthy state
    }
  }
  return findings
}

/**
 * C4 — 依赖可解析性（防 ERR_MODULE_NOT_FOUND）。
 */
export function checkDependencyResolvability(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  const manifest = readPluginManifest(row)
  if (manifest === null) return []
  // Runtime resolution anchor: the INSTALLED copy for file:/registry deps
  // (Node resolves from inside the profile tree), the source dir only for
  // link: deps (Node realpaths the symlink back to the source).
  const root = row.installedDir !== '' ? row.installedDir : (row.sourceDir ?? '')
  if (root === '') return []
  const findings: CheckFinding[] = []
  const imported = collectRuntimeImports(root)
  const specs = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
  for (const spec of specs) {
    // Host-injected externals are never on disk — resolving them proves nothing.
    if (HOST_PROVIDED.some((re) => re.test(spec))) continue
    const name = packageNameOf(spec)
    // Present on disk but without a root export entry (ERR_PACKAGE_PATH_NOT_EXPORTED)
    // is NOT a missing dependency: subpath-only packages are normal.
    if (resolvePackageDir(root, name) !== undefined) continue
    // Declared but never imported (types-only / optional integration) cannot break boot.
    if (!imported.has(name)) continue
    findings.push({
      layer: 'l0', code: 'dep-unresolvable', severity: 'error', plugin: row.name,
      message: `${row.name} 的依赖 ${spec} 无法从 ${root} 解析 — 启动时 ERR_MODULE_NOT_FOUND`,
      evidence: [`spec: ${spec}`, `anchor: ${root}`],
      fixKind: 'prompt',
      prompt: `${PROMPT_HEADER}\n\n问题：${row.name} import "${spec}" 无法从 ${root} 解析。\n判断：\n- 若插件是 link: → 在插件源码目录 pnpm install 装依赖，或改成 file: 依赖；\n- 若依赖是 harness 提供的（@deepseek-ai/*）→ 检查 ~/.dsh/profiles/node_modules 软链与版本；\n- 若是 peer 缺失 → 确认共享层已有该包，再决定 link: 或 file:。`,
    })
  }
  return findings
}

function packageNameOf(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

/** 从 root 向上逐级找 node_modules/<pkg>；找到即视为可解析。 */
function resolvePackageDir(root: string, name: string): string | undefined {
  let dir = resolve(root)
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 收集插件宿主代码里真实 import/require 的裸包名（注释里提到的不算）。 */
function collectRuntimeImports(root: string): Set<string> {
  const specs = new Set<string>()
  const seen = new Set<string>()
  const visit = (dir: string): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
      let text: string
      try { text = readFileSync(path, 'utf8') } catch { continue }
      for (const match of text.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = match[1]
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')) continue
        specs.add(packageNameOf(spec))
      }
    }
  }
  for (const dir of ['lib', 'dist', 'build'].map((name) => join(root, name))) visit(dir)
  if (seen.size === 0) visit(root)
  return specs
}

/**
 * POSIX/macOS-only helpers — missing on Windows by design, not a defect.
 */
const POSIX_ONLY_COMMANDS = new Set(['getconf', 'xattr', 'gio', 'open', 'xdg-open', 'notify-send', 'osascript', 'say', 'pbcopy', 'pbpaste', 'lsattr', 'chattr'])

/**
 * C5 — Windows 命令可用性（防 dsh-skin CLI not found 复发）。
 * 扫描插件对 execFile/spawn 的裸命令引用，验证注册表 PATH 中能找到真 .exe。
 */
export function checkWindowsCommands(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  if (process.platform !== 'win32') return []
  const root = row.sourceDir ?? row.installedDir
  if (root === '') return []
  const findings: CheckFinding[] = []
  const commands = collectCommandRefs(root)
  for (const command of commands) {
    if (/[\\/]/.test(command) || command.endsWith('.exe')) continue
    // POSIX/macOS-only helpers live behind platform branches: on Windows they
    // are expected to be missing and cannot break the backend.
    if (POSIX_ONLY_COMMANDS.has(command)) continue
    let found = false
    try {
      const out = execFileSync('where.exe', [command], { encoding: 'utf8', timeout: 10_000 })
      found = out.split(/\r?\n/).some((line) => line.trim().toLowerCase().endsWith('.exe'))
    } catch {
      found = false
    }
    if (!found) {
      findings.push({
        layer: 'l0', code: 'command-not-found', severity: 'warn', plugin: row.name,
        message: `${row.name} 引用的外部命令 ${command} 在注册表 PATH 中找不到真 .exe — 后端进程（PowerShell 启动）执行时会 ENOENT`,
        evidence: [`command: ${command}`, 'check: where.exe 在注册表 PATH（HKCU/HKLM）中的 .exe'],
        fixKind: 'prompt',
        prompt: `${PROMPT_HEADER}\n\n问题：${row.name} 调用外部命令 ${command}，Windows 后端进程找不到。\n注意三点（本次事故总结）：\n1. Node execFile(shell:false) 只认真实 .exe，不认 .cmd/.bat/shebang 脚本 → 需要编译 .exe 垫片（gcc + C 源码转发参数）；\n2. 垫片必须放在注册表 PATH（如 %APPDATA%\\npm），Git Bash 的 ~/.local/bin 对 PowerShell 启动的后端无效；\n3. 脚本内路径用 os.homedir() + __dirname 推导，禁止硬编码。`,
      })
    }
  }
  return findings
}

/** Collect bare command names referenced by execFile/spawn in a plugin tree. */
function collectCommandRefs(root: string): string[] {
  const found = new Set<string>()
  // 只扫宿主真正加载的运行时目录：lib/ → dist/ → 整棵树（剔除开发期目录）。
  // 否则 tools/smoke-test.mjs、skills/*/render-graphs.js 这类脚本会把 pnpm、dot
  // 之类「只在开发机上用」的命令算成插件运行时依赖。
  const DEV_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'tools',
    'scripts',
    'examples',
    'example',
    'dev',
    'docs',
    'skills',
    'test',
    'tests',
    '__tests__',
  ])
  const scanRoot = [join(root, 'lib'), join(root, 'dist')].find((dir) => existsSync(dir)) ?? root
  const scan = (dir: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const skip = scanRoot === root ? DEV_DIRS.has(entry.name) : entry.name === 'node_modules'
        if (!skip) scan(path, depth + 1)
        continue
      }
      if (!/\.(js|mjs|cjs|ts|yml|yaml|json)$/.test(entry.name)) continue
      let content: string
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const match of content.matchAll(/(?:execFile|execFileSync|spawn)\s*\(\s*["']([^"']+)["']/g)) {
        found.add(match[1])
      }
    }
  }
  scan(scanRoot, 0)
  return [...found]
}

/**
 * C6 — lockfile 一致性（防"改 specifier 不重解析"）。
 */
export function checkLockfileConsistency(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  const findings: CheckFinding[] = []
  if (!row.spec.startsWith('file:') && !row.spec.startsWith('link:')) return findings
  const lockPath = join(ctx.profileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) return findings
  const lock = readFileSync(lockPath, 'utf8')
  const expected = row.spec.startsWith('file:') ? 'file:' : 'link:'
  const versionMatch = new RegExp(`\\n\\s{2}${escapeRegExp(row.name)}:\\n(?:[\\s\\S]{0,200}?)\\n\\s{4}version: (file|link):`)
  const match = versionMatch.exec(lock)
  const actual = match?.[1]
  if (actual !== undefined && actual !== expected) {
    findings.push({
      layer: 'l0', code: 'lockfile-stale', severity: 'error', plugin: row.name,
      message: `${row.name} 的 package.json specifier 是 ${expected} 但 lockfile 仍记录 ${actual} — pnpm 没有重解析，改 specifier 不会生效`,
      evidence: [`specifier: ${row.spec}`, `lockfile version: ${actual}:...`],
      fixKind: 'prompt',
      prompt: `${PROMPT_HEADER}\n\n问题：${row.name} 改过依赖类型（link:/file:）但 pnpm-lock.yaml 没重解析。\n修复（必须 remove + add，直接改 package.json 无效）：\n  cd ${ctx.profileDir}\n  pnpm remove ${row.name}\n  pnpm add "${row.spec}"\n  grep -A2 '${row.name}:' pnpm-lock.yaml   # 确认 version: 前缀已变`,
    })
  }
  return findings
}

/** Escape a literal for a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * C7 — 禁用插件状态识别。被禁用的插件有两种情形：
 * 1. 二分排查遗留（如本次事故的 context-lens / dsh-memory）——已知有问题，
 *    应继续排查根因或移除，而不是带着 disabled 行长期运行；
 * 2. dsh-skin 管理的皮肤互斥（ui-skin-*）——正常机制，不告警。
 * 检查器只对第 1 类给出 warn：被禁用的插件仍在 profile 依赖里，占用磁盘、
 * 参与 install 的 peer 副本安装，且它的问题本身未被修复。
 */
export function checkDisabledPlugins(ctx: CheckerContext, row: PluginRow): CheckFinding[] {
  if (row.disabled !== true) return []
  // Skin-managed rows are the skin-center's exclusive mechanism — not an
  // incident, no finding.
  if (row.name.includes('ui-skin')) return []
  const layers = (row.disabledBy ?? []).join('、')
  return [{
    layer: 'l0',
    code: 'plugin-disabled',
    severity: 'warn',
    plugin: row.name,
    message: `${row.name} 已被禁用（${layers}）但仍登记在 profile 依赖中 — 禁用是压制症状而非修复；该插件仍会参与 pnpm install（peer 副本）并占用空间，建议排查根因后修复启用，或彻底移除`,
    evidence: [
      `disabled by: ${layers}`,
      `specifier: ${row.spec}`,
      `installed: ${row.installedDir !== '' ? row.installedDir : '(not installed)'}`,
    ],
    fixKind: 'prompt',
    prompt: `${PROMPT_HEADER}\n\n问题：${row.name} 因事故被禁用（${layers}），但根因未修复。\n排查方向：\n1. 先跑「插件检测」全量扫描该插件，看 L0 各项是否已修复（依赖可解析/副本/harness 身份等）；\n2. 若根因已修复：从 ~/.dsh/cordis.patch.yml 删除该 disabled 行（或 dsh healthcheck rollback --undo），重启后端验证；\n3. 若根因无法修复：从 profile 彻底移除 —— cd ${ctx.profileDir} && pnpm remove ${row.name}，并删除插件目录；\n4. 不要长期保留 disabled 行 —— 被禁用的插件仍随 pnpm install 装出 peer 副本，是持续的隐患源。`,
  }]
}

/** All L0 checkers in run order. */
export const L0_CHECKERS = [
  checkFilesWhitelist,
  checkDependencySpec,
  checkHighRiskCopies,
  checkDependencyResolvability,
  checkWindowsCommands,
  checkLockfileConsistency,
  checkDisabledPlugins,
] as const

/** Global L0 checks (profile-wide, not per plugin). */
export function checkGlobalL0(ctx: CheckerContext, rows: PluginRow[]): CheckFinding[] {
  const findings: CheckFinding[] = []
  // High-risk copies is global (needs the profile tree, not one plugin).
  findings.push(...checkHighRiskCopies(ctx, rows[0] ?? { name: '', spec: '', bundle: false, installedDir: '' }))
  // Home patch presence sanity: the rollback target must exist.
  if (!existsSync(resolveHomePatch(ctx.home))) {
    findings.push({
      layer: 'l0', code: 'home-patch-missing', severity: 'warn',
      message: `home 层补丁 ${resolveHomePatch(ctx.home)} 不存在 — 自动回滚将无法写入`,
      fixKind: 'none',
    })
  }
  return findings
}
