# EveJS 模组制作教程（作者视角）

> 面向**想做一个模组的人**：从零到一个能在模组市场被安装的模组，一共 **10 个步骤**。
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
| 3 | 创建 **GitHub 令牌**（fine-grained） | GitHub 网页 | 5 分钟 | ✅（发布时需要） |
| 4 | **创建模组**（生成骨架） | 启动器 | 3 分钟 | ✅ |
| 5 | 写你的逻辑（`loader.js`） | 编辑器 | 看需求 | ✅ |
| 6 | 本地测试（启用 / 看日志） | 启动器 | 5 分钟 | 🟩 推荐 |
| 7 | **1) 生成并打包** | 启动器 | 1 分钟 | ✅ |
| 8 | **2) 发布到我的仓库** | 启动器 | 1 分钟 | ✅ |
| 9 | **3) 申请收录**（一次性 PR） | 启动器 | 1 分钟 | ✅ |
| 10 | 发新版（改版本号 → 重复 7、8） | 启动器 | 1 分钟 | 🟩 推荐 |

> 🟦 **一次性 vs 每次都要做的**：步骤 1~4 只做一次；发新版只需要 **7 → 8**（步骤 9 的 PR 一辈子只提一次）。

---

# 第一部分：准备（一次性）

## 步骤 1 ✅ 确认环境

1. 打开启动器 → **环境自检**：Node.js / 依赖 / 客户端路径 等 9 项，红的先解决。
2. 确认 EveJS 服务端根目录（含 `server/`、`config/`）。启动器 → **配置中心** 里能看到当前用的路径。
3. 确认 **`mods/` 目录**存在。不存在就在 模组 / 插件 → **创建 mods 文件夹**。

🟨 **注意**：模组目录固定是 `<EveJS 根目录>/mods/<模组标识>/`，**不要**放到别的地方，也不要改成中文目录名。

---

## 步骤 2 ✅ 创建作者身份（这是"你是谁"的凭证）

模组 / 插件 → 顶部 **作者身份**：

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

## 步骤 3 ✅ 创建 GitHub 令牌（发布模组用）

发布模组是启动器**替你操作你自己的 GitHub 仓库**，所以需要一个令牌（Token）。
共 6 小步：

### 3.1 打开正确的页面 🟨

```
GitHub 右上角头像 → Settings → 左栏最底部 Developer settings
  → Personal access tokens → Fine-grained tokens → Generate new token
```

🟥 **别用 `Tokens (classic)`**：那一页只有 `repo` / `workflow` 这类 scope，**没有**下面要勾的 `Contents` / `Pull requests`。

### 3.2 填基本信息

| 字段 | 填什么 |
| --- | --- |
| Token name | 随便，比如 `evejs-launcher` |
| Expiration | 建议 90 天或自定义（过期后要重新生成） |
| Description | 选填 |

### 3.3 选 Resource owner 与仓库范围

- **Resource owner**：选**你自己的账号**
- **Repository access**：🟩 选 **All repositories**（最省事；只选特定仓库时，新建的仓库不在列表里会报 404）

### 3.4 勾权限（关键）🟨

往下滚到 **Permissions** → 展开 **Repository permissions**（🟥 不是 Account permissions），勾这四项：

| 权限 | 设成 | 作用 | 不勾会怎样 |
| --- | --- | --- | --- |
| **Contents** | Read and write | 写 `evejs-mod.json`、建 Release、上传 ZIP | 写清单/发 Release 报 403 |
| **Pull requests** | Read and write | 步骤 9 申请收录时开 PR | 申请收录报 403 |
| **Administration** | Read and write | 步骤 8 自动**建仓库**用 | 建仓库报 `403 Resource not accessible` |
| **Metadata** | Read-only | GitHub 自动勾上，不用管 | — |

> 🟦 只想手动提交、不想让启动器自动建仓库的：可以不勾 Administration，但要**先在 GitHub 建好仓库**，然后在启动器「我的仓库」里填 `owner/repo`。

### 3.5 生成并复制

点 **Generate token** → 复制那串 `github_pat_...`（🟨 **只显示一次**，关掉页面就看不到了）。

### 3.6 填进启动器

模组 / 插件 → **提交模组** → 找到 GitHub 令牌 → 粘贴 → 点 **保存**（会加密存在本机）→ 点 **校验** 确认可用。

🟨 **注意**：改过令牌权限或重新生成后，要把新令牌**重新粘贴保存**一次。

---

# 第二部分：做一个模组

## 步骤 4 ✅ 创建模组（生成骨架）

