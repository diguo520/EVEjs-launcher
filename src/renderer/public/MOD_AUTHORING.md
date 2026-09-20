# EveJS 模组制作规范

> 适用：EvEJS 启动器 0.1.18 及以上 · manifest schema 3 · Native 后端
> 本文档由启动器自动释放到 `_launcher/mods/MOD_AUTHORING.md`，每次启动会更新。

---

## 0. 一句话理解

**EveJS 服务端本身不知道"模组"是什么。** 模组是**启动器层**的机制：

1. 启动器扫描 `<EveJS 根>/mods/` 下每个文件夹里的 `evejs-launcher.mod.json`；
2. 你（作者）在启动器里把模组切成"启用"；
3. 启动器启动游戏服务时，通过 **`NODE_OPTIONS=--require`** 把你的 `loader.js` **预加载进服务端进程**；
4. 因为跑在同一个 Node 进程里，你可以用 Node 的模块缓存直接调用服务端内部 API。

**全程不需要修改服务端任何文件**（`server/` 目录一个字节都不动）。

---

## 1. 目录结构

```
<EveJS 根>/mods/
└── my-mod/                              ← 一个模组一个文件夹（文件夹名可与 id 不同）
    ├── evejs-launcher.mod.json         ← 必需：清单
    ├── loader.js.disabled              ← 必需（loader 类型）：默认禁用状态
    ├── README.md                       ← 建议：给使用者看
    └── helper.js                       ← 可选：helper（本启动器暂不支持）
```

> 发布时打包成 ZIP 交给玩家，玩家用启动器里的「导入 ZIP」安装（ZIP 结构见 §8）。
> **导入后模组一定是禁用状态**，玩家自己打开开关才会生效。

**启用/禁用的本质就是改名**：

| 状态 | 文件名 |
| --- | --- |
| 禁用 | `loader.js.disabled`（也识别 `loader.js.off` / `loader.js.bak`） |
| 启用 | `loader.js` |

启动器在「模组 / 插件」页点开关时执行的就是这个改名。**改名后必须重启游戏服务**，因为 loader 只在进程启动时注入。

---

## 2. 清单：evejs-launcher.mod.json

最小可用例子：

```json
{
  "schemaVersion": 3,
  "id": "my-mod",
  "displayName": "My Mod",
  "version": "1.0.0",
  "description": "一句话说明这个模组做什么。",
  "kind": "loader",
  "supportedBackends": ["native", "docker"],
  "activation": { "strategy": "loader_rename" },
  "restart": "game_server"
}
```

### 字段表

