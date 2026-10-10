# EveJS 模组制作教程（作者视角）

> 面向**想做一个模组的人**：从零到一个能在模组市场被安装的模组，一共 **8 个步骤**。
> 全程**不需要修改服务端任何文件** —— 模组通过 loader 挂载。

**你需要的**：Windows 10+、EveJS 服务端（0.12.8 或更高）、EvEJS 启动器 0.1.20+、一个 GitHub 账号。

---

## 🎨 颜色 / 标记图例（先读这个）

| 标记 | 含义 | 你要做的事 |
| --- | --- | --- |
| 🟥 **危险** | 踩了会失败、报错，或造成**不可逆**后果 | 一定不要这么做 |
| 🟨 **注意** | 容易出错，或结果和你预期不一样 | 动手前确认一遍 |
| 🟦 **提示** | 省时间的小技巧 | 可以用 |
| 🟩 **推荐** | 建议按这个来 | 照做 |
| ✅ **必做** | 缺了就走不下去 | 必须完成 |
| ⭕ **选填** | 可以留空 | 按需 |
| 🧩 **示例** | 可直接抄的代码 / 配置 | 复制改改 |

> GitHub 的 Markdown、VS Code 预览、Typora 等都能正常显示上面的彩色标记（用的是 emoji，**不需要任何插件**）。

---

## 📋 步骤总览

| # | 步骤 | 在哪做 | 大概耗时 | 必做？ |
| --- | --- | --- | --- | --- |
| 1 | 确认环境（版本 / mods 目录） | 启动器 | 2 分钟 | ✅ |
| 2 | 创建**作者身份**并导出 `.eve-key` | 启动器 | 2 分钟 | ✅ |
| 3 | 创建 **GitHub 令牌**（classic，勾 public_repo） | GitHub 网页 | 5 分钟 | ✅（发布与投稿都需要） |
| 4 | **创建模组**（生成骨架） | 启动器 | 3 分钟 | ✅ |
| 5 | 写你的逻辑（`loader.js`） | 编辑器 | 看需求 | ✅ |
| 6 | 本地测试（启用 / 看日志） | 启动器 | 5 分钟 | 🟩 推荐 |
| 7 | **发布上架**（打包 → 推你的仓库 → 提审核 PR，一次点击） | 启动器 | 1 分钟 | ✅ |
| 8 | 发新版（改版本号 → 再点一次「发布」） | 启动器 | 1 分钟 | 🟩 推荐 |

> 🟦 **一次性 vs 每次都要做的**：步骤 1~4 只做一次；之后每发一版都只走 **步骤 7**（打包、推仓库、提审核 PR 一起做完，见第三部分）。

---

# 第一部分：准备（一次性）

## 步骤 1 ✅ 确认环境

