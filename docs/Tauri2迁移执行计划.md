# Tauri 2 迁移执行计划（迁移 → 代码查重审核 → 打包测试）

> 日期：2026-09-25
> 决策：**确定迁移 Tauri 2**，采用第 3 节 R3 混合路线（外壳先换、UI 逐页换）
> 源工程：`E:\Games\EveJS-v0.12.8\launcher\launcher`（Electron 33 / v0.1.28）
> 新工程：`E:\AI projects\ChatGPT\evejs-launcher`（当前只有 `docs/`，非 git 仓库）
> 配套：`docs/框架迁移方案.md`、`docs/迁移评估-Tauri2+shadcn.md`、桌面《EveJS 启动器换框架迁移方案.md》

---

## 0. 范围与冻结项

| 项 | 冻结决定 | 理由 |
| --- | --- | --- |
| 外壳 | Tauri 2（Rust + 系统 WebView2） | 体积/启动/内存三项唯一同时达标 |
| WebView2 分发 | Evergreen + `downloadBootstrapper{silent:true}`；**禁用 Fixed Version** | Fixed Version >250 MB，等于白换 |
| 前端策略 | 双轨：P2–P4 复用现有 `eve-launcher.html`；U1–U5 逐页切到 shadcn（`assets/eve-console`） | 先拿指标，再换皮 |
| 更新器 | 沿用 Go `evejs-updater.exe`（独立进程替换 exe），补 A1 签名校验 | 与外壳框架无关，0 改动复用 |
| Node 生态 | **保留**（服务端与 `scripts/*-cli.js` 依赖系统 Node，`processManager` 本身就是 `cmd /c npm start`） | 见评审文档 §4，重写风险大于收益 |
| 版本冻结 | Tailwind 3.4 + React 19 + Radix 版本锁死；Tauri 2.x 固定 minor | 避免迁移期叠加升级风险 |
| 分支策略 | `main` = 现役 Electron（继续发布）；`tauri2` = 迁移干线；迁移期只允许单向流动 | 双轨不漂移 |

**迁移期三条铁律**
1. 新功能只进 `tauri2`（React 侧或 Rust 侧），`main` 只修 bug。
2. 任何模块在 `tauri2` 通过验收前，不得从 `main` 删除。
3. 未拿到 §2 的 G0 基线数据，不得进入编码阶段。

---

## 1. 阶段总览与门禁

| 阶段 | 周次 | 内容 | 出口门禁（不通过不得进入下一阶段） |
| --- | --- | --- | --- |
| **S0 冻结与测量** | W1 | 基线埋点、契约清单、分支与版本冻结 | **G0**：3 次冷启动分段耗时 + 常驻内存 + 体积基线存档 |
| **S1 骨架与契约** | W2–W3 | Tauri 工程、双入口、`window.api` shim、通道回包 | **G1**：82/82 通道有回包；终端事件不丢行 |
| **S2 后端直译** | W4–W8 | TS → Rust 模块逐条移植（§4 顺序） | **G2**：每模块与 Electron 同输入同输出（§5.2） |
| **S3 查重与审核** | W8–W9 | 死代码/重复代码清理 + 安全项 A1–A5、B1–B8 | **G3**：查重报告 0 阻断项；安全清单逐条关闭 |
| **S4 打包** | W9–W10 | portable 单 exe、图标、资源、体积预算 | **G4**：体积达标 + 未装 WebView2 的机器能引导安装 |
| **S5 测试** | W9–W12 | 单元/契约/端到端/性能/升级回滚 | **G5**：§7 全部门槛通过，回滚成功率 100% |
| **S6 UI 迁移** | W10–W17 | shadcn 逐页接真数据（U1–U5，与 S2/S5 并行） | **G6**：6 页接线 + 5 页新建完成，旧 HTML 退役 |
| **S7 发布** | W13+ | 双轨 manifest、灰度、旧版停机页 | **G7**：≥30 台次升级成功率 ≥99.5% |

---

## 2. S0 冻结与测量（W1，1–1.5 周）

**任务清单**

- [ ] 建 git 仓库：`E:\AI projects\ChatGPT\evejs-launcher` 执行 `git init`，加 `.gitignore`（`target/`、`node_modules/`、`dist/`）
- [ ] 分支：`git switch -c tauri2`（`main` 留空给现役版镜像或保留为保护区）
- [ ] 在源工程 `src/main/index.ts` 打 5 个埋点：进程入口、`:18` 之后、`:1121`（`whenReady`）之后、
      `:132`（loadFile）之后、`ready-to-show`（`:115`）——写 `performance.now()` 到 `launch_out.log`
- [ ] 用 Electron 内置 `--trace-startup` 取一份官方分段数据做交叉验证
- [ ] 内存口径脚本：启动后 10 s / 60 s 两个时间点，对**进程树** `WorkingSet64` 求和
- [ ] 体积基线：portable exe、`win-unpacked`、`app.asar`、`locales/`
- [ ] 契约清单：从 `src/main/ipc.ts` 抽出 82 个通道的**参数与返回形状**（读函数体，不只看注册点）
- [ ] 事件清单：`services:changed` / `terminal:data` / `terminal:exit` / `init:changed` /
      `update:changed` / `mod:downloadProgress` / `mod:publishProgress` 的载荷结构
- [ ] 冻结阈值：确认评审文档 §7 + 本计划 §7 的数值

