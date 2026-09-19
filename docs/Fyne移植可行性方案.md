# EvEJS 启动器 Electron → Fyne 移植可行性方案

> 版本：v1.0（实施评审稿）  
> 日期：2026-09-19  
> 结论：**可行，但不建议一次性重写，应采用“核心能力先行、UI 同步重构、原型新功能分期落地”的并行迁移策略。**

本方案基于以下实际输入编写，而不是只依据概念稿：

- 原启动器：`launcher/launcher/`（Electron + React + TypeScript，v0.1.5）
- 新界面原型：`launcher/launcher/assets/evejs-launcher/eve-launcher.html`
- 现有 Fyne 原型：`launcher-fyne/`（Go 1.24.4 + Fyne v2.8.1）
- 豆包方案：`launcher/launcher/docs/Fyne-EVEJS重写方案.md`

---

## 1. 可行性结论

### 1.1 可以移植的部分

Fyne 能覆盖当前 Electron 启动器的绝大多数桌面端能力：

- 环境检测、配置读取与回写
- 主服务器、市场服务、游戏客户端的启停与状态机
- 端口与 HTTP 健康检查
- 多页签日志、日志级别着色
- 账号列表、头像、登录验证、改密、删除与备份
- 初始化任务：`npm ci`、数据库创建、Cargo 构建、客户端配置向导
- 单实例窗口、窗口尺寸、状态栏、深色主题、切角面板、LED、六边形头像
- 资源监控中的 CPU、内存、磁盘、网络 I/O

现有 `launcher-fyne` 已经验证了主题、切角面板、导航、服务卡片和主要视图布局可以运行，因此 UI 不是项目成立与否的关键阻塞点。

### 1.2 不能直接一比一照搬的部分

| 原实现 | Fyne 限制 | 建议 |
|---|---|---|
| CSS 星云、扫描线、模糊光晕 | 没有浏览器级滤镜和 CSS | 使用渐变、线条、半透明矩形做静态近似，不强求像素级复刻 |
| xterm.js 完整终端仿真 | Fyne 无内置终端控件 | P0 先实现多页签日志 + 内部命令；需要真实交互终端时再做 ConPTY 专项 |
| HTML iframe 手册 | Fyne 不渲染 HTML | 把手册数据转成 JSON/Markdown 渲染；HTML 仅保留“外部打开”兜底 |
| CSS 3D 翻转登录卡 | 无 CSS 3D 变换 | 用宽度收拢、换面、展开的 Fyne 动画模拟 |
| 浏览器 `localStorage` | 无 Web Storage | 改为启动器自己的 JSON 设置文件 |
| Web GPU 指标 | gopsutil 不提供通用 GPU 使用率 | P0 暂不展示或显示“不支持”，不要继续使用随机演示值 |

### 1.3 迁移原则

1. **旧启动器不删除。** Fyne 版本达到 P0 验收前，Electron 版继续作为可用回退。
2. **先保持契约，再替换 UI。** 优先复用 `account-cli.js`、`Play.bat`、`EvEJSConfig.bat`、`config/server.json` 和现有服务端协议。
3. **原型中的数字不要照搬。** HTML 里的在线人数、CPU、GPU、磁盘、Ping、数据库 QPS 等多为演示数据。
4. **先做 Windows 正确性，再做视觉相似度。** 进程退出、路径解析、账号写库和自动登录优先级高于动画。
5. **所有耗时操作不得阻塞 Fyne UI 线程。** Go goroutine 负责工作，UI 更新统一通过 `fyne.Do`。

---

## 2. 现状盘点

### 2.1 Electron 主进程能力

