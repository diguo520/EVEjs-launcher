# S2 模组体系 · 实施记录（第一批：扫描 / 排序 / 启停 / 签名 / 打包 / 脚手架）

> 日期：2026-09-25
> 对应计划：`docs/Tauri2迁移执行计划.md` §4 第 8–12 项（模组体系，六个 TS 模块）
> 覆盖现役版：`modManager.ts` / `modSigner.ts` / `modPack.ts` / `modScaffold.ts`
> 结论：**模组核心（扫描 → 计划 → 启停 → 排序 → 卸载 → 签名 → ZIP 打包/导入/覆盖安装 →
> 脚手架与制作文档）已直译完成**，台账已实现通道 **48 → 65**；
> 静态契约、渲染层预检、Rust 单测 112/112、clippy 零告警、`cargo fmt --check` 全部通过。

> 待办（S3）：`modRegistry.ts`（市场索引 / 安装）、`modSubmit.ts` + `githubSubmit.ts` +
> `githubPublish.ts`（提交台账 / GitHub 发布）、`githubToken.ts`（令牌），共 **13 个通道**。

---

## 1. 本次销账的通道（HANDLED 48 → 65）

| 分组 | 通道 | 对应现役版 |
| --- | --- | --- |
| 列表 / 计划（2） | `mods:list`、`mods:plan` | `scanMods` / `planLoaders` |
| 单模组操作（5） | `mods:readme`、`mods:setEnabled`、`mods:setOrder`、`mods:uninstall`、`mods:sign` | `readModReadme` / `setModEnabled` / `setModOrder` / `uninstallMod` / `signModFolder` |
| 目录 / 文件（4） | `mods:createFolder`、`mods:openFolder`、`mods:openModFolder`、`mods:saveText` | `createModsFolder` / `shell.openPath` / `shell.showItemInFolder` |
| ZIP（1） | `mods:importZip` | `importModZip`（另含 `updateMod`，被市场安装复用） |
| 脚手架（5） | `mods:templates`、`mods:create`、`mods:authoringDoc`、`mods:authoringDocText`、`mods:openAuthoringDoc` | `modScaffold.ts` / `modManager.ts:1009-1079` |

`PLANNED` 由 34 降为 **17**（mods 13 + update 4），`verify-contract.mjs` 自动变为
「已实现 65 / 待实现 17 / 请求通道 82」。

---

## 2. 新增模块

| 文件 | 对应现役版 | 说明 |
| --- | --- | --- |
| `src-tauri/src/mods/sign.rs` | `modSigner.ts` | Ed25519 三态验签、信任表、canonical JSON、签名/验签；含**跨语言黄金夹具**（Node 现场签名逐字节一致） |
| `src-tauri/src/mods/scan.rs` | `modManager.ts` 前半 | 目录扫描、清单 schema 3 校验（文案逐条对齐）、四类冲突鉴定、统计 |
| `src-tauri/src/mods/plan.rs` | `modManager.ts` 中段 | 注入计划（拓扑排序）、启停、排序文件、卸载（回收站）、README、签名 |
| `src-tauri/src/mods/pkg.rs` | `modPack.ts` + `importModZip` / `updateMod` | ZIP 打包 / 导入 / 覆盖安装（保留用户数据 + 排序 + 启用状态） |
| `src-tauri/src/mods/scaffold.rs` | `modScaffold.ts` | 两个模板、id 规范化、loader 骨架生成、内置制作规范文档 |
| `src-tauri/src/mods/scaffold_loader.rs` | `modScaffold.ts::loaderFrom` | `loader.js` 骨架正文（**自动抽取，逐字节一致**） |
| `src-tauri/src/mods/desktop.rs` | `ipc.ts` 里的四个 handler | 打开 mods 目录 / 定位模组 / 选 ZIP / 另存为 |
| `src-tauri/src/dialog.rs` | Electron `dialog.showOpenDialog` / `showSaveDialog` | 手写 comdlg32 FFI（零依赖），必须主线程弹 |
| `src-tauri/src/shell.rs` | Electron `shell.showItemInFolder` / `trashItem` | 手写 `SHFileOperationW`（回收站）+ `explorer /select` |
| `scripts/extract-loader-skeleton.mjs` | — | 从现役版 TS 抽取 loader 骨架生成 Rust 常量（可重跑） |

---

## 3. 关键设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| S2-D10 | 作者私钥**用 DPAPI 加密落盘**，但**能读现役版明文 PEM** | 老用户升级后无需重新建身份；DPAPI 不可用时退化为写明文（与现役版等价） |
| S2-D11 | `author::read_identity` 只读，**不顺手生成密钥** | 现役版 `trustLocalAuthor` 会因「只是验签」而创建密钥，属副作用；生成只发生在 `author:get` 与显式调用处 |
| S2-D12 | 自己写 `dialog.rs` / `shell.rs`，**不引** `tauri-plugin-dialog` / `rfd` | 体积目标：两者会带进整棵 GTK/muda 依赖；本机只需 4 个 Win32 符号 |
| S2-D13 | 自己解析 ZIP 中央目录做 **A3 路径穿越防护** | `.NET Framework` 的 `Expand-Archive` 对穿越的历史行为不可依赖；解压前先断言条目名 |
| S2-D14 | 导入 / 覆盖更新统一用 `sanitize_folder_name(id)` 决定目录名 | 现役版导入用 `safeFolderName(id)`、更新用裸 `id`，id 含非法字符时两者会错位；统一后「已装」判断才可靠 |
| S2-D15 | `updateMod` 结果额外返回 `restored` / `keptAsNew` | 现役版算了却没用（死代码）；这两个字段只用于日志与调试，不额外暴露给渲染层接口 |
| S2-D16 | `loader.js` 骨架**不手抄**，用脚本从现役版抽取 | 骨架 100+ 行，三处关键写法删一处就「静默不生效」；抽取 + 单测锁行数，改坏会被测试挡住 |
| S2-D17 | `mods:authoringDoc` / `openAuthoringDoc` 缺省语言仍是**英文** | 现役版 `normalizeDocLang(undefined) === "en"`，属既有行为；本次**照搬**并在本文档标注，不静默「修好」 |
| S2-D18 | `Expand-Archive` 前用 `assert_zip_entries_safe` 统一把关（导入与更新两条路） | 更新路径现役版没有做这层校验，属本次加固 |

