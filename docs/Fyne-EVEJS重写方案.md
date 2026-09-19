# EvEJS 启动器 Fyne 重写方案（v2.0 · EVEJS COMMAND UI）

> 版本：v2.0 ｜ 日期：2026-09-19 ｜ 状态：待评审
> 关联设计稿：`launcher\launcher\assets\evejs-launcher\eve-launcher.html`（EVEJS COMMAND 高保真 UI/UX）

---

## 1. 背景与目标

当前启动器为 **Electron + React + TS** 便携版（v0.1.5）：
- 体积 **71.6 MB**（实测单 exe）
- 启动 **10–20 s**（实测，便携版每次解压到临时目录）
- 常驻内存 250–500 MB

已设计完成新版 UI/UX（EVEJS COMMAND 指挥中心风格）并产出高保真 HTML 设计稿。本方案将现有启动器**更换为 Fyne 最新版框架（v2.8.1）**，按设计稿重建全部界面与交互，保留现有 Electron 版全部功能。

**目标指标**：

| 指标 | Electron 现状 | Fyne 目标 |
|---|---|---|
| 单文件体积 | 71.6 MB | 25–40 MB（UPX 后 15–25 MB） |
| 启动时间 | 10–20 s | < 1.5 s |
| 常驻内存 | 250–500 MB | < 100 MB |
| 部署形态 | 便携 exe + Play.bat 补丁 | 便携 exe + Play.bat 补丁（不变） |

---

## 2. 新版 UI/UX 规格提取（来自设计稿）

### 2.1 视觉语言「EVEJS COMMAND」
| 项 | 规格 |
|---|---|
| 主背景 | `#05080d` 深空黑 + 星云/网格/星点/扫描线/暗角多层叠加 |
| 主强调色 | 青色 `#00d4ff`（面板线、选中态、数据） |
| 次强调色 | 琥珀 `#ff9d2e`（启动按钮、角标、GM 标识） |
| 语义色 | 绿 `#2ee6a6` 就绪 ｜ 红 `#ff3b54` 错误 ｜ 黄 `#ffd23e` 警告 ｜ 紫 `#b07cff` |
| 面板 | 深蓝灰渐变 + 1px 青色线 + **切角多边形**（6–16px 切角）+ 顶部青色发光横线 |
| 字体 | 标题 Orbitron 900/600（英文）｜ 正文 Rajdhani/Inter ｜ 等宽 Share Tech Mono（标签/数值/日志）|
| 形态语言 | 切角按钮、六边形角色头像、发光 LED 状态点、脉冲动画 |

### 2.2 信息架构（8 视图 + 3 导航分组）
| 分组 | 导航项 | 视图核心内容 |
|---|---|---|
| CONTROL | 主控台（默认） | 4 服务卡 + 一键启动横幅 + 实时日志（4 Tab）+ 账号登录（3D 翻转改密）+ 资源监控 + 环境自检（9/9 圆环） |
| CONTROL | 控制台 | 管理终端（可输入指令） |
| MANAGE | 账号管理 | 账号搜索/筛选 + 账号块（展开/删除）+ 角色 4 列卡（六边形头像/启动/更多菜单），badge=账号数 |
| MANAGE | 指令手册 | GM 指令参考 v0.12.8.1（items/npcs/templates 数据驱动） |
| MANAGE | 数据库 | SQLite 持久层管理 |
| MANAGE | 模组/插件 | Manifest Schema 3 包管理，badge=数量 |
| SYSTEM | 配置中心 | 服务器/客户端配置（EvEJSConfig 联动） |
| SYSTEM | 设置 | 启动器偏好（语言/托盘/自动登录） |

### 2.3 顶栏 / 侧栏 / 状态
- **顶栏 60px**：Logo（EVEJS COMMAND 双层字标）｜ 4 服务状态芯片（LED）｜ 实时时钟 ｜ 语言切换 ｜ 管理员身份
- **侧栏 200px**：三组导航（图标+文字+角标）｜ 底部资源迷你条（CPU/MEMORY/NET I/O 进度条）
- **底部**：B站 波坤太叔 署名（沿用原版）

---

