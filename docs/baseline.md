# 基线数据（G0 / G1 实测）

> 测量时间：2026-09-25 22:00–22:06（Asia/Shanghai）；**S5/S6 复测 2026-09-26**
> 机器：本机（Windows，E: 盘）
> 脚本：`scripts/measure-startup.ps1`（启动 = CreateProcess → 主窗口出现；
> 内存 = 启动后 N 秒对**整棵进程树** WorkingSet64 / PrivateMemorySize64 求和）、`scripts/size-gate.mjs`
>
> ⚠️ **口径修正（2026-09-26，S4）**：本表里的**启动耗时偏乐观**。原判定用的是
> `Process.MainWindowHandle`，而 `tauri-plugin-single-instance` 会先创建自己的顶层窗口
> （标题 `com.evejs.launcher-siw`），于是 Tauri 那一行实际测的是「单实例插件建窗口」的时间。
> 修正后的脚本改为按标题精确匹配**可见主窗口**，Tauri 热启动实测为 **平均 1130 ms**
> （1091 / 1091 / 1207，打包产物）。详见 `docs/S4-打包-实施记录.md` §7。
> **内存与体积的结论不受影响**；Electron 那一行没有这个偏差（它没有单实例辅助窗口）。
>
> **S5 已按同口径重测**（2026-09-26，两边都挂同一个隔离 userdata，各 3 轮，见 §1.1）：
> 热启动 **Tauri 1137 ms vs Electron 963 ms** —— 旧表里「Tauri 快 1.7×」不成立；
> 内存 Tauri 417.7 MB vs Electron 445.8 MB（低 6.3%，量级同档）。**冷启动本轮未测**。
> 详见 `docs/S5-测试-实施记录.md` §4.3。
>
> **S6 收口（2026-09-26）**：最终交付形态定为 **Tauri 2 + React（shadcn）**，`--ui=react` 是默认入口，
> legacy 页保留为回退入口（G6 退役条件未达成）。内存与体积的**最终读数**见 §2 与 §4。

---

## 1. 启动耗时与常驻内存

| 外壳 | 冷启动(ms) | 热启动(ms) | 内存@10s(MB) | 内存@60s(MB) | 进程数 |
| --- | --- | --- | --- | --- | --- |
| Electron 33（现役 0.1.28） | 10806 | 1008（2 次：1087 / 930） | 389.8 | 397.8 | 4 |
| **Tauri 2（S1 新外壳）** | **644** | **584**（3 次：644 / 578 / 612） | 419 | 417 | 7 |

结论：

- **启动**：冷启动 10.8 s → **0.64 s（约 17×）**；热启动 1008 ms → 584 ms（约 1.7×）。
  冷启动差距主要来自 Electron 需要初始化 Chromium + Node 运行时，而 Tauri 只挂系统 WebView2。
- **内存**：这一项**没有改善**（417 MB vs 398 MB，约 +5%）。两者都是 Chromium 内核渲染同一个页面，
  且 WebView2 的进程模型更碎（7 个进程 vs Electron 4 个）。
  说明「内存极少」不能靠换外壳达成 —— 实测收口见 §4。

> 口径提示：WorkingSet64 会把共享页重复计入，绝对值偏大；这里只用**同脚本同口径的相对值**做对比。

### 1.1 S5 同口径重测（2026-09-26，**以本节为准**）

条件：修正后的 `measure-startup.ps1`（启动 = CreateProcess → 按标题匹配的**可见主窗口**；内存 = 整棵进程树
WorkingSet64，CIM 精确父子关系），两边都带 `-UserDataDir .parity-out/measure-userdata`（隔离运行时数据目录，
否则现役版会按真实用户设置自动拉起服务，实测出现过 1441 MB / 8 进程的脏数据），各 3 轮：

| 外壳 | 启动(ms) 平均（min–max） | 内存@10s | 内存@60s | 进程数 |
| --- | --- | --- | --- | --- |
| Electron 现役 0.1.24（`release/win-unpacked`，窗口标题 `EVEJS COMMAND // 启动器`） | **963**（911–1046） | 445.7 MB | 445.8 MB | 6 |
| Tauri 0.2.0（`src-tauri/target/release`） | **1137**（1081–1205） | 430.1 MB | 417.7 MB | 7 |

- **启动**：热启动 Tauri 慢约 174 ms（+18%），两者同档（都 ~1 s）。换外壳的收益在**冷启动**
  （现役版首次启动要解包 Chromium，S0 实测 10.8 s；Tauri 是解压即用的目录 + 系统 WebView2），
  但这一项本轮**没测**（需要重启或清空 standby list），登记在 `docs/S5-测试-实施记录.md` 债务 #3。
- **内存**：只低 6.3%，**没有达到「极少」**；两个外壳都在用 Chromium 内核渲染同一个 10.97 MB 页面，
  必须靠 §4 的页面瘦身。

