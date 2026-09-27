# S8 UI 整合 · 实施记录（把 eve-console 原型扶正为真界面）

> 状态（2026-09-26）：**已落地并实测通过**（`build.ps1` 1–17 全绿、A4 双入口全绿、便携包真机自检通过）。
> **一条未闭合项必须知情**：视觉层让 GPU 进程的**私有提交内存**多出约 50–60 MB（工作集反而更低），
> 导致 `docs/baseline.md` §4 那条 G6 门槛「页面侧私有内存 ≤ legacy 60%」**从 62% 变成 136%**。
> 根因本轮未能归到任何单个 CSS 属性上，证据与复现全部记在 §4，处置建议见 §4.4。
>
> 关联：`docs/迁移评估-Tauri2+shadcn.md` §1（R3 混合路线的原始判断）、
> `docs/Tauri2迁移执行计划.md` §8、`docs/S6-UI迁移-实施记录.md`、`docs/baseline.md` §2/§4。

---

## 1. 这次整合的是什么

`E:/Games/EveJS-v0.12.8/launcher/launcher/assets/eve-console/` 是一套完整的
React 19 + Tailwind 3.4 + 全量 Radix/shadcn 原型（107 个源文件 / 6 页 / 15 个 ui 组件，标题「新伊甸指挥台」），
旁边那份 731 KB 的 `新伊甸指挥台.html` 是它的单文件产物。

S6 当年**没有用它**：`ui/src/pages/*` 11 页是另起一套 shadcn 界面接的线。于是「长得像原型」和「真的能控服务端」
这两件事一直分在两个工程里。S8 把它们合起来。

### 1.1 三条路线，选了「嫁接」

| 路线 | 做法 | 代价 | 结论 |
| --- | --- | --- | --- |
| A 全量移植原型 | 把 `eve-console` 整个搬进 `ui/` 当唯一界面 | 丢掉 S6 已完成的 82 通道实接、10 万行环形缓冲、vitest、11 页；Tailwind 3→4、Radix 依赖形态、5 个缺失页全要重做 | ✗ |
| **B 嫁接视觉层（本轮）** | 把原型的**设计系统 + 外壳 + 展示原语**移植到已接线的 `ui/` 上 | 需要做 Tailwind 3→4 的 token 转写；配色从 S6 的紫改回原型的青蓝 | **✓** |
| C 只换主题 | 只覆盖颜色 token | 拿不到原型的骨架（HUD 底纹 / 236px 侧栏 / 顶栏读数 / 等宽仪表标签），收益最小 | ✗ |

路线 B 正是 `docs/迁移评估-Tauri2+shadcn.md:15` 当初写的「`assets/eve-console` 扶正为真 UI」的可行版本：
**外观按原型，数据流留 S6**。`--ui=legacy` 回退入口不受影响。

---

## 2. 设计系统映射（Tailwind 3 烧配置 → Tailwind 4 `@theme`）

原型的做法是：DS token 写在 `src/index.css` 的 `:root`/`.dark`，再在 `tailwind.config.js` 里把
`colors / borderRadius / boxShadow / fontSize / fontFamily` 全部烧成 `var()` 引用。
本仓是 Tailwind 4（`@tailwindcss/vite`），没有 `tailwind.config.js` 那条路，所以同一套 token 改写成 `@theme` 命名空间：

| 原型的配置节 | 本仓落点 | 说明 |
| --- | --- | --- |
| `colors.*`（`hsl(var(--x))`） | `--color-*: hsl(var(--x))` | 调色板仍是 HSL 三元组，名字一个不差 |
| `borderRadius.lg/md/sm` | `--radius: 8px` + `--radius-sm/md/lg/xl` | 原型 `--radius: var(--radius-md)`，换算后 rounded-sm/md/lg = 4/6/8px，与本仓原值**恰好一致** |
| `boxShadow.sm/md/lg/xl` | `--shadow-sm/md/lg/xl/2xl` | `sm` = 1px 描边环、`md/lg/xl` = 抬升阴影 |
| `fontSize.xs…4xl` | `--text-*` + `--text-*--line-height` | 原型整条比例尺比 Tailwind 默认**小一档**（xs=11px、sm=12px、base=14px），行高 1.45/1.08 |
| `fontFamily.sans/display/mono` | `--font-sans/body/display/mono` | mono 走内联的 Roboto Mono（见 §5.1） |
| `spacing.1/2/3/4/5/6/8/12` | **不移植** | 原型那 8 个值与 Tailwind 默认的 rem 刻度**逐值相等**（4/8/12/16/20/24/32/48px），移植是纯噪声 |