| 模块 | 责任 | Fyne 迁移策略 |
|---|---|---|
| `main/index.ts` | 窗口、单实例、生命周期、IPC、退出清理 | 用 Fyne 窗口 + Windows 单实例锁 + `SetCloseIntercept` |
| `main/envDetector.ts` | 仓库根目录、Node/Rust/VS/依赖/数据库/市场/客户端/CA 检测 | 原逻辑翻译为 Go；用 `exec.Command` 替代 `execSync` |
| `main/processManager.ts` | 三服务状态机、启动顺序、端口等待、崩溃检测、停止 | 新建 `internal/services`；明确 owned/external 进程边界 |
| `main/ptyManager.ts` | node-pty/ConPTY，多终端数据流 | P0 用进程管道和日志流；P1 视需求接入 ConPTY |
| `main/accountManager.ts` | 调用 `account-cli.js`；头像解析；登录/改密 | 首选继续调用现有 Node CLI，避免重写密码算法 |
| `main/configStore.ts` | `EvEJSConfig.bat`、`server.json`、设置读写 | Go 实现同样规则，保证 CRLF、注释和变量格式不变 |
| `main/initManager.ts` | deps/db/market/client/ca 初始化任务 | 翻译为任务定义 + 串行执行器 + 进度事件 |
| `main/healthChecker.ts` | 26000/26001/26002/40110 探活 | `net.DialTimeout` + `http.Client` |
| `main/logger.ts` | `server/logs/launcher.log` | Fyne 版建议写 `server/logs/launcher-fyne.log`，方便并行对比 |

### 2.2 Electron 渲染层能力

- 服务卡：状态灯、环境状态、启动/停止/重启。
- 一键启动：环境门禁、主服务器 → 市场 → 客户端，按钮防重复点击。
- 内嵌终端：系统/主服务器/市场/客户端四个页签。
- 环境自检看板：8 个文件/工具检查 + 系统资源，共 9 个 UI 条目。
- 配置面板：服务器端口只读，客户端配置可回写。
- 账号面板：账号/角色列表、游戏头像、删除预览与备份。
- 登录框：记住密码、登录直达角色选择、修改密码。
- 任务日志：读取 `server/logs/server.log` 最近 5000 行并按级别着色。
- 指令手册：当前是内嵌 HTML。

### 2.3 HTML 原型新增但后端尚未完整具备的能力

以下能力属于“新功能设计”，不是单纯移植：

- 数据库管理视图
- 模组/插件 Manifest Schema 3 管理
- 自定义指令导入/导出
- 分角色启动卡片
- 在线飞行员、GPU、Ping、数据库 QPS 等实时指标
- 多语言界面（原型已有大规模翻译字典）
- 模组创建、导入、移除与撤销

这些能力必须单独定义后端契约，不能由 Fyne 前端直接“画出来”就视为完成。

---

## 3. 分层范围

### P0：Electron 功能等价迁移

P0 完成后，Fyne 启动器必须能在真实 EveJS 仓库中替代 Electron 版完成日常启动和管理工作。

P0 包含：

1. 仓库根目录解析和 `launcher.config.json` 覆盖。
2. 环境自检和重新检测。
3. 主服务器、市场服务、客户端启动/停止/重启。
4. 一键启动和一键停止。
5. 端口探活、启动超时、崩溃状态。
6. 服务输出日志和 `server.log` 查看。
7. 客户端配置读取、回写和服务器端口只读展示。
8. 账号列表、头像、删除预览/执行、登录验证、修改密码。
9. `Play.bat` 自动登录参数注入及原版回退逻辑。
10. 初始化任务：deps、db、market、client、ca。
11. 单实例与退出清理。
12. Windows 便携版打包。

### P1：新 UI/交互落地

P1 在不新增或只新增少量后端能力的前提下完成：

- 顶栏服务芯片、侧栏三组导航、8 个视图。
- EVEJS COMMAND 主题、切角面板、LED、状态栏和深空背景近似效果。
- 环境自检卡片、初始化进度、Toast、弹窗确认。
- 账号搜索/筛选、角色展开、搜索和无结果状态。
- 指令手册 JSON 数据驱动：指令、物品、NPC、异常模板、QA 装备。
- 资源监控：CPU、内存、磁盘、网络 I/O。
- 中英文首发，其他语言按优先级逐步接入。

