# EvEJS Launcher · 开发与发布约定

本仓库是 **Tauri 2（Rust + 系统 WebView2）** 外壳 + **React/shadcn 界面** 的新框架启动器。
旧的 Electron 版源码不在 `main` 里，需要时用 tag `v0.1.28` 取。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src-tauri/` | Rust 外壳：服务管理、IPC（83 条通道）、模组、签名、更新器、旧数据接管 |
| `ui/` | React + shadcn/ui 界面（编译期嵌入 exe）；`ui/web/` 是随包分发的静态资源 |
| `vendor/` | 随包分发的 Node 侧车 CLI 与 Go 自更新器源码 |
| `contract/` | IPC 契约与固定向量，`scripts/gen-contract.mjs` 生成，禁止手改 |
| `tests/` | parity（跨实现固定向量）、e2e、契约与安全检查 |
| `docs/screenshots/` | README 用图 |

## 版本节奏

- 每累计 **8 个**独立、用户可感知的改动组成一个版本。
- 纯重构、格式化、测试脚本调整和内部依赖清理默认不计入；如果影响用户行为，则计入。
- 计数记录在 `release-notes/pending.json`。达到 8 项后，先发版本，不要继续堆叠。

## 达到 8 项后的流程

1. 提升版本号：根 `package.json`、`ui/package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，
   然后 `node scripts/sync-version.mjs --check` 必须通过。
2. 创建 `release-notes/vX.Y.Z.json`（`changelog.zh` / `changelog.en` 都要有，见下）。
3. 跑门禁：`npm run check`、`npm --prefix ui test`、`pwsh -File scripts/build.ps1`。
4. 提醒维护者提交与打标签，**不自动提交、不自动打标签**。
5. 提交信息里同时写中文与英文摘要，例如
   `release: v0.2.0 换用 Tauri 2 框架 / migrate to the Tauri 2 shell`。

## 更新日志格式

```text
release-notes/vX.Y.Z.json
```

```json
{
  "version": "0.2.0",
  "changelog": {
    "zh": [{ "type": "new", "text": "中文更新说明" }],
    "en": [{ "type": "new", "text": "English release note" }]
  }
}
```

- `type` 只能是 `new`、`fix`、`opt`。
- Git 提交记录只能作为缺少正式说明时的兜底，不能替代 `release-notes`。

## 发布红线（务必先读）

现役 **Electron 0.1.28** 的自动更新器读的是 `releases/latest/download/update-manifest.json`，
并且**只校验 sha256、不认 zip**。

> ⚠️ 发布新框架版本前必须先做通道隔离，三选一：
> ① 把 `src-tauri/src/updater.rs` 的默认清单地址切到 `releases/download/stable/update-manifest.json`
> 并在发布后移动 `stable` tag；② 给新 release 勾 **Pre-release**；
> ③ 在 v0.1.28 页面点 **Set as the latest release** 把 `latest` 钉死。
>
> 否则 `releases/latest` 指向 Tauri 的 zip 清单后，老用户的主程序会被 zip 字节替换而报废。
> 完整分析见本地 `docs/S7-发布与回滚-实施记录.md` §2（`docs/*.md` 不入库，只在维护者本机）。

其余发布检查单、灰度与回滚演练同样在该文档 §5 / §4。

## 代码约定

- 修改 IPC 通道后必须重新生成契约：`node scripts/extract-contract.mjs && node scripts/gen-contract.mjs`，
  然后 `npm run verify`。
- 渲染层产物 `ui/dist`、`ui/app-dist` 不进仓；打 exe 前必须先构建界面，否则 `--ui=react` 会白屏。
- 不要提交 `launcher.config.json`、`.keys/`、`artifacts/`、`.parity-out/`、`docs/*.md`、`assets/`（已在 .gitignore 中）。
- 维护者私钥只进 CI Secret，不进仓。