## 3. 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 语言/框架 | **Go 1.24+ / Fyne v2.8.1** | 2026-09 最新稳定版（v2.8.1），GPU 形状加速、富文本增强 |
| 编译工具链 | MinGW-w64（cgo 必需） | 已装 `C:\w64devkit`，PATH 已配 |
| 服务探活 | net.Dial + HTTP ping | 端口 26000 / 40110，与 Electron 版状态机一致 |
| 进程管理 | os/exec + process tree | 启动/停止 npm start、market-server、Play.bat |
| 资源监控 | gopsutil v4 | CPU/GPU/内存/磁盘/网络，侧栏迷你条 + 监控面板 |
| 日志读取 | 文件尾读 + 行缓存 | server\logs\server.log 多 Tab 分路过滤 |
| SQLite 管理 | modernc.org/sqlite（纯 Go） | 账号/角色数据操作（沿用 gamestore 逻辑） |
| 登录/改密 | Play.bat 补丁注入 EVEJS_AUTO_LOGIN | 与 Electron 版容错逻辑一致（缺失/原版自动回退直连） |
| 打包 | 官方 fyne package + UPX | 单 exe；UPX 二次压缩 |

---

## 4. 功能映射（Electron 现有 16 项 → Fyne）

| # | Electron 现有功能 | Fyne 实现 | 优先级 |
|---|---|---|---|
| 1 | 一键启动（互斥置灰） | 状态机 + 按钮 Disable | P0 |
| 2 | 三服务启停（主/市场/客户端） | 服务卡 mini-btn + 端口探活 | P0 |
| 3 | 环境自检分栏（Node/Rust/VS/资源/CA/DB/市场/路径） | 8 检查卡 + 9/9 圆环 + 重新检测 | P0 |
| 4 | 首次初始化 4 项（互斥+进度条） | 检查卡内联初始化 + 进度条 | P0 |
| 5 | 任务视图 = 日志（server.log） | 实时日志 Tab（系统/主/市场/客户端） | P0 |
| 6 | 账号登录 → 角色选择 | 登录面板（记住密码）→ 角色卡 | P0 |
| 7 | 修改密码（3D 翻转） | 翻转卡（Fyne 动画实现） | P0 |
| 8 | 账号管理（删除/自动备份/头像） | 账号块展开 + 删除确认 | P0 |
| 9 | 角色头像（游戏内头像） | 六边形头像（_local\gameStore\images\Character） | P0 |
| 10 | 指令手册 v0.12.8.1 | 手册视图 + JSON 数据驱动 | P0 |
| 11 | 系统资源统计（内存/线程红黄绿） | 侧栏资源条 + 监控面板 | P1 |
| 12 | 客户端路径/证书初始化 | 配置中心 | P1 |
| 13 | 数据库视图（gamestore） | 数据库视图 | P1 |
| 14 | 模组/插件 | 模组视图 | P2 |
| 15 | 设置（语言/托盘/自动登录） | 设置视图 | P2 |
| 16 | 底部署名 B站 波坤太叔 | 状态栏/侧栏底部 | P0 |

---

## 5. 视觉实现方案（设计稿 → Fyne）

| 设计稿元素 | Fyne 实现 | 备注（v2.8 已验证 API） |
|---|---|---|
| 切角多边形面板/按钮 | `canvas.ArbitraryPolygon`（v2.8 新增） | 自绘切角 Path；旧版 Polygon 已弃用 |
| 面板青色顶线 + 发光 | `canvas.Rectangle` + 渐变 | 顶部 1px 青色线 |
| 发光 LED 状态点 | 自定义 `Led`（RadialGradient + 辉光） | v2.8 无 Gradient 字段坑已规避 |
| 六边形角色头像 | `ArbitraryPolygon` 六边形 + 剪裁图片 | 头像从 gameStore 异步加载 |
| 深空背景（星云/网格/扫描线） | 静态 canvas 组合（Rectangle/Line/渐变） | 无 CSS，用画布堆叠 |
| 3D 翻转卡（登录/改密） | 自定义 Widget：缩放+X 偏移动画 | Fyne 无 CSS 3D，用「宽度塌缩→换面→展开」模拟翻转 |
| 字体 | 嵌入 Orbitron（标题）；中文 fallback simhei.ttf | **禁止 TTC**（msyh.ttc 不可用），标题英文用嵌入字体、中文用系统字体 |
| 脉冲动画（LED/进度） | fyne.Animation 循环 | 仅状态变化时运行 |
| 服务状态芯片（顶栏） | 自定义 Chip（切角 + LED） | 与主控台服务卡联动 |

---

## 6. 项目结构