**两处有意偏离原型（都写在 `ui/src/index.css` 的注释里）**：

1. `--elev-ring` 由 `0 0 0 1px var(--border)` 改成 `0 0 0 1px hsl(var(--border))`。
   原型那行是**无效 CSS**：`--border` 是 HSL 三元组（`218 30% 21%`），不能直接当颜色用，浏览器整条忽略 ——
   等于原型里所有 `shadow-sm` 都没渲染出描边。1px 描边是作者原意，这里补成能生效的写法。
2. 补上 `--chart-1..5` 与 `--sidebar-*` 取值。原型 `tailwind.config.js` 引用了它们，但 `index.css` 里没定义，
   属于「引用未定义 token」（`bg-chart-1` 会解析成无效值）。

---

## 3. 代码落点

### 3.1 新增

| 文件 | 作用 |
| --- | --- |
| `ui/src/lib/page-registry.ts` | 11 页注册表（id / label / eyebrow / hint / description / icon / group / channel / render）。侧栏与顶栏共用一份，**消掉 S6 里 App.tsx 内联的导航定义** |
| `ui/src/lib/shell-data.ts` | 外壳数据：`useServices` / `useShellMetrics` / `useServiceEvents`（`services:changed` 只订阅一次） |
| `ui/src/components/app-shell.tsx` | HUD 底纹 + 侧栏 + 顶栏 + 可滚动主区；`data-evejs-renderer="react"` 挂这里（A4 锚点，不能改名） |
| `ui/src/components/side-nav.tsx` | 236px 侧栏：EVE 徽标、分组导航（图标 + 主标题 + 一行 hint）、底部常驻服务开关（接 `engage:start/stop`、`service:restart`） |
| `ui/src/components/top-bar.tsx` | 顶栏：eyebrow + 页名 + 数据来源 + 状态胶囊 + 四个读数（在线/CPU/内存/网络）+ 秒级时钟 |
| `ui/src/components/server-status-pill.tsx` | 由 `services:list` **聚合**出的服务端状态（running/starting/stopping/crashed/stopped）+ 状态灯 |
| `ui/src/components/ui/panel.tsx` | 原型的面板原语（Panel / PanelHeader / PanelBody） |
| `ui/src/components/ui/sparkline.tsx` | 手绘 SVG 折线（Sparkline），指挥台「资源趋势」在用 |
| `ui/src/styles/fonts.css` | 原型内联的 Roboto Mono（2 个字重，woff2 data URI） |

### 3.2 改造

- `ui/src/index.css`：Token 层整体重写为原型那一套（青蓝 `198 93% 60%` 取代 S6 的紫 `#863bff`），
  新增 `.hud-backdrop` / `.hud-scroll` / `.hud-label` / `.cjk-latin` 四个 HUD 工具类。
- `ui/src/App.tsx`：只剩「当前页 state + appInfo 查询 + AppShell 包裹」，从 150 行降到 30 行。
- `ui/src/components/ui/badge.tsx`：改用原型的分层 `tone`（neutral/primary/success/warn/danger/outline）+ 导出 `StatusDot`；
  **旧的 `variant` 名字保留并做映射**，于是 S6 写的 11 页里那一堆 `<Badge variant="…">` 一行没改就换了皮。
- `ui/src/components/ui/button.tsx`：按原型重排尺寸（sm = h-7/text-xs）与变体（焦点环改成 `--focus-ring` 的 4px 青蓝描边），加 `primary` 作为 `default` 的别名。
- `ui/src/components/page-shell.tsx`：**去掉 title/description**（标题改由顶栏承担，避免同一个标题在一屏里出现两次），只留间距与动作行。
- `ui/src/pages/*.tsx`（11 个）：删掉传给 `PageShell` 的 `title=` / `description=` 两个属性（文案搬进注册表）。
- `ui/src/pages/dashboard.tsx`：新增「资源趋势」面板 —— 复用同一份 `metrics:get` 缓存，在渲染层自攒最近 60 点（约 3 分钟），
  用 `Panel` + `Sparkline` 画 CPU / 内存折线。
