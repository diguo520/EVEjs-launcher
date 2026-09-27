# tests/parity —— 双实现一致性（golden 对比，计划 §5.2）

S3 阶段立起了「同一个逻辑在 TS 与 Rust 各写一遍」的防线（固定向量 + Tauri 侧回归基线），
S5 的 L2 把它补成完整的**双实现对比**：Electron 现役版与 Tauri 新外壳各自产出同一组只读通道的
回包原文，经同一套归一化口径后逐通道对拍。

一句话口径：**固定向量（规则 4）跑在最前，单实现回归基线（规则 1）挡住形状被改坏，
跨实现对拍（规则 1+2）才是真正证明「移植没走样」的那一半。**

## 1. 目录

| 文件 | 作用 |
| --- | --- |
| `fixtures/password-hash.json` | 密码哈希向量：由**现役版** `scripts/account-cli.js` 冻结（生成：`gen-password-fixtures.mjs`） |
| `fixtures/manifest/*.json` | 合法 / 篡改 / 坏签名三份清单 + `expected.json`（判定结果与固定公钥） |
| `fixtures/channels/tauri-baseline.json` | Tauri 侧 26 个只读通道的冻结基线（已归一：无本机路径/时间戳/PID） |
| `fixtures/channels/electron-baseline.json` | **Electron 侧**同一组通道的冻结基线；跨实现比对的前提是「参考实现不漂移」 |
| `gen-password-fixtures.mjs` / `gen-manifest-fixtures.mjs` | 重新冻结固定向量（只读现役版） |
| `make-repo-fixture.mjs` | 生成两边**共用**的「仓库根」fixture —— 不给同一个仓库根，跨实现比出来的全是环境差异 |
| `normalize.mjs` | 归一化口径 + 「按结构比对」通道清单 + `compareChannel`（唯一一处，两个 diff 共用） |
| `run.mjs` | 固定向量驱动（`npm run parity`） |
| `driver-tauri.mjs` | Tauri 侧 dump：起 `--self-test` 真机（`EVEJS_SELF_TEST_DUMP=1`）→ `.parity-out/tauri.json` |
| `driver-electron.mjs` | Electron 侧 dump：包装现役版（见 §3）→ `.parity-out/electron.json` |
| `electron-harness/{parity-main.js,parity-capture.js}` | 塞进 harness 的入口 + `ipcMain` 劫持（唯一「额外」代码，不碰现役源码） |
| `diff.mjs` | 同一实现 ↔ 自己冻结基线；`--update` 刷新基线 |
| `diff-cross.mjs` | **跨实现**比对 + 显式豁免表；`--update` 刷新 Electron 基线 |

两侧读**同一份 fixture**：JS 侧 `run.mjs`（`scripts/gen-update-key.mjs --verify` + `vendor/cli/account-cli.js` 复算哈希），
Rust 侧 `src-tauri/src/updater.rs::js_signed_manifest_verifies_in_rust`（`include_str!` 同一份 manifest）。

## 2. 日常用法

```powershell
# 固定向量（不需要图形界面）
npm run parity

# Tauri 侧回归基线（需要先 pwsh -File scripts/build.ps1）
npm run parity:channels           # dump + 与基线比对
npm run parity:channels:update    # 刷新基线（人工确认差异属预期后再提交）

# 跨实现：Electron 现役版 ↔ Tauri（本机需装有现役版）
npm run parity:cross
npm run parity:electron:update    # 刷新 Electron 基线（现役版升级属预期时）
```

`npm run parity:cross` = `driver-tauri` → `diff.mjs`（Tauri 自比）→ `driver-electron` → `diff.mjs`（Electron 自比）
→ `diff-cross.mjs`（跨实现）。本机实测约 **13 s** 跑完全部五步。
这一步已焊进 `scripts/build.ps1` 的第 10/11 步：本地 `pwsh -File scripts/build.ps1` 会连跨实现一起跑，
没装现役 Electron 的机器（含 CI runner）只跑第 10 步并把第 11 步**明确打印为跳过**，不会假装通过。

## 3. Electron 侧怎么做到的（现役版只读，未改一个字节）

