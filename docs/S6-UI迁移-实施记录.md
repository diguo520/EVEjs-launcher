# S6 UI 迁移 · 实施记录（U0–U4 落地 + U5 部分）

> 本轮范围：**U0 + U1**（脚手架、shadcn 组件、类型化 IPC 层、门禁接线）。U2–U5 未开始。
> 前序：`docs/S5-测试-实施记录.md`；总计划：`docs/Tauri2迁移执行计划.md` §8。

## 1. 落位与三条不变量

S6 的 React 应用直接落在 **`ui/`**（Vite root = `ui/`），源码在 `ui/src/`，产物出到 **`ui/app-dist/`**。
这样放的理由与三条不变量有关：

1. **legacy 页面必须继续可用**：`src-tauri/tauri.conf.json` 的 `frontendDist` 仍是 `../ui/dist`（`ui/web` 的镜像），
   退役条件见计划 §8 G6（「连续 2 个版本无仅 HTML 侧可用的功能」）。本轮**没有动**它。
2. **`npm run check` 必须保持零依赖**：那条链是 6 个纯 node 脚本 + `ui/dist` 同步检查，CI 注释明确写了「不需要 npm ci」。
   新应用需要 `ui/node_modules`，所以它的门禁单独一条（`npm run check:app`），不并入 `check`。
3. **`ui/src` 已是渲染层源码目录**：`scripts/gen-contract.mjs` 生成的 `ui/src/api-shim.generated.ts` 本来就在这里，
   且它 `import` 的 `@tauri-apps/api` 只能从 `ui/node_modules` 解析 —— 应用落在 `ui/` 才不需要复制一份生成物（避免双份 shim）。

## 2. 交付物

```
ui/
  index.html                      # Vite 入口（无内联脚本，满足 CSP script-src self）
  vite.config.ts                  # root=ui/，base=./，outDir=app-dist，@ -> src
  tsconfig.json                   # TS7：**没有 baseUrl**，paths 用相对写法
  components.json                 # shadcn 配置（style new-york / baseColor slate / cssVariables）
  package.json + package-lock.json
  src/
    index.css                     # Tailwind v4 + 主题 token（slate 底 + 现役紫 #863bff 作 primary/ring）
    api-shim.generated.ts         # 既有生成物（单一来源：contract/ipc-channels.json）
    lib/ipc.ts                    # U1：类型化 ipc() + useIpcQuery/useIpcMutation + 事件 subscribe/useLauncherEvent
    lib/types.ts                  # U1：结果类型登记表 IpcResults（按 Rust JSON 构造点手写）
    lib/utils.ts                  # cn()
    components/data-table.tsx     # DataTable（TanStack Table v8 + shadcn Table）
    components/ui/*.tsx           # 21 个 shadcn 组件（button/card/table/dialog/sheet/command/...）
    pages/self-check.tsx          # 唯一实接页：env:check + services:list + services:changed
    pages/placeholder.tsx         # 其余 10 页的占位（写明所属子阶段，避免「看起来做完了」）
    App.tsx                       # 壳层：11 页导航 + app:info 版本/仓库信息
    main.tsx                      # QueryClientProvider + TooltipProvider + Toaster
scripts/check-app.mjs             # 新门禁：typecheck + build（退出码 2 = 未安装依赖）
```

## 3. 门禁接线（4 处）

| 位置 | 内容 |
| --- | --- |
| 安全审计 | 新增 **A6** 规则：`ui/src/**/*.{ts,tsx}` 不得出现 `eval(` / `new Function(` / `dangerouslySetInnerHTML` / `.innerHTML=` / `document.write(` / `window.__TAURI__` / `__TAURI_INTERNALS__` 私有通道。只覆盖新渲染层，legacy `ui/web` 不纳入（待退役页面，历史上有大量 `innerHTML`） |
| 根 `package.json` | `ui:app:install` / `ui:app:dev` / `ui:app:typecheck` / `ui:app:build` / `check:app` |
| `scripts/build.ps1` | 新增**第 13 步**「S6 应用（Vite+React）类型检查 + 打包」（`-SkipApp` 可关；未安装 `ui/node_modules` 时跳过并提示，因为该产物尚未接入 `frontendDist`） |
| `.github/workflows/ci.yml` | 新增 `4b) S6 应用`（先 `npm run ui:app:install` 再 `npm run check:app`）；node 从 20 提到 **22**（Vite 8 要求 `^20.19 || >=22.12`） |

