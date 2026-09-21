# EveJS 启动器 — 作者身份 / 创建模组 / 提交模组 / 模组市场 实施计划（v3.1 决策已定稿）

> **v3.1** = v3 基础上落实 2026-09-21 你拍板的 6 条决策（见 §0.1），并把实测发现的**现有 6 个真实模组的 manifest 约定**纳入兼容范围。
> v1 = `.trae/documents/launcher-mod-signing-and-marketplace.md`（已废弃）；v2 = 本文件上一版。

---

## 0. 相对 v1 的修订清单

| # | 问题 | v1 写法 | 现在改成 | 原因（已实测） |
|---|---|---|---|---|
| 1 | **改错文件（致命）** | UI 改动指向 `assets/evejs-launcher/eve-launcher.html` | 一律改 `src/renderer/public/eve-launcher.html` | `vite.config.ts` 的 `root=src/renderer`、`publicDir` 默认 `<root>/public`；`src/main/index.ts:128` 加载 `renderer/eve-launcher.html`；`electron-builder.yml` 只打包 `dist/**/*`。**`assets/evejs-launcher/` 已按决策删除**（见 §0.1-5） |
| 2 | **"更新"必然失败（致命）** | 阶段 E 写"覆盖安装" | 新增 `updateMod()`：备份 → 导入 → 还原状态（§8.1） | `modManager.ts` 的 `importModZip` 有硬门槛 `if (fs.existsSync(target)) return { ok:false, reason:"已存在同名模组目录：" + folder }` |
| 3 | **刷新即发网络请求** | `refreshModsStatus()` 里同步拉索引 | 缓存 + TTL + 手动"检查更新" + 后台异步（§7.3） | 离线时按镜像逐个超时会卡死模组页 |
| 4 | **版本比较未定义** | "比对本地 version" | semver 比较 + 防降级（§7.5） | `1.10.0` vs `1.9.0` 字符串比较会判错 |
| 5 | **镜像方案不可行** | Gitee Pages 做索引镜像 | GitHub Pages + jsDelivr + Gitee **Releases**（§7.0） | Gitee Pages 免费服务对新用户已关闭 |
| 6 | **安全定位错误** | HMAC + 运行时 Token，称"提高门槛" | **Ed25519 非对称签名**；删掉运行时 Token 层（§9） | HMAC 密钥编译在启动器里、签名动作也由启动器提供 → 对恶意作者防护为 0；Token 会被作者明文写进 loader.js |
| 7 | **运维地雷** | "版本升级改常量即可让旧签名失效" | 签名密钥跨版本稳定，轮换走 keyring（§9.4） | 每次发版会让社区已签名模组被 `planLoaders` 静默跳过 |
| 8 | **签名对象选错** | 只签 mod manifest | 额外给 `mod-index.json` 签名（§7.2） | SHA256 也在索引里，谁拿下索引仓库就能换包 + 换哈希 |
| 9 | 打包方式 | `Compress-Archive` | .NET `ZipFile::CreateFromDirectory` | 部分 PowerShell 版本用 `\` 当 ZIP 内分隔符 |
| 10 | 未覆盖 eve-console | 完全没提 | 见 §2：取数据模型与交互，**不搬 React/Tailwind 运行时** | `assets/eve-console` 是独立 React 原型，数据在 localStorage、市场是假种子、审核进度是模拟值、模板是 Lua 风格 |
| 11 | **（v3.1 新增）遗漏现有 manifest 约定** | 完全没提 | 兼容 `supportedBackends` / `compatibility.evejsVersions` / `updates` / `launcherApi` / `settings`（§1.2） | 实测 `mods/` 下 6 个真实模组已在用这些字段，方案不能与之冲突 |

---

## 0.1 已定决策（2026-09-21）

| # | 决策 | 结果 |
|---|---|---|
| 1 | 创建模组的模板集 | **以我们跑通的示例（`mods/welcome-mod`）为唯一基准**；模板内容直接取自 `MOD_AUTHORING.md` §6「完整骨架」，不改用 console 的 Lua 模板（§4） |
| 2 | 索引仓库名 | **`diguo520/EVEjs-mods`**（写进默认 `modIndexUrls`） |
| 3 | 私钥导入 | **允许导入**（导出 `.eve-key` + 导入还原身份，§3.3） |
| 4 | "官方 MOD"徽章 | **不做** —— 没有官方 MOD，全是社区模组作者。索引签名保留，但那是**索引本身的真实性**，不是"模组官方认证"（§9.1） |
| 5 | `assets/evejs-launcher/` | **已删除**（删除前已确认全仓库无任何引用；仅本文档提到过它） |
| 6 | 托管 / 服务器 | **不需要任何服务器**：索引走 GitHub Pages + jsDelivr，ZIP 由作者自托管，完整性靠索引里的 sha256（详见 **§7.0**） |
| 7 | 提交方式 | **用 GitHub API 自动建 PR**（作者用自己的 PAT：fork 索引仓库 → 建分支 → 提交分片 → 向主仓库开 PR，详见 **§5.4**） |
| 8 | 私钥导出格式 | **`.eve-key` = 注释头（id / keyId / 署名 / since / createdAt）+ PEM 私钥**（§3.4 已实现） |

---

## 1. 现状核对（已实测）

### 1.1 启动器侧

| 项 | 现状 |
|---|---|
| 模组核心 | `src/main/modManager.ts`：`modsRoot/readModOrder/setModOrder/readModDir/scanMods/planLoaders/setModEnabled/createModsFolder/ensureModAuthoringDoc/importModZip` 均为 `export` |
| 模组 IPC | `src/main/ipc.ts:469-510`：`mods:list` / `plan` / `setEnabled` / `createFolder` / `importZip`（**无参数，内部弹框**）/ `setOrder` / `authoringDoc` / `openAuthoringDoc` / `openFolder` |
| 注入点 | `src/main/processManager.ts` 的 `baseEnv()`；`startMainServer()` 在 `env.NODE_OPTIONS` 拼 `--require "<loader>"` |
| 运行时目录 | `src/main/runtimePaths.ts`：`_launcher/` 下 `data/ cache/ temp/ logs/ crash/`；`src/main/index.ts:15-20` 已把 `app.setPath("userData" → _launcher/data)` 等全部重定向 |
| 设置落盘 | `configStore.ts:145` → `_launcher/data/launcher-settings.json` |
| 下载器模板 | `src/main/updater.ts` 的 `downloadToFile()`（流式 + SHA256 + 进度） |
| ZIP | `modManager.ts:675` 用 `powershell.exe Expand-Archive` 解压 |
| **真实 UI 文件** | **`src/renderer/public/eve-launcher.html`** + `src/renderer/public/launcher-bridge.js` |
| 作者文档 | `src/renderer/public/MOD_AUTHORING.md`（18.9KB，构建后释放到 `_launcher/mods/`） |
| `assets/` 现状 | 只剩 `eve-console/` + `paypal.png` / `shoukuanma.png` / `wechat.png`（`evejs-launcher/` 已删） |

### 1.2 现有真实模组（**关键：这是兼容基线**）

`E:\Games\EveJS-v0.12.8\mods\` 下 6 个模组，全部 `schemaVersion: 3`、`kind: "loader"`、`activation.strategy: "loader_rename"`：

| 模组 | id | 版本 | 已用到的 manifest 字段 |
|---|---|---|---|
| `welcome-mod`（**我们的基准示例**） | `welcome-mod` | 1.0.0 | `supportedBackends` / `activation` / `restart` |
| `EveJS-CNText-Fix` | `evejs-cntext-fix` | 1.0.3 | + `compatibility.evejsVersions` |
| `EveJS-SanshaIncursion` | `evejs-sansha-incursion` | 1.0.0 | + `compatibility.evejsVersions`（含 `lib/patches/*.json` 运行时补丁） |
| `AutoLockFire` | `evejs-autolockfire` | 1.0.3 | + `compatibility`（含 `client/` Python 内存投递） |
| `AutoMining` | `automining` | 1.0.7 | + `launcherApi`（`helper.js` + capabilities）/ `updates`（`provider: github` + `repository` + `asset: "{version}.zip"` + `tagPrefix`）/ `settings`（schema + 字段表） |

**必须遵守的三条兼容铁律**：
1. 新增字段（`author` / `category` / `tags` / `signature`）**全部可选**，6 个老模组一个都不能坏
2. `readModDir` 的校验**不得因为未知字段而拒绝**（现有实现不拒绝，保持）
3. 市场索引**必须能表达** `updates` / `launcherApi` / `settings` 的存在（§7.4），不能与它们冲突

### 1.3 `MOD_AUTHORING.md` 已有结构（模板的来源）

`§1 目录结构` / `§2 清单字段表` / `§3 四种 kind` / `§4 loader 注入原理`（4.2 会被加载多次务必身份校验 / 4.3 不要直接 require 服务端大模块）/ `§5 可用服务端接口`（5.1 sessionRegistry / 5.2 chatHub / 5.3 会话属性坑 / 5.4 上线宽限期）/ **`§6 完整骨架（可直接改用）`** / `§7 冲突与加载顺序` / `§8 分发与 ZIP 导入` / `§9 开发与调试流程` / `§10 发布与更新（规划中）` / `§11 发布前检查表`

→ **`§6 完整骨架` 就是创建模组的模板源**（决策 1）。

---

## 2. 与 eve-console 的整合边界

| console 的原型能力 | 真实启动器怎么做 |
|---|---|
| 三页签（已安装 / 我创建的 / 模组市场）+ 三动作（创建模组 / 提交模组 / 作者身份） | **照搬交互与文案**，用现有 DOM/CSS 重写 |
| `AuthorProfile`（localStorage 字符串 id） | 升级为 **Ed25519 密钥身份**（§3） |
| `CreateModDialog`（只写 localStorage） | **真的往 `mods/<id>/` 落盘**（§4） |
| `SubmitModDialog`（模拟审核进度 0–100） | 真流程：签名 → 打包 → sha256 → 索引草稿 → PR（§5） |
| 市场假种子（星门加速 / 市场深度扩展…） | **签名索引**（§7） |
| `buildMyMods`（前端推导） | 三源合并的真实状态机（§6） |
| `ModReview` / `myReview` / `baseRating` | **不做**（需服务端）；只读索引里的 `rating` / `ratingCount` |
| React / Tailwind / Radix 运行时 | **不搬**（会多 ~1MB 依赖 + 两套视觉语言），组件改写成现有渲染函数 |

`assets/eve-console/` **保留作设计参考**（含单文件版 `新伊甸指挥台.html`），但**绝不接入** `vite` / `electron-builder` 输入。

---

## 3. 作者身份（Author Identity）

### 3.1 设计

console 的身份只是"一串自己生成的 id"，认回靠粘贴 id —— 那只能"登记"，不能"证明"。真实启动器把它升级成**密钥身份**：

| console | 真实启动器 |
|---|---|
| `AuthorProfile { id, name, since }` 存 localStorage | `_launcher/data/author.json`：同结构 + `keyId` / `publicKey` / `privateKeyPath` |
| 粘贴 id 认回身份 | **导出/导入 `.eve-key` 密钥文件**（决策 3：允许导入） |
| — | Ed25519 密钥对；`keyId` = 公钥 SHA256 指纹前 12 位 |
| 改名同步刷名下模组的显示名 | 保留，且因 `author.name` 在签名范围内 → **改名 = 批量重签**（§3.3） |

`au-` id 格式保留（`au-` + base36 毫秒时间戳 + 4 位随机尾缀，可从 id 反推 `since`）。
**`id` 是登记标识（"这是谁的模组"），`keyId`/签名才是凭据（"这真是他发的"）。**

### 3.2 落盘结构

```
_launcher/data/
  author.json          # { id, name, since, keyId, publicKey, privateKeyPath }
  mod-keys/
    <keyId>.key        # Ed25519 私钥（PEM，0600），永不外传、永不打包
```

```jsonc
// author.json
{
  "id": "au-m1x2y3abcd",
  "name": "指挥官",
  "since": 1789000000000,
  "keyId": "9f3c1a77b2e4",
  "publicKey": "<base64 raw ed25519 pubkey>",
  "privateKeyPath": "mod-keys/9f3c1a77b2e4.key"
}
```

### 3.3 功能点

| 操作 | 行为 |
|---|---|
| 首次打开「作者身份」 | 自动生成 id + Ed25519 密钥对；提示"私钥仅存本机，请导出备份" |
| 改署名 | 写 `author.json`，并**批量**更新 `mods/*/evejs-launcher.mod.json` 的 `author.name` 后**重新签名** |
| **导出密钥** | 导出 `<keyId>.eve-key`（含私钥，明文，强警告）→ 换机/重装 |
| **导入密钥** | 选 `.eve-key` → 写回 `author.json` + `mod-keys/`，`id` 与 `keyId` 一起还原（**决策 3：已允许**） |
| 复制标识 | 复制 `id`（索引登记用）与**公钥指纹**（人工核对用）；**不复制私钥** |
| 名下统计 | 已上架 / 待合并 PR / 本地未上架（对应 console `AuthorDialog` 概览） |

### 3.4 `.eve-key` 文件格式（已实现）

```text
# EveJS Launcher Author Key v1
# 警告：本文件包含私钥，请勿分享给任何人。
# 丢失后无法再以同一 keyId 签发更新；导入本文件即可在新机器上还原这个身份。
# id: au-mubcko7ik6mp
# name: 指挥官
# keyId: 80476115ef4e
# since: 1790001328014
# createdAt: 2026-09-21T14:35:28.077Z
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