现役版 `--smoke-test` 只产界面截图、不产通道 JSON。原计划是让上游加 3 处 hook，S5 换了个不碰源码的做法：

1. `driver-electron.mjs` 把现役 `dist/` 与 `scripts/` 复制到 `.parity-out/electron-harness/`，
   `node_modules` 用**目录联接（junction）**指向现役安装，不占磁盘；
2. 放一份自己的入口 `parity-main.js` → `parity-capture.js`：先劫持 `ipcMain.handle/on` 录下处理函数，
   再 `require("./dist/main/main/ipc.js").registerIpc()`，最后用**假 event** 逐个调用只读通道；
3. 通道清单取自 Tauri 侧冻结基线（保证两边同一份集合），`api` 名取自 `contract/ipc-channels.json`
   （现役 `window.api` 与契约同名，已验证）；
4. `app.whenReady()` + `EVEJS_PARITY_SETTLE_MS`（默认 2500 ms）等 handler 注册完，把回包原文写成
   `.parity-out/electron.json`（结构与 `tauri.json` 一致）。

> 试过但走不通的路：`NODE_OPTIONS=--require` 注入探针（本机策略直接拦）、`--remote-debugging-port` 调试口。
> 这两条都不需要了，`hooks/probe.js` 已删。

## 4. 归一化口径（`normalize.mjs`，唯一一处）

- 剔除 volatile 键：`pid/processId/ms/durationMs/startedAt/at/timestamp/updatedAt/fetchedAt/publishedAt/uptimeMs/windowBounds/…`
  （`windowBounds` 是用户拖出来的窗口状态，纯运行时持久化数据，永远不构成「实现差异」）；
- ISO 时间串 → `<timestamp>`；
- `C:\Users\<name>` → `<user-home>`；
- 盘符绝对路径 → `<abs-path>`：**按反斜杠分段**匹配，所以路径里的空格（本机仓库目录名就带空格）不会被截断，
  也不会把 `http://127.0.0.1:26002/` 误吃成 `htt<abs-path>`（旧写法就会，S5 修掉）；
- **按结构比对**的通道（载荷天生不稳定）：`log:read`、`metrics:get`、`accounts:checkRunning`（端口来自 netstat，随服务启停变化）、
  `services:list`、`init:state`、`database:overview`、`database:table` —— 只比键集合 + 值类型 + 数组元素形状。

## 5. 跨实现豁免表（`diff-cross.mjs` 的 `EXEMPTION_ROWS`）

只豁免**具体键**，每条必须写明理由；豁免后两侧都退化成空载荷（`{}` / `null`）也算一致（send 通道就是这种）。
脚本会打印这次真正命中的豁免，以及**未被触发**的条目（提示复核是否已可删除，避免豁免腐烂成遮羞布）。

当前 6 条：`app:info.version`、`log:read.reason`、`metrics:get.virtualMem{Total,Used}GB`、
`terminal:input.__parity`、`terminal:resize.__parity`、`update:state.{state,currentVersion,message}` ——
逐条理由见脚本里的注释（都指到代码/时序/测试手段，不写「已知差异」四个字）。

## 6. 基线与机器相关（已知限制）

`env:check` / 依赖版本 / 仓库路径 / 采样得到的系统值会随环境变：换机器、换仓库、升级 Node 之后
要重新 `npm run parity:channels:update`（跨实现那一半还要 `npm run parity:electron:update`）。
`diff-cross.mjs` 会先用冻结的 Electron 基线自查一遍「参考实现有没有漂移」，漂移直接红，
避免拿一个变了的参照物去比。

## 7. 还没落地

- 写通道的 golden：需要可回滚的沙箱仓库 + 快照/恢复，放到 L3 端到端流程里；
- SQLite：不比文件字节，改 `PRAGMA integrity_check` + 有序全表 dump（计划 §5.2 规则 3）；
- 82/82 全通道：现在覆盖的是 26 个**只读**通道；其余 56 个请求通道里写通道有副作用，
  由 `scripts/smoke-ipc.ps1` 的存在性断言 + `src-tauri` 单测覆盖，不在这套 golden 里。