### P2：原型扩展能力

P2 需要新后端设计，建议独立立项：

- SQLite 数据库可视化与维护
- 模组 Manifest Schema 3 的安装、启用、停用、卸载
- 自定义指令存储、导入和导出
- 分角色自动登录
- GPU 指标、Ping、在线玩家等实时遥测
- 托盘、自动更新和高级通知

---

## 4. 功能映射表

| 功能 | 现有实现 | Fyne 建议实现 | 优先级 | 风险 |
|---|---|---|---|---|
| 窗口壳 | Electron BrowserWindow | Fyne Window；保留原生标题栏 | P0 | 低 |
| 单实例 | Electron lock | Windows 命名互斥量 | P0 | 中 |
| 仓库根解析 | `resolveRepoRoot()` | `internal/platform/pathlocator` | P0 | 中 |
| 环境检查 | `envDetector.ts` | `internal/envcheck` + `exec.CommandContext` | P0 | 中 |
| 服务状态机 | `processManager.ts` | `internal/services.Controller` | P0 | 高 |
| 端口探活 | `net.Socket` + fetch | `net.DialTimeout` + `http.Client` | P0 | 低 |
| 服务日志 | node-pty + xterm | 进程 stdout/stderr + 日志环形缓冲 | P0 | 中 |
| 多页签控制台 | xterm 实例 | Fyne List/Text + ANSI 简约解析 | P0 | 中 |
| 终端输入 | node-pty write | P0 内部命令；P1 可接 ConPTY | P1 | 高 |
| 自动登录 | `EVEJS_AUTO_LOGIN` + Play.bat | 原样复用环境变量和命令参数 | P0 | 中 |
| 账号数据 | `account-cli.js` | 继续执行 Node CLI，解析 JSON | P0 | 低 |
| 角色头像 | 读取 JPEG/PNG 转 data URL | 读取文件并创建 Fyne 图片资源 | P0 | 低 |
| 客户端配置 | `EvEJSConfig.bat` 文本回写 | Go 按行 upsert，保留其余内容 | P0 | 低 |
| 设置存储 | Electron userData JSON | `%APPDATA%/EvEJS Launcher/settings.json` | P0 | 低 |
| 服务器日志 | 最近 5000 行 | 尾读 + 1 秒轮询；后续可换 fsnotify | P0 | 低 |
| 环境初始化 | 临时 BAT 串行任务 | Go Task Runner + `cmd.exe /d /c call` | P0 | 中 |
| 指令手册 | HTML iframe / 原型 JS | JSON + 列表/表格虚拟化 | P1 | 中 |
| 自定义指令 | localStorage | JSON 设置文件，P2 再接后端 | P2 | 中 |
| 数据库视图 | 无实际后端 | 只读概览先行，再设计维护能力 | P2 | 高 |
| 模组系统 | `mods/` 当前为空且无加载协议 | 先定义 Manifest 和启用策略 | P2 | 高 |
| 资源监控 | 原型随机数 | gopsutil 获取真实 CPU/内存/磁盘/网络 | P1 | 中 |
| GPU | 原型随机数 | 暂不实现；后续走 NVML/WMI | P2 | 高 |
| 在线飞行员/Ping | 原型随机数 | 必须有服务端 API 才能实现 | P2 | 高 |
| 多语言 | HTML 翻译表 | `internal/i18n` 字典 + 语言切换事件 | P1 | 中 |
| Toast | 浏览器 DOM | Fyne overlay + 动画生命周期 | P1 | 低 |
| 托盘 | Electron 未使用 | Fyne desktop App 系统托盘 | P2 | 中 |

---

## 5. 推荐目标架构