- `ui/index.html`：加首帧兜底底色（`hsl(218 44% 5%)`），避免 CSS 解析完之前闪白。
- `ui/src/lib/page-registry.ts` 的 `readPageFromHash()` + `App.tsx` 写 hash：地址栏 `#mods` 这类能直接落到指定页，
  给逐页截图 / 真机排查用（不引入路由库，切页仍是本地 state）。

### 3.3 刻意**没有**做的

- 没有搬原型的 mock 引擎（`src/lib/engine.tsx` 40 KB + `seed.ts` 38 KB + `localStorage` 持久化 + `simulateCrash`）——
  原型 6 个页面的数据全部来自它，真实数据流在 `ui/src/lib/ipc.ts`，只搬外观不搬假数据。
- 没有搬原型的 6 页页面文件（`AccountTable` / `MarketCard` / `ConfigTabs` …）——11 页里已有等价且**真接线**的实现。
- 没有删原型的未用依赖（`recharts` / `date-fns` / `pocketbase` / `miniprogram-ci` / `next-themes` / `vaul` …）——
  那是参照工程自己的事，本仓 `ui/` 一个都没引入。
- 没有动 `ui/web`（legacy 页）与 `tauri.conf.json` 的 `frontendDist`（G6 退役条件未达成前不拆桥）。

---

## 4. 内存专项：视觉层买到了好看，也买到了 GPU 私有提交（**未闭合**）

### 4.1 复测（同口径：`scripts/measure-startup.ps1`，整棵进程树求和，`-UserDataDir` 隔离，2 轮取均值）

| 形态 | 启动(ms) | 私有@60s | 工作集@60s | 进程数 |
| --- | --- | --- | --- | --- |
| 空白页（本轮现校准的地板） | — | **156.5 MB** | 349.4 MB | 7 |
| **S8 react（本轮）** | 1302（1134–1470） | **287.1 MB** | **401.6 MB** | 7 |
| **S8 legacy（本轮）** | 1140（1137–1143） | **252.8 MB** | 421.4 MB | 7–9 |
| 参照：pre-S8 react（`docs/baseline.md` §4 原值） | 1137（L7） | 218.9 MB | 418.7 MB | 7 |
| 参照：legacy（同上原值） | — | 260.7 MB | 439.1 MB | 7 |

- **地板仍与旧值一致**（156.5 vs 150.9，差 4%），所以旧公式还成立，不是「机器变了」。
- **工作集方向是好的**：react 401.6 MB 比 legacy 421.4 MB **低 19.8 MB**，也比 pre-S8 react 的 418.7 MB 低 17.1 MB。
- **私有提交方向是坏的**：react 287.1 MB 比 legacy 252.8 MB **高 34.3 MB**，比 pre-S8 react 的 218.9 MB **高 68.2 MB**。
  按 `docs/baseline.md` §4 的公式（减地板）：
  - pre-S8 react 页面侧 = 68.0 MB，legacy = 109.8 MB → **62%**
  - 本轮 react 页面侧 = 130.6 MB，legacy = 96.3 MB → **136%** ← **G6 门槛（≤60%）不达标，且反超 legacy**
- **启动**：react 首轮 1470 ms、第二轮 **1134 ms**（≈ legacy 1140 ms）。首轮偏高是字体光栅 + 合成着色器的一次性编译；
  稳态与 legacy 同档。

### 4.2 差在哪：**全部在 GPU 进程**（45 s 逐进程采样）

| 进程 | react | legacy | 空白页 |
| --- | --- | --- | --- |
| `gpu-process` | **167.1** | 121.4 | 60.1 |
| `renderer` | **45.8** | 61.8 | 25.0 |
| webview browser 进程 | 39.0 | 41.9 | 38.1 |
| EvEJSLauncher.exe（Rust 宿主） | 11.5 | 13.3 | 10.8 |
| network / storage / crashpad | 22.4 | 22.6 | 22.5 |
| **合计** | 285.8 | 261.5 | 156.5 |