导入时的校验（已实现并测试）：
- 必须是有效 PEM 且 `asymmetricKeyType === "ed25519"`，否则拒绝
- 头里的 `keyId` 必须与**私钥实际指纹**一致，不一致直接拒绝（防张冠李戴）
- 头里缺 `id` 时自动补一个新的 `au-` id；`name` / `since` 从注释头还原
- 覆盖前把现有 `author.json` 与私钥文件改名成 `*.bak`，可回滚

---

## 4. 创建模组（真实脚手架落盘）

### 4.1 模板：**以 `mods/welcome-mod` 为唯一基准**（决策 1）

不做 console 的 Lua 模板。模板内容 = `MOD_AUTHORING.md §6 完整骨架` = `welcome-mod` 的写法。

**默认模板「服务端 loader 模组」生成：**

```
mods/<id>/
  evejs-launcher.mod.json     # schema 3 清单（含新加的 author 块）
  loader.js                   # 骨架：身份校验 + 等 require.cache + 业务钩子占位
  README.md                   # 由表单的"详细介绍 / 功能要点"生成
  CHANGELOG.md                # 首版记录
```

`loader.js` 骨架必须**保留 welcome-mod 里那几处关键技巧**（这是跑通的关键，缺一个就会静默失效或内存暴涨）：

| 技巧 | 作用 |
|---|---|
| `setImmediate` + `require.main.filename` 判断（`/index\.js$/` 或 `EVEJS_GAMESTORE_OWNER_ROLE === "world"`） | `NODE_OPTIONS` 会被 npm → autostart.js → 真服务端继承多次，**只在真服务端进程里启动逻辑** |
| `globalThis.__evejsXxx` 守卫 | 防止重复初始化 |
| **不直接 `require` 服务端大模块**，而是轮询 `require.cache` 等服务端自己加载完再取引用 | 避免把 456MB/645 模块的依赖图提前拉起（就是当初"node 内存暴涨"的原因） |
| `timer.unref()` | 不阻止进程退出 |
| 会话属性坑补丁（`session.characterID` 小写 `charid`） | 否则 `sendSystemMessage` **静默不发送** |
| 上线宽限期（GRACE_MS） | 避开"聊天子系统还没就绪"的窗口 |

