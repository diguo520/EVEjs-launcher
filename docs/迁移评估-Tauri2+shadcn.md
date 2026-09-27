# 迁移评估：Tauri 2 + shadcn/ui 桌面组件

> 日期：2026-09-25
> 配套文档：`docs/框架迁移方案.md`（我方）与桌面《EveJS 启动器换框架迁移方案.md》（评审团）
> 结论对象：是否在 Tauri 2 外壳之上，用 shadcn/ui 把 UI 重写为 React

---

## 0. 结论

**技术路线可行，且推荐；但"一步到位"不推荐。**

- **推荐形态**：Tauri 2（Rust 后端直译）+ **双轨 UI** —— 外壳与后端按评审文档 P1–P4 推进，
  前端**先保留现有 `eve-launcher.html`（零重写）拿到体积/启动/内存收益**，再按页把
  `assets/eve-console`（shadcn 原型）扶正为真 UI，最后退役 HTML。
- **原因**：评审文档的整份成本估算都建立在「前端零重写」这一前提上；改用 shadcn 意味着
  这条前提作废，**必须重新定价**（后端 3–5 周不变，UI 追加 6–9 周）。
- **一步到位的代价**：单人 10–14 周，且大爆炸式重写一个已发到 v0.1.28、模组生态在跑的成品，
  P5 之前无法交付任何可回滚版本。
- **仍然值得做**：shadcn 路线顺带满足评审文档 A4（严格 CSP、无内联脚本——文档称其为
  "体积与启动收益最大的一项"），并把 2,333 行命令式 DOM 换成类型安全组件，长期维护成本显著下降。

---

## 1. 三个必须先对齐的事实

### 1.1 新文件夹是空的，源永远在游戏目录

`E:\AI projects\ChatGPT\evejs-launcher` 目前只有一个 `docs/`（本方案 + 迁移方案），**不是 git 仓库**，
不含任何启动器代码。你要移植的源始终是：

```text
E:\Games\EveJS-v0.12.8\launcher\launcher     （Electron 33，v0.1.28，有完整 git 历史）
```

现状无需担心"我忘了"：已核对到的实况是——82 个 IPC 通道、主进程 7,986 行 TS / 19 个模块、
生产入口 `dist/renderer/eve-launcher.html`（4,468 行）+ `launcher-bridge.js`（2,333 行）、
Go 独立更新器、版本节奏 8 项/版（`release-notes/pending.json` 当前 0/8，nextVersion `0.1.29`），
git 上到 `739f827 release: v0.1.28 已安装详情只在作者本人模组上显示签名`。

### 1.2 `assets/eve-console` 是一个 **mock 原型**，不是可接线的成品

它确实是完整的 shadcn 工程（`components.json`：style=default、baseColor=slate、cssVariables=true，
Tailwind 3.4 + React 19 + 全量 Radix + cmdk + sonner + recharts + react-resizable-panels +
react-router-dom，107 个源文件 ≈ 1.8 MB），六个页面：指挥台 / 宇宙参数 / 账号与角色 / 日志中心 /
存档与备份 / 模组管理。

但它在 `src/lib/engine.tsx`（40 KB）里用 `setInterval` 造了一个**模拟服务端**，
数据来自 `seed.ts`（38 KB 假数据），进度落在 `localStorage`，还带 `simulateCrash()`。
全仓 `src` 内**没有任何** `window.api` / `ipcRenderer` / PocketBase 引用——
也就是说：**视觉与交互完成度高，后端接线 0%**。它的依赖里 `pocketbase`、`miniprogram-ci` 属未用项。

### 1.3 shadcn 路线与评审文档的核心前提正面冲突

| 评审文档的承重假设 | shadcn 路线下是否成立 |
| --- | --- |
| 「前端零重写，790 KB HTML + 114 KB bridge + 29.6 KB CSS 整体搬入」 | **不成立**，改为全量重写 |
| 「唯一必须新写的前端代码：约 150 行 `webview-shim.ts`」 | **不成立**，变为 82 通道接线 + 5 个缺失页面 |
| 「React 层是死重，直接删除（P1）」 | **反转**，React 成为主界面，死重改为旧 `src/renderer/*.tsx` |
| P3「后端直译 3–5 周」 | **仍成立**（后端与 UI 无关） |

---

## 2. 能力覆盖对照（真实启动器 vs shadcn 原型）