| 字段 | 必需 | 约束 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 必须是整数 `3` |
| `id` | ✅ | 唯一、稳定、≤128 字符；不能含 `/` `\`；发布新版本**不要改** |
| `displayName` | ✅ | 玩家看到的名字，≤100 字符 |
| `version` | ✅ | ≤64 字符，建议语义化版本 |
| `description` | | ≤1000 字符 |
| `kind` | ✅ | `loader` / `source-integrated` / `client-package` / `settings` |
| `supportedBackends` | | `native` / `docker` |
| `activation` | ✅ | loader 用 `{"strategy":"loader_rename"}` |
| `restart` | ✅ | `none` / `game_server` / `client` / `launcher` |
| `requires` | | 依赖的模组 id 数组，≤64 项 |
| `loadAfter` / `loadBefore` | | 加载顺序提示（只对 loader 有意义） |
| `conflicts` | | 互斥的模组 id 数组 |
| `launcherApi` | | helper 声明（本启动器暂不支持） |
| `settings` | | 设置表单（本启动器暂不支持） |
| `updates` | | GitHub 更新源（本启动器暂不支持） |
| `compatibility` | | 例如 `{"evejsVersions":["0.12.8"]}` |

清单文件大小上限 **1 MiB**；`id` / 依赖引用大小写不敏感。

---

## 3. 四种 kind 与能力边界

| kind | 做什么 | 改服务端文件？ | 本启动器（0.1.17） |
| --- | --- | --- | --- |
| **`loader`** | 预加载一段 Node 代码到服务端进程 | **完全不改** | ✅ 支持 |
| `settings` | 只改某个配置 JSON 的布尔开关 | 不改 | ⏳ 计划中 |
| `client-package` | 改客户端文件（install/verify/recover） | 不改服务端 | ⏳ 计划中 |
| `source-integrated` | 覆盖服务端源码（启用时装、禁用时还原） | **会改** | ⏳ 计划中 |

> 想遵守"不改服务端文件"，就用 **`loader`**。这也是本文档的重点。

---

## 4. loader 的注入原理

启动器启动主服务时设置：

```
NODE_OPTIONS=--require "E:/…/mods/a-mod/loader.js" --require "E:/…/mods/b-mod/loader.js"
```

### 4.1 一个必须知道的坑：NODE_OPTIONS 的路径规则

Node 解析 `NODE_OPTIONS` 时：

- **反斜杠会被当作转义符吞掉** → `C:\mods\x\loader.js` 会变成 `C:modsxloader.js`
- 按空格分词，所以含空格的路径必须加引号

**正确写法：把路径转成正斜杠，并用双引号包住。**

```js
// 启动器内部就是这么拼的（已实测）
const requireArgs = paths.map((p) => `--require "${p.replace(/\\/g, "/")}"`).join(" ");
```

### 4.2 会被加载多次：务必做身份校验

`npm start` 的真实链路是：

```
npm(node) → node autostart.js → node .（真正的服务端 index.js）
```

`NODE_OPTIONS` 会被逐层继承，**你的 loader 会被加载 3 次**。所以必须：

1. preload 阶段只做"留痕"，**不要**直接跑业务逻辑；
2. 用 `setImmediate` 等到主模块加载完成；
3. 校验身份，只在**真正的服务端进程**里启动。

```js
function entryFile() {
  try { return require.main?.filename || ""; } catch { return ""; }
}
function isRealServerProcess(entry) {
  // server/index.js 会把该变量设为 "world"
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  return /(^|[\\/])index\.js$/i.test(entry);
}

setImmediate(() => {
  const entry = entryFile();
  if (!isRealServerProcess(entry)) return;   // npm / autostart 包装进程，直接退出
  start(entry);
});
```

### 4.3 内存与加载顺序：**不要直接 require 服务端大模块**

实测：`require("<server>/src/services/chat/chatHub")` 会拉起 **约 456 MB / 645 个模块**的依赖图。

好消息是这部分内存服务端**本来就要花**——`server/bootstrap.js` 的 `registerServices()` 会加载所有 `*/**/*Service.js`，其中 `src/services/chat/xmppChatMgrService.js` 就 `require` 了 `chatHub`。

**但如果你在 preload 里直接 require，会让这 456 MB 在"服务端初始化完成之前"就被提前加载**（表现为内存一下子涨上去），而且有些模块在顶层会读取配置/数据库，过早加载有风险。

**规范做法：等服务端自己加载完，再从 `require.cache` 取引用（缓存命中，零额外内存）。**

```js
function whenServerChatLoaded(serverRoot, callback) {
  const hub = require.resolve(path.join(serverRoot, "src/services/chat/chatHub.js"));
  const reg = require.resolve(path.join(serverRoot, "src/services/chat/sessionRegistry.js"));
  let tries = 0;
  const timer = setInterval(() => {
    // 服务端 bootstrap 已经 require 过它们 → 现在 require 是缓存命中
    if (!require.cache[hub] || !require.cache[reg]) {
      if (++tries >= 240) clearInterval(timer);   // 最多等 120 秒
      return;
    }
    clearInterval(timer);
    callback(require(reg), require(hub));
  }, 500);
  timer.unref?.();
}
```

> 通用原则：**任何服务端模块都这样"等缓存命中再取"，不要主动提前 require。**

---

## 5. 可用的服务端接口（实测可用）

### 5.1 在线会话 —— `src/services/chat/sessionRegistry`

| 接口 | 说明 |
| --- | --- |
| `getSessions()` | 返回当前存活会话数组（只含 live session） |
| `resolveSessionCharacterID(session)` | 取角色 ID，兼容 `characterID` / `charID` / `charid` |
| `findSessionByCharacterID(id)` | 按角色 ID 找会话 |

### 5.2 发送系统消息 —— `src/services/chat/chatHub`

```js
chatHub.sendSystemMessage(session, "消息内容");        // 发到该角色当前本地频道
chatHub.sendSystemMessage(session, "消息内容", "local"); // 指定频道
```

### 5.3 ⚠️ 会话属性坑（会导致"静默失败"）

`sendSystemMessage` 内部实现是：

```js
const charId = Number(session.characterID || 0);
if (!charId) return;            // ← 静默 return，不抛错！
```

**它只认 `characterID`，不认小写 `charid`。** 如果你的代码不检查就调用，可能出现"没报错但消息没发出去"，然后你把它记成"已发送"永久不再重试。

**规范做法：发送前补一次。**

```js
if (!Number(session.characterID || 0)) session.characterID = characterID;
```

### 5.4 ⚠️ 上线宽限期

角色刚登录时可能：`characterID` 还是 `0`，或者聊天客户端还没连上、还没加入频道。

**规范做法：**

- `characterID` 为 0 时**跳过**（不要发）；
- 角色上线后**等待 10 秒左右**再发第一条；
- 发送抛错时**不要**记入已发送，下一轮重试；
- 角色下线后从记录中移除，这样下次登录会重新收到消息。

---

## 6. 完整骨架（可直接改用）

```js
"use strict";
const path = require("path");