**「进阶模板」延后**（本轮不做，等有需求再加）：客户端内存投递（`AutoLockFire` / `AutoMining` 风格）、运行时补丁（`EveJS-CNText-Fix` / `EveJS-SanshaIncursion` 的 `lib/patches/*.json`）。原因是这两类各有独立的注入协议，先把 loader 这一类做扎实。

### 4.2 单一模板源（避免文档与代码不同步）

把骨架文件内容抽到**一处**：`src/main/modScaffold.ts` 里的模板常量，
同时 `MOD_AUTHORING.md §6` 由构建脚本从同一份常量生成（或反过来），**保证"文档里看到的骨架" = "创建出来的文件"**。

### 4.3 表单字段 → manifest 映射

| 表单 | manifest 字段 |
|---|---|
| 模组名 | `displayName` |
| 标识（`slugifyModId` 自动生成，可改） | `id` |
| 版本（默认 `1.0.0`） | `version` |
| 分类 / 标签 | `category` / `tags`（**新增可选字段**） |
| 简介 | `description` |
| 详细介绍（分段）/ 功能要点 | 写进 `README.md` |
| 冲突模组（多选） | `conflicts` |
| 需要重启服务端 | `restart: "game_server"` |
| 署名 / 作者标识 | `author { id, name, keyId }`（**新增可选字段**，取自 §3） |
| 支持的运行方式 | `supportedBackends: ["native","docker"]`（默认，与现有模组一致） |
| 兼容的 EveJS 版本 | `compatibility.evejsVersions`（从当前服务端版本预填） |
| 源码地址 | `repo`（登记用） |
| 两个开关 | 建好后**立即启用** / 建好后**立即签名**（console 的 `publish` 开关 → 改成"立即走提交流程"） |

### 4.4 落盘安全

- `id` 复用 `safeFolderName()` 清洗；`mods/<id>` 已存在 → 明确报错，**不覆盖**
- 先建到 `_launcher/temp/scaffold-<id>/` 校验，再整体移入 `mods/`
- 写出的 manifest 必须能被 `readModDir` 一次通过（含 `author` 块）

---

## 5. 提交模组（打包 + 索引草稿）

### 5.1 console 的做法 vs 真实做法

| console | 真实启动器 |
|---|---|
| `status: pending / reviewing / published` | `draft`（已生成待提交包）/ `submitted`（PR 已开，等合并）/ `listed`（索引已收录且 `authorId` 匹配）/ `delisted` |
| `progress: 0–100` | **删除**；改为展示 PR 链接 / 生成时间 / 体积 / SHA256 |
| 自动变 published | 「检查是否已收录」→ 命中索引则自动转 `listed` |

### 5.2 提交流程（前 4 步完全可离线）

1. 选本地模组（来自 `mods/` 中 `author.id === 本机 id` 的条目）
2. 填/确认上架资料 + `changelog` 更新说明
3. **签名**（未签名或内容有变 → 用本机私钥重签）
4. **打包** → `_launcher/temp/export-<id>-<version>.zip`，算 `sha256` / `sizeBytes`
5. **生成索引条目草稿**（JSON 片段，§7.2 格式）
6. **通过 GitHub API 自动开 PR**（§5.4）：fork 索引仓库 → 建分支 → 提交分片文件 → 向主仓库开 PR；失败时降级为「打开 PR 页面 + 复制草稿」

### 5.3 本机提交台账 `_launcher/data/my-submissions.json`

```jsonc
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "welcome-mod",
      "version": "1.1.0",
      "changelog": "修了登录广播重复发送",
      "zipPath": "temp/export-welcome-mod-1.1.0.zip",
      "sha256": "<hex>",
      "sizeBytes": 12345,
      "downloadUrls": [],          // 作者自己填（他托管的 GitHub/Gitee Release 直链）
      "indexDraft": { /* 可直接贴进 mod-index.json 的条目 */ },
      "status": "draft",           // draft | submitted | listed | delisted
      "prUrl": "",
      "createdAt": 1789000000000
    }
  ]
}
```

- 「撤回提交」= 提示去关 PR（给链接），状态退回 `draft`
- 「下架」= 生成 `delisted: true` 的索引 PR 草稿（条目仍在，别人看不到，作者可见 → 沿用 console 语义）
- 「提新版」= 对已上架条目再走 1–6 步

### 5.4 提交流程（决策 7 修订版）：作者发布到**自己的仓库**

> ⚠️ 这一节在实现时被修正过。原方案是「每个作者 fork 索引仓库 → 改 `mods/<id>.json` → 向索引仓库提 PR」，
> 但社区有成百上千作者，那样会产生**每人一个 fork + 每个版本一个 PR**，维护者会成为瓶颈。
> 现在改成：**作者发到自己的仓库；索引仓库只登记一次；索引由 CI 聚合生成。**

```
作者侧（每个版本都做，不需要任何人审核）
  ① 启动器本地：重签 → 打包 ZIP → 算 sha256 → 生成上架清单 evejs-mod.json
  ② 推到自己仓库：确保仓库存在 → 写 evejs-mod.json → 建 Release(vX.Y.Z) → 上传 ZIP
     下载地址是确定性的：
       https://github.com/<作者>/<仓库>/releases/download/v<版本>/<id>-<版本>.zip

收录（**只有第一次**需要，一次性）
  ③ 往索引仓库的 sources.json 加一行 `<作者>/<仓库>`（PR 一次，之后永不重复）

索引侧（自动）
  ④ 索引仓库的 CI 定时抓 sources.json 里每个仓库的 evejs-mod.json
     校验 → 合并 → 生成 mod-index.json → 用仓库 secret 里的私钥签名 → 发布到 GitHub Pages
```

**这样分工之后**：版本更新**零 PR、零审核**；维护者只在「新作者加入」时处理一次；ZIP 存储与带宽全在作者自己仓库；
客户端依旧只拉一个签名的 `mod-index.json`（用 jsDelivr 镜像 + 本地缓存兜底）。

**为什么 PAT 只需要作者自己的权限**：`POST /user/repos` 建库、`PUT contents` 写 `evejs-mod.json`、`POST releases` + `uploads.github.com` 传 ZIP —— 全都落在作者自己的仓库里，
**不需要索引仓库的任何写权限**。只有第 ③ 步（收录）才会建索引仓库的 fork 并开 PR。

**PAT 存放**（已实现）：Electron `safeStorage`（Windows DPAPI）加密后存 `_launcher/data/github-token.bin`；
`safeStorage` 不可用时**只放内存**并明确提示。权限最小化：fine-grained PAT，只要自己仓库的 **Contents: Read and write**（+ 收录时需要 Pull requests: Read and write）。

**失败降级**：仓库建好了但 ZIP 传失败 → 回传仓库与 Release 地址，提示「手动把 ZIP 传到 Release 即可」；
开 PR 失败（收录步骤）→ 回传 `compareUrl`，让用户点「打开 PR 页面」手动提交。

**分片与 CI 约定**：`sources.json` 是一行一个仓库的清单；每个被收录的仓库根目录放 `evejs-mod.json`（内容 = 索引条目的完整字段，含 `sha256` 与 `downloadUrls`）。
索引条目的 `author` 块**必须带 `publicKey`** —— 客户端在验过索引签名之后，才能信任这些作者公钥去校验各自模组的签名（`modSigner.trustPublicKey`）。

**索引仓库需要放的东西**（待你建仓库时创建）：`sources.json`、`README.md`（收录规范）、`.github/workflows/build-index.yml`（聚合+签名）。

---

## 6. 我创建的（作者名下模组）

三源合并（替换 console 的前端推导 `buildMyMods`）：

| 来源 | 判据 |
|---|---|
| `mods/` 本地扫描 | `manifest.author.id === 本机 authorId` |
| 市场索引 | 条目 `authorId === 本机 authorId`（含 `delisted`） |
| `my-submissions.json` | 本机待提交/已提交记录 |