1. 打开启动器 → **环境自检**：Node.js / 依赖 / 客户端路径 等 9 项，红的先解决。
2. 确认 EveJS 服务端根目录（含 `server/`、`config/`）。启动器 → **配置中心** 里能看到当前用的路径。
3. 确认 **`mods/` 目录**存在。不存在就在 模组 / 插件 → **自动创建 mods/**。

🟨 **注意**：模组目录固定是 `<EveJS 根目录>/mods/<模组标识>/`，**不要**放到别的地方，也不要改成中文目录名。

---

## 步骤 2 ✅ 创建作者身份（这是"你是谁"的凭证）

模组 / 插件 → 顶部 **令牌配置**（作者身份与 GitHub 令牌在同一个弹窗里）：

1. **首次打开会自动生成**你的 Ed25519 密钥对（不需要点什么按钮）
2. 改 **署名**（给人看的名字，比如「指挥官」）→ 点 **保存署名**
3. 点 **导出密钥** → 存成 `.eve-key` 文件，**放到安全的地方**（U 盘 / 密码管理器）
4. 想换电脑：在新机器上点 **导入密钥** 选这个 `.eve-key`，身份就恢复了
5. **密钥目录** 按钮可以直接打开私钥所在目录（`_launcher/data/mod-keys/`）

你会得到三样东西：

| 东西 | 说明 | 要不要保管 |
| --- | --- | --- |
| **作者标识**（`au-...`） | 写在模组清单里，代表"这个模组是你做的" | 会自动写入清单 |
| **密钥指纹**（`keyId`，12 位） | 校验签名用 | 会自动写入清单 |
| **`.eve-key` 文件** | 里面是**私钥** | 🟥 **必须保管好** |

🟥 **危险**：
- **`.eve-key` 就是你的身份**。丢了 → 你**再也签不出更新**（老用户会看到"签名失败"）；泄露了 → 别人可以冒充你发版。
- **绝对不要**把 `.eve-key` 或 `_launcher/data/mod-keys/*.key` 提交到 GitHub、发给别人、打进 ZIP。

🟩 **推荐**：换电脑时用「导入密钥」把 `.eve-key` 导回去，身份就恢复了。

---

## 步骤 3 ✅ 创建 GitHub 令牌（发布与投稿都要用）

启动器要替你操作 GitHub：**发布**时往你自己的仓库写文件、建 Release、上传 ZIP；**申请收录**时还要往索引仓库 `diguo520/EVEjs-mods`（在维护者名下）建 fork、开 PR。用一个 **classic 令牌**就能同时覆盖这两件事。

### 3.1 打开正确的页面 🟨

```
GitHub 右上角头像 → Settings → 左栏最底部 Developer settings
  → Personal access tokens → Tokens (classic) → Generate new token (classic)
```

照着下面这张图点（编号对应页面上的红圈）：

![GitHub classic 令牌页面：① Tokens (classic) ② Generate new token (classic) ③ Note ④ Expiration ⑤ 勾 repo](./github-token-classic.png)

| 编号 | 点哪里 / 填什么 |
| --- | --- |
| ① | 左栏 **Tokens (classic)** —— 不是上面的 Fine-grained tokens |
| ② | **Generate new token** → **Generate new token (classic)** |
| ③ | **Note**：随便写，比如 `evejs-launcher` |
| ④ | **Expiration**：建议 90 天（到期要重新生成一次） |
| ⑤ | **Select scopes** 里勾 **repo**（`public_repo` 是它下面的子项，勾上 repo 就一起有了） |

🟥 **别用 fine-grained（细粒度）令牌**：它的 Repository access 只能勾「你自己有权限的仓库」，勾不到维护者名下的索引仓库 `EVEjs-mods`；而建 fork 与开 PR 都需要在这个仓库上的写权限，所以细粒度令牌投稿必然报 `403 Resource not accessible by personal access token`。

### 3.2 填基本信息

| 字段 | 填什么 |
| --- | --- |
| Note | 随便，比如 `evejs-launcher` |
| Expiration | 建议 90 天或自定义（过期后要重新生成） |

### 3.3 勾 scope（关键）🟨

| scope | 勾不勾 | 作用 |
| --- | --- | --- |
| **public_repo** | 🟩 必勾 | 读写公共仓库：发 Release、传 ZIP、建 fork、开 PR 全靠它 |
| **repo** | 🟨 建议 | 包含 public_repo；还想让启动器自动建仓库 / 管私有仓库时勾上 |

### 3.4 生成并复制

点 **Generate token** → 复制那串 `ghp_...`（🟨 **只显示一次**，关掉页面就看不到了）。

### 3.5 填进启动器

模组 / 插件 → **令牌配置** → 找到 GitHub 令牌 → 粘贴 → 点 **保存**（会加密存在本机，保存后自动核验权限）→ 校验通过即可。

> 🟦 **为什么改成 classic？** 索引仓库在维护者名下，细粒度令牌给不了它写权限。只有被维护者加成**索引仓库协作者**的人，才可以用细粒度令牌：Repository access 勾上 `EVEjs-mods`，权限开 **Contents = Read and write** 与 **Pull requests = Read and write**。

🟨 **注意**：改过令牌 scope 或重新生成后，要把新令牌**重新粘贴保存**一次。

---

# 第二部分：做一个模组

## 步骤 4 ✅ 创建模组（生成骨架）

模组 / 插件 → **创建模组**，填表：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 模板 | ✅ | `Welcome Broadcast (Example)`（带一条登录欢迎消息的示例）/ `Blank Skeleton`（空骨架）。🟩 第一次建议先用示例跑通 |
| 模组名 | ✅ | 显示给玩家看的名字 |
| 标识（id / 目录名） | 🟩 | 会自动按名字生成；只允许 `a-z 0-9 - _ .`，建好后**不要再改** |
| 版本 | ✅ | 默认 `1.0.0`；发新版要**递增**（见步骤 8） |
| 分类 | ✅ | 玩法 / 经济 / AI / 画面 / 工具（市场按这个筛选） |
| 标签 | ⭕ | 逗号分隔，比如 `聊天, 新手` |
| 简介 | 🟩 | 一句话，会显示在市场上的卡片里 |
| 详细介绍 / 功能要点 | ⭕ | 会写进你模组的 README |
| 冲突模组 id | ⭕ | 与哪些模组互斥，逗号分隔 |
| 构建选项 | — | ☑ 需要重启服务端（默认开）、☑ 建好后立即启用（默认开）、☑ 建好后立即签名（默认开） |

点 **创建** 后，你的 `mods/` 目录里会多出：

```
mods/<你的模组 id>/
├─ evejs-launcher.mod.json    ← 清单（身份、版本、分类、依赖都在这）
├─ loader.js                  ← 你要写的逻辑
├─ README.md                  ← 从「详细介绍」生成
└─ CHANGELOG.md               ← 版本变更记录
```

🟨 只有把「建好后立即启用」**取消勾选**，`loader.js` 才会落成 `loader.js.disabled`（默认勾着，所以默认就是能加载的 `loader.js`）。之后想切换，在**已安装**页开关一下就行 —— 开关做的就是改名。

🟨 **清单里的必填字段**（启动器会校验，缺了会报"清单校验失败"）：

```
schemaVersion: 3                       ← 必须是 3
id / displayName / version             ← 标识 / 名字 / 版本
kind: "loader"                         ← 目前只有 loader 能真正启用
restart: "game_server"                 ← none | client | game_server | launcher
activation.strategy: "loader_rename"   ← 必须是这个
目录里必须有 loader.js 或 loader.js.disabled
```

---

## 步骤 5 ✅ 写你的逻辑（`loader.js`）

打开 `mods/<你的模组 id>/loader.js`，里面已经有骨架 —— 🟩 **骨架本身就是能跑的最小示例**（玩家上线 10 秒后在本地聊天框收到一条消息），照着改就行。

🟥 **四条硬约定**（骨架里都写好了，删掉任何一条都会出问题）：

| 约定 | 为什么 |
| --- | --- |
| `setImmediate` + 入口校验（`process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world"`，或入口是 `index.js`） | `NODE_OPTIONS` 会被 npm → 服务端逐层继承，每个包装进程都会加载你的文件；不校验就会在错的进程里干活 |
| **不要直接 `require` 服务端大模块**（`chatHub` 会拉起约 456MB / 645 个模块） | 等 `require.cache` 里出现它之后再取引用：缓存命中、零额外内存 |
| `timer.unref()` | 不让定时器拖住进程退出 |
| 用 `globalThis.__xxx` 做「只装一次」判断 | loader 会被加载多次，否则消息重复发送、监听器越堆越多 |

🟨 **路径规则（最容易踩的一个）**：loader 里 `require("./src/...")` 是相对**你自己的模组目录**解析的，**不是**服务端根目录 —— 直接这么写会 `MODULE_NOT_FOUND`。正确写法是先算出服务端根目录：

```js
const path = require("path");
const serverRoot = path.resolve(__dirname, "..", "..", "server");
const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
// 🟨 不要在这里直接 require —— 等服务端自己加载过它再取引用，完整写法见附录 B
```

🟨 **会话属性**：聊天会话上的自定义属性**不会自动同步**，直接读写可能"静默失败"，要走 `chatHub` / `sessionRegistry` 提供的接口。

🟩 需要**改服务端源码**（而不只是调接口）的模组看**附录 G** —— 不要自己 hook `Module.prototype._compile`。

---

## 步骤 6 🟩 本地测试

1. 模组 / 插件 → **已安装** → 找到你的模组 → 把开关**打开**（或创建时勾了"立即启用"）
2. 启动器 → 控制台 → **一键启动**（只拉起主服务器 + 市场服务）
3. 进游戏验证效果
4. 出问题看两处日志：
   - 启动器 → **服务器日志**（可以按 系统 / 主服务器 / 市场服务 / 客户端 和 INFO/WARN/ERROR 筛选）
   - 服务端控制台输出（启动器里能看到）
5. 🟩 **确认「到底加载了没、花了多久」**：在服务端输出里搜 `[EveJS-MOD]`：
   - `loader 就绪 <你的模组> 3ms` —— 你的 loader 被加载了；`loader 失败 ... :: <原因>` 则是没加载成功
   - `loaders-done total=14 failed=0 ms=1086` —— 全部模组加载完的总耗时
   - `<文件> 注入 N 层（A -> B 字节）` —— 总线补丁生效了
   - `<id> 补丁失败，保留上一层结果：<原因>` —— 这一层被跳过（**不影响**其它模组）

   🟨 每个进程的明细与每一层的结果还会写成 `_launcher/logs/mod-load-report.json`，排查「谁把文件改了」时直接看它。

### 🔧 排错速查

| 症状 | 最可能的原因 |
| --- | --- |
| 模组列表里显示"缺少 loader.js" | 文件被删了，或改成了别的名字 |
| 打开开关后又自己关掉 | 清单校验失败 / 签名被改过 → 看卡片上的红色提示 |
| 日志里看不到"加载模组" | 模组在**已停用**状态，或与别的模组冲突被跳过 |
| 日志里报 `MODULE_NOT_FOUND` | `require("./src/...")` 被当成相对服务端根目录了 —— 实际相对你的模组目录（见步骤 5） |
| 游戏里没效果、日志也没报错 | 逻辑里没做"只装一次"判断前就 return 了；或路径 `require` 写错 |
| Node 内存暴涨 | `require` 了服务端大模块（见步骤 5 的坑 2） |

---

# 第三部分：发布到市场

> **发布是一次点击**：启动器把「重新签名 → 打包 ZIP → 推到你自己的仓库（没有就建仓库、发 Release、传 ZIP）→ 往索引仓库提一条版本审核 PR」连着做完，你只看进度条。
> 索引仓库那条 PR **每一版都提** —— 合并之后市场才换到新版本。

## 步骤 7 ✅ 发布上架（一次点击）

模组 / 插件 → **发布模组**（「我创建的」卡片上的「提交审核 / 重新提交」进的是同一个弹窗）：

1. **选择模组**：下拉里**只列出你自己创建的模组**（别人的模组不会出现，避免误提交）
2. 填 **版本号** 与 **更新说明**（更新说明会写进索引与 PR，建议写人话）
3. 确认 **分类 / 标签**；**源码 / 项目地址** ⭕ 选填（比如 `https://github.com/你/你的模组`），**GitHub Releases 直链** ⭕ 留空即可（发布时自动生成正确地址）
4. 勾上三条声明（本人原创 / 不含恶意代码 / 已阅读规范与上架条款）
5. 点 **发布**

弹窗顶上的前置条件够了才点得动「发布」：**署名**（步骤 2）、**GitHub 令牌**（步骤 3）、**同一个模组两次提交间隔 30 分钟**、**两次发布之间间隔 60 秒**。差哪一项，那一行会亮黄并给一个去补的入口。

### 进度里的四个环节

| 环节 | 它做了什么 | 在哪发生 |
| --- | --- | --- |
| 本地打包安装包 | 重新签名 → 打包 ZIP → 算 SHA256 → 生成上架清单 | **只在本机**：不联网、不需要令牌 |
| 准备你的源码仓库 | 没有仓库就建一个公开仓库 | 你自己的 GitHub |
| 发布 Release 并上传安装包 | 写入 `evejs-mod.json`（市场读的就是它）→ 建 Release（tag = `v<版本号>`）→ 上传 `<id>-<版本号>.zip` | 你自己的 GitHub |
| 提交版本审核 PR | 往索引仓库提 PR：首次多一份 `sources.json`（收录登记），之后每一版只更新 `mods/<id>.json` | 索引仓库 `diguo520/EVEjs-mods` |

产物与台账：

| 产物 | 位置 |
| --- | --- |
| ZIP 包 | `_launcher/temp/export-<id>-<version>.zip`（同一份也传到了你的 Release） |
| 提交台账 | `_launcher/data/my-submissions.json` |

🟨 **改了代码就重新点一次「发布」**：内容一变签名就失效，启动器会重新签名、重新打包、推一个新版本。

### 🔧 这一步的常见报错

| 报错 | 原因 | 怎么解决 |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | 令牌是 fine-grained，或 classic 没勾 public_repo | 改用 classic 令牌并勾 **public_repo**；索引仓库在维护者名下，细粒度令牌勾不到它。已被加成索引仓库协作者的：用细粒度令牌勾上 `EVEjs-mods` + Contents / Pull requests = Read and write |
| 🟥 `net::ERR_INVALID_ARGUMENT` | 旧版启动器上传 ZIP 的 bug | 升级到 **0.1.20+** |
| 🟥 `404` | 仓库不存在，或令牌没覆盖它 | 检查 owner/repo 拼写；投稿请用 classic 令牌（public_repo / repo） |
| 🟥 `还没有填 GitHub 令牌` | 没保存令牌 | 回到步骤 3.5 |

🟩 **成功之后**：弹窗显示仓库地址与 Release 地址（可以点开确认 ZIP 在），卡片进入 **审核中**。

### 审核与合并

- 维护者会在 PR 里审核你的模组（清单字段、分类、ZIP 位置、版本号等）
- **通过（合并）**：索引 CI 立刻重建，市场更新到你这一版，所有人的启动器都能搜到
- **不通过**：维护者在 PR 里回复原因，同时你 **我创建的** 里那张卡片变红并写明**拒绝收录原因**

🟨 **同一个模组两次提交至少间隔 30 分钟**：连着点会重复推 Release、反复刷新同一条 PR；弹窗里会写还差几分钟，按钮在那之前是灰的。

🟦 提交后启动器会**再查一次**这条 PR，确认它真的开出来了，并把编号与状态记进台账：
「我创建的」卡片上显示 `审核中 / 已合并 / PR 已关闭`（这条状态最多 30 分钟复查一次，不会频繁打扰 GitHub）。

---

## 步骤 8 🟩 发新版（改版本号 → 再点一次「发布」）

1. 改版本号：编辑 `mods/<id>/evejs-launcher.mod.json` 里的 `"version"`（例如 `1.0.1`）
   🟨 也可以在 **创建模组** 里用同一个 id 重新生成 —— 但**别改 id**
2. 模组 / 插件 → **发布模组** → 选你的模组 → 填版本号与更新说明 → 点 **发布**
   （同一个仓库、新 tag `v1.0.1`、新 ZIP `<id>-1.0.1.zip`；同一条 `release/<id>` 分支刷新那条 PR）

🟨 **为什么版本号必须递增**：市场按版本号判断"有没有新版"；版本号不变，别人的启动器就不会提示更新。

🟦 **为什么 ZIP 文件名带版本号**：jsDelivr 对分支引用有最长约 12 小时缓存；新文件名 = 不会命中旧缓存。

---

# 第四部分：审核、下架与恢复

## 维护者会怎么审

| 检查项 | 要求 |
| --- | --- |
| 仓库归属 | 必须是你自己的仓库 |
| 清单完整性 | `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` / `sizeBytes` / `sha256`(64 位 hex) / `downloadUrls[]` |
| ZIP 位置 | 放在**你自己的 Release**（索引仓库不存二进制） |
| 分类 | 玩法 / 经济 / AI / 画面 / 工具 五选一 |
| 归属硬规则 | `id` 先到先得；`author.id` 与密钥绑定（换钥匙会被拒） |
| 服务端源码补丁 | 改了服务端文件的模组要用 `__evejsMods.register`（附录 G）；自己 hook `Module.prototype._compile` 的会被要求改 —— 多个模组各自挂钩子会互相顶掉 |

## 你会在哪里看到审核结果

启动器 → 模组 / 插件 → **我创建的**：

| 卡片状态 | 含义 | 你能做什么 |
| --- | --- | --- |
| 🟩 已上架 | 已进市场 | 发新版即可 |
| 🟨 可更新 / 本地比已上架新 | 你本地版本比市场新 | 走步骤 8 |
| 🟧 已下架 | 被维护者下架 | 卡片上有**下架原因**；改好后点 **重新提交审核** |
| 🟥 已拒绝收录 | 没通过审核 | 卡片上有**拒绝收录原因**；改好后点 **重新提交审核** |
| ⬜ 仅本地 / 待提交 | 还没发布 | 走步骤 7 |

🟦 **我创建的**只显示"你本地还有这个模组、或市场里仍可安装"的条目；本地文件夹删掉后，只剩审核记录的条目会自动隐藏（标题栏会提示"已隐藏 N 条"）。

---

# 附：重点注意事项（🟥 收藏这段就够）

| # | 事项 | 后果 |
| --- | --- | --- |
| 1 | 🟥 别把别人的模组当自己的提交（清单里 `author.id` 不是你的会被主进程直接拒绝） | 提交失败 |
| 2 | 🟥 `.eve-key` / 私钥绝不外传、绝不提交、绝不打进 ZIP | 身份被盗用，或你彻底失去更新能力 |
| 3 | 🟥 不要在磁盘上改服务端文件 | 直接改别人的 `server/` 会装不上 / 一升级就崩；要在内存里改就走 `__evejsMods.register`（附录 G） |
| 4 | 🟥 不要在 loader 里 `require` 服务端大模块 | Node 内存暴涨 |
| 5 | 🟨 版本号只能往上加 | 别人收不到更新 |
| 6 | 🟨 改了代码必须重新点一次「发布」（自动重签、重打包、重推） | 签名失效 / 市场还是旧包 |
| 7 | 🟨 `id` 建好后不要改 | 老用户那边会变成"卸载 + 新装" |
| 8 | 🟨 ZIP 文件名带版本号 | 否则可能命中 CDN 缓存，别人下到旧包 |
| 9 | 🟨 分类只用五个固定值 | 市场筛选里看不到 |
| 10 | 🟦 loader 只装一次（`globalThis` 判断） | 否则重复注册、消息重复 |

---

# 附录 A：清单字段全表（`evejs-launcher.mod.json`）

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | number | 固定 `3` |
| `id` | ✅ | string | 模组标识，≤128 字符，不能含路径分隔符，建议 `a-z0-9-` |
| `displayName` | ✅ | string | 显示名，≤100 字符 |
| `version` | ✅ | string | 版本号，≤64 字符，如 `1.0.0` |
| `kind` | ✅ | string | `loader`（可用）/ `settings` / `client-package` / `source-integrated`（后续版本） |
| `restart` | ✅ | string | `none` / `client` / `game_server` / `launcher` |
| `activation.strategy` | ✅ | string | `loader_rename` |
| `description` | ⭕ | string | 简介，≤1000 字符（市场卡片展示） |
| `category` | 🟩 | string | 玩法 / 经济 / AI / 画面 / 工具 |
| `tags` | ⭕ | string[] | 标签 |
| `author` | ✅ | object | `{ id, name, keyId, publicKey }`（启动器自动写入） |
| `requires` / `loadAfter` / `loadBefore` / `conflicts` | ⭕ | string[] | 依赖与冲突（写模组 id） |
| `compatibility.evejsVersions` | ⭕ | string[] | 兼容的 EveJS 版本，如 `["0.12.8"]` |
| `signature` | ✅ | object | 签名（启动器自动生成） |

# 附录 B：一个能跑的 loader 骨架

这是启动器「创建模组」生成的骨架的**精简版** —— 四条硬约定一条不少，改吧改吧就能用（完整的注释版直接看 `mods/<你的模组 id>/loader.js`）：

```js
"use strict";
const path = require("path");

const TAG = "[我的模组]";
const MOD_ID = "my-mod";
const POLL_MS = 3000;
const GRACE_MS = 10000;                      // 上线后等这么久再发：会话要先就绪
const MESSAGE = "欢迎回来，飞行员！";

// 要改服务端源码就打开这一段（新机制：总线上报、只追加），不改就保持 null：
//   target —— 相对 EveJS 根目录、正斜杠
//   marker —— 唯一标记，总线上检测到已存在就跳过（幂等）
//   slot   —— 同一个文件有多层补丁时的先后，越小越前（建议留 10 的整数倍）
//   append —— 只追加的代码，别整段重写
const SOURCE_PATCH = null;
// const SOURCE_PATCH = {
//   target: "server/src/network/tcp/handshake.js",
//   marker: "// my-mod:patch",
//   slot: 40,
//   append: "// my-mod:patch\nconsole.log('[my-mod] patched');",
// };

console.log(TAG + " preload 已执行 · pid=" + process.pid);

/** 只在真正的服务端进程里继续（排除 npm / 包装进程） */
function isRealServerProcess() {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  const entry = (require.main && require.main.filename) || process.argv[1] || "";
  return /(^|[\\/])index\.js$/i.test(entry);
}