---

## 4. 与现役版的已知偏差（全部为「更严」或「去掉副作用」）

1. **A3**：`importZip` / `updateMod` 解压前拒绝 `..`、绝对路径、盘符、控制字符条目。
2. **A4**：`mods:openModFolder` 在 Rust 侧再次校验目录名（渲染层校验可被绕过）。
3. **只读身份**：见 S2-D11；没有身份时脚手架生成的清单不带 `author` 块，
   由后续 `mods:sign`（会补 `author` 块）补上。
4. **文档内嵌**：现役版从 `dist/renderer/MOD_AUTHORING*.md` 读，改为 `include_str!`
   进二进制 —— 没有「打包漏拷 → 文档打不开」这条失败路径。

---

## 5. 测试与门禁

- `cargo test --lib`：**112 passed / 0 failed**（本轮新增 20 条：mods 扫描 / 计划 / 签名 /
  打包导入 / 脚手架 / 文档释放 / 对话框与 shell 的布局断言）。
- `cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`：零告警。
- `node scripts/verify-contract.mjs`：**已实现 65 / 待实现 17 / 请求通道 82**。
- `node scripts/check-renderer.mjs`：4 个脚本语法通过。
- `scripts/smoke-ipc.ps1` 自检清单新增 `mods:list`、`mods:plan`、`mods:templates`
  三个只读通道（写通道只靠单测覆盖，避免自检改盘）。
---

## 6. S3 批次 A 销账（2026-09-26）

本模块的安全项在 S3 批次 A 全部关闭（明细见 `docs/S3-查重与审核-实施记录.md`）：

- **A2** 索引背书对账：`pkg.rs::check_index_endorsement` / `endorsement_from_index`；
  用例 `import_refuses_tampered_package_when_index_disagrees`（包内自称一律降级为「未签名」）。
- **A3** 解压条目安全检查新增**符号链接**拒绝，导入与更新两条路都走 `pkg.rs::assert_zip_entries_safe`；
  用例 `assert_zip_entries_safe_rejects_traversal_and_symlinks`。
- **B1** 路径前缀绕过：新增 `mods/mod.rs::contains_path`（组件级比较）/ `join_within`（白名单名 + 包含断言），
  本模块所有目录拼接（`plan.rs` / `pkg.rs` / `registry.rs` / `desktop.rs` / `submit.rs` / `scaffold.rs`）统一走它，
  并删掉重复实现 `plan.rs::folder_arg`；用例 `contains_path_uses_components_not_string_prefix`、`join_within_rejects_escapes`。
- **查重**：`MOD_SOURCE_FILE`（`.evejs-source.json`）原先在 `scan.rs` 与 `registry.rs` 各声明一份，
  S3 批次 B 上移到 `mods/mod.rs` 单一来源（`scripts/audit-dedup.mjs` 会持续断言）。
---

## 7. 脚手架对齐复核（2026-09-28）

创建模组的「预设模板 + 生成文件」做了一轮逐字节复核，并给 `mods:templates` 补了两个只读读数：

- **清单键序对齐**：`scaffold.rs::manifest_from` 改成按 `#[derive(Serialize)]` 的字段顺序输出
  （`ScaffoldManifest` / `ScaffoldAuthor` / `ScaffoldCompatibility`），与现役版
  `JSON.stringify(manifest, null, 2)` 的插入顺序一致。此前经 `serde_json::Value`（Map 默认按字母序）
  输出，语义相同但和现役版 diff 不齐。
- **`mods:templates` 新增 `fileCount` / `sizeBytes`**：`sizeBytes` 用示例 draft
  （`your-mod-id` / `Your Mod Name` / 示例身份 / `0.12.8`）走**同一条生成管线**量出真实字节数
  （broadcast 7377 B、blank 5585 B），渲染层用它替掉原型里写死的假体积。
  跨实现比对在 `tests/parity/diff-cross.mjs` 的 `EXEMPTION_ROWS` 里对这两项写明理由后放行
  （现役版没有、也不该有这两项）。
- **逐字节复核证据**：把现役版 `modScaffold.ts` 用 `typescript` 转译后在桩环境里跑 `createMod`
  （桩掉 runtimePaths / modManager / authorStore），与本机 Tauri 侧 `mods:create` 的产物对比 ——
  `blank` 与 `broadcast` 两套模板的四个文件（`evejs-launcher.mod.json` / `loader.js.disabled` /
  `README.md` / `CHANGELOG.md`）SHA256 全部一致。`scaffold_loader.rs` 同时用
  `scripts/extract-loader-skeleton.mjs` 重抽比对，仍是逐字节一致。