| 状态 | 含义 |
|---|---|
| `local` | 只在本地，未提交 |
| `draft` | 已生成待提交包 |
| `submitted` | PR 已开、等合并 |
| `listed` | 索引已收录 |
| `delisted` | 作者已下架 |
| `update-pending` | 本地版本 > 已上架版本 |

动作（沿用 console `MyModList`）：编辑资料（**改完必须重签**）/ 提新版 / 上架 / 下架 / 撤回提交 / **导出 CSV**（表头：名称·署名·版本·分类·状态·体积·下载量·更新时间）。
排序沿用 console：在审 → 在架 → 下架 → 未上架。

---

## 7. 模组市场

### 7.0 托管模型：**不需要任何服务器**（决策 6 的建议）

```
【你维护】索引仓库  github.com/diguo520/EVEjs-mods
   ├─ mod-index.json       ← 全生态唯一的"目录"，只有几十 KB
   ├─ mod-index.sig         ← 官方索引签名（Ed25519）
   └─ README.md             ← 收录规范 + PR 模板
   托管：GitHub Pages（免费静态） + jsDelivr 镜像

【作者自己托管】模组 ZIP
   ├─ GitHub Releases（主）
   ├─ Gitee Releases（国内镜像 —— 收录规范里要求至少有一个国内可直达的）
   └─ 或任意 https 直链

【你的另一个仓库】EVEjs-launcher.exe 发行版（已有 CI 流程，不变）
```

**为什么不需要服务器：**

1. 索引是**静态 JSON** → GitHub Pages / jsDelivr 免费静态托管，你没有后端要运维
2. ZIP 二进制由**作者自己托管** → 你不承担存储与带宽
3. 完整性由 **sha256** 保证（写在索引里，且索引由你签名）→ 作者换包能被发现
4. 一个链接挂了 → 自动回退下一个镜像（`downloadUrls[]` 带 `priority`）

**下载源解析顺序：**

1. 索引条目的 `downloadUrls[]`（按 `priority` 升序尝试）
2. 索引没给 / 全部失效 → **回退到已安装模组 manifest 的 `updates` 块**（`provider: github` + `repository` + `asset: "Name-{version}.zip"` + `tagPrefix`）—— 这条对**更新**场景有效（本地已有 manifest，`AutoMining` 就在用）
3. 全失败 → 明确提示"作者未提供可用下载源"，卡片置灰

**链接失效怎么处理：** 索引 PR 把该条目标 `delisted: true`（保留历史、不再展示；已安装的本地副本不受影响），并在条目里保留 `repo` 便于作者回归。

**要诚实说的现实问题：** 国内访问 GitHub Releases 经常很慢或直接失败。所以**收录规范里把"至少一个国内可直达的镜像 URL"作为硬性门槛**（通常就是 Gitee Releases）。索引本身很小，GitHub Pages + jsDelivr 一般够用。

**将来想自己托管也不用重构：** `downloadUrls[]` 是数组，只要往里加一条你自己的 URL 就行，**schema 不用改**。这就是"现在不需要服务器、将来想上也不用重做"的保障。

### 7.1 索引地址与镜像

| 用途 | 方案 |
|---|---|
| 索引主源 | `https://diguo520.github.io/EVEjs-mods/mod-index.json` |
| 索引镜像 | `https://cdn.jsdelivr.net/gh/diguo520/EVEjs-mods@main/mod-index.json` |
| 索引兜底 | 本地缓存 `_launcher/cache/mod-index.json`（全失败时用最后一份，界面标注"离线/缓存"） |

优先级：`process.env.EVEJS_MOD_INDEX_URL` → `launcher-settings.json` 的 `modIndexUrls[]` → 内置默认（上面两条）。

### 7.2 `mod-index.json`（带索引签名）

> 注意：`mod-index.json` 是 **CI 合并产物**，作者只提交 `mods/<id>.json` 分片（原因见 §5.4）。下面展示的是合并后的形态。

```jsonc
{
  "schemaVersion": 1,
  "publishedAt": "2026-09-21T08:00:00Z",
  "mods": [
    {
      "id": "welcome-mod",
      "displayName": "欢迎广播",
      "author": { "id": "au-m1x2y3abcd", "name": "指挥官", "keyId": "9f3c1a77b2e4" },
      "version": "1.1.0",
      "category": "玩法",
      "tags": ["聊天", "新手"],
      "description": "玩家登录 10 秒后在本地频道发送欢迎消息",
      "readme": ["...分段介绍..."],
      "highlights": ["..."],
      "conflicts": [],
      "requiresRestart": true,
      "evejsVersions": ["0.12.x"],
      "sizeBytes": 12345,
      "sha256": "<zip 的 sha256 hex>",
      "downloadUrls": [
        { "mirror": "github", "url": "https://github.com/.../welcome-mod-1.1.0.zip", "priority": 1 },
        { "mirror": "gitee",  "url": "https://gitee.com/.../welcome-mod-1.1.0.zip",  "priority": 2 }
      ],
      "rating": 4.6, "ratingCount": 12,       // 只读聚合值（M1 不支持用户打分）
      "changelog": "修了登录广播重复发送",
      "history": [{ "version": "1.0.0", "changelog": "首个版本", "at": 1788000000000 }],
      "repo": "https://github.com/diguo520/welcome-mod",
      "featured": false,
      "delisted": false,
      "publishedAt": "2026-09-21"
    }
  ],
  "signature": { "alg": "ed25519", "keyId": "index-2026", "sig": "<base64>" }
}
```

**启动器必须先验索引签名，再信任里面的任何 `sha256` / `downloadUrls`；验签失败 → 整个市场不可用并明确报错，不降级。**

### 7.3 缓存与刷新

- 拉取成功写 `_launcher/cache/mod-index.json`（带 `fetchedAt`）；TTL **30 分钟**
- `refreshModsStatus()` **不**发请求；进入模组页且已过期才后台异步拉
- 手动「检查更新」按钮：忽略 TTL 强制拉 + 重新比对
- 单镜像超时用 `AbortController`（`net.fetch` 没有 `timeout` 选项）：镜像 5s、总预算 12s

### 7.4 交互（沿用 console 的组件形态）

| console 组件 | 移植为 | 说明 |
|---|---|---|
| `MarketStats` | 统计条 | 在架 / 可更新 / 已装 / 冲突 |
| `MarketToolbar` | 搜索 + 分类/标签筛选 | 复用现有 `.mod-toolbar` 样式 |
| `MarketGrid` + `MarketCard` | 卡片网格 | 角标：可安装 / 已安装 / 可更新 / **我的**（按 `authorId`） |
| `MarketDetailDialog` | 详情弹窗 | 分段 readme / 功能要点 / 本次更新 / 历史版本 / 冲突 / 需重启 / 体积 / SHA256 / 作者(署名+id) / 仓库 |
| `MarketInstallQueue` | 安装队列 | 进度条 + 取消；`InstallTask.mode: install|update` |
| `ModSubmissionsPanel` | 归入"我创建的" | 市场页不再单独列"审核中"，避免与 §6 重复 |

**新增并纳入详情展示（来自 §1.2 的实测发现）：**
- 若 manifest/索引带 `settings` → 卡片标「可配置」，详情里展示字段数与「在已安装页配置」入口
- 若带 `launcherApi.helper` → 卡片标「有安装助手」，安装/更新时按 `capabilities` 调用 `helper.js`
- 若带 `updates` → 详情里显示更新渠道（`provider/repository`），并作为 §7.0 的下载回退源

### 7.5 下载 / 安装 / 更新