### 1.2 三种交付形态（S5 续测，热缓存）

上面比的是「目录形态 vs 目录形态」。但**现役版用户实际双击的是便携单 exe**（NSIS 自解压到 %TEMP%），
这一段开销不在外壳框架里，却占了大头 —— 所以必须单独量出来（`measure-startup.ps1` 已支持
「主窗口属于子进程」的形态，否则便携版根本测不到窗口）：

| 形态 | 热启动(ms) | 内存@10s | 进程数 | 主窗口属于 |
| --- | --- | --- | --- | --- |
| **Tauri 2.0.0（zip 解压即用目录）** | **1137**（3 轮：1081–1205） | 430.1 MB | 7 | 自身进程 |
| Electron 0.1.24（目录版） | **963**（3 轮：911–1046） | 445.7 MB | 6 | 自身进程 |
| **Electron 0.1.24（便携单 exe）** | **≈10600**（单轮实测 10606 / 10635） | 403–418 MB | 7–9 | **解压后的子进程** |

**这才是「启动器启动非常慢」的真正来源**：现役便携单 exe 要先自解压 73 MB 才有窗口，热缓存下就要
**10.6 s**；Tauri 交付的是 zip 解压即用的目录，同一口径 **1.14 s** —— 约 **9.3×**。
（S0 记录的冷启动 10.8 s 就是这同一个形态，所以那一行其实一直是对的，被误读成了「Electron 冷启动很慢」。）

> 冷启动（重启后第一次）的正式数据由 `scripts/measure-cold-start.ps1` 采集，见 §1.3。

### 1.3 冷启动（**待重启后回填**，任务已武装）

```powershell
pwsh -File scripts/measure-cold-start.ps1 -RegisterAtLogon   # 注册一次性登录任务
# 重启 → 登录 → 约 3–5 分钟（会自动弹几次启动器窗口）→ 结果落在：
#   .parity-out/cold-start.json（机器可读）+ .parity-out/cold-start.md（markdown 表）
pwsh -File scripts/measure-cold-start.ps1 -Unregister        # 取消
```

重启后第 1 轮 = 冷，第 2/3 轮 = 热，三个形态各自成一条冷热曲线。

任务已于 2026-09-26 04:17 通过**交付前预检**并重新武装：`cold-start.cmd` 内建 4 级解释器兜底链
（本机没有 Program Files 版 pwsh，只有沙箱缓存里的 pwsh + Windows PowerShell 5.1），两个脚本补了
UTF-8 BOM 以兼容 5.1，`Get-UptimeSeconds` 显式处理了 5.1 下 `TickCount64` 取值为 `$null` 的静默陷阱；
预检共抓到 P1–P6 六个「重启空跑」缺陷并全部修掉，照任务真入口端到端实跑通过（三形态全部测到）。
细节见 `docs/S5-测试-实施记录.md` §4.4。

**S6 收口后重新武装（2026-09-26）**：测量对象里 Tauri 那一行是 `src-tauri/target/release/EvEJSLauncher.exe`
（即下面 §2 重打的 release 产物，含 legacy 页 + React 产物全套），所以**重打包后不需要改任务**，
重启后测到的就是最终交付形态。

未重启前的现场（2026-09-26 04:36 实测）：`LastBootUpTime = 2026-09-17 01:41:02`，开机时长约 13,135 分钟
（9.1 天），任务 `State=Ready`。此时脚本会把结果标成 `coldBoot: false` 并写警告 —— 只有重启后的第 1 轮
才会被判定为冷启动（P6：`uptimeMinutes` 一度写成秒，已修）。

---

## 2. 体积

| 产物 | 体积 |
| --- | --- |
| **Tauri 2 便携 zip（release，对外分发物）** | **4.42 MB** |
| **Tauri 2 exe（release，LTO + strip；`frontendDist` = `ui/dist` 全套）** | **6.35 MB** |
| ├─ 同一份源码、只嵌 legacy 页 | 6.19 MB |
| ├─ 同一份源码、只嵌 React 产物（`--ui=react` 的最小形态） | 4.81 MB |
| └─ 同一份源码、嵌空白页（外壳地板） | 4.68 MB |
| ui/dist 静态资产（含 5.3 MB 手册 + 4 个 JSON + React 产物） | 10.97 MB |
| Electron 对外分发便携版（0.1.24） | 72.95 MB |
| Electron `win-unpacked` 目录（含 Chromium） | 295.32 MB |

结论：

- 便携 zip 是现役对外便携版的 **6.1%（缩小 16.5 倍）**；exe 是 **8.7%**。
- **体积几乎全来自 legacy 页资产**：只嵌 React 产物时 exe 掉到 4.81 MB（-22%）。
  G6 退役 legacy 页之后，exe 会自然回到这一档 —— 这条是「退役」在体积上的量化收益。