```text
launcher-fyne/
├── cmd/
│   └── launcher/
│       └── main.go                 # 只负责启动和依赖装配
├── internal/
│   ├── app/
│   │   ├── app.go                  # 生命周期、单实例、关闭拦截
│   │   └── events.go               # 事件总线
│   ├── domain/
│   │   ├── models.go               # ServiceInfo、EnvReport、AccountInfo 等
│   │   └── errors.go
│   ├── platform/
│   │   ├── pathlocator.go          # repoRoot、exeDir、配置覆盖
│   │   ├── process_windows.go      # taskkill、进程树、单实例
│   │   └── settings.go             # 用户设置持久化
│   ├── services/
│   │   ├── controller.go           # 三服务状态机
│   │   ├── service.go              # Runtime、进程所有权
│   │   └── health.go               # TCP/HTTP 探活
│   ├── envcheck/
│   │   ├── checker.go              # 8 项环境检查 + 系统资源
│   │   └── versions.go             # Node/Rust/VS 探测
│   ├── init/
│   │   └── manager.go              # deps/db/market/client/ca
│   ├── config/
│   │   ├── client.go               # EvEJSConfig.bat
│   │   └── server.go               # config/server.json
│   ├── accounts/
│   │   ├── cli.go                  # account-cli.js 适配器
│   │   ├── portrait.go             # 角色头像解析
│   │   └── login.go                # 验证、改密、登录启动
│   ├── logs/
│   │   ├── ringbuffer.go           # 服务输出内存日志
│   │   └── tailer.go               # server.log 尾读
│   ├── terminal/
│   │   ├── ansi.go                 # ANSI 最小解析
│   │   └── conpty_windows.go       # P1 可选
│   ├── i18n/
│   │   └── translator.go
│   └── assets/
│       ├── embed.go                # go:embed JSON/图标
│       └── data/                   # items/npcs/templates/qa/logo
├── ui/
│   ├── theme/
│   ├── widgets/
│   └── views/
├── assets/                         # 开发期源资源，构建时嵌入
├── testdata/
└── build/
```

### 5.1 UI 与业务解耦

业务层不得直接操作 Fyne 控件。推荐事件模型：

```go
type Event any

type ServiceChanged struct { Services []ServiceInfo }
type InitChanged struct { State InitState }
type LogAppended struct { Tab string; Data []byte }
type MetricsChanged struct { Metrics Metrics }
type ToastRequested struct { Message string; Level string }
```

- 业务层发送事件到 Go channel。
- UI 层监听 channel。
- 更新控件前统一调用 `fyne.Do`。
- 窗口关闭时取消 `context.Context`，停止 ticker、日志轮询和监控采集。

---

## 6. 关键实现设计

### 6.1 仓库根目录

必须按以下优先级解析，不能依赖 `os.Getwd()`：

1. 环境变量 `EVEJS_REPO_ROOT`
2. exe 同目录的 `launcher.config.json` 中的 `repoRoot`
3. exe 所在目录及其最多 3 级父目录
4. 当前目录及最多 5 级父目录
5. 含有 `server/autostart.js` 的第一个目录
6. 最终回退到 exe 所在目录

验收要求在以下三种位置运行都一致：

- 源码目录 `launcher-fyne/`
- 服务端根目录中的 exe
- 服务端根目录下 `launcher/` 子目录中的 exe

### 6.2 服务状态机

保持与 Electron 版相同的状态：

```text
idle -> starting -> running
                 -> error
running -> stopping -> idle
```

关键规则：

- 服务启动前先探活端口；已监听则标记为 `running`，但不接管停止。
- 只终止本启动器拉起的进程。
- 启动顺序固定为：主服务器 → 市场服务 → 客户端。
- 超时：主服务器 60 秒、市场服务 30 秒、客户端 90 秒。
- 停止时先尝试优雅停止；3 秒后仍未退出则 `taskkill /PID <pid> /T /F`。
- 客户端通过 `Play.bat` 启动时，优先复用带 `EVEJS_AUTO_LOGIN` 的补丁版本。
- 未打补丁或 Play.bat 缺失时，回退到直接启动 `exefile.exe` 并传 `/login:<user>:<password>`。
- 密码包含冒号时明确拒绝，因为 `/login:` 参数无法正确表达。