- 下载到 `_launcher/temp/market/<id>-<version>.zip`；完成后校验 `sha256`，不匹配则删除并报错
- 镜像按 `priority` 升序，失败自动回退
- `evejsVersions` **必须真正校验**：不满足 → 卡片标注"与当前 EveJS 版本不兼容"并禁用下载
- 版本比较用 **semver**：远程 > 本地 → 可更新；相等 → 无徽章；远程 < 本地 → 标"本地版本更新（开发版）"且**不给更新按钮**（防降级）
- 已装同 id → 调 **`updateMod()`**（§8.1），不是 `importModZip()`
- 下载后**默认禁用**；首次启用弹确认框（作者 / 来源镜像 / SHA256 / 版本）

### 7.6 收录规范（写进索引仓库 README，由你在 PR 里人工过）

**归属三原则（必须由 CI 强制执行，这是防「抢注/改署名」的唯一有效手段）**：

1. **`id` 全局唯一、先到先得**：某个 `id` 第一次由来源仓库 `<owner>/<repo>` 注册后，**只有那个仓库能更新它**；
   其他来源提交同一个 `id` → CI 直接拒绝。这就是 npm 的 namespace 模型 —— 与其说是防篡改，不如说是**没有第二个位置可以冒充**。
2. **`author.id` ↔ 公钥 绑定**：同一个 `author.id` 第一次注册时记录的 `keyId`/`publicKey` 固定；
   之后出现「同一个 `author.id` 但换了 `keyId`」的条目 → 拒绝（防止借别人的作者标识）。
3. **来源可见 + 客户端比对**：市场条目展示 `owner/repo`；启动器安装时把来源记进 `my-submissions.json`，
   若同 id 条目的来源与已记录的不一致 → 明确警告「同名模组来自不同来源」。

- manifest 合法、`sha256` 与 `sizeBytes` 齐全、**至少一个可用的 GitHub Releases 直链**（当前只要求 GitHub）
- 条目必须带 `author.id`（认人）与 `author.name`（展示）
- 不审代码安全性（做不到）；要求作者在条目里如实写明用途与冲突
- 首次启用时启动器给玩家风险提示 —— 模组是 `NODE_OPTIONS --require` 注入的**任意 JS 执行**，等同玩家机器上的完整权限

---

## 8. 已安装页

**不新增后端能力**，只借鉴 console 的呈现：

- 统计卡（总数 / 已启用 / 已停用 / 冲突 / 占用）—— 已有
- **冲突横幅**（`ModConflictBanner` 形态）—— 现有冲突检测结果汇总成一横幅
- **加载顺序面板**（`ModLoadOrderPanel` 形态）—— `mod-order.json` 的右侧只读视图
- 卡片增加**签名三态徽章**（§9.2）

### 8.1 `updateMod()`（v1 漏掉、必须实现）

```ts
export async function updateMod(repoRoot: string, zipPath: string):
  Promise<ModImportResult & { previousVersion?: string; newVersion?: string }>;
```

必须还原：
- `loader.js` ↔ `loader.js.disabled` 的**启用状态**
- `mod-order.json` 里的**排序位置**（新目录替换后插回原下标）
- 目录下的用户私有文件（`settings.json` / `config/` / `profile/`）：先备份、导入后合并；同名冲突以**用户旧文件**为准，包里的同名文件另存 `*.new`
- 旧目录留档到 `_launcher/temp/mod-backup/<folder>-<version>-<ts>`，失败可回滚

---

## 9. 签名与验证（Ed25519）

### 9.1 安全定位（UI 与文档统一口径）

签名 = **"来源标记 + 完整性校验 + 绑定本启动器生态"**，**不是**"防止恶意模组"。
禁止出现"安全签名 / 防篡改 / 防盗版"这类措辞。

**没有"官方 MOD"这个概念（决策 4）**：所有模组都是社区作者发布的，UI 不出现"官方"徽章。
索引签名保留，但它证明的是**"这份目录是你发布的、没被中间人替换"**，与"模组是否官方"无关。

v1 的 HMAC 与运行时 Token 已删除：HMAC 密钥编译在启动器里、签名动作也由启动器提供（任何人下载启动器就能给自己的 mod 签名）→ 对恶意作者防护为 0；Token 要作者明文写进 `loader.js`，`strings` 一下就能拿到 → 同样为 0。

### 9.2 manifest 扩展（schema 3，全部可选）

```jsonc
{
  "schemaVersion": 3,
  "id": "welcome-mod",
  "displayName": "欢迎广播",
  "version": "1.1.0",
  "kind": "loader",
  "activation": { "strategy": "loader_rename" },
  "author":   { "id": "au-m1x2y3abcd", "name": "指挥官", "keyId": "9f3c1a77b2e4" },
  "category": "玩法",
  "tags": ["聊天", "新手"],
  "signature": { "alg": "ed25519", "keyId": "9f3c1a77b2e4", "sig": "<base64>", "signedAt": "2026-09-21T08:00:00Z" }
}
```

`ModRecord` 新增：

```ts
signatureState: "none" | "valid" | "invalid";   // none = 老模组，仍可启用
signatureError: string;
signatureKeyId: string;
```

**兼容性铁律**：`"none"` 绝不拦截。

`ModRecord` 除了三态，还带一个 `signatureTrusted`（密钥是否命中信任表），拦截规则据此细分：

```ts
// 只有「密钥可信 且 签名不匹配」= 确定被篡改，才拦截
if (mod.signatureState === "invalid" && mod.signatureTrusted) {
  plan.skipped.push({ id: mod.id, reason: "签名校验失败: " + mod.signatureError });
  return false;
}
```

| 情形 | state | trusted | 结果 |
|---|---|---|---|
| 没有 signature 字段（老模组/手工模组） | `none` | false | 放行（显示灰标「未签名」）|
| 本机作者签名、内容没改 | `valid` | true | 放行（绿标「已签名」）|
| 本机作者签名、内容被改了一个字符 | `invalid` | true | **拦截**（红标 + 禁止启用）|
| `author.keyId` 与 `signature.keyId` 不一致 | `invalid` | true | **拦截**（防张冠李戴）|
| 别人的密钥，尚未进信任表 | `invalid` | false | **只红标，不拦截** |

> **为什么「未知密钥」先不拦截**：在索引公钥表（阶段 F）接上之前，「密钥未知」与「被换过密钥」无法区分，直接拦截会误伤用户手动安装的第三方签名模组。
> 阶段 F 把公钥从签名索引注入信任表后，再升级为全拦截。这一段已写进 `modSigner.ts` 的注释。

签名三态徽章：`已签名`（绿）/ `签名校验失败`（红，禁用启用）/ `未签名`（灰，仍可启用）。

### 9.3 `src/main/modSigner.ts`（✅ 已实现）

```ts
const TRUSTED_PUBKEYS: Record<string, string> = { /* keyId -> ed25519 公钥 base64 */ };

export function canonicalManifestJson(manifest: Record<string, unknown>): string; // 递归 key 升序
export function verifyManifestSignature(manifest):
  { state: "none" | "valid" | "invalid"; keyId: string; reason: string };
export function verifyIndexSignature(index: Record<string, unknown>):
  { ok: boolean; reason?: string };
export function generateAuthorKeypair(): { keyId: string; publicKey: string; privateKeyPem: string };
export function signManifestWithKey(manifest, privateKeyPem): string;
```

要点：Ed25519 用 `crypto.verify(null, data, pubKeyObject, sig)`（algorithm 传 `null`）；规范化与验证**共用同一函数**；未知 `keyId` → `invalid` 并写明"签名密钥不在信任列表"；任何异常都包成 `invalid`，不向上抛。

### 9.4 签名 ≠ 归属（重要，别宣传错）

**签名只能证明两件事**：① 内容与签发时一致（没被改过）；② 这份内容是**持某个 keyId 的那台机器**签的。

**签名不能证明「这个模组是谁的」**。因为签名工具随启动器分发、私钥在签名者手里，所以任何人都能：