const TAG = "[my-mod]";
const POLL_MS = 3000;
const GRACE_MS = 10000;          // 上线后等 10 秒再发
const MESSAGE = "欢迎回来，飞行员！";

console.log(TAG + " preload 已执行 · pid=" + process.pid);

function entryFile() {
  try { return require.main?.filename || ""; } catch { return ""; }
}
function isRealServerProcess(entry) {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  return /(^|[\\/])index\.js$/i.test(entry);
}

setImmediate(() => {
  const entry = entryFile();
  if (!isRealServerProcess(entry)) {
    console.log(TAG + " 跳过包装进程（entry=" + (entry || "?") + "）");
    return;
  }
  start(entry);
});

function start(entry) {
  if (globalThis.__myModStarted) return;      // 防重复启动
  const serverRoot = path.resolve(__dirname, "..", "..", "server");

  whenServerChatLoaded(serverRoot, (sessionRegistry, chatHub) => {
    if (globalThis.__myModStarted) return;
    globalThis.__myModStarted = true;

    const seen = new Set();          // 已成功发送过的角色
    const firstSeenAt = new Map();   // 首次出现时间，用于宽限期

    const timer = setInterval(() => {
      let sessions = [];
      try { sessions = sessionRegistry.getSessions() || []; } catch { return; }

      const now = Date.now();
      const online = new Set();

      for (const session of sessions) {
        let characterID = 0;
        try { characterID = sessionRegistry.resolveSessionCharacterID(session); } catch {}
        if (!characterID) continue;              // 还没真正进游戏
        online.add(characterID);

        if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
        if (seen.has(characterID)) continue;
        if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

        // 补 session.characterID，避免 sendSystemMessage 静默失败
        try { if (!Number(session.characterID || 0)) session.characterID = characterID; } catch {}

        try {
          chatHub.sendSystemMessage(session, MESSAGE);
          seen.add(characterID);                 // 只有成功才记
          console.log(TAG + " 已向角色 " + characterID + " 发送消息");
        } catch (error) {
          console.log(TAG + " 角色 " + characterID + " 尚未就绪，稍后重试：" + error.message);
        }
      }

      for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
      for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
    }, POLL_MS);

    timer.unref?.();                             // 不要阻止服务端正常退出
  });
}