实现建议：

- `startService` 返回结构化结果，不要用字符串判断成功。
- 为每个服务保存 `owned`、`sessionID`、`pid`、`cancel`。
- UI 只订阅状态快照，不直接修改状态。

### 6.3 终端和日志

P0 不建议立即承诺完整 xterm 等价能力，采用两级方案：

#### P0

- 进程运行使用 `exec.Cmd`，分别读取 stdout/stderr。
- 每个页签维护固定上限的环形缓冲，例如 10,000 行。
- 实现 ANSI SGR 的常见颜色解析；不支持的控制序列安全剥离。
- 控制台输入先实现内部命令：
  - `help`
  - `status`
  - `start all`
  - `stop all`
  - `env`
  - `pilot list`
  - `clear`
- 超过 200KB 的单次输出分块写入，避免 Fyne 重绘卡顿。

#### P1 可选增强

- 通过 Windows ConPTY 启动交互式 `cmd.exe`。
- 为每个服务建立 PTY session，转发键盘输入。
- 加入 resize、Ctrl+C、进程退出码和完整 ANSI 状态机。
- 该部分先做独立技术验证，再纳入主界面。

### 6.4 环境检测与初始化

环境检测保持以下 8 项：

1. Node.js，要求主版本 ≥ 24
2. Rust/Cargo
3. VS C++ Build Tools
4. `server/node_modules/express`
5. `_local/gameStore/manifest.json` 与 `gamestore.sqlite`
6. `market-server.exe`
7. EVE 客户端路径
8. CA 证书

再加 1 项系统资源：

- 内存 < 8GB 或线程 < 8：FAIL
- 等于 8GB/8 线程：WARN
- 大于 8GB/8 线程：OK

初始化任务保持串行互斥：

| Key | 动作 |
|---|---|
| `deps` | 在 `server/` 执行 `npm ci --no-audit --no-fund` |
| `db` | 调用 `CreateDatabase.bat /force` |
| `market` | 加载 VS 环境后执行 `cargo build --release` |
| `client` | 探测常见 EVE 路径并回写 `EvEJSConfig.bat` |
| `ca` | 调用 `tools/ClientSETUP/StartClientSetup.bat` |

实现时不要把中文提示塞进临时 BAT。BAT 只负责 ASCII 命令和状态码，中文说明、进度和结果由 Go 层发送到 UI，避免代码页问题。

### 6.5 配置和设置

#### `EvEJSConfig.bat`

- 读取位置：
  1. `tools/ClientSETUP/scripts/EvEJSConfig.bat`
  2. 仓库根目录 `EvEJSConfig.bat`
- 支持 `set "KEY=VALUE"` 和 `set KEY="VALUE"`。
- 展开 `%EVEJS_REPO_ROOT%`。
- 只更新指定键，保留注释和其他行。
- 统一使用 CRLF 写出。
- 写回后重新读取并返回实际值，避免 UI 显示草稿值。

#### 启动器设置

建议位置：

```text
%APPDATA%/EvEJS Launcher/settings.json
```

支持 `launcher.config.json` 覆盖设置目录，便于便携部署。

“记住密码”若继续保留，建议不要明文存储。Windows 版本优先使用 DPAPI (`CryptProtectData`)；如果暂不实现，则默认不持久化密码。

### 6.6 账号与角色

推荐 P0 继续调用现有：

```text
node scripts/account-cli.js list <repoRoot>
node scripts/account-cli.js delete <repoRoot> <target> [--apply]
node scripts/account-cli.js check-running <repoRoot>
node scripts/account-cli.js verify <repoRoot> <user> <password>
node scripts/account-cli.js set-password <repoRoot> <user> <newPassword>
```

原因：

- 密码哈希算法不需要重写。
- SQLite schema 和删除备份逻辑保持一致。
- 服务端热读取密码的行为不会改变。

后续若迁移到 Go SQLite，必须具备兼容测试：