| 伪造手法 | 签名层能发现吗 | 真正的防线 |
|---|---|---|
| 改别人已签名模组的内容 | ✅ 能（签名不匹配 → 拦截） | 启动器（已实现） |
| **用自己密钥给别人的模组签名**（顺手改掉 `author` 块） | ❌ **不能** —— 结果是「一个合法签名的、作者写着他的模组」 | **索引/来源仓库的归属层**（见 §7.6） |
| 偷走作者的私钥再发新版 | ❌ 不能 | 密钥轮换 / 吊销（超出现阶段） |

所以角色分工要说清楚：

- **签名层（启动器，已实现）**：完整性 + 密钥持有证明 + 提高伪造成本；
- **归属层（索引 + 作者自己的仓库，阶段 F）**：谁拥有哪个 `id`、哪个 `author.id` 对应哪把公钥。

启动器这边已经做的两件事（注意：这是**防误操作**，不是防伪造）：
1. **主进程**拒绝签名：清单里已经声明了**别的 `author.id`**，或 `author.keyId` 与本机密钥不一致 → 直接拒绝（渲染层的提示可以被绕过，所以这层必须在主进程）；
2. 清单里**完全没有作者块**时，UI 会明确告知「签名会把你的作者身份写进去，之后它会出现在『我创建的』里」，确认后才签。

### 9.5 密钥轮换

`TRUSTED_PUBKEYS` 是 `keyId → 公钥` 的 map，**可并行放多把**。轮换时加新 keyId、保留旧的，老模组不失效。签名密钥**跨启动器版本稳定**（v1 的"改常量让旧签名失效"是地雷，已删）。

---

## 10. 代码组织与文件清单（绝对路径）

### 10.1 主进程新增

- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\main\authorStore.ts` — `author.json` 读写、密钥生成/导出/导入、改名批处理（含批量重签）
- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\main\modSigner.ts` — 规范化 + 验签 + 密钥工具
- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\main\modScaffold.ts` — **模板常量（唯一模板源）** + 创建模组落盘
- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\main\modSubmit.ts` — 签名 → 打包 → sha256 → 索引草稿 → `my-submissions.json`
- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\main\modRegistry.ts` — 索引拉取/验签/缓存、下载队列、semver 比对、`updates` 回退
- `E:\Games\EveJS-v0.12.8\launcher\launcher\tools\mod-sign\` — 维护者 CLI（`keygen.mjs` / `sign-index.mjs` / `verify.mjs`），**不进打包**

### 10.2 主进程修改

- `src/main/modManager.ts` — `ModRecord` 扩展、`readModDir` 验签、`planLoaders` 拦截、`signModFolder`、`exportModZip`、**`updateMod`**
- `src/main/ipc.ts` — 新增 `author:*` / `mods:create` / `mods:submit*` / `mods:market*` / `mods:myMods`
- `src/preload/index.ts` — 暴露上述 API + `onModDownloadProgress`

### 10.3 渲染层（**不是 `assets/` 那份**）

- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\renderer\public\launcher-bridge.js` — 三页签、创建/提交/作者弹窗、市场卡片与详情、安装队列
- **`E:\Games\EveJS-v0.12.8\launcher\launcher\src\renderer\public\eve-launcher.html`** — 子页签 DOM、徽章/弹窗样式与文案
- `E:\Games\EveJS-v0.12.8\launcher\launcher\src\renderer\public\MOD_AUTHORING.md` — 新增「作者身份与签名」「创建模组（§6 骨架由模板源生成）」「发布到模组市场（含收录规范）」三章

### 10.4 保留 / 已删

- **已删**：`E:\Games\EveJS-v0.12.8\launcher\launcher\assets\evejs-launcher\`（决策 5，删除前已确认全仓库零引用）
- **保留但不接入构建**：`E:\Games\EveJS-v0.12.8\launcher\launcher\assets\eve-console\`（设计参考，含单文件版 `新伊甸指挥台.html`）

---

## 11. 实施阶段（每步可编译可验证）

### 阶段 A — 作者身份与密钥  ✅ 已完成

- [x] `src/main/authorStore.ts`：`au-` id 生成、Ed25519 密钥对、`author.json` + `mod-keys/<keyId>.key`（0600）读写、改署名
- [x] `author:get` / `author:setName` / `author:exportKey` / `author:importKey` / `author:openKeyFolder` 五个 IPC + preload 暴露
- [x] 「作者身份」弹窗：署名可改、显示作者标识与密钥指纹、密钥状态（KEY OK / KEY MISSING）、缺失告警、复制标识、导出/导入 `.eve-key`、打开密钥目录
- [x] 启动时加载身份，模组页工具栏按钮直接显示当前署名
- [x] 24 条新文案补齐 7 语言（中英日韩法德荷俄）
- [x] **往返测试通过**：新建 → 改名 → 导出 → 清空数据目录 → 导入 → `id` / `keyId` / 署名全部还原；头部 keyId 被篡改 → 拒绝导入；垃圾文件 → 拒绝导入

### 阶段 B — 签名基础设施  ✅ 已完成

- [x] `src/main/modSigner.ts`：规范化 JSON（递归 key 升序）、Ed25519 验签、索引验签、公钥信任表（`trustPublicKey`）、`signManifestWithAuthorKey`
- [x] `modManager.ts`：`ModRecord` 新增 `signatureState` / `signatureError` / `signatureKeyId` / `signatureTrusted`；`readModDir` 验签；`planLoaders` 按 §9.2 规则拦截
- [x] `signModFolder(repoRoot, folder)`：签名前重跑清单校验，缺 `author` 块时补本机作者，去旧签名后重签（可反复执行）
- [x] `mods:sign` IPC + `modsSign` preload
- [x] 模组卡片：三态徽章（已签名 / 签名失败 / 未签名）+「签名」按钮；被拦截时禁用启用开关并列出原因
- [x] 9 条新文案补齐 7 语言
- [x] **测试通过**：未签名 `none` → 签名后 `valid` → 重复签名幂等 → 改一个字符变 `invalid(trusted)` 且 `planLoaders` 拦截 → 未知密钥 `invalid(not trusted)` 不拦截 → `author.keyId` 不符被拦截 → `alg` 非法被拒 → **`mods/` 下真实模组全部 `none`，无一误判**

> 注：`tools/mod-sign/` CLI 推迟到阶段 D（提交流程要用它签索引），本阶段先由启动器内的「签名」按钮完成签发。

### 阶段 C — 创建模组  ✅ 已完成

- [x] `src/main/modScaffold.ts`：模板常量 + `createMod()`（校验 → 写 `_launcher/temp/scaffold-<id>/` → 用 `readModDir` 预校验 → 整体移入 `mods/<id>` → 可选签名/启用）
- [x] 两个模板，**同源于 `mods/welcome-mod`**：`broadcast`（登录欢迎广播，默认）、`blank`（同骨架、业务留空）
- [x] 生成的 `loader.js` 保留全部关键技巧：进程身份校验 / `globalThis` 守卫 / **轮询 `require.cache` 等服务端自己加载**（不提前拉起 456MB 依赖图）/ `timer.unref()` / 会话属性坑补丁 / 上线宽限期
- [x] `mods:templates` + `mods:create` IPC；`modsTemplates` / `modsCreate` preload
- [x] 「创建模组」弹窗：模板选择、模组名、标识（自动 slug，中文名推不出时用 `mod-<时间戳>` 兜底）、版本、分类、标签、简介、详细介绍、功能要点、冲突、**真实文件树预览**、立即启用 / 立即签名开关
- [x] 新模组**默认禁用**（写成 `loader.js.disabled`），只有勾「立即启用」才改名；「立即签名」默认勾上
- [x] 24 条新文案补齐 7 语言
- [x] **测试通过**：创建（含签名）→ 文件齐全、默认禁用 → `scanMods` 报 `valid` + `signatureState=valid` → 生成的 `loader.js` 语法合法（162 行）→ 重名被拒 → `blank`+立即启用 → `loader.js` 存在且 `restart=none` → 非法 id / 非法版本 / 空名字全部被拒 → `_launcher/temp` 无残留

> 实现时修掉一个真问题：manifest 的 `id` 原本会保留用户输入的原始值（如 `My First Mod` 带空格），导致清单 id 与目录名 `my-first-mod` 不一致；现已统一用规范化后的值。

> 模板与 `MOD_AUTHORING.md §6` 目前靠注释互相引用保证同源（`modScaffold.ts` 顶部注明基准），脚本级一致性校验排在后续。

### 阶段 D — 提交模组  ✅ 已完成

- [x] `src/main/modPack.ts`：用 **.NET `ZipFile::CreateFromDirectory`** 打包（避开 `Compress-Archive` 的 `\` 分隔符坑）+ sha256 + sizeBytes
- [x] `src/main/githubToken.ts`：PAT 优先用 `safeStorage`（Windows DPAPI）加密存 `_launcher/data/github-token.bin`；不可用时**只放内存**并明确提示；支持清除与状态查询
- [x] `src/main/githubSubmit.ts`：纯 REST —— `GET /user` → fork（409 复用已有 fork）→ 取 base SHA → 建分支（422 复用）→ `PUT contents`（已存在则带 blob sha）→ 开 PR；另导出 `pullRequestCompareUrl` 作为降级入口
- [x] `src/main/modSubmit.ts`：`prepareSubmission`（重签 → 打包 → sha256 → 组装分片 → 写 `my-submissions.json`，**前四步完全离线**）+ `submitToGitHub`（失败时回传 compareUrl）
- [x] 归属校验：清单里 `author.id` 不是本机作者 → 拒绝提交（不能替别人上架）
- [x] 8 个 IPC（prepare / submit / mySubmissions / tokenStatus / tokenSave / tokenClear / tokenCheck / revealZip）+ preload
- [x] 「提交模组」弹窗：选模组（按「我创建的 / 其它模组」分组）、更新说明、分类/标签/仓库、GitHub 与国内镜像直链、**①生成并打包** → 展示 ZIP 路径 + SHA256 + 体积 + 分片 JSON（可复制）+ 打开 ZIP 目录；**②GitHub 提交**（令牌保存/校验/清除、PR 链接、失败降级提示）
- [x] 41 条新文案补齐 7 语言
- [x] **离线部分测试通过**：造模组 → prepare → ZIP 生成、`sha256` 与文件实际值一致、`sizeBytes` 一致、`ftp://` 链接被过滤、分片含全部必需字段、`my-submissions.json` 落盘、重复 prepare 是 upsert 不重复、跨作者提交被拒、无令牌提交给出可读原因
- [x] **GitHub 流程用「假 GitHub API」端到端测试通过**：请求序列严格符合 `GET /user → POST forks → GET ref → POST refs → GET contents → PUT contents → POST pulls`；提交内容 base64 解码后与原文本一致；fork 409 时复用已有 fork；分支 422 时继续提交；PR 422 时返回 `{ok:false, branch, compareUrl}` 供降级