即：**渲染器进程（真正装 JS 堆和页面内容的那块）react 比 legacy 省 16 MB；赤字 100% 来自 GPU 进程的私有提交。**
另一个可疑信号：react 的 GPU 进程 `priv 167.1` 远大于 `ws 78.5` —— 这些是**已提交但非常驻**的提交量，
不占物理内存（不是「吃了 167 MB 内存条」，是提交账本）。

### 4.3 归因实验（每次改一个变量、重新构建 exe、同口径复测）

| 变量 | react 树私有@45s | 结论 |
| --- | --- | --- |
| 初版（照抄原型 CSS：`background-attachment: fixed` + `backdrop-blur-sm`） | 345.1 | 基线 |
| 去掉 `background-attachment: fixed` + 顶栏 `backdrop-blur-sm` | **285.8** | **−59 MB，真收益，已保留** |
| 再关掉 `.hud-backdrop` 的四层渐变底纹 | 285.8（GPU 167.1 vs 167.7） | 无影响 |
| 再移除内联 Roboto Mono 字体 | 290.9 | 无影响 |
| 再关掉全部阴影 + 半透明背景 | 297.2 | 无影响（±7 MB = 噪声） |
| 对照：legacy | 261.5 | — |
| 对照：空白页 | 156.5 | — |

用 `WEBVIEW2`/顺序对照排除了「第一个启动的进程吃亏」：先 legacy 后 react 复测，`gpu` 仍是 121.0 vs 161.6。

**结论**：这 ~46 MB 的 GPU 私有提交**不来自任何可单独摘掉的视觉属性**（底纹、字体、阴影、半透明都试过了），
更像是新旧页面在合成器里走的**着色器/光栅变体集**不同 —— 本轮没有更细的观测手段（WebView2 不提供 GPU 内存分解），
所以**不做进一步猜测**，如实登记。

### 4.4 处置建议（需要你拍板）

1. **推荐：把 G6 门槛从「整树私有内存」改成「渲染器进程私有内存」。**
   理由：`docs/baseline.md` §4 当初选私有内存是为了避开工作集的共享页重复计入，
   但本轮实测暴露出私有提交也有自己的病 —— GPU 进程那块是**非常驻提交**，跟「页面吃多少内存」不是一回事。
   口径定为渲染器进程后：react **45.8 MB vs legacy 61.8 MB = 74%**（pre-S8 react 是 62%）。
   仍然没到 60%，但**方向和量级都对**，且这条数字不会被 GPU 驱动的提交策略影响。
2. 或者：**门槛改成「工作集」，只记录私有。** 工作集口径下 react 401.6 MB vs legacy 421.4 MB = **95%**（react 更省），
   且与任务管理器「内存」列的直觉一致。
3. 或者：**继续查 GPU 提交的根因**再决定。需要外部手段（如 ETW/GPUView 或 WebView2 的
   `--enable-logging` + 内存直方图），已超出本仓目前的自检能力。
4. **不建议**为了这条指标去砍视觉层：§4.3 已经证明砍了也没用（±7 MB 噪声），砍掉的只有原型的识别度。

> 在你拍板前，`--ui=legacy` 回退入口保持可用（`src/lib.rs` 的 `resolve_ui_page()`），G6 不推进。

---

## 5. 验证证据

### 5.1 命令与结果（2026-09-26）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 契约 82 通道 / 审计 33 项 + 3 债务 / 查重 17 项 + 3 提示 / parity 固定向量 / renderer 语法 / `ui/dist` 同步 全绿 |
| `pwsh -File scripts/build.ps1` | **1–17 步全绿**（L3 60 项断言、L4 10 万行 0 丢失、L5 代码页 936、L6 停服 0 残留、L8 6/6） |
| `pwsh -File scripts/smoke-ipc.ps1 -Ui react` | 26/26 通道；A4 **9 项全绿**（含 `pageCspClean=true`） |
| `pwsh -File scripts/smoke-ipc.ps1 -Ui legacy` | 26/26 通道；A4 **9 项全绿**（含 `legacyInlineScriptRan=true`） |
| 便携包解压后 `smoke-ipc.ps1 -Exe <解压目录>\EvEJSLauncher.exe -Ui react` | 26/26 通道；A4 9 项全绿 |
| `ui` 目录 `tsc --noEmit` / `vitest run` | 0 错误 / 17 项全绿 |