- 口径说明：上表用 **MiB**（脚本输出的 `N2 MB` 即 1024 进制）。历史文档里的 `5.03 MB` 是
  早期一次 `frontendDist` 子集构建的读数，与当前 `6.35 MB` 不同源，**以本表为准**；
  `6.35 MB` 是 `size-gate.mjs` 在 S6 收口那次完整构建（`ui/dist` 含 legacy 页 + React 产物）里的读数。

### 2.1 S8 UI 整合后的复测（2026-09-26）

| 产物 | 体积 | 与 §2 的差 |
| --- | --- | --- |
| **便携 zip** | **4.60 MB** | +0.18 MB |
| **exe（release）** | **6.38 MB** | +0.03 MB |
| NSIS 安装包 | 3.36 MB | 持平 |
| `ui/app-dist`（React 产物，发布到 `ui/dist/react`） | 3 个文件 / 670.9 KB | +约 60 KB |

增量构成：`+30 KB CSS`（内联 Roboto Mono 字体 + HUD 工具类）；`+约 30 KB JS`（外壳/侧栏/顶栏/注册表）。
sha256 与 `update-manifest.json` 一致：`8f0f27b2f2aa2fe2abad35d1bde4de40f7a11b546ec80e48b59ef9e9f22a0d0d`。
明细见 `docs/S8-UI整合-实施记录.md` §5.2。

---
---

## 3. G1 门禁（S1 出口）

| 项 | 结果 |
| --- | --- |
| 静态契约校验 `node scripts/verify-contract.mjs` | 通过（shim 89 入口 / channels.rs 89 条 / 台账 26+56=82） |
| 渲染层语法预检 `node scripts/check-renderer.mjs` | 通过（4 个脚本） |
| Rust 单测 `cargo test --lib` | 20/20 通过 |
| `cargo clippy --all-targets -- -D warnings` | 无告警 |
| **运行时自检 `scripts/smoke-ipc.ps1`** | **70/70 通道有回包**（真实 WebView 端到端） |
| 实机截图 | 主控台 / 服务卡片 / 资源监控 / 日志面板均正常渲染 |

未纳入自动自检的 12 个写通道：`window:minimize/toggleMaximize/close`、`settings:set`、
`config:setRepoRoot/setClient/repairClientDisplay`、`service:start/stop/restart`、`engage:start/stop`
（有副作用，避免自检真的把服务拉起来）。契约上它们都在 `registry::HANDLED` 里，靠单测与人工验证。

---

## 4. 内存专项：结论与剩余空间（2026-09-26 实测收口）

三条原始诉求里，**「占用内存极少」不能靠换外壳达成** —— 本轮用三组同口径实测把它钉死
（`scripts/measure-startup.ps1`，整棵进程树求和，`-UserDataDir` 隔离运行时数据；三个 exe 是**同一份
Tauri 外壳**、只换编译期嵌入的页面，产物与数据落在 `.parity-out/memtest*/`）：

| 形态 | 私有内存 @60 s | 工作集 @60 s | 页面侧开销（减去地板） |
| --- | --- | --- | --- |
| 空白页（只有外壳 + WebView2） | **150.9 MB** | 337.3 MB | — |
| React 全 11 页（`--ui=react`） | **218.9 MB** | 418.7 MB | **68.0 MB** |
| legacy 页（现役实现） | **260.7 MB** | 439.1 MB | **109.8 MB** |

1. **150.9 MB 是地板**：`msedgewebview2.exe` 那 6 个子进程 + 主进程，什么都不显示也要这么多。
   所以计划里「稳态内存 ≤150 MB（比现役降 ≥60%）」**不可达** —— 不是优化不够，是 WebView2 的成本模型。
   这也说明「换框架」在内存上的全部收益就是：Electron 4 进程 → WebView2 7 进程，量级不变（§1.1 实测低 6.3%）。
2. **能赚的在页面侧**：React 页 68.0 MB vs legacy 109.8 MB = **62%**。
   计划原本写「页面侧 ≤60%」（`docs/S6-UI迁移-实施记录.md` §11.4），**当前 61.9%，差约 2 MB 未达标**，
   剩余路径见下。
3. **旧行动项里有两条是错的**（本轮查证后更正，避免继续按错误前提投入）：
   - `items_map.json`(2.79 MB) / `npcs_data.json`(1.17 MB) / `templates_data.json`(0.97 MB) / `qa_data.json`
     在 legacy 页**本来就是懒加载**（`ui/web/eve-launcher.html:3176 / 3301 / 3302 / 3303`，点开对应页签才 `fetch`）
     —— 这一项**没有空间可赚**；
   - 5.3 MB 的 `manual/manual.html` **不是 iframe**，legacy 页根本不加载它（只有 React 页是「点开才挂 iframe」）
     —— 「手册改按需」在 legacy 侧同样无空间可赚。