> 需要你亲自验证的一步：用**真实 PAT** 跑一次完整的 fork → PR（建议先拿一个测试仓库当 `modIndexRepo`）。离线部分与请求序列都已用模拟 API 验证过，真实网络这一段无法在我这边代跑。

### 阶段 E — 我创建的  ✅ 已完成

- [x] `modSubmit.listMyMods()`：三源合并（本地扫到 `author.id`/签名 keyId 是本机的 + 索引里 `author.id` 是本机的 + `my-submissions.json` 台账）
- [x] 状态机：`submitted` → `update-pending`（本地比已上架新）→ `listed` → `delisted` → `draft` → `local`，按此优先级排序
- [x] 模组页新增「我创建的」子页签：卡片显示状态徽章、id/版本/已上架版本、是否已签名、来源仓库；动作：打开目录 / 提新版·提交 / 打开 PR
- [x] **踩到的坑（已修）**：`esc()` 只存在于 `launcher-bridge.js` 的 IIFE 里，HTML 的内联脚本拿不到。
      于是「我创建的」/「模组市场」只要**列表非空**就会在 `renderMyMods()`/`renderMarket()` 抛 `ReferenceError: esc is not defined`，
      网格不更新 → 表现成「点了页签没反应」；列表为空时因为提前 return 反而看不出问题。
      现在 HTML 里补了一份等价的全局 `esc()`（含单引号转义），并在冒烟里加了**用真实形状数据直接渲染两个网格**的探针防回归。
- [x] 空状态做成带说明与直达按钮的卡片（「我创建的」→ 直接给创建入口；「模组市场」→ 给「重新拉取索引」）
- [x] 页签与四个动作按钮（创建模组 / 提交模组 / 作者身份 / 模组制作规范）统一放在页签行，且**改用脚本绑定**，不依赖 inline onclick 的作用域解析
- [x] 导出 CSV（BOM + 引号转义，走系统保存对话框）
- [x] **测试通过**：aaa(本地 1.1 < 上架 1.2) = `listed`、bbb(本地 2.0 > 上架 1.0) = `update-pending`、ccc(索引 `delisted`) = `delisted`，别人的模组不出现

### 阶段 F — 市场索引（含验签）  ✅ 已完成

- [x] `src/main/modRegistry.ts`：多镜像（GitHub Pages → jsDelivr）+ `AbortController` 单镜像 8s / 总预算 12s + 缓存 `_launcher/cache/mod-index.json`（带 `fetchedAt`）+ **TTL 30 分钟**（`force` 忽略）
- [x] **先验签再信任**：`verifyIndexSignature` 通过后才读取条目，并把条目里 `author.publicKey` 注入 `modSigner` 的信任表（这样社区作者的模组签名才能被认）
- [x] 全部镜像失败 → 回退最后一份缓存并标注 `cached`；无缓存 → 明确报错
- [x] `satisfiesEvejs` 兼容性门禁 + `compareVersion` semver 比较 + `findUpdates`
- [x] IPC `mods:marketList`（带 `force`）+ 「模组市场」子页签：卡片网格（可安装/可更新/已安装徽章、作者、标签、需重启、源码）
- [x] **测试通过**：缓存索引被正确读取（`source=cache`）、`0.12.8 ∈ [0.12.x]` 为真而 `0.13.0` 为假、`findUpdates` 认出 `1.1.0 → 1.2.0`

### 阶段 G — 下载安装与更新  ✅ 已完成

- [x] `downloadEntry`：按 `downloadUrls.priority` 逐个镜像回退 → 流式下载并回传进度 → **sha256 不匹配立刻丢弃并换镜像** → 全部失败给出逐镜像原因
- [x] `installEntry`：已装同 id → `updateMod`；未装 → `importModZip`（下载后默认禁用）
- [x] **`updateMod`（v1 漏掉的关键能力，已实现）**：解包探 id/版本 → 备份旧目录到 `_launcher/temp/mod-backup/` → 导入新包 → **还原启用状态** → **还原用户私有数据**（新包里没有的照搬旧的；两边都有的把旧的还原、新的另存 `.new`）→ **还原 `mod-order.json` 排序位置**；导入失败自动回滚
- [x] 进度通过 `mod:downloadProgress` 推给渲染层，市场卡片显示进度条并禁用按钮
- [x] `evejsVersions` 不满足的条目不进市场列表（`blocked` 单独返回）
- [x] **测试通过**：v1.0.0（已启用 + 有 `settings.json` + 已排序）→ 更新到 v1.1.0 → **版本变 1.1.0 / enabled 仍为 true / 排序仍为 `["demo"]` / `userSetting: keep-me` 保留**

### 阶段 H — 已安装页增强  ✅ 已完成

- [x] **冲突横幅**（对应原型 `ModConflictBanner`）：汇总现有冲突检测结果，启用中的冲突用红色强调，最多列 6 条
- [x] **加载顺序面板**（对应原型 `ModLoadOrderPanel`）：按当前生效顺序列出已启用模组（读 `mod-order.json` 的结果）
- [x] 签名三态徽章（阶段 B 已完成，此处合流到同一张卡片）
- [x] **验证**：`npm run build` 通过、`npm run smoke`（Electron 实跑）exit 0 且无 ReferenceError / TypeError