模组 / 插件 → **创建模组**，填表：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 模板 | ✅ | `Welcome Broadcast (Example)`（带一条登录欢迎消息的示例）/ `Blank Skeleton`（空骨架）。🟩 第一次建议先用示例跑通 |
| 模组名 | ✅ | 显示给玩家看的名字 |
| 标识（id / 目录名） | 🟩 | 会自动按名字生成；只允许 `a-z 0-9 - _ .`，建好后**不要再改** |
| 版本 | ✅ | 默认 `1.0.0`；发新版要**递增**（见步骤 10） |
| 分类 | ✅ | 玩法 / 经济 / AI / 画面 / 工具（市场按这个筛选） |
| 标签 | ⭕ | 逗号分隔，比如 `聊天, 新手` |
| 简介 | 🟩 | 一句话，会显示在市场上的卡片里 |
| 详细介绍 / 功能要点 | ⭕ | 会写进你模组的 README |
| 冲突模组 id | ⭕ | 与哪些模组互斥，逗号分隔 |
| 构建选项 | — | ☑ 需要重启服务端（默认开）、☐ 建好后立即启用、☑ 建好后立即签名 |

点 **创建** 后，你的 `mods/` 目录里会多出：

```
mods/<你的模组 id>/
├─ evejs-launcher.mod.json    ← 清单（身份、版本、分类、依赖都在这）
├─ loader.js                  ← 你要写的逻辑
├─ loader.js.disabled         ← 未启用时的名字（启用后变成 loader.js）
├─ README.md                  ← 从「详细介绍」生成
└─ CHANGELOG.md               ← 版本变更记录
```

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

打开 `mods/<你的模组 id>/loader.js`，里面已经有骨架。核心就一件事：**往服务端已有的模块上挂东西**。

```js
// 🧩 最小示例：玩家上线后发一条本地聊天消息
const chatHub = require('./src/services/chat/chatHub');        // 路径从服务端根目录算
const sessionRegistry = require('./src/services/chat/sessionRegistry');

// 🟨 必须做身份校验：loader 会被加载多次，不做校验会重复注册
if (!globalThis.__myModInstalled) {
  globalThis.__myModInstalled = true;
  // 在这里挂你的逻辑
}
```

🟥 **三个必踩的坑**：

1. **会被加载多次** → 一定要用 `globalThis.__xxx` 之类做**只装一次**的判断，否则消息会重复发送、监听器越堆越多。
2. **不要 `require` 服务端大模块**（比如整个 `server` / 庞大的世界模型）→ 会把 Node 内存吃满（实测过内存暴涨）。
3. **会话属性**：聊天会话上的自定义属性**不会自动同步**，直接读写可能"静默失败"，要走 `chatHub` 提供的接口。

🟨 **路径规则**：loader 里 `require('./src/...')` 是相对**服务端根目录**解析的，不是相对你的模组目录。

---

## 步骤 6 🟩 本地测试

1. 模组 / 插件 → **已安装** → 找到你的模组 → 把开关**打开**（或创建时勾了"立即启用"）
2. 启动器 → 控制台 → **一键启动**（只拉起主服务器 + 市场服务）
3. 进游戏验证效果
4. 出问题看两处日志：
   - 启动器 → **服务器日志**（可以按 系统 / 主服务器 / 市场服务 / 客户端 和 INFO/WARN/ERROR 筛选）
   - 服务端控制台输出（启动器里能看到）

### 🔧 排错速查

| 症状 | 最可能的原因 |
| --- | --- |
| 模组列表里显示"缺少 loader.js" | 文件被删了，或改成了别的名字 |
| 打开开关后又自己关掉 | 清单校验失败 / 签名被改过 → 看卡片上的红色提示 |
| 日志里看不到"加载模组" | 模组在**已停用**状态，或与别的模组冲突被跳过 |
| 游戏里没效果、日志也没报错 | 逻辑里没做"只装一次"判断前就 return 了；或路径 `require` 写错 |
| Node 内存暴涨 | `require` 了服务端大模块（见步骤 5 的坑 2） |

---

# 第三部分：发布到市场

> 这一部分就是启动器 **提交模组** 弹窗里的 `1) 2) 3)` 三步。

## 步骤 7 ✅ 1) 生成并打包（完全离线）

模组 / 插件 → **提交模组**：

1. **选择模组**：下拉里**只列出你自己的模组**（别人的模组不会出现，避免误提交）
2. 填 **更新说明**（会写进索引和 PR，建议写人话）
3. 确认 **分类 / 标签**（会自动带出清单里的值）
4. **源码 / 项目地址** ⭕（选填，比如 `https://github.com/你/你的模组`）
5. **GitHub Releases 直链** ⭕ 留空即可（第 8 步会自动生成正确的地址）
6. 点 **`1) 生成并打包`**