/** 把源码补丁注册到注入总线（🟥 必须同步执行，原因见下面） */
function registerSourcePatch() {
  if (!SOURCE_PATCH || !SOURCE_PATCH.target) return;
  const bus = globalThis.__evejsMods;
  if (!bus || !(Number(bus.api) >= 1)) {
    console.log(TAG + " 老启动器没有注入总线，跳过源码补丁");
    return;
  }
  bus.register({
    id: MOD_ID,
    target: SOURCE_PATCH.target,
    marker: SOURCE_PATCH.marker,
    slot: SOURCE_PATCH.slot,
    apply: (source) => source + "\n" + SOURCE_PATCH.append + "\n",
  });
}
// 🟥 同步注册：服务端启动时就会 require 目标文件，
//    放进 setImmediate 里再注册就晚了（那时文件已经编译过，补丁不会生效）
registerSourcePatch();

setImmediate(() => {
  if (!isRealServerProcess()) return;
  if (globalThis.__myModStarted) return;      // 🟨 会被加载多次：只装一次
  globalThis.__myModStarted = true;
  start();
});

function start() {
  // 🟥 require("./src/...") 是相对**你的模组目录**，不是服务端根目录 —— 必须先算出根目录
  const serverRoot = path.resolve(__dirname, "..", "..", "server");
  const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
  const registryPath = path.join(serverRoot, "src", "services", "chat", "sessionRegistry.js");

  // 🟨 等服务端自己把这两个模块加载进 require.cache 再取引用：
  //    缓存命中、零额外内存，也不会把 456MB 的模块图提前拉起来
  const timer = setInterval(() => {
    if (!require.cache[require.resolve(hubPath)]) return;
    if (!require.cache[require.resolve(registryPath)]) return;
    clearInterval(timer);
    run(require(require.resolve(hubPath)), require(require.resolve(registryPath)));
  }, 500);
  timer.unref();
}