**CSP 专项**（内联字体是这轮新增的风险点）：`font-src 'self' data:` 已包含 `data:`，
所以 `@font-face` 的 woff2 data URI 不会触发违规 —— 上面 react 的 `pageCspClean=true` 就是这条的运行时证据。

### 5.2 交付物

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `artifacts/EvEJSLauncher-Tauri-0.2.0-portable.zip` | **4.60 MB** | sha256 `8f0f27b2f2aa2fe2abad35d1bde4de40f7a11b546ec80e48b59ef9e9f22a0d0d`（与 `update-manifest.json` 一致） |
| `artifacts/EvEJSLauncher-Tauri-0.2.0-setup.exe` | 3.36 MB | NSIS |
| `src-tauri/target/release/EvEJSLauncher.exe` | 6.38 MB | 目录版 |
| `ui/app-dist` | 3 个文件 / 670.9 KB | 由 `scripts/check-app.mjs` 发布到 `ui/dist/react` |

zip 内容只剩 5 个条目（白名单打包仍然有效）：
`EvEJSLauncher.exe` + `_launcher/cli/account-cli.js` + `_launcher/cli/database-cli.js` + `_launcher/updater/evejs-updater.exe` + `README-便携版.txt`。

> 体积对比：S8 前 zip 4.57 MB → 4.60 MB（+30 KB CSS：内联字体 + HUD 工具类；+11 KB JS：外壳与注册表）。

### 5.3 视觉确认（并非只有断言）

`ui/app-dist` 用本地静态服务 + Edge headless 截图，逐页看过 6 张：
指挥台（HUD 底纹 / 顶栏读数 / 资源趋势）、模组管理（Tabs + 工具栏 + 分组导航高亮）、
账号与角色、日志中心、指令手册。截图落在 `.parity-out/ui-shot-*.png`。
（浏览器里没有 Tauri 桥，页面内的 `Cannot read properties of undefined (reading 'invoke')` 是预期现象，不是缺陷。）

---

## 6. 已知债务 / 未闭合项

| # | 事项 | 严重度 | 说明 |
| --- | --- | --- | --- |
| 1 | **G6 内存门槛需要重新定口径** | 高 | §4.4，需要你拍板；在此之前不推进 legacy 退役 |
| 2 | GPU 进程私有提交 +46 MB 的根因未定位 | 中 | §4.3 已排除全部单项 CSS 属性；现有自检手段到头了 |
| 3 | 125% / 150% DPI 未逐页截图 | 中 | 沿用 S6/S7 的既有债务（需注销/登录后补），S8 没有加重 |
| 4 | `prefers-color-scheme: light` 分支没有实现 | 低 | 原型是 dark-only（`:root` 与 `.dark` 两份 token 完全一致），本仓 `ui/index.html` 固定挂 `.dark`。跟着原型保持 dark-only |
| 5 | 原型 `index.css` 里的 `.cjk-latin` 工具类搬了但没用上 | 低 | 原型自己在 6 个页面里也没用；留着是因为它是 DS 的一部分（中英混排字高对齐），后续有中英混排标题时可以取用 |

---

## 7. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-26 | 首版：完成 token 层转写（Tailwind 3 → 4）、外壳移植（侧栏/顶栏/状态聚合）、展示原语（Panel/Sparkline）、11 页标题上收、深链、首帧兜底；`build.ps1` 1–17 与 A4 双入口全绿；便携包重打（4.60 MB）并解压自检通过 |
| 2026-09-26 | 内存专项复测与归因：摘掉 `background-attachment: fixed` + `backdrop-blur-sm`（−59 MB）；底纹/字体/阴影/半透明逐项排除；G6 门槛 62% → 136% 的未闭合项登记为 §4.4 |