**产出**：`docs/baseline.md`（基线数据）、`docs/ipc-contract.md`（82 通道契约，**React 接线的唯一依据**）

**测量脚本骨架（PowerShell）**

```powershell
$exe = "E:\Games\EveJS-v0.12.8\launcher\launcher\release\EvEJSLauncher.exe"
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -PassThru
while ($p.MainWindowHandle -eq 0 -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 50 }
"窗口可见: $($sw.ElapsedMilliseconds) ms"
Start-Sleep -Seconds 10
$ws = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" |
       Measure-Object WorkingSetSize -Sum).Sum
"子树内存: $([math]::Round(($p.WorkingSet64 + $ws)/1MB,1)) MB"
```

---

## 3. S1 骨架与契约（W2–W3，1–2 周）

> **实施状态（2026-09-25）：S1 已完成，G1 通过。** 详见 `docs/S1-骨架与契约-实施记录.md`
> （§4 列出 7 处与本文的有意偏差，§7 为实测结果）；性能/体积/内存数据见 `docs/baseline.md`。
>
> 门禁实测：
> - 静态：`node scripts/verify-contract.mjs` 通过（已实现 26 + 待实现 56 = 82/82 登记齐全）
> - 运行时：`pwsh -File scripts/smoke-ipc.ps1` → **70/70 通道有回包**（真实 WebView 端到端；
>   其余 12 个写通道有副作用，靠单测 + 人工验证，契约上仍在 `HANDLED` 内）
> - 质量：`cargo test --lib` 20/20、`cargo clippy -D warnings` 无告警、`cargo fmt --check` 通过
> - 指标：冷启动 10.8 s → 0.64 s；exe 72.95 MB → 5.03 MB；**内存未改善（417 vs 398 MB）**，
>   已列为 S6 专项（页面瘦身，目标 ≤150 MB）

**任务清单**

- [ ] `pnpm create tauri-app`（React + TS + Vite 模板），工程根即 `evejs-launcher/`
- [ ] `rust-toolchain.toml` 固定 Rust 版本；提交 `Cargo.lock`、`pnpm-lock.yaml`
- [ ] Tauri 配置：
      `decorations:false`、`visible:false` + ready 后 show（防白屏）、`backgroundColor:"#0b0e14"`、
      `withGlobalTauri:false`、`title "EvEJS 启动器"`
- [ ] Vite 多入口：`launcher.html`（复用现有 EVE HTML 全套静态资源）+ `console.html`（挂 `eve-console`）
- [ ] **legacy 资产原样拷贝**：`eve-launcher.html`、`launcher-bridge.js`、`eve-theme.css`、`public/*`（含 5.3 MB 手册与 4 个 JSON）
- [ ] `src-tauri/src/ipc.rs` 注册 82 个 command（先返回 mock/空值），命名与现有通道号一一对应
- [ ] legacy shim（≈150 行）：`window.api` 的 82 个方法 → `invoke`；事件用 `Channel` 回灌
- [ ] `window:*` 3 通道 + `shell:openExternal`（scheme 白名单 `^https?://`，修 B2）
- [ ] PTY：`portable-pty` 起 `cmd.exe /c npm start`，事件走单队列 + rAF 合帧
- [ ] 单实例锁（`tauri-plugin-single-instance`）、窗口位置持久化（复刻 `saveWindowBounds`）
- [ ] 保留并接入 `scripts/check-renderer.js`（legacy HTML 语法预检）

**门禁 G1**：82/82 通道回包；`npm start` 日志在 legacy 页面实时滚动且**10 万行不丢行**；
无 ConPTY 时降级分支可用（对齐 `ptyManager.ts:83`）。

---

## 4. S2 后端直译（W4–W8，3–5 周）

**移植顺序（每完成一个模块即提交一个 PR，禁止批量合入）**

| # | 源模块（TS） | 目标（Rust） | 关键等价点 |
| --- | --- | --- | --- |
| 1 | `runtimePaths.ts` | `runtime.rs` | 便携版自定义 userData 路径、临时目录 |
| 2 | `configStore.ts` | `config.rs` | `config/server.json` + `EvEJSConfig.bat` 读写、键序与编码保持 |
| 3 | `envDetector.ts` | `env.rs` | **必须异步化**：`node -v`/`rustc`/`cargo` 不再 `execSync` 串行阻塞 |
| 4 | `logger.ts` | `log.rs` | 日志文件路径、时间戳格式、UTF-8 |
| 5 | `healthChecker.ts` | `health.rs` | TCP 探活、延迟测量、超时语义 |
| 6 | `processManager.ts` | `process.rs` | 状态机、`taskkill /PID /T /F` 杀进程树、**`DETACHED_PROCESS｜CREATE_NEW_PROCESS_GROUP` 逐位对齐（B8）** |
| 7 | `ipc.ts` | `ipc.rs` | 82 通道签名与返回形状 |
| 8 | `modManager.ts` | `mods/scan.rs`、`mods/plan.rs` | 扫描/启用/加载顺序/冲突检测/`path.relative` 断言（B1） |
| 9 | `modPack.ts` | `mods/pkg.rs` | ZIP 打包改原生 `zip` crate；**解压路径穿越断言（A3）** |
| 10 | `modSigner.ts` | `mods/sign.rs` | Ed25519 逐位一致 + 内置索引公钥 |
| 11 | `modRegistry.ts` | `mods/registry.rs` | 多镜像下载、sha256、验签先行 |
| 12 | `modScaffold.ts` / `modSubmit.ts` | `mods/scaffold.rs` / `mods/submit.rs` | 脚手架文件集与提交台账格式 |
| 13 | `authorStore.ts` | `author.rs` | `.eve-key` 导入导出；私钥**不落 localStorage**，DPAPI 加密 |
| 14 | `githubToken.ts` / `githubSubmit.ts` / `githubPublish.ts` | `github.rs` | `net.fetch` → `reqwest`；令牌加密；403 兜底提示文案 |
| 15 | `accountManager.ts` / `databaseManager.ts` | 保持 Node CLI（见下） | 不重写，避免 KV 编码与哈希语义漂移 |
| 16 | `updater.ts` | `updater.rs` | manifest 解析 + sha256 + **A1 签名校验**；替换动作交给 Go 更新器 |
| 17 | `ptyManager.ts` | `pty.rs` | `portable-pty`（ConPTY）+ 真实 `resize` |
| 18 | 指标采集（`ipc.ts` 内 PowerShell CIM） | `metrics.rs` | 改 Win32 性能计数器，CPU/GPU/虚拟内存/网络/磁盘数值口径一致 |