function run(chatHub, sessionRegistry) {
  const seen = new Set();
  const firstSeenAt = new Map();

  const timer = setInterval(() => {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions() || [];
    } catch {
      return;
    }

    const now = Date.now();
    const online = new Set();

    for (const session of sessions) {
      const characterID = sessionRegistry.resolveSessionCharacterID(session);
      if (!characterID) continue;              // 还没真正进游戏，等下一轮
      online.add(characterID);
      if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
      if (seen.has(characterID)) continue;
      if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

      try {
        // 有的会话对象只带小写 charid，补一次，避免"静默不发送"
        if (!Number(session.characterID || 0)) session.characterID = characterID;
        chatHub.sendSystemMessage(session, MESSAGE);
        seen.add(characterID);
        console.log(TAG + " 已向角色 " + characterID + " 发送消息");
      } catch (error) {
        console.log(TAG + " 角色 " + characterID + " 尚未就绪，稍后重试：" + error.message);
      }
    }

    // 下线的角色清掉，下次登录会重新触发
    for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
    for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
  }, POLL_MS);
  timer.unref();
}
```

🟨 上面用到的是**实测可用**的服务端接口：

| 接口 | 用途 |
| --- | --- |
| `sessionRegistry.getSessions()` | 在线会话数组（🟥 **不是** `list()`，那个方法不存在） |
| `sessionRegistry.resolveSessionCharacterID(session)` | 取角色 ID（未进入游戏时为 0） |
| `chatHub.sendSystemMessage(session, "消息")` | 在该角色本地频道发系统消息 |

不同 EveJS 版本接口可能变化，以你版本里的实际导出为准。

# 附录 C：冲突与加载顺序

| 类型 | 怎么产生的 | 后果 |
| --- | --- | --- |
| 声明冲突 | 清单里 `conflicts` 互相写了对方 | 两个模组不会同时启用 |
| 重复 `id` | 两个目录里的清单 `id` 相同 | 只加载其中一个 |
| 共用服务端模块 | 多个 loader 同时引用同一个服务端模块 | 可能互相影响（启动器会提示） |
| 依赖缺失 | `requires` 里的模组没装 | 该模组不会加载 |

🟦 加载顺序：在**已安装**页可以**拖拽**卡片排序，也可以点卡片左上角的「⤓ 移到最后」。列表按「已启用在前、已停用在后」分组，两段内部都是你排的顺序 —— 关掉一个模组不用重排，重新打开会回到原位。
🟨 清单里的 `loadAfter` / `loadBefore` **优先级更高**，会插进来微调你拖的顺序；被挪过位置的模组会在「加载顺序」面板里标成「清单约束调整过位置」。
🟦 「加载顺序」面板列的是**真正生效**的次序，并单独列出**本次不会加载**的模组（清单坏了 / 缺依赖 / 冲突 / 没有 loader.js）和**没生效的顺序声明**（目标没装或已停用、顺序记录里的目录已被删掉）。改完要**重启服务端**才生效。

## 🟥 多个模组改同一个服务端文件（新启动器有解）

如果模组是**自己 hook `Module.prototype._compile`** 去改服务端源码，两个模组改同一个文件就会出事：

- 谁先看到原始文件完全取决于加载顺序；
- 其中一个模组按「整份文件的 sha256」校验时，会因为另一个模组已经追加过内容而**校验失败**；
- 实测过的那一幕：`自动挖矿` 与 `自动锁定自动集火` 都往 `server/src/network/tcp/handshake.js` 末尾追加代码，先注入的把内容写进去之后，后注入的看到哈希对不上就**安静地放弃**（不报错，也不生效）。

🟩 新启动器为此提供了**注入总线**：模组不再各自挂钩子，而是用 `__evejsMods.register` 声明「改哪个文件、加什么」，由总线按 `(slot, 注册先后)` 串成一条链 —— 每一层看到的是**前一层改过之后**的内容。用法见**附录 G**。

# 附录 D：ZIP 结构与被导入的规则

### ZIP 结构（两种都支持，推荐方式二）

```text
方式一：根目录直接放清单            方式二：单层文件夹包住（推荐）
my-mod.zip                          my-mod.zip
├── evejs-launcher.mod.json          └── my-mod/
├── loader.js.disabled                   ├── evejs-launcher.mod.json
└── README.md                            ├── loader.js.disabled
                                          └── README.md
