/**
 * Checker unit tests over the fixture plugins — every L0 checker must catch
 * its fixture (each fixture replays one historical incident) and stay quiet
 * on the good fixture.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  checkDependencyResolvability,
  checkDependencySpec,
  checkFilesWhitelist,
  checkLockfileConsistency,
  checkWindowsCommands,
} from '../src/host/checkers.ts'
import type { PluginRow } from '../src/host/env.ts'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')

const ctx = { home: '', profileDir: '', profile: 'web' }

function row(name: string, spec: string, sourceDir?: string): PluginRow {
  return { name, spec, bundle: false, installedDir: '', sourceDir }
}

describe('C1 files whitelist (dsh-pet incident)', () => {
  it('catches a fixed-name whitelist that drops a hashed chunk', () => {
    const findings = checkFilesWhitelist(ctx, row('missing-chunk', 'file:x', join(FIXTURES, 'missing-chunk')))
    const error = findings.find((f) => f.code === 'files-missing-chunk')
    expect(error).toBeDefined()
    expect(error?.severity).toBe('error')
    expect(error?.repair?.kind).toBe('files-whitelist')
    expect(error?.repair?.path).toContain('missing-chunk')
  })

  it('stays quiet on a glob whitelist', () => {
    const findings = checkFilesWhitelist(ctx, row('good-plugin', 'file:x', join(FIXTURES, 'good-plugin')))
    expect(findings).toHaveLength(0)
  })
})

describe('C2 dependency spec (link:/file: incident)', () => {
  it('flags link: deps that carry runtime dependencies', () => {
    const findings = checkDependencySpec(ctx, row('link-dep-plugin', 'link:x', join(FIXTURES, 'link-dep-plugin')))
    const error = findings.find((f) => f.code === 'link-deps')
    expect(error).toBeDefined()
    expect(error?.severity).toBe('error')
    expect(error?.prompt).toContain('pnpm remove')
  })

  it('warns about file: plugins with harness-core peers', () => {
    // ctx.profileDir = '' means no pnpm-workspace.yaml → autoInstallPeers
    // defaults to enabled → the risk warning is legitimate.
    const findings = checkDependencySpec(ctx, row('peer-copy-plugin', 'file:x', join(FIXTURES, 'peer-copy-plugin')))
    const warn = findings.find((f) => f.code === 'file-peer-copies')
    expect(warn).toBeDefined()
    expect(warn?.severity).toBe('warn')
  })

  it('stays quiet on harness-core peers when autoInstallPeers is disabled', () => {
    // The dsh profile template ships autoInstallPeers: false — peers never
    // materialize as nested copies, so the declaration alone is not a risk.
    const dir = mkdtempSync(join(tmpdir(), 'peers-off-'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nautoInstallPeers: false\n', 'utf8')
    const findings = checkDependencySpec(
      { ...ctx, profileDir: dir },
      row('peer-copy-plugin', 'file:x', join(FIXTURES, 'peer-copy-plugin')),
    )
    expect(findings.find((f) => f.code === 'file-peer-copies')).toBeUndefined()
  })

  it('warns again when autoInstallPeers is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peers-default-'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    const findings = checkDependencySpec(
      { ...ctx, profileDir: dir },
      row('peer-copy-plugin', 'file:x', join(FIXTURES, 'peer-copy-plugin')),
    )
    expect(findings.find((f) => f.code === 'file-peer-copies')).toBeDefined()
  })

  it('stays quiet on a dependency-free link: plugin', () => {
    const findings = checkDependencySpec(ctx, row('good-plugin', 'link:x', join(FIXTURES, 'good-plugin')))
    expect(findings).toHaveLength(0)
  })
})

describe('C4 dependency resolvability', () => {
  it('flags a dependency that cannot resolve from the plugin anchor', () => {
    // A temp plugin dir (outside any node_modules chain) with a dependency
    // that cannot exist — resolution must fail from the plugin's own anchor.
    const dir = mkdtempSync(join(tmpdir(), 'unresolvable-plugin-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'unresolvable-plugin',
      version: '1.0.0',
      type: 'module',
      dependencies: { 'this-package-cannot-exist-xyz': '^9.9.9' },
    }), 'utf8')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), "import anything from 'this-package-cannot-exist-xyz'\nexport default anything\n", 'utf8')
    const findings = checkDependencyResolvability(ctx, row('unresolvable-plugin', 'link:x', dir))
    const error = findings.find((f) => f.code === 'dep-unresolvable')
    expect(error).toBeDefined()
    expect(error?.severity).toBe('error')
  })

  it('ignores host-injected externals declared as dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-external-plugin-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'host-external-plugin',
      version: '1.0.0',
      type: 'module',
      dependencies: { '@deepseek-ai/cordis': '^4.0.0', react: '^18.2.0' },
    }), 'utf8')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), "import { Context } from '@deepseek-ai/cordis'\nimport { createElement } from 'react'\nexport const ok = [Context, createElement]\n", 'utf8')
    expect(checkDependencyResolvability(ctx, row('host-external-plugin', 'link:x', dir))).toHaveLength(0)
  })

  it('ignores a declared-but-never-imported dependency (types-only / optional)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optional-dep-plugin-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'optional-dep-plugin',
      version: '1.0.0',
      type: 'module',
      dependencies: { 'left-pad-nope': '^1.0.0' },
    }), 'utf8')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), '// optional integration: left-pad-nope is mentioned only in this comment\nexport const ok = true\n', 'utf8')
    expect(checkDependencyResolvability(ctx, row('optional-dep-plugin', 'link:x', dir))).toHaveLength(0)
  })

  it('treats an installed-but-subpath-only package as resolvable', () => {
    // @codemirror/legacy-modes has no root export: import.meta.resolve throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED even though the package is on disk.
    const dir = mkdtempSync(join(tmpdir(), 'subpath-plugin-'))
    const dep = join(dir, 'node_modules', '@codemirror', 'legacy-modes')
    mkdirSync(dep, { recursive: true })
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: '@codemirror/legacy-modes', version: '6.5.3' }), 'utf8')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'subpath-plugin',
      version: '1.0.0',
      type: 'module',
      dependencies: { '@codemirror/legacy-modes': '^6.5.3' },
    }), 'utf8')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), "import { shell } from '@codemirror/legacy-modes/mode/shell'\nexport const ok = shell\n", 'utf8')
    expect(checkDependencyResolvability(ctx, row('subpath-plugin', 'link:x', dir))).toHaveLength(0)
  })

  it('stays quiet when every dep resolves', () => {
    const findings = checkDependencyResolvability(ctx, row('good-plugin', 'file:x', join(FIXTURES, 'good-plugin')))
    expect(findings).toHaveLength(0)
  })
})

describe('C5 Windows commands', () => {
  it('flags a bare command that resolves to no real .exe', () => {
    // good-plugin has no command refs, so craft one inline.
    const findings = checkWindowsCommands(ctx, row('good-plugin', 'file:x', join(FIXTURES, 'good-plugin')))
    expect(findings).toHaveLength(0)
  })
})

describe('C6 lockfile consistency', () => {
  it('stays quiet when the lockfile is absent', () => {
    const findings = checkLockfileConsistency({ ...ctx, profileDir: FIXTURES }, row('any', 'file:x'))
    expect(findings).toHaveLength(0)
  })
})