## 4. 实测证据（2026-09-26）

```
npx tsc --noEmit --listFiles   → 本仓库 31 个文件参与编译，0 错误（不是空跑：已列出受检文件）
npm --prefix ui run build      → 2054 模块，app-dist/index.html 0.41 KB + CSS 52.7 KB + JS 458.2 KB（gzip 140.5 KB）
npm run check:app              → typecheck 0.9 s + build 1.6 s 全过
npm run check                  → 契约 82/82 · 版本一致 · 安全 33 项(+3 债务) · 查重 17 项(+3 提示) · 固定向量 · 渲染 4 脚本 · ui/dist 15 资产
pwsh -File scripts/build.ps1   → 第 1–13 步全绿（新增的第 13 步：typecheck 0.9 s + build 1.6 s）
```

## 5. 本轮踩到 / 发现的 8 条

| # | 发现 | 处置 |
| --- | --- | --- |
| 1 | **shadcn CLI 把 `@/lib/utils` 解析成了 npm 包 `cn`**（21 个组件全 `import { cn } from "cn"`，还顺手装了 `cn` 与 `next-themes`） | 批量改回 `from "@/lib/utils"`，`sonner.tsx` 去掉 `next-themes`（应用固定 dark，不做主题切换），两个包卸载 |
| 2 | **TypeScript 7 移除了 `baseUrl`**（TS5102） | tsconfig 删除 `baseUrl`，`paths` 改相对写法 `{"@/*": ["./src/*"]}` |
| 3 | **TanStack Table v9 换了 API**（`useTable` / `createTableHook`，不再是 `useReactTable`），与 shadcn 官方 data-table recipe 不一致 | 钉 `@tanstack/react-table@^8.21.3`，登记「升 v9」为债务 |
| 4 | **Tailwind v4 把 legacy 资产也当类名来源扫**：`ui/web`（75k 行）+ `ui/dist`（10.97 MB，含 5.3 MB 手册）→ 单次构建 **28.5 s** | 在 `index.css` 里加 `@source not "../web" / "../dist" / "../app-dist" / "../../.parity-out"` → 构建 **1.8 s**（vite 本体 441 ms），CSS 也从 54.9 KB 降到 52.7 KB |
| 5 | **Rust 侧结果类型不是结构化类型**：`app:info`/`env:check`/`metrics:get` 等都是 `serde_json::json!` 内联值（`ipc/mod.rs:80/92/104`、`env.rs:279`），**没有可 `derive` 的结构体** → 计划 §8 U1 写的「ts-rs/specta 从 Rust 生成 TS 类型」在现状下无法直接做 | 改为「按 JSON 构造点手写 + 登记债务」：`IpcResults` 只登记页面真正用到的通道，未登记 = 编译期报错；U2 每页接线时用 golden 兜住字段 |
| 6 | **CSP 里两处 `unsafe-inline` 是 legacy 页面的债**：`script-src-attr`（165 处内联事件属性）与 `style-src`（200 处内联 style 属性） | 换 React 后可删这两条 —— 这是 S6 的安全收益（审计 A4 的两条债务由本阶段关闭） |
| 7 | **A4 渲染隔离断言是 legacy 专用**（`legacyInlineScriptRan` / `inlineScriptBlocked` / `shimInjected` / `noGlobalTauri` / `cspViolationReported` / `eventRoundTrip`，见 `scripts/smoke-ipc.ps1`） | cutover（G6）前必须做一套 React 等价断言，否则「换页」会让 A4 直接失效 —— 已登记债务 |
| 8 | **本轮产物尚未接入运行时**：`frontendDist` 仍是 `ui/dist`，所以 `ui/app-dist` 里的 React 界面**还没在真实 WebView2 里跑过**（`ui/app-dist` 也已在 `.gitignore` 里） | U2 第一个试点页 cutover 时做真机验证（届时一并处理 7 的断言改造） |

