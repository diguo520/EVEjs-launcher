# EvEJS 启动器（launcher）

EVE Online Neocom 风格一键启动器，基于《EveJS 启动器技术方案.md》实施。

## 新版 UI/UX

当前正式 renderer 已切换为 `eve-launcher.html` 原型，并通过 `launcher-bridge.js` 接入 Electron IPC。

已接入：

- 服务启停、一键启动/停止、实时日志
- 环境自检和初始化
- 真实账号、角色和删除预览
- 登录、改密
- 配置中心读写
- CPU、内存、磁盘、网络监控
- 窗口最小化、最大化和关闭

详细报告：`docs/Electron新版原型移植报告.md`

## 当前进度



| 阶段 | 内容                                        | 状态     |
| -- | ----------------------------------------- | ------ |
| 1  | Electron + Vite + React + TS 脚手架，窗口壳      | ✅ 完成   |
| 2  | EVE 风格 UI：Neocom 栏 + 星图背景 + 服务卡片 + 内嵌终端布局 | ✅ 完成   |
| 3  | 内嵌终端：node-pty + xterm.js 多 Tab（真实日志流）     | ✅ 完成   |
| 4  | 进程管理：环境自检 + 一键启停 + 端口探活 + 崩溃处理            | ✅ 完成   |
| 5  | 配置回写（EvEJSConfig.bat）、日志落盘                | ✅ 完成   |
| 6  | electron-builder 打包（portable + NSIS）      | ✅ portable 已出，含启动器自动更新；NSIS 待确认 |

当前已实现真实服务启停、环境自检看板（Node / Rust·Cargo / VS C++ 构建工具 / 依赖 / 数据库 / 市场二进制 / 客户端路径 / CA 证书，
未安装项提供「官网安装」跳转）、服务器端口与客户端配置只读展示、内嵌 xterm 终端（系统页签输出自检报告）、IPC 全链路骨架。

### 启动器自动更新

- 顶部更新入口、红点、更新弹窗、下载进度和错误状态
- 默认从 GitHub Latest Release 检查更新，可通过 `EVEJS_UPDATE_MANIFEST_URL`、`launcher-settings.json` 或便携版同目录 `launcher.config.json` 覆盖
- 启动约 5 秒后自动检查；保持运行期间每 30 分钟检查一次，窗口重新聚焦时也会刷新提示
- 更新日志优先读取 `release-notes/vX.Y.Z.json`，缺少专用文件时回退到上一个 Git 标签区间的提交记录
- 下载后校验 SHA256，由独立 `evejs-updater.exe` 等待启动器退出并替换当前便携版
- 替换前要求主服务器和市场服务已停止，失败保留 `.backup` 回滚

GitHub Release 发布流程位于 `.github/workflows/release.yml`。推送与 `package.json` 版本一致的 `v*` 标签后，会自动构建便携版并上传：

```text
EvEJS-Launcher-Portable-<version>.exe
update-manifest.json
```

默认更新清单地址：

```text
https://github.com/diguo520/EVEjs-launcher/releases/latest/download/update-manifest.json
```

## 任务视图（服务器日志）

* 左侧 Neocom「任务」图标 → 打开日志面板，读取 `server/logs/server.log`（UTF-8，最近 5000 行）
* 顶部显示文件路径 / 行数 / 大小 / 最后更新时间，可「刷新」重新读取
* 级别着色：红=ERR/FTL、黄=WRN、绿=SUC、灰=DBG，其余为默认色
* 文件不存在或为空时给出明确提示

## 环境自检看板

* 布局：右侧常驻分栏（分栏模式），启动即显示，无需弹出
* 支持「重新检测」；未安装 Node.js / Rust / VS Build Tools 时，对应项显示 FAIL 并提供「官网安装」按钮（跳转官方下载页）
* 环境要求：Node.js ≥ 24、Rust 工具链（rustc + cargo）、VS C++ 构建工具（构建市场服务用）、Windows 10 1809+

## 环境要求



* Node.js ≥ 24（开发机）；目标机器运行时需 Node + 已有服务运行环境

* Windows 10 1809+（ConPTY 原生支持，Phase 3 生效）

## 开发



```
npm install          # 安装依赖（npmmirror 镜像）

npm run dev          # Vite HMR + Electron 开发模式

npm run build        # 编译主进程(tsc) + 渲染层(vite)

npm start            # 构建后启动 Electron

npm run smoke        # 构建 + 冒烟测试（窗口加载后 3s 自动退出）

npm run build:updater    # 编译 Go 独立更新器

npm run package:portable # 构建并生成 Windows x64 便携版
```

## 目录结构



```
launcher/

├── package.json / electron-builder.yml / vite.config.ts

├── tsconfig.json            # 渲染层

├── tsconfig.main.json       # 主进程 + preload

├── src/

│   ├── main/                # Electron 主进程

│   │   ├── index.ts         # 窗口 / 单实例 / 冒烟

│   │   ├── processManager.ts# 服务状态机（Phase 3/4 接入真实启停）

│   │   ├── ptyManager.ts    # node-pty 封装（ConPTY，缺失时降级 spawn）

│   │   ├── healthChecker.ts # 端口/HTTP 探活

│   │   ├── envDetector.ts   # 环境自检（含 repoRoot 解析）

│   │   ├── configStore.ts   # config/server.json + EvEJSConfig.bat 读写

│   │   ├── ipc.ts           # ipcMain 注册

│   │   └── logger.ts        # 日志落盘 \_local/logs/launcher.log

│   ├── preload/index.ts     # contextBridge 安全桥

│   └── renderer/            # 新版 HTML UI + React 兼容界面

├── updater/                 # 独立更新器（Go）

└── assets/                  # 图标和原型资源
```

## 仓库根目录解析

启动器自动向上寻找含 `server/autostart.js` 的目录；也可在启动器目录放

`launcher.config.json` 覆盖：



```
{ "repoRoot": "E:/Games/EveJS-v0.12.8" }
```

## 说明



* 环境自检为只读操作，不会启动服务。

* node-pty 为 optionalDependencies，缺失时自动降级为 spawn 管道透传。