```
launcher-fyne/
├── go.mod                     # module evejs-launcher (fyne.io/fyne/v2 v2.8.1)
├── main.go                    # 装配：主题/窗口/三区导航
├── ui/
│   ├── theme.go               # EVEJS COMMAND 主题（色板/字体/字号）
│   ├── widgets.go             # 切角按钮/LED/六边形头像/进度条/面板
│   ├── topbar.go              # 顶栏（Logo/服务芯片/时钟/语言/管理员）
│   ├── sidebar.go             # 侧栏（分组导航/角标/资源迷你条）
│   └── views/
│       ├── dashboard.go       # 主控台（服务卡/一键启动/日志/登录/监控/环境自检）
│       ├── console.go         # 控制台
│       ├── accounts.go        # 账号管理
│       ├── manual.go          # 指令手册
│       ├── database.go        # 数据库
│       ├── modules.go         # 模组/插件
│       ├── config.go          # 配置中心
│       └── settings.go        # 设置
├── core/
│   ├── services.go            # 服务状态机（探活/启停/崩溃检测）
│   ├── envcheck.go            # 环境自检（Node/Rust/VS/资源/CA/DB/市场/路径）
│   ├── login.go               # 登录/改密/Play.bat 补丁注入
│   ├── accounts.go            # 账号/角色数据（gamestore.sqlite）
│   ├── logger.go              # 日志尾读（server\logs\server.log）
│   └── monitor.go             # 资源监控（gopsutil）
├── assets/                    # 嵌入资源（Orbitron.ttf、logo.svg、JSON 数据）
└── release/                   # 打包产物（便携 exe + Play.bat + 发布说明）
```

---

## 7. 里程碑（A–F）

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **A UI 骨架** | 主题 + 顶栏/侧栏/8 视图路由 + 主控台静态布局 | 与设计稿像素级接近（截图比对） | 3–4 天 |
| **B 服务引擎** | 服务状态机/一键启动/日志/资源监控 | 真实拉起 E 盘服务端，日志实时滚动 | 3–4 天 |
| **C 环境与初始化** | 环境自检 8 项 + 首次初始化互斥 | 检测/初始化与 Electron 版结果一致 | 2 天 |
| **D 账号与登录** | 登录/改密/账号管理/角色头像 | 自动登录直达角色选择（含直连回退） | 3 天 |
| **E 数据视图** | 指令手册/数据库/模组/配置 | 手册数据从 JSON 加载 | 2–3 天 |
| **F 打包交付** | fyne package + UPX + Play.bat + 发布说明 | 体积 ≤40MB（UPX ≤25MB）、启动 <1.5s | 1–2 天 |

**总预估：14–18 天。**

---

## 8. 测试与验收

1. **视觉验收**：A 阶段产出 demo，与 `eve-launcher.html` 截图逐区比对（顶栏/侧栏/主控台/账号管理）。
2. **功能等价**：16 项功能逐项对照 Electron 版行为（一键启动置灰、初始化互斥、日志路径、自动登录容错）。
3. **性能验收**：体积/启动/内存对照目标表（第 1 节）。
4. **实机验证**：在 E 盘服务端真实拉起全部服务，验证日志、登录、角色选择全链路。
5. **分发验证**：干净机器解压便携 exe → Play.bat 补丁检测 → 自动登录。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| Fyne 无 CSS 复杂视觉（切角/发光/翻转） | 全部封装为自绘 Widget（A 阶段先行验证）；翻转卡用塌缩动画模拟 |
| 中文字体（TTC 不支持） | 标题英文 Orbitron + 中文 simhei.ttf 运行时加载；正文统一系统字体 |
| 设计稿含 Web 专属特效（星云/scanlines） | 桌面端用静态画布近似，保证密度与主色一致，不做逐像素复刻 |
| 自动登录在部分机器失效（历史问题） | 完整移植 Electron 版容错：补丁检测→缺失回退直连 exefile + /login: |
| 服务端路径依赖 | 全部路径相对「当前项目根」，便携式放服务端根目录即可 |

---

## 10. 交付物

- 源码：`launcher-fyne\`（Go + Fyne v2.8.1）
- 便携版：`release\EvEJS-启动器-便携版-0.2.0.exe`（目标 ≤40MB）
- 补丁：`Play.bat`（自动登录注入）+ `发布说明.txt`
- 设计稿：沿用 `launcher\launcher\assets\evejs-launcher\`（不再改动）

> 本方案待确认项：① A 阶段视觉验收基准 = eve-launcher.html 全量复刻 or 优先主控台；② Fyne 版版本号起点 0.2.0 是否可接受；③ 数据视图（手册/数据库/模组）是否首版交付。