这一步做了什么（**不联网、不需要令牌**）：

```
重新签名 → 打包 ZIP → 计算 SHA256 → 生成上架清单
```

产物：

| 产物 | 位置 |
| --- | --- |
| ZIP 包 | `_launcher/temp/export-<id>-<version>.zip` |
| 提交台账 | `_launcher/data/my-submissions.json` |
| 索引分片（JSON） | 弹窗里直接显示，可复制 |

🟨 **注意**：每次改完代码都要**重新点一次 `1)`**（因为改了内容，签名会失效；启动器会自动重新签名）。

---

## 步骤 8 ✅ 2) 发布到我的仓库

1. （可留空）**我的仓库**：留空会自动建一个 `evejs-mod-<id>`；也可以自己填 `owner/repo`
2. 点 **`2) 发布到我的仓库`**
3. 看**进度条**依次走：

```
校验 GitHub 令牌 → 准备仓库 → 写入 evejs-mod.json → 创建 Release → 上传 ZIP（最慢的一步）→ 完成
   5%              20%           40%                    60%            75%                     100%
```

它替你做了 4 件事（只动**你自己的仓库**，不碰索引仓库）：

1. 没有仓库就建一个公开仓库
2. 写入 `evejs-mod.json`（市场就是读这个文件）
3. 建 Release：tag = `v<版本号>`
4. 上传 ZIP：文件名 `<id>-<version>.zip`

### 🔧 这一步的常见报错

| 报错 | 原因 | 怎么解决 |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | 令牌缺权限 | 补 **Administration = Read and write**（要自动建仓库）和 **Contents = Read and write**；Repository access 选 All repositories |
| 🟥 `net::ERR_INVALID_ARGUMENT` | 旧版启动器上传 ZIP 的 bug | 升级到 **0.1.20+** |
| 🟥 `404` | 仓库不存在，或令牌没覆盖它 | 检查 owner/repo 拼写；把令牌的 Repository access 改成 All repositories |
| 🟥 `还没有填 GitHub 令牌` | 没保存令牌 | 回到步骤 3.6 |

🟩 **成功之后**：弹窗会显示仓库地址和 Release 地址，可以点开看看 ZIP 在不在。

---

## 步骤 9 ✅ 3) 申请收录（一辈子只提一次）

点 **`3) 申请收录`** → 启动器会往索引仓库提一个 PR（改 `sources.json`，加一行你的仓库）。

- 维护者会在 PR 里审核你的模组（清单字段、分类、ZIP 位置等）
- **通过**：合并后 CI 会在几十分钟内把你的模组聚合进市场，所有人的启动器都能搜到
- **不通过**：维护者会在 PR 里回复原因，同时你的启动器 **我创建的** 里那张卡片会变红，写明**拒绝收录原因**

🟦 之后**发新版完全不用再提 PR**：你推自己的仓库，索引会自动更新（见步骤 10）。

---

## 步骤 10 🟩 发新版（重复 7 → 8 就行）

1. 改版本号：编辑 `mods/<id>/evejs-launcher.mod.json` 里的 `"version"`（例如 `1.0.1`）
   🟨 也可以在 **创建模组** 里用同一个 id 重新生成——但**别改 id**
2. 模组 / 插件 → **提交模组** → 选你的模组 → 点 **`1) 生成并打包`**
3. 点 **`2) 发布到我的仓库`**（同一个仓库、新 tag `v1.0.1`、新 ZIP `<id>-1.0.1.zip`）

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

## 你会在哪里看到审核结果

启动器 → 模组 / 插件 → **我创建的**：

| 卡片状态 | 含义 | 你能做什么 |
| --- | --- | --- |
| 🟩 已上架 | 已进市场 | 发新版即可 |
| 🟨 可更新 / 本地比已上架新 | 你本地版本比市场新 | 走步骤 10 |
| 🟧 已下架 | 被维护者下架 | 卡片上有**下架原因**；改好后点 **重新提交审核** |
| 🟥 已拒绝收录 | 没通过审核 | 卡片上有**拒绝收录原因**；改好后点 **重新提交审核** |
| ⬜ 仅本地 / 待提交 | 还没发布 | 走步骤 7、8 |

🟦 **我创建的**只显示"你本地还有这个模组、或市场里仍可安装"的条目；本地文件夹删掉后，只剩审核记录的条目会自动隐藏（标题栏会提示"已隐藏 N 条"）。