## 6. 债务（按优先级）

| # | 债务 | 关闭时机 |
| --- | --- | --- |
| 1 | 结果类型靠手写（见 §5 #5），与 Rust 侧的漂移只能靠 golden 兜 | 两条路选一：① 把 `json!` 内联值重构成 `#[derive(Serialize, TS)]` 的结构体；② 保持 `json!` 但写「构造点 ↔ TS 接口」的字段级 golden 比对 |
| 2 | A4 的 React 等价断言（见 §5 #7） | U2 首个页面 cutover 前 |
| 3 | `@tanstack/react-table` v9 迁移（`useTable` 新 API） | U2 接线模组/数据库页时再评估，避免与 shadcn recipe 分叉 |
| 4 | 21 个 shadcn 组件里目前只有 button/card/badge/table/skeleton/scroll-area/separator/tooltip/sonner 被真正用到；剩下 12 个（dialog/sheet/command/resizable/…）**没有任何调用点** | U2/U3 接线时用起来；若某个到 U3 结束仍无用，删掉（避免「装了就是用了」） |
| 5 | `ui/package-lock.json` + `ui/node_modules` 目前只在本机；CI 步骤尚未在真实 runner 上跑过（沿用 S4 债务） | 首次 push 后校准 |

## 7. 与「内存极少」目标的关系（诚实版）

> **2026-09-26 续：U2/U3 已把 11 页全部实接，内存有真实变化 —— 见 §11.4 与 §13。**
> 本节记录的是 U0/U1 当时的结论（那时 `frontendDist` 还是那份 10.97 MB 的 legacy 页面，
> 两个渲染层渲染的是同一份东西，所以「换外壳」没有省下任何内存）。

内存真正会掉的点仍按 `docs/baseline.md` §4：三个大 JSON（`items_map.json` 2.79 MB / `npcs_data.json` 1.17 MB /
`templates_data.json` 0.97 MB）改按需加载、5.35 MB 手册懒加载、终端虚拟化 —— 这些都要等 U2/U3/U4 把页面搬进 React 之后才谈得上。

## 8. 下一步（U2 试点页）

1. 选一个「只读 + 无副作用」的页面做首个 cutover 试点（建议**环境自检**，本轮已经实接：`env:check` + `services:list` + `services:changed`）；
2. cutover 方式：`tauri.conf.json` 的 `frontendDist` 指向 `ui/app-dist` 之前，先做「双入口」——保留 legacy 页，React 页作为可选入口（例如 `?ui=react`），真机跑一遍；
3. 补 A4 的 React 等价断言（债务 #2），再切 `frontendDist`；
4. 然后按 U2 表逐页接线（指挥台 → 模组管理 → 账号与角色 → 存档与备份 → 宇宙参数 → 日志中心）。

## 9. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-26 | S6 起步（U0+U1）：React 应用落在 `ui/`（Vite+Tailwind v4+shadcn 21 组件），类型化 IPC 层（`ipc()`/`useIpcQuery`/`useLauncherEvent` + `IpcResults` 登记表）与 DataTable 落地；环境自检页实接 `env:check`/`services:list`/`services:changed`，其余 10 页占位；门禁接 4 处（A6 安全规则、`check:app`、`build.ps1` 第 13 步、CI `4b` + node 22）；发现 8 条（见 §5），其中 Tailwind 扫描面把构建从 28.5 s 压到 1.8 s |


---

## 10. 双入口（cutover 机制）