---

## 12. 不做的事

- 不做 **运行时 Token 注入**、不做 HMAC 对称签名（改 Ed25519）
- 不做 **"官方 MOD" 徽章**（决策 4：全是社区作者）
- 不把 **React/Tailwind/Radix** 打进启动器（组件按现有 HTML/CSS 重写）
- 不做**用户评分 / 写评价**（需服务端；M1 只读索引聚合值）
- 不做**假的审核进度**（改为由索引收录情况推导的真实状态）
- 不做**自建下载服务器**（§7.0：索引静态托管 + 作者自托管 ZIP）
- 不做在线吊销列表 / 黑名单 / 用户系统 / 评论
- 不做自动 push 到索引仓库（生成草稿 + 手动 PR）
- 不做客户端模组签名（客户端不是 Node）
- 不做模组代码沙箱（改为"默认禁用 + 首次启用确认 + 展示来源与哈希"）
- 本轮不做**进阶模板**（客户端内存投递 / 运行时补丁），先把 loader 这一类做扎实

---

## 附录 A：索引仓库（diguo520/EVEjs-mods）需要放的东西

这个仓库你只需要建**一次**，之后由 CI 自动维护。目录结构：

```
EVEjs-mods/
  sources.json                     # 收录了哪些作者仓库（一行一个）
  README.md                        # 收录规范 + PR 模板
  scripts/build-index.mjs          # CI 用：抓 sources → 合并 → 签名
  .github/workflows/build-index.yml
  docs/                            # 产物发布目录（GitHub Pages 从这里出）
    mod-index.json
```

**`sources.json`**（作者点「③ 申请收录」时，启动器会帮他改这个文件）：

```jsonc
{
  "schemaVersion": 1,
  "sources": [
    "alice/evejs-mod-autolockfire",
    "bob/evejs-mod-cntext-fix"
  ]
}
```

**每个被收录的作者仓库**根目录要有一个 `evejs-mod.json`（启动器「② 发布到我的仓库」会自动写），内容就是索引条目的完整字段：
`id / displayName / version / author{id,name,keyId,publicKey} / description / category / tags / readme / highlights / conflicts /
requiresRestart / evejsVersions / sizeBytes / sha256 / downloadUrls[] / changelog / history / repo / delisted`。

**CI 干的事**（`build-index.yml` 要点）：

```yaml
name: build-index
on:
  schedule: [{ cron: "0 */6 * * *" }]   # 每 6 小时
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - name: Build and sign
        env:
          INDEX_SIGNING_KEY: ${{ secrets.INDEX_SIGNING_KEY }}   # Ed25519 私钥（PKCS8 PEM）
        run: node scripts/build-index.mjs
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./docs
```

`scripts/build-index.mjs` 的核心（抓取 + 校验 + 合并 + 签名）：

```js
import fs from "node:fs";
import crypto from "node:crypto";

const sources = JSON.parse(fs.readFileSync("sources.json", "utf8")).sources;
const mods = [];
for (const repo of sources) {
  const url = "https://raw.githubusercontent.com/" + repo + "/HEAD/evejs-mod.json";
  const res = await fetch(url);
  if (!res.ok) { console.warn("skip", repo, res.status); continue; }
  const entry = await res.json();
  if (!entry.id || !entry.version || !entry.sha256) { console.warn("invalid", repo); continue; }
  if (!Array.isArray(entry.downloadUrls)) entry.downloadUrls = [];
  mods.push(entry);
}
const index = { schemaVersion: 1, publishedAt: new Date().toISOString(), mods };
const { signature: _omit, ...rest } = index;
const canonical = JSON.stringify(sortKeysDeep(rest));
const key = crypto.createPrivateKey(process.env.INDEX_SIGNING_KEY.replace(/\\n/g, "\n"));
index.signature = { alg: "ed25519", keyId: "index-2026", sig: crypto.sign(null, Buffer.from(canonical, "utf8"), key).toString("base64") };
fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync("docs/mod-index.json", JSON.stringify(index, null, 2));

function sortKeysDeep(v){ if(Array.isArray(v)) return v.map(sortKeysDeep); if(v && typeof v==="object"){const o={};for(const k of Object.keys(v).sort())o[k]=sortKeysDeep(v[k]);return o;} return v; }
```

> 客户端侧的对应实现已经就绪：签名验证、公钥注入、TTL 缓存、jsDelivr 镜像回退都在 `src/main/modRegistry.ts`；
> 索引里的 `author.publicKey` 会在验签通过后被注入信任表，作者模组的签名才能被认。

---

## 13. 决策记录（全部已定）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 创建模组模板集 | 以 `mods/welcome-mod` 为唯一基准（= `MOD_AUTHORING.md §6` 骨架） |
| 2 | 索引仓库名 | `diguo520/EVEjs-mods` |
| 3 | 私钥导入 | 允许 |
| 4 | 官方 MOD 徽章 | 不做（全是社区作者） |
| 5 | `assets/evejs-launcher/` | 已删除 |
| 6 | 托管 / 服务器 | 不需要服务器（§7.0） |
| 7 | 提交方式 | **作者发布到自己的仓库**（启动器代劳建库/写清单/传 Release）；索引只做一次性 `sources.json` 登记，由 CI 聚合（§5.4） |
| 8 | `.eve-key` 格式 | 注释头 + PEM（§3.4，已实现） |

**无遗留待决策项。** 后续若出现新的取舍点，追加到本表。

---

## 14. 维护者审核（收录 / 拒绝 / 下架）

维护者（索引仓库 owner）不需要启动器 UI，全部在索引仓库 `diguo520/EVEjs-mods` 里做；
操作手册写在那个仓库的 `README.md`「维护者审核」章节，这里只记设计口径。

### 14.1 三种状态

| action | 索引（mod-index.json） | 启动器·模组市场 | 启动器·我创建的（作者） |
| --- | --- | --- | --- |
| 不填（正常） | 正常条目 | 正常展示 / 可安装 | 已上架 |
| `delist` | 条目保留 + `delisted:true` + `delistReason` | **不列出**，安装被主进程拒绝 | 红标「已下架」+ 原因 + 维护者 |
| `reject` | 条目被丢弃，只留在 `moderation` 表 | 不出现 | 红标「已拒绝收录」+ 原因 + 维护者 |

### 14.2 链路

```
作者：启动器「提交模组」→ ① 发布到我的仓库 → ③ 申请收录（对 sources.json 开 PR）
维护者：审 PR（§7.6 清单）
        ├─ 通过 → merge（或 node scripts/moderate.mjs approve <owner/repo>）
        └─ 不通过 → node scripts/moderate.mjs reject <id|owner/repo> --zh 原因 --en reason
                   node scripts/moderate.mjs pr-text <id|owner/repo>   # 贴到 PR 回复作者
已上架后要撤 → node scripts/moderate.mjs delist <id> --zh 原因 --en reason
改完 → node scripts/build-index.mjs → git commit/push（CI/Pages 自动生效）
```

### 14.3 关键约束

- **审核只动索引，不动作者仓库**：ZIP 始终在作者自己的 Release 里，你只决定它在市场里可见/不可见。
- **原因跟着索引走**：`moderation` 表随 `mod-index.json` 一起签名发布，所以作者不用问你要原因 —— 启动器会直接显示。
- **下架条目仍留在索引里**（带 `delisted:true`），这样已安装的用户不会“掉”条目；市场列表在 `ipc.ts` 层过滤掉它，`mods:marketInstall` 还会再拦一次（拿着旧缓存也装不上）。
- **更新检查自动跳过下架条目**（`modRegistry.findUpdates` 里 `entry.delisted` 直接 continue）。
- 拒绝收录后作者**重做再提交**：同 id 重新收录时用 `restore` 清掉审核记录即可。