- 同一账号同一密码的哈希验证结果一致。
- 删除账号生成相同范围的备份。
- 删除后角色、资产、关系和头像处理一致。

头像解析顺序保持原实现：

1. `_local/gameStore/images/Character/<id>_<size>.jpg|png`
2. `server/src/_secondary/image/generated/Character/<id>_<size>.jpg|png`
3. `server/src/_secondary/image/images/hi.jpg|png`

尺寸优先级：128、64、256、512、32、1024。

“分角色启动”是原型新需求。现有后端只有按账号验证并启动客户端，没有按角色直接登录的稳定协议。P0 不应伪造该能力；P1/P2 需要先确认客户端和登录流程能否选择角色。

### 6.7 指令与查询数据

现有数据文件：

- `items_map.json`：约 2.8MB
- `npcs_data.json`：约 1.1MB
- `templates_data.json`：约 1.0MB
- `qa_data.json`：约 8KB
- `manual.html`：约 5.3MB

Fyne 建议：

- 小数据使用 `go:embed`。
- 大数据不直接嵌入首屏初始化逻辑，后台异步解析。
- 搜索前建立小写索引，避免每次输入扫描全部对象。
- 使用分页或 `widget.List` 虚拟化，禁止一次性渲染 36,000 个控件。
- HTML 手册改为结构化数据后渲染；完整 HTML 仅保留“用系统浏览器打开”入口。

### 6.8 资源监控

P0/P1 使用 `gopsutil/v4`：

- CPU：`cpu.Percent`
- 内存：`mem.VirtualMemory`
- 磁盘：`disk.Usage`
- 网络：`net.IOCounters`
- 更新周期：1 至 2 秒
- 窗口不可见或最小化时降低采集频率

必须遵守：

- 不在 UI 线程执行采集。
- 采集失败时显示“不可用”，不回退到随机数。
- GPU、Ping、在线人数、数据库 QPS 只有在存在可靠数据源时才展示。

### 6.9 Fyne UI 决策

| 原型元素 | Fyne 实现 |
|---|---|
| 切角面板 | `canvas.ArbitraryPolygon` |
| LED | `canvas.Circle` + `RadialGradient` |
| 六边形头像 | `ArbitraryPolygon` + `canvas.Image` 或首字母 |
| 深空背景 | 多个 `Rectangle`/`RadialGradient` 叠加 |
| 服务芯片 | 自定义 Widget |
| 顶部导航 | `container.NewBorder` + 自定义 Sidebar |
| 8 个视图 | `container.NewStack` 切换，按需懒加载 |
| 大列表 | `widget.List`/分页，避免 `VBox` 全量构建 |
| Toast | 顶层 overlay，自动消失 |
| 确认弹窗 | `dialog.ShowCustomConfirm` 或自定义 PopUp |
| 登录翻转 | 两阶段动画，不做真实 3D |
| 状态栏 | 自定义横向 Border 布局 |
| 原生窗口按钮 | 保留 Fyne 原生标题栏；边框窗口需走 Windows 专项 |

字体建议：

- 标题英文可嵌入 Orbitron。
- 中文使用可嵌入的 TTF；不要依赖系统 TTC。
- 如果发布包需要完全一致字体，必须确认字体授权并嵌入 TTF。

---

## 7. 打包与部署

建议构建命令：

```powershell
go build -trimpath -ldflags "-s -w -H=windowsgui" `
  -o release\EvEJS-Launcher-Fyne.exe .\cmd\launcher
