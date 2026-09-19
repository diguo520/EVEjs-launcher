# Electron 新版原型移植报告

> 日期：2026-09-19  
> 状态：新版 UI/UX 已接管 Electron renderer，核心功能已接入真实后端。

---

## 1. 清理结果

已停止并删除 Fyne 构建策略：

- 删除 `launcher-fyne/`
- 删除本次产生的项目内 Go 缓存：
  - `_local/go-mod`
  - `_local/go-build`
  - `_local/go-tmp`

系统级 `C:\Users\chang\go\pkg\mod` 属于共享缓存，没有整体删除，避免影响其他 Go 项目。

---

## 2. Electron renderer 改造

正式窗口现在加载：

```text
dist/renderer/eve-launcher.html
```

开发模式加载：

```text
http://127.0.0.1:5173/eve-launcher.html
```

原型资源已加入 `src/renderer/public`：

- `eve-launcher.html`
- `items_map.json`
- `npcs_data.json`
- `qa_data.json`
- `templates_data.json`
- `logo.svg`
- `launcher-bridge.js`

新增桥接层：

```text
src/renderer/public/launcher-bridge.js
```

桥接层把原型的 mock 行为替换为 Electron IPC 能力。

---

## 3. 已接入的真实功能

### 服务控制

- 主服务器、市场服务、客户端状态来自 `services:list`
- 服务状态变化实时更新卡片和顶部服务芯片
- 单个启动 / 停止按钮调用真实 processManager
- 一键启动 / 一键停止调用真实 ENGAGE 流程
- 控制台日志接收真实终端输出
- 已移除原型随机日志

### 登录

- 账号密码使用 `accountsVerify`
- 登录成功后调用 `loginStart`
- 修改密码调用 `accountsSetPassword`

### 账号管理

- 使用 `accountsList` 读取真实账号和角色
- 真实显示账号数量、角色数量、GM 标记
- 删除账号前检查服务运行状态
- 删除前调用 CLI 预览，再确认执行
- 创建账号、创建角色、删除单角色当前后端尚不支持，界面内明确提示

### 环境自检

- 使用 `envCheck` 读取 Node、Rust、VS、依赖、数据库、市场、客户端路径、CA
- 增加系统资源检测项
- 初始化按钮调用 `initRun`
- 初始化进度监听 `initChanged`
- 初始化完成后自动重新检测环境

### 配置中心

- 读取 `config/server.json`
- 读取 `EvEJSConfig.bat`
- 保存客户端配置时真实回写 BAT
- 启动选项通过 `settingsGet` / `settingsSet` 接入
- 服务端端口显示为只读

### 资源监控

新增 IPC：

```text
metrics:get
```

当前真实数据：

- CPU 使用率
- 内存使用量
- 磁盘使用量
- Windows 网络吞吐

GPU、Ping、DB QPS 当前仍显示原型占位值。

### 窗口控制

原型原本没有 Electron 窗口按钮，现已加入：

- 最小化
- 最大化
- 关闭
- 顶栏拖拽区域
- 按钮区 no-drag

---

## 4. 数据视图验证

Electron smoke 中实际加载：

```text
items     26896
templates  5944
npcs       5620
qa           89
```

说明：

- `items_map.json`
- `templates_data.json`
- `npcs_data.json`
- `qa_data.json`

在 `file://` 生产 renderer 下可以正常加载，数据查询、分页、复制功能可以继续使用原型实现。

---

## 5. 实际验证结果

### Renderer 状态

```text
navItems      8
svcCards      3
svcChips      3
envCards      9
hasApi        true
hasBridge     true
consoleLines  3
envApiPass    8/8
```

### 真实账号

```text
accounts: 3
roles:    5
```

账号页截图：

`launcher/launcher/docs/ui-accounts.png`

### UI 按钮启停服务

已通过真实点击服务卡按钮验证：

```text
start via UI: true
stop via UI: true
```

启动截图：

`launcher/launcher/docs/ui-service-start.png`

停止后确认：

```text
no listener on 26000
```

---

## 6. 构建与 smoke

构建：

```powershell
cd launcher/launcher
npm.cmd run build
```

普通 smoke：

```powershell
$env:EVEJS_USER_DATA_DIR='E:\Games\EveJS-v0.12.8\_local\electron-user-data'
.\node_modules\.bin\electron.cmd . --smoke-test --disable-gpu --disable-gpu-sandbox --no-sandbox --in-process-gpu
```

服务按钮 smoke：

```powershell
$env:EVEJS_USER_DATA_DIR='E:\Games\EveJS-v0.12.8\_local\electron-user-data'
.\node_modules\.bin\electron.cmd . --service-smoke --disable-gpu --disable-gpu-sandbox --no-sandbox --in-process-gpu
```