**为什么不直接改 `frontendDist`**：G6 的退役条件是「连续 2 个版本无仅 HTML 侧可用的功能」，
在那之前 legacy 页必须**同时**可用；而 `frontendDist` 是静态配置，两个目录只能二选一。
于是让 React 产物以**子目录**形式住进同一个 `frontendDist`：

```
ui/dist/                     ← frontendDist（未改）
├── eve-launcher.html        ← legacy 页（原样，含 165 处内联事件、200 处内联 style）
└── react/index.html         ← check-app.mjs 构建后发布过来的 React 产物（约 640 KB）
```

| 环节 | 落点 | 说明 |
| --- | --- | --- |
| 产物发布 | `scripts/check-app.mjs` 末尾 `fs.cpSync(app-dist → dist/react)` | 构建完自动发布，不需要第二条命令 |
| 选择入口 | `src-tauri/src/lib.rs`：`resolve_ui_page()` 解析 `--ui=react|legacy` | 默认 React；非法值**弹系统对话框**提示后回落（B4 禁止生产代码 println） |
| 窗口装载 | `WebviewUrl::App(page.into())` | 同一个 exe、同一份 dist，切换只改启动参数 |
| 回退 | `EvEJSLauncher.exe --ui=legacy` | 零构建成本 |

代价：dist 里多一份 React 产物；收益：切换与回退都是「改一个参数」，G6 到期前不会拆桥。

## 11. U2/U3：11 页全部实接

| 页 | 接的通道（摘要） |
| --- | --- |
| 指挥台 | `services:list` + `service:start/stop/restart` + `engage:start/stop` + `metrics:get`(3 s) + `health:check`(10 s) + `services:changed` |
| 日志中心 | `terminal:data`（环形缓冲）+ `log:read`(5 s) + `terminal:input` |
| 账号与角色 | `accounts:list/create/delete/setPassword/launch` |
| 角色直登 | `accounts:launch` + `login:start` |
| 存档与备份 | `database:backups/backup/restore` |
| 宇宙参数 | `config:get/setClient/setRepoRoot/repairClientDisplay` + `app:info` |
| 模组管理 | 25 条 `mods:*`（已安装 / 注入计划 / 市场 / 模板 / 我的作品 五个页签） |
| 数据库管理 | `database:overview/table`（动态列，原生表渲染） |
| 环境自检与初始化 | `env:check` + `init:state/run`（deps/db/market/client/ca 五个键）+ `shell:openExternal` + `init:changed` |
| 更新器 | `update:state/check/download/apply` + `update:cancel`(send) + `update:changed` |
| 指令手册 | 手册 iframe **点开才加载** + `items_map.json` **首次搜索才 fetch** + `mods:authoringDocText` |

配套：`lib/types.ts` 扩到约 60 个接口 + `IpcResults` 登记表（未登记的通道 tsc 直接报错），
`lib/ipc.ts` 增加 `TypedSend`/`ipcSend()`（send 类通道）与 `refetchInterval`；
`main.tsx` 在 render 前调 `ensureTerminalStore()`，把 PTY 订阅与 React 树解耦（切页不丢输出）。

### 11.4 内存：真实测量（诚实版）

| 形态 | 私有内存 @60 s | 工作集 @60 s | 说明 |
| --- | --- | --- | --- |
| 空白页（只有外壳 + WebView2） | **150.9 MB** | 337.3 MB | 这是 Tauri + WebView2 的**地板**，任何页面都跑不掉 |
| React 全 11 页 | 见 `docs/baseline.md` §4（本轮实测） | 同左 | |
| legacy 页 | 260.7 MB | 439.1 MB | 现役实现 |

**结论：原计划的「稳态 ≤150 MB」不可达** —— 150.9 MB 就是「什么都不显示」的成本。
新目标改为**「页面侧 ≤ legacy 的 60%」**（即页面自身开销从 110 MB 降到 ~66 MB），
口径与理由写在 `docs/baseline.md` §4。

## 12. U4 日志吞吐 + A4 断言改造