**剩余空间在哪**：legacy 页多出来的 ~110 MB 私有内存，来源是那份 789 KB 的 `eve-launcher.html` 里
**内联**的巨型数据与长寿命 DOM：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `const CMDS_DATA=[…]`（指令手册全量 · 8 语言） | `ui/web/eve-launcher.html:3007` | 随页面解析，**无法**懒加载 |
| `const TRANSLATE={…}`（全站 8 语言词条） | `ui/web/eve-launcher.html:1576` | 同上，且被大量长寿命闭包引用 |
| 单页巨 DOM + 165 处内联事件 + 200 处内联 style | 同上 | V8 堆与 render tree 常驻 |

**结论与门槛（取代旧「≤150 MB」）**：

| 指标 | 现役（Electron legacy） | 当前（Tauri + React） | 目标 |
| --- | --- | --- | --- |
| 页面侧私有内存 | 109.8 MB | 68.0 MB（62%） | **≤60%（即 ≤65.9 MB）** |
| 外壳地板 | （含在 445.8 MB 里） | 150.9 MB | 不设目标（WebView2 决定） |
| 稳态工作集 | 445.8 MB | 418.7 MB（94%） | 只记录，不作为 G6 门槛 |

> **为什么不再用「整树 WorkingSet」当门槛**：它把共享页重复计入（地板 337 MB vs 私有 151 MB），
> 放大噪声，而且对「页面瘦身」不敏感。**G6 改用「页面侧私有内存」**，口径写死在本节表格里；
> 复跑命令：`pwsh -File scripts/measure-startup.ps1 -Exe <exe> -UserDataDir <dir> -JsonOut <out>`
> （三个形态的 exe 用 `--ui=react` / `--ui=legacy` 区分，见 `docs/S6-UI迁移-实施记录.md` §11.4）。

### 4.1 S8 UI 整合后的复测（2026-09-26）：**本节门槛当前不达标，待重新定口径**

S8 把 `assets/eve-console` 原型的视觉层（HUD 底纹 / 236px 侧栏 / 顶栏读数 / 等宽仪表标签 / 收紧的字号比例尺）
嫁接到已接线的 11 页上之后，同口径（同脚本、`-UserDataDir` 隔离、2 轮均值）复测：

| 形态 | 私有@60s | 工作集@60s | 页面侧（减地板 156.5） |
| --- | --- | --- | --- |
| 空白页（本轮现校准的地板） | 156.5 MB | 349.4 MB | — |
| S8 react（`--ui=react`） | 287.1 MB | **401.6 MB** | 130.6 MB |
| S8 legacy（`--ui=legacy`） | 252.8 MB | 421.4 MB | 96.3 MB |
| §4 原值 react | 218.9 MB | 418.7 MB | 68.0 MB |
| §4 原值 legacy | 260.7 MB | 439.1 MB | 109.8 MB |

三条要点：

1. **地板仍与旧值一致**（156.5 vs 150.9，差 4%），所以这不是「机器变了」，是页面变了。
2. **工作集方向是好的**：react 401.6 MB 比 legacy 421.4 MB 低 19.8 MB，比 §4 原值也低 17.1 MB。
3. **私有提交方向是坏的**：react 反超 legacy 34.3 MB，页面侧 130.6 MB / 96.3 MB = **136%**（门槛 ≤60%）。
   逐进程拆开看，赤字 **100% 在 GPU 进程**（react 167.1 MB vs legacy 121.4 MB，空白页 60.1 MB），
   而真正装 JS 堆与页面内容的 **renderer 进程反而更省**（45.8 MB vs 61.8 MB）；
   GPU 进程的 `priv`（167.1）远大于 `ws`（78.5），属于**已提交但非常驻**的提交量。

**归因实验**（每次只改一个变量、重编 exe、同口径复测）已排除全部单项 CSS 属性：
摘掉 `background-attachment: fixed` + `backdrop-blur-sm` 是唯一真收益（−59 MB，已保留）；
关掉 HUD 底纹渐变、移除内联字体、关掉全部阴影与半透明背景**都是 ±7 MB 噪声**。

**处置建议**（需拍板，详见 `docs/S8-UI整合-实施记录.md` §4.4）：
把 G6 门槛从「整树私有内存」改成**「渲染器进程私有内存」**（react 45.8 MB vs legacy 61.8 MB = 74%），
或改成**工作集**（401.6 vs 421.4 = 95%，react 更省）；**不建议**为这条指标去砍视觉层 —— 实验已证明砍了没用。
在你拍板前 `--ui=legacy` 回退入口保持可用，G6 不推进。