GPU 参数用于当前沙箱环境；正式构建不需要这些限制。

---

## 7. 当前仍保留的 mock / 未接入项

- 数据库页面的数据统计与表列表
- 模组 / 插件页面的实际 Manifest 启用、停用、导入
- 创建账号
- 创建角色
- 删除单个角色
- GPU 使用率
- Ping
- DB QPS
- 部分非核心设置项

这些项目中，原 Electron 后端也没有完整能力，需要后续按后端能力逐步接入。

---

## 8. 说明

服务 smoke 在 Electron 强制退出时，`node-pty` 的 ConPTY helper 偶尔打印：

```text
Error: AttachConsole failed
```

该错误发生在 smoke 强制退出阶段，不影响主进程服务启停和渲染层交互。正式发布前应进一步处理 PTY 退出顺序和 helper 生命周期。
---

## 9. 增量修改（2026-09-19）

- 控制台改为只轮询 `server/logs/server.log`
- 保留 `capsuleer@tranquility:~$` 输入框，但设置为只读模式
- 移除随机日志，日志 DOM 增加 render key，避免系统/主服务器/市场/客户端日志闪烁
- 客户端卡片移除启动按钮，改为“登录后启动”
- 一键启动只启动主服务器和市场服务器
- 服务状态显示改为 `0/2 RUNNING`
- 服务端根目录可配置，并写入 `launcher.config.json`
- 配置中心右侧路径和底部 PATH 改为真实用户路径
- 客户端配置继续通过 `EvEJSConfig.bat` 自定义

增量 smoke 结果：

```text
envApiPass: 8/8
consoleReadOnly: true
fullTabCount: 1
serverLogCount: 488
clientStartButtons: 0
service status: 0/2 RUNNING
data: items=26896 templates=5944 npcs=5620 qa=89
accounts: 3 accounts / 5 roles
```

Engage smoke 结果：

```text
主服务器启动成功
市场服务启动成功
客户端未启动
一键停止成功
```

最新便携版（已集成更新交互与更新器）：

```text
release\EvEJS-启动器-便携版-新版原型-0.1.5.exe
SHA256: 4E9F7361908616F73FBBD34464DA2A94FAE15ECDDCDBF86B94A9A5659457FEB4
```
### 日志颜色与滚动增量修复

- 日志采用增量 DOM 追加，不重复重绘已有行
- 恢复 ANSI 颜色
- IP 地址使用青色
- 端口使用琥珀色
- `[进程退出] exit code` 和退出码使用红色
- `ERR/FAIL` 整条日志红色，但 IP 和端口继续使用各自颜色
- `WARN` 整条日志黄色，但 IP 和端口继续使用各自颜色
- 用户滚动查看旧日志时，不再强制跳到最新日志
- 只有用户位于日志底部时才自动跟随新日志
### 指令手册大分类筛选修复

- 统计卡增加独立筛选状态
- 指令分类 / 指令条目 / 无限制 / 需停泊 / 需太空 / 需GM 分别筛选
- 分类标签点击后恢复为“当前分类 + 全部限制”
- 筛选时直接过滤实际 `CMDS_DATA`
- 验证结果：
  - 无限制：160
  - 需停泊：29
  - 需太空：33
  - 需GM：4

### 启动器更新系统整合（2026-09-19）

- 已从新版原型合并顶部更新入口、更新状态红点、更新弹窗和下载进度交互
- 渲染层 `launcher-bridge.js` 不再使用原型中的模拟定时器，改为调用真实 `window.api.update*`
- 主进程已接入 `update:check`、`update:state`、`update:download`、`update:apply`、`update:cancel`
- 更新清单支持 `EVEJS_UPDATE_MANIFEST_URL`、用户设置 `updateManifestUrl`、便携版同目录 `launcher.config.json` 三种来源
- 更新包支持 SHA256 校验；下载完成后由独立 `evejs-updater.exe` 等待启动器退出并替换当前便携版 exe
- 替换流程保留 `.backup` 回滚路径，成功后自动重启启动器；运行中的主服务器或市场服务存在时会阻止安装
- macOS/Linux 的更新机制仍留在方案阶段；当前已打包验证的是 Windows x64 便携版

更新 smoke 结果：

```text
updateOk: true
updateAvailable: true
updateLatestVersion: 0.2.0
updateModalTitle: 发现新版本
download + SHA256: passed
updater replace + rollback simulation: passed
```

发布更新时，在便携版 exe 同目录放置 `launcher.config.json`：

```json
{
  "updateManifestUrl": "https://your-release-host/update-manifest.json"
}
```

未配置更新源时，启动器仍可正常使用，点击检查更新会显示“未配置 updateManifestUrl”。