- 环形缓冲挪到 React 之外（`lib/log-buffer.ts`：10 万行、跨 chunk 半行拼接、单行 4096 封顶、
  快照身份稳定），`useSyncExternalStore` 取版本号快照 + 虚拟列表；
- L4 压测（10 万行 0 丢失、最大间隔 48 ms）见 `docs/S5-测试-实施记录.md` §10.1；
- **A4 断言改造（债务 #2 关闭）**：`ipc/smoke.rs` 的注入脚本新增「等渲染层挂载」
  （legacy 看 `window.t`，React 看 `[data-evejs-renderer='react']`，8 s 超时）与
  `security.pageCspClean`（页面自身 CSP 违规数 = 0）；`scripts/smoke-ipc.ps1` 加 `-Ui react|legacy`
  参数并按渲染层动态断言，summary 里带 `renderer` 字段。
- ⚠️ **2026-09-26 修正**：`pageCspClean` 原来的注册/摘除时序是错的（监听在挂载之后注册、探针之后才摘，
  于是探针自己那条 `script-src` 违规被算成页面违规）—— 这条断言**恒定为假**，等于没有门禁。
  已修为「挂载前注册 + 探针前摘掉结算 + 400 ms 静默期」，并把违规指令名带进 `summary.pageCspViolations`
  （红灯自证）。修完实测：`--ui=react`（默认入口）与 `--ui=legacy` **各九条 A4 断言全绿、26/26 通道回包**。
  细节见 `docs/S5-测试-实施记录.md` §10.8。

## 13. U5 视觉回归（现状）

- 主题：slate + 紫（`#863bff`）token 已覆盖到 shadcn 变量层，`hud-*` 组件族沿用；
- **已完成**：11 页在 100% 缩放下逐页截图评审（`a11y` 对比度、空态/错误态/加载态三态齐全）；
- **未完成**：**125% / 150% DPI** 的截图 —— 改 Windows 缩放（`HKCU\Control Panel\Desktop\LogPixels`）
  需要注销/重新登录才生效，本轮做不到（本机正是「等重启」的状态，见 `docs/baseline.md` §1.3）。
  已把可复跑的口径写进 `docs/S7-发布与回滚-实施记录.md` 的发布检查单：**重启后**按
  100% → 125% → 150% 各跑一遍逐页截图，重点看虚拟列表行高、`DataTable` 横向滚动、日志页等宽字体换行。

## 14. 前端单测（L1 前端侧）

`ui/` 引入 vitest（`ui/vitest.config.ts` 用 `mergeConfig` 复用 vite 配置，**生产打包不依赖测试包**），
首批 17 项：`ansi.ts` 8 项（含 L5 从真 ConPTY 抓到的字节向量）+ `log-buffer.ts` 9 项。
已接进 `npm run check:app`（顺序：`test` → `typecheck` → `build`）。覆盖率工具仍未接（债务 #4 剩余部分）。
| 2026-09-26 | S6 收口验收：`--ui=react`（默认）与 `--ui=legacy` 两个入口在真机自检里 **A4 九条断言全绿 + 26/26 通道回包**；修掉 `pageCspClean` 的恒定假断言（时序错误，见 §12 警示行）；exe 6.35 MB（含 React 产物，`ui/dist/react` 已随构建发布）；内存口径与体积口径回填 `docs/baseline.md` §2/§4 |
| 2026-09-26 | S6 续做（U2/U3/U4 + 双入口）：**11 页全部实接**（约 82 个请求通道里 76 个 invoke + 6 个 send 有了真实调用点），共享组件与 `IpcResults` 登记表补齐；`--ui=react|legacy` 双入口 + `check-app.mjs` 自动发布到 `ui/dist/react`；A4 断言按渲染层分支（债务 #2 关闭）；U4 环形缓冲移出 React 树；引入 vitest 17 项；内存实测推翻「≤150 MB」目标（空白页地板 150.9 MB），改判「页面侧 ≤ legacy 60%」，见 §11.4 与 `docs/baseline.md` §4 |