**关于 `scripts/account-cli.js` / `database-cli.js`**

S2 阶段**保持 Node CLI 不变**（评审文档 §4 结论：`better-sqlite3` 复用服务端依赖、
密码哈希 `SHA1(pw_utf16le ‖ user_lower_utf16le)×1000`、KV 编码与 `LIKE '%\x1f<角色>'` 前缀约定
逐位兼容风险高）。改为在 **S2.5（可选优化）** 做**常驻 Node 侧车**：

- 一次性拉起 node 进程，用 stdin/stdout 行协议复用现有 CLI 逻辑（JS 侧代码几乎不动）；
- 消除每次操作的进程启动与 `better-sqlite3` 加载开销（0.3–1 s → 期望 ≤200 ms）；
- 验收：与 CLI 逐字节相同的返回 JSON + 延迟采样；失败则回退 CLI，不影响 G2。

**门禁 G2**：每个模块都要过 §5.2 的 golden 对比；`process.rs` 额外过 B8 专项回归（客户端窗口可见）。

---

## 5. S3 代码查重与审核（W8–W9，贯穿全程）

### 5.1 死代码与重复代码查重

**A. 源工程（Electron 侧，迁移期它仍是现役版，所以只做零风险删除）**

```bash
npx knip --reporter json --no-progress          # 未使用的文件/导出/依赖
npx jscpd --min-lines 10 --min-tokens 70 --reporters console,html --output .audit/jscpd src scripts
npx madge --circular --extensions ts,tsx src    # 循环依赖
npx depcheck --json                             # 未声明/未使用依赖
```

预计命中（**以工具报告为准，逐条人工确认后再删**）：

| 命中对象 | 判定依据 |
| --- | --- |
| `src/renderer/components/*.tsx`、`App.tsx`、`main.tsx`、`index.html` | 生产只加载 `dist/renderer/eve-launcher.html`，`launch_out.log` 里 `index-a-4BUpJ5.js 446.34 kB` 是死重产物 |
| `react`、`react-dom`、`@xterm/xterm`、`@xterm/addon-fit`、`@vitejs/plugin-react` | 只服务上面那套死重 |
| `scripts/delete-account.py` | 与 `account-cli.js` 功能重叠，需确认无外部调用 |
| `src/renderer/theme/eve-theme.css` | 需确认未被 `eve-launcher.html` 引用 |

**必须维护 allowlist（否则误报）**：`src/renderer/public/*.js`（由 HTML `<script src>` 运行期加载）、
`scripts/*-cli.js`（由 Rust 侧 `Command` 拉起）、`eve-launcher.html` 内联脚本（knip 不解析）。

**B. 新工程（Tauri 侧）**

```bash
cargo clippy --all-targets --all-features -- -D warnings
cargo machete                                  # 未使用的 crate 依赖
cargo deny check                               # 许可 / 公告 / ban / 来源
cargo audit
cargo +nightly udeps --all-targets
cargo geiger --output-format Json              # unsafe 面
cargo bloat --release --crates -n 30           # 体积归因
cargo llvm-cov --summary-only                  # 覆盖率
pnpm exec tsc --noEmit && pnpm exec eslint . --max-warnings 0
pnpm exec knip && pnpm exec jscpd src
```

**C. 单一来源原则（本项目"查重"的真正重点）**

迁移最大的冗余风险是**同一份逻辑在 TS 与 Rust 各写一遍**。硬性要求：

- **类型与常量只在一处定义**：82 个通道名、状态枚举、manifest 字段、内置索引公钥、端口号
  —— 全部在 Rust 侧定义，用 `ts-rs` / `specta` 自动生成 TS 类型，禁止手抄第二份。
- 加一条 CI 检查：对 `pubkey|26000|26001|26002|40110|api_key|[a-z]+:[a-z]+` 之类的常量做
  "出现次数 >1 且不在生成文件内" 的告警。
- UI 侧禁止再出现 mock 引擎：`engine.tsx` + `seed.ts`（78 KB）在 U1 阶段整体替换，
  替换后从仓库删除，不得作为"演示模式"保留（否则等于双份状态机）。

### 5.2 双实现一致性（golden 对比，G2 的判定手段）

