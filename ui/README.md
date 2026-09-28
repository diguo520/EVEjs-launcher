# EVEJS COMMAND · 启动器

EveJS（EVE 私服）的本地启动器界面：一台深色指挥台，把服务启停、环境自检、服务器日志、账号与角色、指令手册、数据库、模组市场、配置中心收在八个页面里。

**纯前端，所有数据都是本地模拟**，没有任何后端依赖 —— 可以直接当成真启动器（Electron / Tauri / 浏览器壳）的渲染层接着做。

## 跑起来

需要 Node 20+（开发用的是 22）。

```bash
npm install          # 或 pnpm install，锁文件是 pnpm-lock.yaml
npm run dev          # http://localhost:5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # 预览构建产物
npx tsc --noEmit -p tsconfig.app.json   # 只做类型检查
```

## 技术栈

Vite 8 · React 19 · TypeScript 6 · Tailwind CSS 3.4（class 深色模式，只做深色）· 手写 shadcn/ui（radix 原语 + cva + tailwind-merge）· lucide-react 图标 · sonner 提示。

**没有路由**：`src/App.tsx` 里用 `useState<ViewId>` + `switch` 切页。跨页共享的状态（服务与日志、环境自检、账号与角色、启动器版本）都提升到 `App.tsx`，以 props 或 context 往下发；页面组件卸载即丢本地状态，所以「要等几秒」的流程（例如到游戏里建号）状态必须挂在外壳上。

## 目录

```
src/
  App.tsx            外壳：顶栏 / 侧栏 / 内容区 / 状态栏 + 全部跨页状态
  pages/             八个页面，一页一个文件
  components/
    shell/           外壳：顶栏、侧栏、状态栏、自更新入口与更新弹窗
    dashboard/       主控台：服务卡片、环境自检、资源读数、日志尾巴
    accounts/        账号与角色：账号卡、角色槽、新建账号
    commands/        指令手册：指令全表、筛选、QA 装备、常用指令
    console/         服务器日志：级别筛选、关键词、跟随
    database/        数据库：备份、恢复、导出
    modules/         模组市场：列表、详情、评论区、构建与安装任务
    config/          配置中心：服务端配置、客户端配置
    settings/        设置：常规、关于、危险操作
    common/          通用件：面板、区块标题、状态点、指标格
    ui/              手写的 shadcn/ui 组件
  lib/               纯逻辑与数据（不依赖 React，可单独测）
  hooks/             有状态的一层：定时器、流程编排、持久化
  data/              指令手册的静态 JSON（约 4MB）
```

## 数据都在哪（要接真后端先看这段）

界面里的数字**全部是模拟的**，集中在这几个文件，替换掉它们就等于接上了真启动器：

| 想改什么 | 改这里 |
| --- | --- |
| 服务列表、端口、PID、资源曲线 | `src/lib/mock.ts` 的 `SERVICES`、`src/hooks/use-launcher.ts` |
| 服务器日志的滚动与级别 | `src/hooks/use-launcher.ts`、`src/lib/log-logic.ts` |
| 环境自检的检查项与「服务端根目录」 | `src/lib/mock.ts` 的 `CHECK_ITEMS` / `SERVER_CONFIG`、`src/hooks/use-env-check.ts` |
| 账号与角色（校验、状态迁移、登录规则） | `src/lib/launcher-logic.ts`、`src/hooks/use-launcher-accounts.ts` |
| 启动器版本、更新通道 | `update:state` / `update:check`（`src/components/shell/launcher-version.tsx`）；浏览器里跑原型时退回 `src/lib/mock.ts` 的 `LAUNCHER_META` |
| 更新说明（这一版改了什么） | 清单 `update-manifest.json` 的 `changelog` → `update:check` 回包 → `src/lib/release-notes.ts` 分组；原型里的 `LAUNCHER_RELEASE.notes` 只在没有桥时兜底 |
| 模组市场：上架、评分、安装任务 | `src/lib/mod-logic.ts`、`src/hooks/use-mod-downloads.ts` |
| 指令手册 / 物品 / NPC 数据 | `src/data/*.json`（由 `scripts/build-manual-data.mjs` 从手册 HTML 生成） |
| 数据库备份列表 | `src/lib/mock.ts`、`src/components/database/` |

账号与角色是唯一有持久化的部分：写在浏览器 `localStorage` 的 `evejs_launcher_accounts` 键下，读写与迁移都在 `src/hooks/use-launcher-accounts.ts`（换真数据库时只替换这一层即可，`launcher-logic.ts` 里的纯函数不用动）。

## 换成一个真启动器

界面不用重写，按这个顺序替换底层：

1. **起壳**：Electron / Tauri 起一个窗口，把 renderer 指向这份 Vite 工程（开发期 `npm run dev` 的地址，发布期 `dist/`）。
2. **服务启停**：`src/hooks/use-launcher.ts` 现在用定时器假装拉起服务；换成主进程 `child_process.spawn` / Tauri `Command`，把 stdout 转发给服务器日志页。
3. **环境自检**：`src/hooks/use-env-check.ts` 里的「检测」「修复」换成真实文件检查（`node_modules`、`market-service.exe`、CA 证书）与真实修复动作。自检项的文案与修复指引都在 `src/lib/mock.ts`。
4. **账号与角色**：把 `use-launcher-accounts.ts` 的 localStorage 换成主进程 / 本地 HTTP 服务；`src/lib/launcher-logic.ts` 的规则（每账号 3 个角色槽、同账号同时仅一个角色在线、角色只在游戏内创建）保持不动即可。
5. **自更新**：版本、下载进度、更新说明都走真通道（`update:state` / `update:check` / `update:download`）；
   更新通道的内置公钥没配之前检查一律 fail closed，弹窗会照实显示原因，不摆原型示例条目。
6. **外网数据**：这份界面没有联网取数，所以不需要代理配置。

## 设计系统

深空指挥台：海军蓝画布 + 青色信号 + 琥珀遥测，低光高信息密度。

- 颜色 token 全部在 `src/index.css`（CSS 变量，形如 `hsl(var(--primary))`），组件里只用 token，不写死色值。
- 字号只用 10 / 11 / 12 / 13 / 14 / 18px；数字一律加 `tabular`（等宽 + 对齐）。
- 圆角 ≤ 6px，不加阴影发光，靠描边与底色分层。
- 面板、区块标题、指标格、微标签这些共用件在 `src/components/common/`，新页面直接复用。

## 打包源码包

```bash
node scripts/pack-source.mjs          # → public/evejs-command-src.zip
```

打包脚本会排除 `node_modules`、`dist`、`logs`、`.rh`、以及打包产物自身；需要系统里有 `zip` 或 `python3`。界面里「设置 → 关于 → 下载源码包」指向的就是这个文件。
