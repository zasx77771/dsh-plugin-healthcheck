# dsh-plugin-healthcheck

> DSH 插件健康检查 —— 装完新插件后**不重启后端**即可验证插件是否会导致事故。
> 纯静态检查 + 配置组合 + 隔离试跑 + 木马扫描，发现即修复（自动修复 / 自动回滚 / 预制提示词）。

`#dsh-plugin` · DeepSeek Harness (DSH) · TypeScript · turtle-ui

## 关于这个 fork（0.2.1）

上游 [`chenw2759-wq/dsh-plugin-healthcheck`](https://github.com/chenw2759-wq/dsh-plugin-healthcheck) 0.1.0 针对 DSH `0.1.0-rc.6`。在 DSH 桌面版 `0.2.1-rc.x` 上，它装得上但**完全没有反应**，实测是三层独立故障叠在一起：

1. **bundle 的 `package.json` 必须是合法 UTF-8 JSON。** 宿主解析失败时只打一行 `dsh: skipping profile bundle "dsh-plugin-healthcheck": SyntaxError …` 就把整条 bundle 跳过，面板自然一无所有。用 PowerShell 5.1 改含中文的 manifest 特别容易踩（默认按 ANSI 解码/回写），改这类文件请用 node 或 `-Encoding UTF8`。
2. **host 入口不能静态 import `@deepseek-ai/*`。** 上游在 `lib/index.js` 顶部 import 了 `@deepseek-ai/cordis-plugin-include`（它只是 devDependency），桌面版进程里解析不到，异常逃出路由 → `/healthcheck/inventory` 直接 400。而补一份副本又会牵出 `cordis-plugin-loader`、`cordis`、`cosmokit` 整条核心链（正是本插件自己检测的 `harness-copy` 风险）。
3. **客户端 inject 了 0.2.x 已不存在的 `@deepseek-ai/dsh-client-runtime`**，cordis 等不到这个服务就静默不 apply，设置里没有「插件检测」。

本 fork 的改动：

| 适配点 | 上游 0.1.0 | 本 fork 0.2.1 |
|---|---|---|
| `!!js` YAML schema | 静态 `import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'` | 用 `js-yaml` 的 `Type` 自建（支持 `!!js` / `!!js/function` / sequence / mapping），对 harness 核心包**零运行时依赖** |
| harness 安装根 | `createRequire().resolve('@deepseek-ai/dsh-app-boot/package.json')`，失败即抛 | 三级回退：`$DSH_HOME/profiles/node_modules` → `createRequire` → `<exe>/resources/app.asar/dsh/node_modules`；全失败返回 `undefined`，inventory 降级成 `builtin: []` 而不是 400 |
| `dsh.client` | 声明了已删除的 `dsh-client-runtime` | `{ platform: "web", inject: [] }`，客户端 `inject = ["slots","locale"]` |
| 客户端实现 | 0.1.0 的构建产物（92 KB，JSX 编译结果） | 手写同步 factory-CJS：无 JSX、只用 `React.createElement`、`apply()` 全 `try/catch`，无 slots 服务时安静退出 |
| slot 注册 | `ctx.slots.register(...)` 未诊断 | 先 `ctx.get('slots')` 判空再 `slots.inject('settings.section', …)`，带 `label` 与 `fallbackT` |
| profile 解析 | 硬编码 `'web'`（4 处） | `resolveProfileName()`：`DSH_PROFILE` → `desktop` → `web` → 其它有 manifest 的 profile |
| 修复提示词 | 写死作者机器路径（`M:\dsh\node_modules`、`C:/Users/cysja/...`、`~/.dsh/profiles/web`） | 用运行时的 `ctx.profileDir` / `ctx.home` / `~/.dsh/profiles/<profile>` |
| `peerDependencies` | 4 个 `@deepseek-ai/*` peer | 只留 `react`（避免 pnpm `autoInstallPeers` 装出核心包副本） |

注意事项：

- 本仓库**直接改构建产物**（`lib/*.js`）。原因：`@deepseek-ai/dsh-client-*` 在 npm 上只有 `0.0.1-rc.1` 占位版，没有 0.2.x 的包和 `.d.ts`，`pnpm build` 无法在外部环境跑通。`lib/client.js` 因此是手写的，与 `src/client/*.tsx` 不同步——源码仅供参考，原构建产物留在 `lib/client.built-upstream.js`。
- `lib/index.js` 的宿主侧改动与 `src/host/*.ts` 是同步的，但同样以 `lib/` 为准。
- `lib/types/**/*.d.ts` 仍是上游生成的声明，未按本次改动重建（只影响类型提示，不影响运行时）。
- 装完仍需**重启 DSH**（客户端模块按进程缓存）后硬刷新页面，设置面板才会出现「插件检测」。宿主侧是否挂上可看 `~/.dsh/storages/healthcheck/host-mount.log`。
- 面板里的 L1/L2 依赖 harness 的 `dsh-app-boot` 等内部包，由宿主解析，插件目录里不要放这些包的副本。
- 冒烟自检（无需装任何 harness 包、无需 React）：`node scripts/verify-client.mjs` —— stub `window.__ModuleLoader__` + 迷你 hooks 引擎 + fetch stub，跑 `apply` 并渲染一次页面，断言 15 项（注册项、label、缺 slots 不抛异常、inventory 数据真的进 DOM）。

## 截图

设置面板 →「插件检测」：

![插件检测面板](docs/healthcheck-panel.png)

运行一次检测（L0 静态 + L1 配置组合 + L2 隔离试跑 + 木马扫描）：

![插件检测结果](docs/healthcheck-results.png)

---

## 它解决什么问题

DSH 的 `dsh plugin add` 只负责把插件装进 profile（薄 pnpm 转发器），**装完不做任何验证**——
问题要等下次后端启动才暴露。常见事故：

| 事故 | 根因 | 本插件拦截方式 |
|---|---|---|
| 启动报 `ERR_MODULE_NOT_FOUND`（缺哈希 chunk） | `files` 白名单漏掉代码分割产物 | C1 files 完整性 |
| 后端启动报缺 `zod` / `schemastery` | 插件登记成 `link:` 依赖，绕过了 profile 的 node_modules | C2 依赖声明审计 |
| agent 报 `Cannot read properties of undefined (reading 'prepare')` | `file:` 依赖装出 harness 核心包副本 → **模块双实例** → Symbol 身份错位 | C3 高危副本检测 |
| `dsh-skin CLI not found`（Windows） | 命令不在注册表 PATH / `execFile` 只认 .exe | C5 Windows 命令 |
| 改了 `link:`→`file:` 不生效 | pnpm 不重解析 lockfile | C6 lockfile 一致性 |
| 被禁用的插件长期残留在依赖里 | 禁用是压制症状而非修复 | C7 禁用插件识别 |
| 供应链投毒 / 恶意代码 | 发布包内注入恶意逻辑 | C8 木马扫描（纯静态隔离） |
| 启动报 `loader fibers failed`（`cannot get property "fs" without inject`） | 插件未构建（lib 缺失）或 cordis 用法错误（`ctx.plugin()` 后同步取服务） | C9 cordis 用法检测（毫秒级） + L2 隔离试跑（重启前确认） |

---

## 实战案例（真实事故）

### 案例 A：未构建的插件导致后端启动崩溃

`dsh-ssh-workspace`（SSH 远程工作区）登记进了 profile（`file:` 依赖 + bundle），但它的
`lib/` 从未构建 —— 源码在、构建产物缺。重启后端时报：

```
Error: dsh: plugin tree failed to load: loader fibers failed
  Error: failed to apply loader entry ssh-workspace-fs (@deepseek-ai/dsh-ssh-workspace/fs):
    cannot get property "fs" without inject
```

**根因链**：`ctx.plugin(SandboxedFileSystem)` 是异步的，随后立即同步取 `localCtx.fs` 拿不到
服务（隔离作用域的 key 对不上）→ `cannot get property "fs" without inject`。

**L2 隔离试跑如何救场**：装完插件后不重启，直接跑一遍子进程完整 boot——它在后端真正
重启**之前**就把这条链断掉了（报同样的错），而不是等用户重启才发现。

**修复**（插件侧，不涉及 harness）：
1. 改用同步 `new SandboxedFileSystem(localCtx, config)` 并持有实例引用，不再
   `ctx.plugin()` 后同步取服务；
2. 直接 `new` 不走 cordis config 默认值填充，需显式传入
   `{ cwd, diffBasisMaxBytes: 10 * 1024 * 1024 }`；
3. `inject` 补上 `sandboxPolicy`。

**这个案例说明**：C8 木马扫描 + L2 隔离试跑在 CI 化的安装流程里互为补充——
静态检查看"有什么"，隔离试跑看"装完能不能起来"。

---

## 检查能力

### L0 静态检查（不加载、不启动）
| 检查器 | 内容 |
|---|---|
| C1 files 完整性 | `files` 白名单 vs 实际 lib 产物，缺 chunk → error |
| C2 依赖声明 | `link:` 带运行时依赖 / `file:` 带 harness peer |
| C3 高危副本 | 6 个核心包（cordis/cosmokit/dsh-tools/schemastery/dsh-credentials/dsh-home-paths）是否被装成真实目录副本 |
| C4 依赖可解析 | 逐个依赖从插件锚点试解析 |
| C5 Windows 命令 | `execFile`/`spawn` 引用的命令在注册表 PATH 是否有真 .exe |
| C6 lockfile 一致性 | specifier 与 lockfile `version:` 前缀是否一致 |
| C7 禁用插件 | 被 disabled 但仍登记的插件（皮肤互斥正常机制不误报） |
| C9 cordis 用法 | 静态检测三类 cordis 错误：E1 `ctx.plugin()` 后同步取服务、E2 直接 `new` 需 config 的 Service 缺 config、E3 访问的服务不在 `inject` 声明里 → 提前捕获 `cannot get property "X" without inject` 类崩溃 |

### L1 配置组合
复用基座 `composeEntries` 组合 bundle + profile + home 补丁层，与真实启动用**同一算法**；
检测补丁语法错误、行 id 冲突、补丁跳失。

### L2 隔离试跑（"不重启试跑"的核心）
子进程完整 `boot()` 全树（webserver 端口偏置为 0，与运行中后端零冲突），
基座 `assertEntriesActivated` 断言每个启用插件都激活，超时 90s 抓 hang。
失败 → 自动回滚（写 home patch 禁用行，HMR 热生效，无需重启）。

### C8 木马扫描（纯静态、隔离）
- **隔离铁律**：只 `readFile`，绝不 import / require / 执行插件代码。
- 7 类恶意模式：M1 下载执行、M2 凭据窃取、M3 外联回传、M4 混淆后门、M5 持久化、M6 破坏性、M7 环境劫持。
- 两级校准：强组合（下载执行 / 破坏性 / 凭据+外联）→ error；单一命中 → warn（提示人工复核）。
- 证据脱敏：密钥/令牌/私钥一律 `[REDACTED]`。
- 误报控制：跳过 tests/node_modules/构建产物；`new Function("return …")`（schemastery 惯用法）、
  `atob(dataUrl)` 数据解码、`downloadFile(` 方法名、回环 IP、普通 https API 均不命中。

---

## 铁律（HARD RULE）

修复执行器**严禁修改 harness 源码/安装本体**，只允许修改：
1. 插件代码（`~/.dsh/plugins/**`）
2. 配置层（`~/.dsh/profiles/**`、`~/.dsh/cordis.patch.yml`）

所有写路径经 `assertSafeTarget` 门禁（realpath 后必须落在 home 内且不在安装根内），
界面弹确认后路由仍要求 `confirmed: true`。修复执行器自身不跑 LLM——需要判断力的修复
打包成预制提示词交给 agent。

---

## 安装

```sh
# 1. 克隆到插件目录
mkdir -p ~/.dsh/plugins
cd ~/.dsh/plugins
git clone https://github.com/zasx77771/dsh-plugin-healthcheck.git

# 2. 装进 profile（桌面版是 desktop，CLI/Web 版是 web）
cd ~/.dsh/profiles/desktop
corepack pnpm@11 add "link:$HOME/.dsh/plugins/dsh-plugin-healthcheck"
#    再把 dsh-plugin-healthcheck 追加进该 package.json 的 dsh.profile.bundles
#    （桌面版的 profile 由 Electron 托管，`dsh plugin --profile desktop add` 会被拒绝）

# 3. 重启 DSH，打开左下角设置 →「插件检测」
```

> 用 `link:` 安装不会触发 `prepare`/`tsdown` 构建，这点很重要：本 fork 的 `lib/` 是手工维护的，重新构建会覆盖掉它。

> Windows 下 `file:` 路径用正斜杠绝对路径，如
> `file:C:/Users/<你>/.dsh/plugins/dsh-plugin-healthcheck`。

---

## 使用

1. 打开 Web GUI **左下角设置**，导航里点「插件检测」；
2. 选作用域（全部插件 / 指定插件）与层级（L0/L1/L2/木马扫描）；
3. 点「开始检测」；
4. 结果按 severity 徽标列出，每条含证据 + 修复动作：
   - **一键修复**（确定性，弹确认）
   - **自动回滚**（L2 失败写 disabled 行，弹确认，HMR 热生效）
   - **复制提示词**（复杂问题交给 agent）

也可直接调 HTTP 路由：`/healthcheck/inventory`、`/healthcheck/run`、`/healthcheck/status`、
`/healthcheck/repair`、`/healthcheck/rollback`、`/healthcheck/history`。

---

## 开发

```sh
pnpm install          # devDeps（SDK 类型 + 构建工具）
pnpm run typecheck    # host/client 双 program
pnpm run build        # lib/index.js + lib/runner.js + lib/client.js
pnpm test             # vitest（fixtures 复刻历史事故）
```

需要环境变量 `RUN_HEALTHCHECK_E2E=1` 才会跑真实 profile 的 e2e（smoke boot / live 路由）。

---

## 测试

| 文件 | 覆盖 |
|---|---|
| `tests/checkers.spec.ts` | L0 检查器对 fixture 的断言（missing-chunk 复刻 dsh-pet、link-dep 复刻 zod 事故、peer-copy 复刻双实例事故） |
| `tests/repair.spec.ts` | 铁律门禁（harness 路径必须拒绝）+ files 修复 + 回滚/撤销幂等 |
| `tests/malware.spec.ts` | 恶意 fixture 拦截、零执行证明、干净插件不误报、密钥脱敏、禁用识别、patch 解析 |
| `tests/cordis.spec.ts` | C9 cordis 用法检测：E1 异步 plugin 后同步取服务、E2 new Service 缺 config、E3 inject 缺服务（复刻 dsh-ssh-workspace 事故） |
| `tests/smoke.e2e.spec.ts` | 真实 profile 子进程完整 boot（L2） |
| `tests/live.e2e.spec.ts` | 真实 profile HTTP 路由全链路（inventory/run/status/history） |

---

## 目录结构

```
src/
├── index.ts              # host 入口：/healthcheck 路由 + systemPrompt 通告
├── core/types.ts         # 共享类型（Envelope / Finding / 严重度）
├── host/
│   ├── env.ts            # home/profile/插件清单/禁用行解析
│   ├── checkers.ts       # L0 检查器（C1~C7）
│   ├── malware.ts        # C8 木马扫描（纯静态隔离）
│   ├── cordis.ts         # C9 cordis 用法检测（E1~E3，纯静态）
│   ├── verify.ts         # L1 配置组合 + L2 子进程试跑调度
│   ├── runner.ts         # L2 子进程入口（lib/runner.js）
│   ├── repair.ts         # 修复执行器 + 回滚（含铁律门禁）
│   ├── service.ts        # 检测编排（分层 + 历史）
│   └── routes.ts         # HTTP 路由
└── client/
    ├── index.ts          # settings.section 插槽注册
    ├── HealthcheckSection.tsx  # 检测面板
    ├── api.ts            # 浏览器客户端
    └── locales.ts        # 中英文案
```

---

## License

MIT