| 功能域 | 真实启动器 v0.1.28 | eve-console 原型 | 迁移缺口 |
| --- | --- | --- | --- |
| 服务控制台 | `service:*` / `engage:*` / `metrics:get`（CPU / GPU / 虚拟内存 / 网络 / 磁盘）/ 在线人数 | 指挥台：ControlDeck + MetricStrip + PresencePanel + BootSequence（模拟） | 真实数据接线 |
| 日志中心 | `log:read`（server.log 尾 5,000 行）+ PTY 实时流 + 模块/级别过滤 | 日志中心：LiveLogPanel（假日志池） | 真实 PTY 流 + 10 万行虚拟化 |
| 账号与角色 | `accounts:*`（增删改密 / 校验 / GM / **角色直登 exefile**） | 账号与角色：表 + 批量操作 + 授权弹窗 | 直登链路 + 真实 SQLite |
| 存档与备份 | `database:backup/backups/restore`（`__backup/databackup`） | 存档与备份：时间线 + 快照 + 进度 | 真实落盘与回滚 |
| 模组管理 | `mods:*` 25 个通道（验签 / 冲突 / 加载顺序 / ZIP 导入 / 脚手架 / 提交 / GitHub / 市场） | 模组管理：25 KB 页面 + 20 个组件 | 全部后端接线 + 签名信任链 |
| 宇宙参数 / 配置 | `config:*`（server.json + EvEJSConfig.bat）、`settings:*` | 宇宙参数：参数面板 + 影响评估 | 真实读写；差分/影响需重新定义语义 |
| 指令手册 | 5.3 MB `manual.html` + 2.8 MB `items_map.json` 指令补全 | **无** | 全新 |
| 数据库管理 | `database:*` 8 通道（表浏览 / 行编辑 / 结构 / SQL 预览） | **无** | 全新 |
| 环境自检 / 初始化 | `env:check` / `init:run` / `init:state`（npm ci、cargo build、CA） | **无**（BootSequence 只是动画） | 全新 |
| 自动更新 | `update:*` 4 通道 + Go 更新器 | **无** | 全新（Go 侧沿用） |
| 窗口 / 应用外壳 | `window:*`、`app:info`、`shell:openExternal` | TopBar + ServerStatusPill | 需自绘标题栏（含无边框拖拽） |
| 客户端角色直登 | `accounts:launch`（`DETACHED_PROCESS｜CREATE_NEW_PROCESS_GROUP`） | **无** | 全新，且是评审文档 B8 历史故障点 |

**一句话**：原型覆盖约 55% 的信息架构，但每个已覆盖页面都仍是 mock；另有 5 个功能域完全没有页面。

---

## 3. 三条路线的取舍

| | **R1 保留 EVE HTML**（评审文档原方案） | **R2 Tauri 2 + shadcn 全量重写** | **R3 混合（推荐）** |
| --- | --- | --- | --- |
| UI 迁移量 | 0（+≈150 行 `window.api` shim） | 100%（6 页接线 + 5 页新建 + 标题栏） | 先 0，后按页替换 |
| 首版可用时间（单人） | 4–6 周达体积/启动/内存指标 | 10–14 周 | 4–6 周达指标，再 +6–9 周完成 UI |
| 体积 / 冷启动 / 内存 | ≤10 MB / ≤1.5 s / ≤90 MB | 同左 +250–400 KB gz、+100–300 ms、+20–50 MB | 同左 |
| 严格 CSP / 无内联脚本（A4） | 需额外改造 HTML 才达成 | 天然达成 | 天然达成（React 侧） |
| 维护性 | 手写 DOM 命令式，改一处动全文件 | TS 组件化 + 类型安全 + 可测试 | 过渡期两套，末期收敛到 React |
| 高风险项 | 少 | 大爆炸、缺页、10 万行日志未验证 | 逐页可回滚 |
| 老用户升级（A5） | 需双轨 manifest | 同 | 同 |

### 3.1 为什么推荐 R3 而不是 R2

1. **指标收益与 UI 无关**：体积、冷启动、内存的改善全部来自「换外壳 + 后端直译」。
   先把这部分做完，就能在 4–6 周内拿到可验收、可回滚的产物，而不是等 3 个月。
2. **shadcn 原型的最大缺口是状态层，不是外观**：`engine.tsx` + `seed.ts` 共 78 KB 的模拟引擎
   要换成真实通道。这部分工作无论何时做都存在，**放在外壳已稳定之后做，才有稳定契约可依**。
3. **可并存，无技术障碍**：Vite 多页构建（`launcher.html` 纯静态 + `console.html` React），
   Tauri 内两个入口共用同一份 Rust 侧 `window.api`；导航切换时整页替换，两套 UI 不共享 DOM，
   天然避免命令式 DOM 与 React 打架。