```text
tests/parity/fixtures/          输入 + 期望输出（由 Electron 现役版生成并冻结）
tests/parity/driver-electron.js 驱动 Electron 版：--parity-dump 逐通道输出 JSON
tests/parity/driver-tauri.mjs   驱动 Tauri 版：--parity-dump 同格式输出
tests/parity/diff.mjs           规范化后逐字节比对，CI 失败即阻断
```

规则：

1. **volatile 字段白名单**：时间戳、耗时、PID、绝对路径前缀，在对比前剔除或归一。
2. **逐字节相同的对象**：`config:*`、`mods:*` 返回 JSON、`env:check`、`log:read`（去时间戳前缀）、
   脚手架生成的文件集、台账 JSON。
3. **SQLite 不比文件字节**：页布局与 `VACUUM` 会让文件字节不同。改为
   `PRAGMA integrity_check` + 表/行数 + 有序全表 dump 比对（逻辑等价）。
4. **固定测试向量**（单独一类，跑在最前）：
   - 密码哈希：`SHA1(pw_utf16le ‖ user_lower_utf16le)×1000` 的输入/期望哈希表；
   - Ed25519：固定私钥签固定 payload 比对签名字节，并**交叉验证**（Rust 验 JS 签名、JS 验 Rust 签名）；
   - manifest：合法 / 篡改 / 错误签名 三个 fixture 的判定结果一致。

### 5.3 安全审核清单（评审文档 A1–A5 / B1–B8 的落地与验证方法）