```

启动器会自动定位包根；ZIP 里如果有**多个**模组包会被拒绝（一次只导一个）。

### 别人导入你的 ZIP 时的规则

| 规则 | 说明 |
| --- | --- |
| 安装位置 | `<EveJS 根>/mods/<清单 id>`（id 里的非法字符会被换成 `-`） |
| 初始状态 | **强制禁用**（`loader.js` 会被改回 `loader.js.disabled`），用户手动开 |
| 同名冲突 | `mods/` 下已有同名目录 → 拒绝导入并提示 |
| 清单缺失 | ZIP 里没有 `evejs-launcher.mod.json` → 拒绝 |

### 🟨 体积

模组页会**递归统计每个模组的占用空间**。只打包运行必需的文件 —— 🟥 不要把源码仓库、`node_modules`、截图、`.git` 塞进 ZIP。

# 附录 E：loader 是怎么被注入的

🟩 **现在（走注入总线时）**：启动器只往 `NODE_OPTIONS` 里放**一条** `--require "<启动器自带的 mod-host.js>"`，你的 `loader.js` 由总线按 `_launcher/mods/mod-plan.json` 的顺序 `require` 进来。所以模组目录名带中文或空格都没问题；启动器日志里 `[EveJS-MOD] loaders-done total=N failed=0 ms=X` 就是「全部模组加载完花了多少毫秒」。

🟨 **下面这段是「每个 loader 一条 `--require`」的旧写法**（现在只在总线写盘失败时当保底用）：启动器是通过 Node 的 `NODE_OPTIONS=--require ...` 把你的 `loader.js` 注入服务端进程的。因此：

- 🟥 **反斜杠会被当作转义符吞掉** → `C:\mods\x\loader.js` 会变成 `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` 按空格分词，**含空格的路径必须加引号**

正确写法是「把路径转成正斜杠 + 用双引号包住」——启动器内部就是这么拼的（已实测）：

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 你**不需要**自己拼这段 —— 只要知道「模组目录不要放中文或空格路径」，排错时能对上号。

# 附录 F：发布前检查表

- [ ] 模组在本地能启用、能生效（步骤 6 测过）
- [ ] 需要改服务端源码的模组走了 `__evejsMods.register`（附录 G），没有自己 hook `_compile`
- [ ] `evejs-launcher.mod.json` 里 `id` / `version` / `category` 都对
- [ ] 版本号**比上一版大**
- [ ] `.eve-key` 已备份（换电脑要用）
- [ ] `mods/<id>/` 里没有私钥、没有你的本机路径等隐私内容
- [ ] 点过 **发布模组**，四个环节都走完，ZIP 能在你自己的 Release 页面点到
- [ ] 这一版在索引仓库开出的 review PR **已经被合并**（没合并＝市场还停在上一版）


# 附录 G：改服务端源码 —— 注入总线 `__evejsMods.register`

🟨 只有**必须改服务端源码**的模组才需要这段。像「登录问候」那样只调用服务端 API 的模组，用附录 B 的写法就够了。

总线由启动器注入，模组侧在文件末尾声明就行：

```js
const bus = globalThis.__evejsMods;
if (bus && bus.api >= 1) {
  bus.register({
    id: "你的模组 id",                              // 与清单里的 id 一致，报告里用它标记
    target: "server/src/network/tcp/handshake.js",  // 相对 EveJS 根目录，正斜杠
    marker: "MY_MOD_MARK",                         // 唯一标记：已经注入过就自动跳过（幂等）
    slot: 10,                                      // 同一个文件有多层时的先后，越小越前
    apply: (source) => source + "\n// MY_MOD_MARK\n// 这里写你要追加的代码\n",
  });
} else {
  // 老启动器没有总线：可以回退成自己 hook，或者干脆不注入
}
```

四条约定（🟥 违反任何一条都会让别的模组莫名失效）：

| 约定 | 为什么 |
| --- | --- |
| 只用 `register`，**不要**再自己 hook `Module.prototype._compile` | 自己挂钩子又会回到「抢注入点」，总线也看不见你的改动 |
| `apply` **只追加**，不要整段重写或删除原有内容 | 后面的层要拿到你改完的结果继续追加 |
| `marker` 用一个别人不会用到的唯一串 | 总线靠它判断这次是不是已经注入过，重复启动不会叠加 |
| 要校验就校验**改动前的前缀**（或长度），别拿整份文件 sha256 | 整份哈希在多层串链下必然对不上，等于把自己锁死 |

🟩 怎么看结果：日志里 `[EveJS-MOD] <文件> 注入 N 层（A -> B 字节）` 是这一层生效了；`[EveJS-MOD] <id> 补丁失败，保留上一层结果：<原因>` 是这一层被跳过（**不会**影响其它模组）。

---

**文档版本**：随启动器发布更新（与启动器 `_launcher/mods/MOD_AUTHORING.md` 同步）。
遇到本文档没写的情况，先看启动器里的**服务器日志**和卡片上的红色提示，再带着日志去问维护者。