4. **风险顺序正确**：先解决"能否达标"，再解决"是否好看好维护"。

### 3.2 如果坚持 R2（一步到位），必须接受

- 单人 **10–14 周** 才有首个可交付版本，期间旧 Electron 版仍需维护（双轨成本不可避免）。
- 需要先冻结契约（82 通道的返回形状清单）——评审文档 §8 已把这列为未覆盖项。
- 需要补齐 5 个全新页面（指令手册 5.3 MB、数据库管理、环境自检/初始化、更新器、角色直登）。
- 必须为 10 万行日志吞吐写压测（评审文档 §7 的硬门槛），React 侧方案见 §5.3。

---

## 4. 工期与验收指标修正

**工期（单人）**

| 阶段 | R3 混合 | R2 一步到位 |
| --- | --- | --- |
| P0 测量埋点 + P1 零风险瘦身（评审文档 P0/P1） | 1–1.5 周 | 1–1.5 周 |
| P2 双轨 spike（Tauri 加载现有 HTML + 通道回包） | 1–2 周 | 1–2 周 |
| P3 后端直译（评审文档 3–5 周） | 3–5 周 | 3–5 周 |
| P4 打包 / 更新双轨 | 1–2 周 | 1–2 周 |
| U1 通道契约层（Rust ↔ React hooks，82 通道） | +0.5–1 周 | 0.5–1 周 |
| U2 已有 6 页接线（去掉 mock，接真数据与动作） | +2–3 周 | 2–3 周 |
| U3 缺失 5 页新建（手册 / 数据库 / 自检 / 更新 / 直登） | +1.5–2.5 周 | 1.5–2.5 周 |
| U4 日志与终端吞吐（虚拟化 + 命令式缓冲 + 压测） | +0.5–1 周 | 0.5–1 周 |
| U5 视觉回归（shadcn slate + 紫色主色 → EVE 主题 token） | +0.5–1 周 | 0.5–1 周 |
| **合计** | **约 11–17 周（UI 可与后端并行，实际 8–12 周）** | **约 10–14 周** |

**指标修正**（沿用评审文档 §7，另加 UI 专项）

| 指标 | 阈值 | 备注 |
| --- | --- | --- |
| 安装包（portable） | ≤10 MB（P5） | shadcn 路线需额外容纳 ≈250–400 KB gz 的 JS、内联字体（`index.css` 里已内嵌 woff2） |
| 冷启动到可交互 | ≤1.5 s（相对基线改善 ≥30%） | React 侧再留 100–300 ms 预算 |
| 常驻内存（静止 60 s） | ≤基线 60%（量级 ≤90 MB） | React 堆开销 +20–50 MB，需在预算内 |
| 首屏可交互（TTI） | ≤1.2 s | **新增**：不含数据刷新的纯渲染 |
| 日志吞吐 | 10 万行无丢行、无 >500 ms 卡顿 | 硬门槛，React 必须虚拟化 |
| 通道兼容 | 82/82 冒烟通过 | 与 UI 方案无关 |
| 升级 / 回滚成功率 | ≥99.5% / **100%** | 硬门槛 |

---

## 5. 技术要点（shadcn 在 Tauri 里的落地）

### 5.1 契约层是唯一新增的"界面 API"

Rust 侧注册 82 个 command，渲染侧只暴露一份 `window.api`：

- legacy 页：沿用现有 ≈150 行 shim，`ipcRenderer.invoke` → `invoke`，**HTML 与 bridge 零改动**。
- React 页：新增 `src/lib/ipc.ts`，把 `invoke` 包成类型化函数，再用 `@tanstack/react-query`
  统一缓存/失效（原型现在缺这一层，`engine.tsx` 的模拟状态机正是要替换掉的东西）。
- 事件方向（`terminal:data` / `services:changed` / `init:changed` / `update:changed` /
  `mod:downloadProgress`）统一走 Tauri `Channel`，两套 UI 用同一份订阅封装。

### 5.2 双轨切换机制

Vite 多页构建产出两个入口，Tauri 内整页切换（不共享 DOM，命令式与声明式不会互踩）：

```text
ui/launcher.html   ← 现有 EVE HTML（P2–P4 阶段的主界面，继续原样复用）
ui/console.html    ← eve-console（shadcn，逐页扶正）
```

冻结策略：**新功能只进 React 侧，旧 HTML 只修 bug**，避免双轨漂移把工期吃掉。

### 5.3 高频日志与终端：不要用 React state 承载 PTY 流

评审文档把「10 万行无丢行、无 >500 ms 卡顿」列为硬门槛。落地要点：