function whenServerChatLoaded(serverRoot, callback) {
  const hub = require.resolve(path.join(serverRoot, "src/services/chat/chatHub.js"));
  const reg = require.resolve(path.join(serverRoot, "src/services/chat/sessionRegistry.js"));
  let tries = 0;
  const timer = setInterval(() => {
    if (!require.cache[hub] || !require.cache[reg]) {
      if (++tries >= 240) { clearInterval(timer); console.log(TAG + " 等待服务端加载超时"); }
      return;
    }
    clearInterval(timer);
    try { callback(require(reg), require(hub)); } catch (e) { console.error(TAG + " " + e.message); }
  }, 500);
  timer.unref?.();
}
```

---

## 7. 冲突与加载顺序（作者必须知道）

启动器在模组页会自动做冲突鉴定，并在统计面板显示**冲突数**（只统计已启用模组之间）。

### 7.1 四类冲突

| 类型 | 触发条件 | 后果 |
| --- | --- | --- |
| **声明互斥** | 你的清单里写了 `conflicts: ["x"]`（或对方向你声明） | **阻止同时启用**，被拦截的模组不会注入 |
| **重复 id** | 两个模组目录用了同一个 `id` | 提示，且依赖解析会出现歧义 |
| **同模块引用** | 两个 loader 的源码里都出现了同一个服务端模块文件名（如都引用 `chatHub.js`） | **仅警告**，不拦截 |
| **依赖缺失** | 已启用但 `requires` 里的模组没装或没启用 | 不注入并说明原因 |

「同模块引用」是**静态扫描**你源码里的字符串字面量得出的启发式结果，可能误报。想降低误报：

- 尽量只引用你真正要改的那个模块；
- 如果两个模组确实会互相影响，请主动在清单里写 `conflicts` 或 `loadAfter`，让启动器给出准确提示。

### 7.2 加载顺序：不要靠文件名

不要指望"文件夹名字母序"来决定加载顺序 —— 玩家可以拖拽排序。

用清单里的 `loadAfter` / `loadBefore` 声明约束：

```json
"loadAfter": ["base-content"],
"loadBefore": ["final-overlay"]
```

优先级说明：

1. `loadAfter` / `loadBefore` 约束**最优先**（启动器做拓扑排序，检测到环会回退并记录）；
2. 约束无法区分先后时，才使用**玩家在模组页拖拽的顺序**（保存在 `_launcher/mods/mod-order.json`）；
3. 都没指定时按显示名排序。

也就是说：**想让顺序稳定且正确，就必须写 `loadAfter`/`loadBefore`。**

---

## 8. 分发与 ZIP 导入

### 8.1 ZIP 结构（两种都支持）

```text
方式一：根目录直接放清单            方式二：单层文件夹包住（推荐）
my-mod.zip                          my-mod.zip
├── evejs-launcher.mod.json          └── my-mod/
├── loader.js.disabled                   ├── evejs-launcher.mod.json
└── README.md                            ├── loader.js.disabled
                                          └── README.md