---

# 附：重点注意事项（🟥 收藏这段就够）

| # | 事项 | 后果 |
| --- | --- | --- |
| 1 | 🟥 别把别人的模组当自己的提交（清单里 `author.id` 不是你的会被主进程直接拒绝） | 提交失败 |
| 2 | 🟥 `.eve-key` / 私钥绝不外传、绝不提交、绝不打进 ZIP | 身份被盗用，或你彻底失去更新能力 |
| 3 | 🟥 不要修改服务端任何文件 | 你的模组会在别人机器上装不上 / 一升级就崩 |
| 4 | 🟥 不要在 loader 里 `require` 服务端大模块 | Node 内存暴涨 |
| 5 | 🟨 版本号只能往上加 | 别人收不到更新 |
| 6 | 🟨 发新版必须重新走 `1)`（重签）+ `2)`（重发） | 签名失效 / 市场还是旧包 |
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

```js
/**
 * 载入时会执行多次：务必只装一次。
 * require 路径相对【服务端根目录】，不要 require 服务端大模块。
 */
if (!globalThis.__myFirstMod) {
  globalThis.__myFirstMod = true;

  const sessionRegistry = require('./src/services/chat/sessionRegistry');
  const chatHub = require('./src/services/chat/chatHub');

  // 🟨 上线有宽限期：玩家登录后不一定会话立刻可用，稍等一下再发
  const timer = setInterval(() => {
    try {
      const online = sessionRegistry.list ? sessionRegistry.list() : [];
      for (const s of online) {
        if (s && s.characterId && !globalThis.__greeted?.[s.characterId]) {
          globalThis.__greeted = globalThis.__greeted || {};
          globalThis.__greeted[s.characterId] = true;
          chatHub.sendSystemMessage(s, '欢迎回来，飞行员');
        }
      }
    } catch (e) {
      // 静默失败比抛错好：不要把整个服务端带崩
    }
  }, 5000);
  timer.unref?.();
}
```

🟨 上面用到的是**实测可用**的服务端接口：`src/services/chat/sessionRegistry`（在线会话）、`src/services/chat/chatHub`（发系统消息）。不同 EveJS 版本接口可能变化，以你版本里的实际导出为准。

# 附录 C：冲突与加载顺序

| 类型 | 怎么产生的 | 后果 |
| --- | --- | --- |
| 声明冲突 | 清单里 `conflicts` 互相写了对方 | 两个模组不会同时启用 |
| 重复 `id` | 两个目录里的清单 `id` 相同 | 只加载其中一个 |
| 共用服务端模块 | 多个 loader 同时引用同一个服务端模块 | 可能互相影响（启动器会提示） |
| 依赖缺失 | `requires` 里的模组没装 | 该模组不会加载 |

🟦 加载顺序：在**已安装**页可以**拖拽**卡片排序，顺序保存在 `_launcher/mods/mod-order.json`；清单里的 `loadAfter` / `loadBefore` 优先级更高。

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

# 附录 E：loader 是怎么被注入的（NODE_OPTIONS 的坑）

启动器是通过 Node 的 `NODE_OPTIONS=--require ...` 把你的 `loader.js` 注入服务端进程的。因此：

- 🟥 **反斜杠会被当作转义符吞掉** → `C:\mods\x\loader.js` 会变成 `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` 按空格分词，**含空格的路径必须加引号**

正确写法是「把路径转成正斜杠 + 用双引号包住」——启动器内部就是这么拼的（已实测）：

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 你**不需要**自己拼这段 —— 只要知道「模组目录不要放中文或空格路径」，排错时能对上号。

# 附录 F：发布前检查表

- [ ] 模组在本地能启用、能生效（步骤 6 测过）
- [ ] `evejs-launcher.mod.json` 里 `id` / `version` / `category` 都对
- [ ] 版本号**比上一版大**
- [ ] `.eve-key` 已备份（换电脑要用）
- [ ] `mods/<id>/` 里没有私钥、没有你的本机路径等隐私内容
- [ ] 走了 `1) 生成并打包` → `2) 发布到我的仓库`（ZIP 能在 Release 页面点到）
- [ ] 第一次发布：走过 `3) 申请收录`，并在 PR 里看到维护者的回复

---

**文档版本**：随启动器发布更新（与启动器 `_launcher/mods/MOD_AUTHORING.md` 同步）。
遇到本文档没写的情况，先看启动器里的**服务器日志**和卡片上的红色提示，再带着日志去问维护者。