- 环形缓冲（上限 10 万行）放在 React 之外，用 `useSyncExternalStore` 暴露快照；
- 渲染走虚拟滚动（`@tanstack/react-virtual` 或 `react-window`），只挂载可视行；
- 单队列 + `requestAnimationFrame` 合帧，禁止每行一次 `setState`；
- 高频段落可直接用 ref 管理 DOM（沿用现有 bridge 的做法），React 只管壳与工具栏。

### 5.4 桌面外壳

shadcn 只提供 Web 组件，**不含桌面窗口能力**：无边框、标题栏拖拽、最小化/最大化/关闭、
多显示器 DPI 仍需在 Tauri 侧做（`decorations:false` + `data-tauri-drag-region`），
并保留现有 `window:minimize/toggleMaximize/close` 三通道语义。

### 5.5 依赖与版本冻结

- 保留项目现有 **Tailwind 3.4 + React 19**（不要同时追 Tailwind 4 / shadcn 新默认，避免组件重写一遍）。
- 清理未用依赖：`pocketbase`、`miniprogram-ci`（体积与供应链）。
- `index.css` 已内联 Roboto Mono woff2（37 KB），迁移时评估是否保留。
- `HashRouter` 正确（Tauri 自定义协议下最稳），保持。

### 5.6 顺带修掉的安全项（评审文档 A4/B3/B5）

| 项 | shadcn 路线下的处理 |
| --- | --- |
| A4 无 CSP / 内联脚本 / sandbox false | React 构建天然外置脚本 → 可上严格 CSP（禁 `unsafe-inline`）；Tauri 侧 `withGlobalTauri:false` + 仅注册白名单 command |
| B3 未校验 `event.senderFrame` | Tauri command 无 Electron 的 senderFrame 概念，改为「按窗口标签校验 + 拒绝未知 webview」 |
| B5 密码经 argv 暴露 | `accounts:*` 改为 stdin/临时文件传参；`execFile("node")` 裸名改绝对路径 |

---

## 6. 风险与前置条件

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `engine.tsx` + `seed.ts`（78 KB）模拟语义与真实通道不对齐 | UI 接线返工 | 先冻结 82 通道返回形状清单（评审文档 §8 未覆盖项），再动 React |
| 大爆炸重写已上线产品 | v0.1.28 之后长期无可交付版本 | 走 R3 双轨，逐页替换 |
| 10 万行日志未压测 | 迁移后卡顿 | 先写压测（假流 10 万行），再定虚拟化方案 |
| 双轨 UI 漂移 | 改动做两遍 | 冻结策略：新功能只进 React |
| `author.ts` / `persist.ts` 依赖 localStorage | 作者私钥（Ed25519）落在浏览器存储，与 `.eve-key` 语义冲突 | 私钥必须留在 Rust 侧加密文件（DPAPI），React 只拿公钥与指纹 |
| 视觉方向未定 | U5 反复 | 先决策：保留 EVE Neocom，还是转 shadcn 暗色科幻（原型现为 slate + 紫 `#863bff`） |
| 5.3 MB 手册 | React 侧渲染方案 | 决定 iframe 复用 vs 转 Markdown，二选一后再排期 |
| 供应链面变大（107 文件 + 全量 Radix） | 审计与打包体积 | 只保留实际使用的 shadcn 组件，删未用 Radix 包 |

---

## 7. 下一步（建议顺序）

1. **P0 测量**：按评审文档在 5 个点打时间戳 + 内存口径，冻结基线。**没有基线不得进入 P1**。
2. **冻结契约**：产出 82 通道的返回形状清单（这是 React 接线的唯一依据）。
3. **建骨架**：在 `E:\AI projects\ChatGPT\evejs-launcher` 建 Tauri 2 工程 + Vite 多页
   （`launcher.html` 复用现有 EVE HTML、`console.html` 挂 eve-console），先做 P2 spike：
   验证「HTML 零改动能跑通 + React 壳能并排切换 + 终端事件通道对齐」。
4. **决策视觉与版本**：EVE 主题 or shadcn 暗色科幻；Tailwind 3.4 / React 19 冻结。
5. **回答评审文档 §8 的 6 个问题**（最低 Windows 版本、是否接受 WebView2、`eve-console` 是否在交付范围、
   是否保留 Node 生态、升级通道要求、体积/启动硬指标）。

---

## 8. 专项：shadcn 的"桌面组件"到底给了什么

### 8.1 先破一个误解

shadcn/ui **没有**官方"桌面组件"包。它是一套 **React + Radix + Tailwind** 的**源码级组件**
（`npx shadcn add ...` 把组件拷进你的仓库，你拥有源码），能力边界仍是 Web：