```

使用 Fyne 打包：

```powershell
fyne package -os windows -icon .\build\icon.ico -name EvEJSLauncher
```

发布目录必须包含或能够定位：

- `server/`
- `config/`
- `tools/`
- `externalservices/`
- `_local/gameStore/`
- `Play.bat`
- `EvEJSConfig.bat`
- 数据 JSON 和图标

如果采用 `go:embed`，exe 至少会增加约 5MB 的原始数据体积；压缩后不一定显著小于 Electron，但启动速度、内存和部署复杂度仍会改善。UPX 只能作为实验项，因为可能触发杀毒软件误报。

体积目标建议改为：

- 未压缩：25 至 45MB
- UPX 后：18 至 30MB
- 不要承诺 15MB 以下或“必定 < 1.5 秒”，必须在目标机器实测。

---

## 8. 里程碑计划

以下为一名熟悉 Go、Windows 进程和 Fyne 的开发者的估算；首次接触 ConPTY/Fyne 时应预留 1.5 倍。

| 阶段 | 内容 | 交付物 | 验收 | 预估 |
|---|---|---|---|---|
| M0 技术验证 | repoRoot、启动服务、停止进程树、日志、账号 CLI、打包 | 可执行 spike | 能从真实仓库启动主服务器并停止 owned 进程 | 3 至 5 天 |
| M1 基础设施 | 目录重构、事件总线、设置、路径、配置、日志 | `internal/` 核心包 | 单元测试通过；Electron 配置兼容 | 4 至 6 天 |
| M2 UI 壳 | 主题、顶栏、侧栏、8 视图、导航、状态栏 | 视觉可运行 Fyne 应用 | 与 HTML 原型主页面结构一致 | 5 至 7 天 |
| M3 服务与日志 | 三服务状态机、一键启停、健康检查、日志页签 | 可真实启停服务 | 启动/停止/崩溃/外部进程场景通过 | 7 至 10 天 |
| M4 环境与账号 | 环境检测、初始化任务、配置中心、账号、登录、改密 | P0 功能闭环 | 真实账号和数据库操作通过 | 6 至 9 天 |
| M5 数据视图 | 指令手册、物品/NPC/模板/QA、搜索分页 | 数据驱动视图 | 数据加载和搜索稳定 | 5 至 8 天 |
| M6 新功能 | 自定义指令、数据库概览、模组、i18n | P1/P2 增量版本 | 按各功能单独验收 | 8 天以上 |
| M7 发布 | 日志、单实例、安装包、性能测试、文档 | 便携版和发布说明 | P0 验收清单全部通过 | 3 至 5 天 |

**P0 推荐周期：4 至 6 周。**  
**P1 完整原型 UI + 数据视图：再增加 2 至 4 周。**  
**P2 数据库/模组/分角色登录：需要单独立项，不应混入 P0。**

---

## 9. 测试方案

### 9.1 单元测试

- 仓库根目录解析：不同类型启动目录。
- `EvEJSConfig.bat`：解析、转义、变量展开、注释保留、CRLF 写回。
- 环境检查：临时目录、假 exe、版本号边界、缺失工具。
- 服务状态机：启动、超时、退出码、停止、外部进程。
- 日志尾读：不存在、空文件、UTF-8、超长行、5000 行截断。
- ANSI 解析：颜色、重置、未知控制码、超长输出。
- 账号 JSON 解析：空列表、无效 JSON、无角色、头像缺失。
- 设置迁移：旧 Electron 设置在允许范围内的兼容。
- 数据索引：中文/英文/ID 搜索和分页边界。

### 9.2 Windows 集成测试

1. 真实启动主服务器，确认 26000、26001、26002 监听。
2. 真实启动市场服务，确认 40110 监听。
3. 客户端通过 Play.bat 启动，确认校验日志可见。
4. 自动登录参数注入，确认客户端进入角色选择。
5. `stopService` 只终止本启动器拉起的进程。
6. 外部进程占用端口时显示“外部已启动”，停止按钮不误杀。
7. 服务异常退出后状态变为 ERROR。
8. 关闭启动器时 owned 服务被清理，外部服务不受影响。
9. 删除账号前必须停止服务，并生成备份。
10. 初始化过程中关闭窗口，任务被安全终止或提示仍在执行。

### 9.3 UI 验证

- 逐页截图对比 HTML 原型：主控台、控制台、账号、指令、数据库、模组、配置、设置。
- 1024×640、1280×800、最大化三种尺寸。
- 中文、英文至少各走一遍。
- 键盘 Tab、Enter、Esc、弹窗关闭和错误提示。
- 列表为空、加载中、失败、超长文本四种状态。

### 9.4 性能验证

- 冷启动时间取 20 次中位数。
- 空闲 5 分钟内存占用。
- 日志连续输出 10MB 时 UI 是否卡顿。
- 指令数据加载时间。
- 打包 exe 体积和首次启动杀毒扫描影响。
- 停止所有服务后的残留 PID。

---

## 10. 主要风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| Go 进程树停止不彻底 | 高 | owned PID + `taskkill /T /F`；M0 验证；必要时 Windows Job Object |
| ConPTY 与 Fyne 无现成完整方案 | 高 | P0 用管道日志，P1 单独立项 ConPTY |
| CSS 视觉无法像素级复刻 | 中 | 以设计 token、布局和交互为先，动画做近似 |
| 手册 HTML 转 JSON 工作量大 | 中 | 先保留外部打开；新数据视图逐步替换 |
| 账号逻辑重写导致密码不兼容 | 高 | P0 继续调用 `account-cli.js`，不直接改哈希算法 |
| 大数据 JSON 导致内存过高 | 中 | 异步加载、索引、分页、虚拟列表 |
| 客户端自动登录失败 | 高 | 完整保留 Play.bat 补丁检测和直连回退；记录终端日志 |
| 设置/密码明文存储 | 中 | DPAPI；至少把“记住密码”默认关闭 |
| 打包后找不到资源 | 高 | 所有路径经 `PathLocator`；禁止依赖 cwd |
| UPX 触发杀毒误报 | 中 | 默认不启用，提供未压缩版本 |
| 原型功能被误认为已有后端 | 高 | 以本文 P0/P1/P2 分层为准，先定义接口再开发 |

---

## 11. P0 验收清单

- [ ] 可从源码目录、服务端根目录、launcher 子目录正确找到仓库根。
- [ ] Node、Rust、VS、依赖、数据库、市场、客户端、CA 八项检查结果与 Electron 一致。
- [ ] 系统资源检查作为第 9 个 UI 条目显示。
- [ ] 主服务器、市场服务、客户端可单独启动、停止、重启。
- [ ] 一键启动按顺序执行，失败时中止后续关键步骤。
- [ ] 一键停止不会终止外部启动的服务。
- [ ] 服务崩溃后自动标记 ERROR，并显示退出码。
- [ ] 系统/主服务器/市场/客户端四个日志页签可用。
- [ ] `server/logs/server.log` 最近 5000 行可读取并着色。
- [ ] 环境初始化五项可执行，任务互斥，进度和结果可见。
- [ ] 服务器端口只读展示正确。
- [ ] 客户端配置可回写 `EvEJSConfig.bat`，其他内容不丢失。
- [ ] 账号列表、角色、GM、封禁、头像显示正确。
- [ ] 账号删除先预览，执行前检查服务停止，备份生成。
- [ ] 登录验证、修改密码和自动登录可用。
- [ ] 单实例、关闭清理、日志落盘正常。
- [ ] 便携版在干净目录可启动，不依赖 Electron/Node GUI。
- [ ] 通过 Windows 10 1809+ 和 Windows 11 回归测试。

---

## 12. 推荐执行顺序

1. 先做 M0，不先大规模搬 UI 代码。
2. M0 通过后，把现有 `launcher-fyne` 拆成 `internal/` 和 `ui/`。
3. 先移植服务状态机、环境检测、配置和账号，再完成视觉细节。
4. 每个功能都以 Electron 版行为作为对照，而不是以 HTML 演示值为准。
5. P0 稳定后，再把数据库、模组、分角色登录作为独立里程碑推进。

**最终建议：Fyne 适合作为下一版启动器，但应把它定义为“分阶段替代 Electron”，而不是“一次性开发完再切换”。在 P0 验收前保留 Electron 作为正式回退。**