```

启动器会自动定位包根；如果 ZIP 里有**多个**模组包会拒绝导入（一次只导一个）。

### 8.2 导入规则

| 规则 | 说明 |
| --- | --- |
| 安装位置 | `<EveJS 根>/mods/<清单 id>`（id 里的非法字符会被替换成 `-`） |
| 初始状态 | **强制禁用**（`loader.js` 会被改回 `loader.js.disabled`） |
| 同名冲突 | `mods/` 下已有同名目录 → 拒绝导入并提示 |
| 清单缺失 | ZIP 里没有 `evejs-launcher.mod.json` → 拒绝 |

### 8.3 体积

模组页会**递归统计每个模组的占用空间**并在统计面板显示总量。请只打包运行必需的文件，不要把源码仓库、node_modules、截图等塞进 ZIP。

---

## 9. 开发与调试流程

1. 在 `<EveJS 根>/mods/` 下新建文件夹，放 `evejs-launcher.mod.json` + `loader.js.disabled`；
2. 启动器 →「模组 / 插件」→ 点「刷新列表」，确认模组出现且清单校验通过（有错会在卡片上用琥珀色标出）；
3. 点开关启用（文件自动改名为 `loader.js`）；
4. **重启游戏服务**（「主服务器」卡片 停止 → 启动）；
5. 看「主服务器」页签，应出现：

```
[主服务器] 已注入 1 个模组 loader
[主服务器]   · my-mod
[my-mod] preload 已执行 · pid=12345
[my-mod] 跳过包装进程（entry=…\autostart.js）
[my-mod] 已启用 · …
```

6. 登录角色验证游戏内效果。

### 排错清单

| 现象 | 原因 |
| --- | --- |
| 模组卡片显示"○ 暂不支持" | `kind` 不是 `loader`，或 `activation.strategy` 不是 `loader_rename`，或缺少 `loader.js(.disabled)` |
| 卡片有琥珀色错误 | 清单字段不合规（`schemaVersion` 必须是 3） |
| 启用了但服务端没加载 | **没重启游戏服务**（loader 只在进程启动时注入） |
| 控制台只有 `preload 已执行` 没有 `已启用` | 身份校验把它当成包装进程跳过了（检查 `entry` 值） |
| 有 `已启用` 但游戏里没效果 | 检查 5.3 / 5.4 的两个坑（会话属性、宽限期） |
| 内存一下子涨很多 | 见 4.3：不要提前 require 服务端大模块 |
| 想确认到底注入了哪些 | 「主服务器」页签的 `已注入 N 个模组 loader` 列表 |
| 统计面板「冲突数」不为 0 | 展开卡片看冲突类型；声明互斥会阻止注入，同模块引用只是警告 |
| 两个模组该一前一后却没按预期 | 补 `loadAfter`/`loadBefore`，不要依赖文件夹名或玩家拖拽顺序 |
| 导入 ZIP 提示"已存在同名模组目录" | `mods/` 下已有同 id 的模组，先删除或改名 |
| 导入 ZIP 提示"ZIP 里没有 evejs-launcher.mod.json" | ZIP 打包层级不对，或忘了放清单 |
| 导入后模组没生效 | 导入默认禁用，需要在模组页打开开关**并重启游戏服务** |
| 拖拽排序后顺序没变 | 重启游戏服务后才会按新顺序注入 |

### 日志位置

| 内容 | 位置 |
| --- | --- |
| 启动器服务日志 | `_launcher/logs/launcher.log` |
| 服务端日志 | `server/logs/server.log` |
| 聊天/XMPP 日志 | `server/logs/xmpp-stub.log` |
| 客户端输出 | `_launcher/logs/client/*.out.log` / `*.err.log` |

---

## 10. 发布与更新（规划中）

manifest 支持 `updates` 字段指向 GitHub Release：

```json
"updates": {
  "provider": "github",
  "repository": "owner/repo",
  "asset": "MyMod-{version}.zip",
  "channel": "stable",
  "tagPrefix": "v",
  "preserveFiles": []
}
```

当前启动器版本**尚未实现**该字段的下载逻辑，先把模组以文件夹/ZIP 形式分发即可。

---

## 11. 发布前检查表

- [ ] `id` 与上个版本一致（改 id 会被当成另一个模组）
- [ ] `version` 已递增
- [ ] `kind: "loader"` + `activation.strategy: "loader_rename"`
- [ ] 发布包里 `loader.js` **改回** `loader.js.disabled`（默认禁用）
- [ ] 清单不超 1 MiB，字段拼写正确
- [ ] 有 `README.md` 说明用法与兼容的 EveJS 版本
- [ ] 本机实测：启用 → 重启服务端 → 登录 → 效果正确 → 关闭 → 重启 → 效果消失
- [ ] 需要固定加载顺序时已写 `loadAfter` / `loadBefore`（不要依赖文件夹名）
- [ ] 会与其它模组互斥时已声明 `conflicts`（否则启动器只能给出启发式警告）
- [ ] 发布 ZIP 结构正确（根目录放清单，或单层文件夹包住）
- [ ] 包内只含运行必需文件（占用空间会在启动器统计里显示）
- [ ] 在启动器里用「导入 ZIP」实测一次：能导入、默认禁用、开关能启停