| 桌面能力 | shadcn 是否提供 | 本项目的承担方 |
| --- | --- | --- |
| 无边框窗口 / 拖拽区 / 最小化·最大化·关闭 | 否 | Tauri `decorations:false` + `data-tauri-drag-region` + 自绘 TopBar |
| Win11 Snap Layouts（悬停最大化键的窗口布局） | 否 | 需原生命中测试（`WM_NCHITTEST` / `HTMAXBUTTON`），Tauri 默认不给 |
| 窗口位置/尺寸持久化、多屏 DPI | 否 | Rust 侧复刻现有 `saveWindowBounds` 语义 |
| 托盘、原生菜单、单实例锁 | 否 | `tauri-plugin-tray` / `menu` / `single-instance` |
| 文件·目录选择、打开外部链接、系统通知 | 否 | `tauri-plugin-dialog` / `opener` / `notification` |
| 面板、弹窗、表格、标签页、抽屉、提示、命令面板 | **是** | shadcn（按需拷贝） |

**所以"用 shadcn 桌面组件"实际等于：shadcn 出面板与弹窗，Tauri 出窗口与系统集成。**

### 8.2 原型现状对照（`assets/eve-console`）

已有 **15 个** `src/components/ui/*`：badge / button / checkbox / dialog / dropdown / input /
panel / rating / select / slider / sparkline / switch / table / tabs / tooltip，
外层是 `AppShell = SideNav + TopBar + main`，并有 `hud-backdrop` / `hud-scroll` / `hud-label`
这层自定义 HUD 主题（在 shadcn token 之上）。

**缺失、且真实启动器用得上的**（shadcn 按需拷贝，成本 10 分钟–半天/个）：

| 缺失组件 | 对应真实功能 |
| --- | --- |
| AlertDialog | 危险操作确认：删账号、删数据行、恢复备份、卸载模组 |
| ContextMenu | 账号 / 模组 / 数据库行的右键菜单 |
| Command（`cmdk` 依赖已装） | 指令手册补全 + 全局命令面板 |
| Progress | 模组下载、更新下载进度（`mod:downloadProgress` / `update:*`） |
| Resizable（`react-resizable-panels` 已装） | 终端与日志的分栏布局 |
| ScrollArea | 日志虚拟滚动容器 |
| Sheet / Drawer（`vaul` 已装） | 终端抽屉、模组详情侧栏 |
| Skeleton / Popover / RadioGroup / Separator / Breadcrumb | 加载态、指标详情、表单与导航 |
| **DataTable（TanStack Table）** | **数据库浏览/排序/分页/行编辑**（`database:table` 8 通道），成本 1–2 天，是唯一的"重活" |

### 8.3 桌面外壳缺口与工期

| 项 | 工期 | 备注 |
| --- | --- | --- |
| 无边框标题栏 + 拖拽 + 三按钮（替代现有 `window:*` 3 通道） | 0.5–1 天 | 社区有 shadcn 风格的窗口控件组件可直接改 |
| 窗口位置持久化 + 多屏 | 0.5 天 | 复刻现有 `saveWindowBounds` |
| Win11 Snap Layouts | 0.5–1 天 | **唯一有坑项**；不做也不影响基本使用 |
| 托盘 / 原生菜单 / 单实例 | 0.5 天 | Tauri 官方插件 |
| 目录选择、打开文件夹、系统通知 | 0.5 天 | 对应 `mods:openFolder` / `saveText` / `shell:openExternal` |
| 高 DPI 与缩放回归 | 0.5 天 | 截图对照 |

**合计 3–5 天。** 相对第 3 节 R2 的 10–14 周，shadcn 这块能"省"的只有约 3–5 天的交互原语成本——
**成本大头（82 通道接线、5 个缺失页面、日志吞吐、视觉回归）不受影响**。

### 8.4 由此得到的执行口径

1. 布局别自造：直接用现有 `AppShell / SideNav / TopBar` 与 `hud-*` 主题层，缺的组件按需 `shadcn add`。
2. 桌面能力一律走 Tauri 官方插件 + 少量窗口控件组件，**不要试图用 shadcn 补**。
3. 视觉不要直接用 slate 默认真皮：原型是 slate + 紫 `#863bff`，与现有 EVE Neocom 不一致，
   先决策保留哪一套（`index.css` 37 KB 含内联 woff2 字体，注意体积预算）。
4. 结论不变：走第 3 节 **R3 混合**，shadcn 侧从「指挥台 + 日志中心」两页开始接真数据。