| 项 | 修复要点 | 验证方法（可自动化的写成用例） |
| --- | --- | --- |
| **A1** 更新器只验完整性 | manifest 用内置维护者公钥 Ed25519 验签，失败即拒；移除 `file://` 与本地路径分支（仅留 smoke 开关）；打包版忽略 `launcher.config.json` 里的 manifest URL | fixture：篡改 manifest 版本号 / 换签名 / 换 asset URL → 断言全部拒绝；断言代码中无 `file://` 分支 |
| **A2** ZIP 导入无校验、绕过索引 | 导入后算整包 sha256；命中索引必须匹配；未命中一律标"未签名"，`trusted` 区分索引背书与包内自称 | fixture：自签包（应显示未签名）、索引内包篡改（应拒）、正版包（应通过） |
| **A3** 解压路径穿越 | 逐条归一化 entry 名并断言落在 tempRoot 内，拒 `..`、绝对路径、符号链接；`cpSync` 前同样断言 | fixture：含 `..\..\evil`、`C:\x`、symlink 的 ZIP → 断言抛错且 tempRoot 外无新增文件 |
| **A4** 渲染隔离易降级 | 严格 CSP（禁 `unsafe-inline`）、脚本外置、`withGlobalTauri:false`、只注册白名单 command、无远程域 IPC | DevTools 注入内联脚本应被 CSP 拦截；Rust 侧导出 command 清单与白名单比对为 0 差异 |
| **A5** 老用户升级断链 | 新旧 artifact 名并存；旧 Electron 版保留一个发布周期做"停机页"；manifest 双轨 | 在真实的 v0.1.28 上跑一次升级演练，确认出现停机页而非静默失败 |
| **B1** `startsWith` 前缀绕过 | 改 `path.relative` 断言 | 单测：同级目录 `mods-evil` vs `mods` 应判越界 |
| **B2** `openExternal` 未校验 scheme | 对齐白名单 `^https?://` | 单测：`javascript:` / `file://` / `ms-settings:` 全部拒绝 |
| **B3** 未校验调用来源 | Tauri 侧按窗口 label 校验，拒绝未知 webview | 用例：从非授权窗口 invoke → 拒绝并记录 |
| **B4** 终端输入被写日志 | 只记长度与 tabId，或直接脱敏 | 断言日志中不含明文口令模式 |
| **B5** `execFile("node")` 裸名 + 密码走 argv | 改绝对路径；密码走 stdin（S2.5 侧车协议里一并落定） | 断言进程命令行中不含密码；`node` 路径为绝对路径 |
| **B6** `characterId` 未校验拼路径 | 断言 `^[A-Za-z0-9_-]{1,32}$` 且结果在允许目录内 | 单测：`..\..\x`、超长、含分隔符全部拒绝 |
| **B7** 硬编码本机绝对路径 | `launcher.config.json` 置空/排除，发布产物不得含本机路径 | CI：grep `C:\Users\` 命中即失败 |
| **B8** 客户端进程创建标志 | `DETACHED_PROCESS｜CREATE_NEW_PROCESS_GROUP` 逐位对齐，且不加 `windowsHide` | 手动用例：角色直登后"进程在跑、有声音、**桌面窗口可见**"（历史故障点） |

### 5.4 审查流程与门禁

- **PR 粒度**：一个模块一个 PR（§4 表的 18 行，每行最多一个 PR），禁止批量合入。
- **每个 PR 必附三件证据**：① golden diff 结果；② `clippy -D warnings` + `eslint --max-warnings 0`；
  ③ 若涉及性能，附前后采样（启动 / 内存 / 单次操作延迟）。
- **必须双人复核的模块**：`process.rs`、`mods/sign.rs`、`mods/pkg.rs`、`github.rs`、`updater.rs`、`pty.rs`。
- **提交规范**：沿用现役约定（中英双语摘要）；面向用户的改动写入新工程自己的
  `release-notes/vX.Y.Z.json`（`type` 仅 `new` / `fix` / `opt`）。
- **门禁 G3**：查重报告 0 阻断项（重复块 <1%、无未使用依赖、无循环依赖）；A1–A5 全部关闭且有用例。

---

## 6. S4 打包（W9–W10，1–2 周）

**体积与启动相关配置**

```toml
# src-tauri/Cargo.toml
[profile.release]
lto = true
codegen-units = 1
panic = "abort"
opt-level = "s"
strip = true
```

```jsonc
// src-tauri/tauri.conf.json 关键项
{
  "app": { "withGlobalTauri": false,
           "windows": [{ "decorations": false, "visible": false,
                         "backgroundColor": "#0b0e14", "title": "EvEJS 启动器" }],
           "security": { "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" } },
  "bundle": { "windows": { "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true } },
              "icon": ["icons/icon.ico"] }
}
```

**步骤**

- [x] 版本单一来源脚本：`tauri.conf.json` / `Cargo.toml` / `package.json` 三处版本由一条命令同步
      （`scripts/sync-version.mjs`；真源 = `package.json`，`--check` 已进 `build.ps1` 与 `npm run check`）
- [x] 资源策略决策：UI 资产 10.97 MB 内嵌进 exe；Node 侧车（`account-cli.js` / `database-cli.js`）与
      自更新器外置到 `_launcher/`（必须是磁盘真实文件，见 `docs/S4-打包-实施记录.md` S4-D01）
      并保持"放进服务端根目录即可运行"的部署形态
- [x] **portable 绿色版 = 构建产出的主 exe 本身**（资源内嵌，无需 NSIS）；分发物为目录 + zip（`_launcher/` 需同置）
      ；另出 `nsis` 安装包（S4-D02：装机用户缺 WebView2 时由安装器自动补齐）
- [x] 产物命名与旧版区分（A5 双轨）：`EvEJSLauncher-Tauri-<version>-portable.zip` / `-setup.exe`（exe 内部名不变，S4-D03）
- [x] 生成 `update-manifest.json`（sha256 + 平台 + 体积）；签名随发布（`-SignKey`，公钥未配置前更新功能 fail closed）
- [x] **体积预算门禁**：`scripts/size-gate.mjs` 断言 exe ≤ 12 MB、便携版 zip ≤ 20 MB（`--require-zip`），超限直接 fail
- [x] 可复现构建：`rust-toolchain.toml` 固定 1.98.1 + 提交 `Cargo.lock`（前端零 npm 运行时依赖，无 `pnpm-lock.yaml`）
- [x] CI（GitHub Actions `windows-latest`）：`lint → unit → parity → build → size-gate → smoke`
      —— `.github/workflows/ci.yml` 已写（含缺 WebView2 冒烟）；**尚未在真实 runner 上跑过**，首次 push 时校准
- [x] 首启白屏与暗色闪屏防护：`visible:false` + 内容就绪后 show + `background_color(#05080d)`（Rust 侧设置，对齐 `--bg-void`）
- [ ] 未装 WebView2 的机器实测：确认引导安装流程可走通（含离线提示文案）
      —— 本机可自动化部分已覆盖（`scripts/smoke-webview2-missing.ps1`，3/3 断言：进程停住等用户选择 +
      顶层窗口标题 == 中文指引 + 未创建主窗口）；**缺运行时的真机仍待实机清单**

**门禁 G4**：体积达标；在干净 Win10 (1809/21H2) 与 Win11 各一台实机双击可用。

> **S4 收口记录**：`docs/S4-打包-实施记录.md`。体积已达标（exe 6.17 MB / 便携版 zip 4.42 MB / NSIS 3.19 MB，
> 现役 Electron 便携版 72.95 MB 的 4.4%）；干净机实机双击仍待执行（见该文档 §6 清单）。

---

## 7. S5 测试（W9–W12，与 S6 并行）

> **进度（2026-09-26，详见 `docs/S5-测试-实施记录.md`）**：**L1–L9 全部有产出/证据**（剩余债务见下表与 `docs/S5-测试-实施记录.md` §7）。
> 本轮补齐 **L4 终端压测 / L5 编码 / L6 进程树 / L8 升级回滚**，并把 **ConPTY 必须应答 `ESC[6n`** 这条移植缺陷抓出来
> （修复前 10 万行压测只收到 4 字节、之后长时间空白，现象极难判断）；L8 演练还抓到更新器 1/6 偶发替换失败并加固。
> 旧的启动耗时结论已更正：同口径热启动 **Tauri 1137 ms vs Electron 963 ms**；换外壳的收益在**冷启动与体积**。

| 层级 | 内容 | 工具 / 方法 | 门槛 | 状态 |
| --- | --- | --- | --- | --- |
| L1 单元 | 哈希向量、Ed25519、路径断言、config/bat 解析、版本比较、manifest 校验 | `cargo test` + `vitest` | 关键路径覆盖率 ≥70% | ⚠️ Rust **195 项全绿**（+4 项 `#[ignore]` 重档；含 `oscrypt::` 6 项 —— 与 Electron `safeStorage` 互通的 OSCrypt 密文，见 `docs/S9-界面重做-移植待办.md` §8）+ **vitest 58 项全绿**；覆盖率工具（`@vitest/coverage-v8`）未接（债务 #4） |
| L2 契约 | §5.2 golden 对比，82 通道逐条 | `tests/parity/diff.mjs`（同实现）+ `diff-cross.mjs`（跨实现） | 82/82，diff 为 0 | ✅ 26 个只读通道**三处比对全绿**（Tauri 自比 / Electron 自比 / 跨实现，6 条豁免逐条写明理由）；56 条写通道由 L3 覆盖 |
| L3 端到端 | 启动 → 起主服务/市场 → 日志滚动 → 建账号 → 角色直登 → 备份/恢复 → 装模组 → 卸载 → 更新检查 | `tests/e2e/run.mjs`（快照 → 跑 → 还原 → 复跑比对）+ 场景注入 | 全流程通过，无外部 cmd 窗口 | ⚠️ 沙箱已落地并接 `build.ps1`；**3 个场景共 25 步，两轮产物指纹逐字节一致**：`repo-mods`（`mods:*` 10 步 60 项）+ `config-settings`（`config/settings` 7 步 48 项）+ `author-token`（作者身份与 GitHub 令牌 8 步 52 项，含「令牌不明文落盘」）；剩余场景（起服务/日志滚动/账号/备份恢复/直登/更新检查）待补 |
| L4 终端压测 | 喷 100,000 行，检查丢行与卡顿、`resize` 生效、无 ConPTY 降级分支 | `scripts/stress-terminal.ps1` + `pty.rs` 的 `#[ignore]` 测试 | 无丢行；单次卡顿 ≤500 ms | ✅ 100,000 行 **0 丢失**，最大间隔 **48 ms**；`resize` 生效；应答 `ESC[6n` 的回归测试 `conpty_cursor_query_is_answered` 常驻（毫秒级） |
| L5 编码 | zh-CN Windows（代码页 936）下 `npm`/`cargo` 中文输出与 ANSI 颜色 | `scripts/check-encoding.ps1` + `pty.rs` 的 `#[ignore]` 测试 | 无乱码、无颜色丢失 | ✅ 代码页 **936** 中文无乱码（含 GBK 专有字符 `·`）、ANSI 保留；⚠️ 实测 **ConPTY 会重新序列化 VT 流**（`ESC[0m`→`ESC[m`、注入 OSC 标题）→ 连带修掉 `ansi.ts` 两个真缺陷（OSC 未剥离、加粗被颜色吃掉） |
| L6 进程 | 停服后进程树清理；客户端直登窗口可见（B8） | `scripts/check-process-residue.ps1` + Toolhelp32 探针 | 无残留 `node`/`exefile`/`market-server` | ✅ 真起 `node → node` 两级 → 走生产同一条 `taskkill /PID <pid> /T /F` → 残留 **0**；四个服务端口空闲；**B8（窗口可见）只能人工确认**（S7 §5.4） |
| L7 性能 | 冷启动 3 次取 P95、内存 10 s/60 s、体积、单次账号/DB 操作延迟 | `scripts/measure-startup.ps1`（需带 `-UserDataDir` 同口径） | 见 §12 汇总 | ⚠️ 热启动 **1137 ms**（目录版，3 轮 1081–1205）/ 工作集 **417.7 MB**@60s（私有 **218.9 MB**）/ exe **6.19 MB** / zip **4.42 MB**；「启动慢」真因已定位（现役便携单 exe 自解压 73 MB：热缓存 10.6 s vs Tauri 目录版 1.14 s ≈ **9.3×**）；**冷启动正式数据待重启后由登录任务采集**（`docs/baseline.md` §1.3） |
| L8 升级回滚 | 旧版 → 新版升级、新版 → 旧版回滚，≥30 台次 | `scripts/release-drill.ps1` + 灰度机器池 | 成功率 ≥99.5%；回滚 **100%** | ⚠️ **本机演练 6/6**（升级 7.8–9.3 s / 回滚 8.1–8.3 s，验签 + SHA256 + 重启存活全过），并据此给更新器加 `rename/copy` 重试；计划要求的「**≥30 台次**」是外部前置条件（`docs/S7-发布与回滚-实施记录.md` §6-①） |
| L9 冒烟等价 | 把现有 `--smoke-test` 移植为 `--parity-dump` + 精简冒烟 | 脚本 | 每次构建自动跑 | ✅ 等价物已落地：`smoke-ipc.ps1`（26 通道 + A4 断言，支持 `-Ui react|legacy`）+ `EVEJS_SELF_TEST_DUMP=1` 结构化 dump + 冻结基线值级比对 |

**门禁 G5**：L1–L9 全绿；任一红线不达标即不放行 —— **当前状态**：L1–L9 均有落地与实测证据，
剩余三项未闭合：L3 剩余场景（起服务/账号/备份恢复/直登/更新检查）待补、L8 缺外部灰度（≥30 台次）、L1 缺覆盖率工具；
阻塞点登记在 `docs/S5-测试-实施记录.md` §7/§8 与 `docs/S7-发布与回滚-实施记录.md` §6。

---

## 8. S6 UI 迁移（W10–W17，与 S2/S5 并行）

> **进度（2026-09-26，详见 `docs/S6-UI迁移-实施记录.md`）**：**U0–U4 全部落地，U5 完成 100% 缩放部分**。
> React 应用落在 `ui/`（Vite 8 + Tailwind v4 + shadcn 21 组件），**11 页全部实接**约 82 个 IPC 通道
> （`--ui=react` 是默认入口，`--ui=legacy` 一键回退）；U4 把 10 万行环形缓冲移出 React 树
> （`useSyncExternalStore` + 虚拟列表），L4 压测 0 丢失。前端单测 vitest 17 项已接进 `npm run check:app`。
> ⚠️ **`frontendDist` 仍是 `ui/dist`（legacy 页 + React 产物双入口并存）**，G6 退役条件未达成前不拆桥。
> **内存实测推翻旧目标**：空白页地板 **150.9 MB** 私有 → 「≤150 MB」不可达，改判「页面侧 ≤ legacy 60%」
> （当前 68.0 MB / 109.8 MB = 62%，差约 2 MB），详见 `docs/baseline.md` §4。

> **S8 UI 整合（2026-09-26，详见 `docs/S8-UI整合-实施记录.md`）**：`assets/eve-console` 原型**扶正落地** ——
> 把它的设计系统（Tailwind 3 烧配置 → 本仓 Tailwind 4 `@theme`）与外壳（HUD 底纹 / 236px 侧栏 / 顶栏读数 /
> 等宽仪表标签）嫁接到已接线的 11 页上，**数据流仍是 S6 的 `lib/ipc.ts`，没有搬原型的 mock 引擎**。
> 净变化：`+9` 个新文件、11 页只删两行（标题上收到顶栏）、`App.tsx` 从 150 行降到 30 行；配色从 S6 的紫改回原型青蓝。
> ⚠️ **内存门槛当前不达标**：页面侧私有 62% → **136%**（反超 legacy 34 MB），赤字 100% 在 GPU 进程的
> 非驻留提交；单项 CSS 属性已逐条排除（摘掉 `fixed` 附件 + `backdrop-blur` 是唯一真收益 −59 MB）。
> 工作集与 renderer 进程两项反而更省。**门槛口径待拍板，G6 不推进**（`docs/baseline.md` §4.1）。

| 阶段 | 内容 | 工期 | 出口 | 状态 |
| --- | --- | --- | --- | --- |
| **U0 组件补齐** | `shadcn add`：AlertDialog、ContextMenu、Command、Progress、Resizable、ScrollArea、Sheet、Skeleton、Popover、Separator；另加 **DataTable（TanStack Table）** | 2–3 天 | 组件齐备，`hud-*` 主题层覆盖 | ✅ 21 组件 + DataTable |
| **U1 契约层** | `src/lib/ipc.ts` 类型化包装 + `@tanstack/react-query` + 事件订阅封装；删除 `engine.tsx`/`seed.ts` 模拟层与 `localStorage` 依赖 | 0.5–1 周 | 页面不再依赖任何 mock | ✅ 手写结果类型 + `IpcResults` 登记表（未登记通道 tsc 直接报错） |
| **U2 已有 6 页接线** | 指挥台、日志中心、账号与角色、存档与备份、宇宙参数、模组管理 | 2–3 周 | 每页 golden 通过 | ✅ 6 页实接 |
| **U3 缺失 5 页新建** | 指令手册、数据库管理、环境自检/初始化、更新器 UI、角色直登入口 | 1.5–2.5 周 | 功能对等旧版 | ✅ 5 页新建（手册 iframe 点开才加载、`items_map.json` 首次搜索才 fetch） |
| **U4 日志吞吐** | 环形缓冲（10 万行）放 React 之外 + 虚拟滚动 + rAF 合帧 | 0.5–1 周 | L4 压测通过 | ✅ 0 丢失 / 最大间隔 48 ms（`docs/S5-测试-实施记录.md` §10.1） |
| **U5 视觉回归** | token 覆盖对齐主题；逐页截图对照（含 100%/125%/150% DPI） | 0.5–1 周 | 截图评审通过 | ⚠️ 100% 缩放 11 页已完成；**125%/150% DPI 需注销/登录后补**（S7 §5.4） |

**门禁 G6**：6 页接线 + 5 页新建完成（✅）；连续 2 个版本无「仅 HTML 侧可用」的功能后，才允许删除
`eve-launcher.html`（退役条件，避免过早拆桥）。**退役的量化收益**：exe 从 6.19 MB 降到约 4.81 MB（-22%），
见 `docs/baseline.md` §2。

---

## 9. S7 发布与回滚（W13+）

> **进度（2026-09-26，详见 `docs/S7-发布与回滚-实施记录.md`）**：**已就绪、待授权**。
> L8 本机演练 6/6 并据此加固了更新器（`renameWithRetry` / `copyWithRetry`）；发布检查单已固化。
> **三条外部前置条件未满足**（≥30 台次灰度、灰度机回滚实测、B8 直登 + 125/150% DPI 截图），另外查证到一条
> **必须先解决的冲突**：旧版 0.1.28 与新外壳读同一个 `releases/latest`，而旧更新器不认 zip ——
> 直接发布会把现役用户的 exe 替换成 zip 字节（S7 §2.1）。

- [x] 回滚演练（本机 6/6；灰度机器实测登记为 S7 §6-②）
- [x] 发布检查单固化（S7 §5）
- [ ] **双轨 manifest**：旧 Electron 版继续指向旧 artifact，只推一次「停机页」版本（A5）
      —— 方案与一次性动作清单见 S7 §2.2/§2.3（推荐 `stable` tag 固定 URL）
- [ ] 灰度：内测 3–5 台 → 20% → 全量；每档观察 48 h（崩溃率、启动耗时、内存）—— S7 §3
- [ ] 签名公钥写入 `src-tauri/src/updater.rs` 的 `UPDATE_PUBKEY`/`UPDATE_KEY_ID`（当前为空 = fail closed）
- [ ] Git 约定沿用现役：中英双语提交摘要、打 `vX.Y.Z` 标签、**不自动提交**

---

## 10. 风险与中止条件

**中止并回退 Electron 的条件（任一先触发即停）**

| 触发点 | 条件 |
| --- | --- |
| W3 末（G1） | 终端事件仍丢行/乱序，或 82 通道无法全部回包 |
| W8 末（G2） | golden 对比无法收敛（哈希、验签、config 语义任一不可对齐） |
| W10 末（G4） | 目标机型（Win10 1809 精简版 / 无网环境）无法引导 WebView2 且不可接受 |
| 任意时点 | 体积或内存实测超出阈值 ≥50% 且无优化路径 |

**主要风险**

| 风险 | 对策 |
| --- | --- |
| Rust 人力不足 | 先做 S1/S2 的 spike 评估；不足则切 Wails（Go），迁移量同量级 |
| 双轨 UI 漂移 | 铁律：新功能只进 React；旧 HTML 只修 bug |
| 大资源（手册 5.3 MB / JSON 4.9 MB） | 内嵌 vs 外置二选一并锁死；手册异步加载 |
| Playwright + WebView2 驱动版本匹配 | 在 CI 固定 `msedgedriver` 与 Runtime 版本对应关系 |
| 目标机器性能差异 | 冷启动阈值按"相对基线改善 ≥30%"判定，不以绝对毫秒一刀切 |

---

## 11. 交付物清单

| 类别 | 交付物 |
| --- | --- |
| 文档 | `docs/baseline.md`、`docs/ipc-contract.md`、`docs/parity-matrix.md`、`docs/perf.md`、`docs/security-checklist.md` |
| 代码 | `src-tauri/`（18 个模块）、`ui/`（legacy + shadcn 双入口）、`tests/parity/`、`scripts/`（版本同步、manifest 生成、签名、体积门禁） |
| CI | 6 个 job：lint / unit / parity / build / size-gate / smoke |
| 测试资产 | golden fixtures、固定向量（哈希、Ed25519、manifest）、10 万行压测生成器 |
| 发布 | 签名 manifest、灰度报告、回滚包与回滚演练记录 |

---

## 12. 验收阈值汇总

| 指标 | 现役基线（评审文档实测） | 目标 | 判定方式 |
| --- | --- | --- | --- |
| portable 体积 | 72.95 MB（现役 Electron 便携） | **≤10 MB**（P5；P1 中间目标 ≤60 MB） | 构建产物测量：**zip 4.60 MB / exe 6.38 MB** ✅（S8 复测，见 `docs/baseline.md` §2.1） |
| 冷启动 → 窗口可见 | 现役便携单 exe 热缓存 **10.6 s**（实测，同口径；见 `docs/baseline.md` §1.2） | **≤1.5 s** | 3 次取 P95；**冷启动正式数据待重启后由登录任务采集**（`docs/baseline.md` §1.3） |
| 页面侧私有内存（静止 60 s） | legacy 页 **109.8 MB**（实测，已减去空白页地板 150.9 MB） | **≤基线 60%（≤65.9 MB）**；S6 时 68.0 MB（62%）→ **S8 后 130.6 MB（136%），口径待重定** | 进程树 PrivateMemorySize64 求和 − 空白页地板（`docs/baseline.md` §4 / §4.1） |
| 工作集（静止 60 s，仅记录） | 445.8 MB | 记录当前 **418.7 MB** | 进程树 WorkingSet64 求和（含共享页，噪声大，不作为门槛） |
| 指标面板刷新 | 1–3 s（PowerShell CIM） | **≤100 ms** | 单次调用测量 |
| 日志吞吐 | 未测 | **10 万行不丢行、无 >500 ms 卡顿** | L4 压测 |
| 通道兼容 | — | **82/82** | L2 golden |
| 升级成功率 | — | **≥99.5%（≥30 台次）** | 灰度统计；本机演练 6/6 只算前置证据（S7 §4） |
| 回滚成功率 | — | **100%** | 演练：本机 6/6 ✅（S7 §4） |
| 查重 | 未测 | 重复块 <1%、无未使用依赖、无循环依赖 | knip/jscpd/madge/machete |

> 除「冷启动」一项（等重启后由登录任务采集，`docs/baseline.md` §1.3）外，本表的实测值均已落地；
> 内存门槛口径已按 S6 收口结果从「整树 WorkingSet ≤90 MB」改为「页面侧私有内存 ≤基线 60%」
> —— 原口径不可达（WebView2 空白页地板就有 150.9 MB 私有 / 337.3 MB 工作集），理由见 `docs/baseline.md` §4。
>
> **S8 追加（2026-09-26）**：「页面侧私有内存」这条口径本身出了问题 —— S8 实测显示它的赤字**全部集中在 GPU 进程的
> 非驻留提交**上（renderer 进程反而从 61.8 MB 降到 45.8 MB、工作集也降了 19.8 MB），而 GPU 提交量对
> 「页面吃多少内存」不敏感、还会被驱动的分配策略放大。**建议改判为「渲染器进程私有内存 ≤ 基线 60%」或
> 直接用工作集**；归因实验与两个候选口径的数字见 `docs/baseline.md` §4.1 与 `docs/S8-UI整合-实施记录.md` §4。
