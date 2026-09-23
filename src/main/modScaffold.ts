import * as fs from "fs";
import * as path from "path";
import { launcherTempDir } from "./runtimePaths";
import { modsRoot, readModDir, signModFolder } from "./modManager";
import { getAuthor } from "./authorStore";

/**
 * 创建模组：把模板落成真实文件树。
 *
 * 设计约束（见 docs/mod-signing-and-marketplace-plan.md §4）：
 *  - **唯一基准是已跑通的 `mods/welcome-mod`**（= MOD_AUTHORING.md §6 骨架），
 *    不再沿用原型的 Lua 风格模板；
 *  - 骨架里那几处关键技巧一个都不能少，否则会"静默不生效"或"内存暴涨"：
 *      ① setImmediate + require.main.filename 身份校验（NODE_OPTIONS 会被继承多次）
 *      ② globalThis 守卫（防重复初始化）
 *      ③ 不直接 require 服务端大模块，而是轮询 require.cache 等服务端自己加载（避免 456MB 依赖图提前拉起）
 *      ④ timer.unref()（不阻止进程退出）
 *      ⑤ 会话属性坑补丁（session.characterID / charid）+ 上线宽限期
 *  - 先写到 _launcher/temp/scaffold-<id>/ 校验，再整体移入 mods/<id>（不半个模组留在盘上）
 */

export interface ScaffoldTemplate {
  id: string;
  name: string;
  desc: string;
  /** 生成的文件（相对模组根） */
  files: string[];
  /** 默认分类 */
  category: string;
  /** 默认是否需要重启服务端 */
  requiresRestart: boolean;
  /** 默认标签 */
  tags: string[];
  /** 默认功能要点（填进 README） */
  highlights: string[];
}

export const SCAFFOLD_TEMPLATES: ScaffoldTemplate[] = [
  {
    id: "broadcast",
    name: "Welcome Broadcast (Example)",
    desc: "加载模组后会在游戏本地聊天框看到一条「欢迎回来，飞行员」的信息。",
    files: ["evejs-launcher.mod.json", "loader.js", "README.md", "CHANGELOG.md"],
    category: "玩法",
    requiresRestart: true,
    tags: ["聊天", "新手"],
    highlights: [
      "玩家上线后在其本地聊天频道发送欢迎消息",
      "只改运行内存，不修改 server/ 下任何文件",
      "骨架已内置进程身份校验与 require.cache 等待，不会提前拉起大依赖"
    ]
  },
  {
    id: "blank",
    name: "Blank Skeleton",
    desc: "同样的加载骨架，业务逻辑留空，适合从零写起",
    files: ["evejs-launcher.mod.json", "loader.js", "README.md", "CHANGELOG.md"],
    category: "玩法",
    requiresRestart: true,
    tags: [],
    highlights: [
      "保留全部 loader 加载要点（身份校验 / require.cache 等待 / unref）",
      "业务钩子集中在 loader.js 的 start() 里，改这一处即可"
    ]
  }
];

export function findTemplate(id: string): ScaffoldTemplate | null {
  return SCAFFOLD_TEMPLATES.find((t) => t.id === id) || null;
}

export interface CreateModDraft {
  id: string;
  displayName: string;
  version: string;
  description: string;
  templateId: string;
  category?: string;
  tags?: string[];
  readme?: string;
  highlights?: string[];
  conflicts?: string[];
  requiresRestart?: boolean;
  /** 建好后立即启用（默认 false：新模组先保持禁用） */
  enabled?: boolean;
  /** 建好后立即用本机作者密钥签名 */
  sign?: boolean;
}

export interface CreateModResult {
  ok: boolean;
  folder?: string;
  dir?: string;
  files?: string[];
  signed?: boolean;
  keyId?: string;
  reason?: string;
}

/** id 安全化：只留 [a-z0-9-_.]，与 modManager 的文件夹规则保持一致 */
export function normalizeModId(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 64);
}

/** 从模组名推 id（中文名推不出拉丁字符时返回空串，由调用方兜底） */
export function slugifyModId(name: string): string {
  return normalizeModId(String(name || "").replace(/[^A-Za-z0-9\-_.]+/g, "-"));
}

function readmeFrom(draft: CreateModDraft, template: ScaffoldTemplate): string {
  const lines: string[] = [];
  lines.push("# " + draft.displayName);
  lines.push("");
  lines.push(draft.description || "");
  lines.push("");
  const highlights = (draft.highlights && draft.highlights.length ? draft.highlights : template.highlights) || [];
  if (highlights.length) {
    lines.push("## 功能要点");
    lines.push("");
    for (const h of highlights) lines.push("- " + h);
    lines.push("");
  }
  if (draft.readme && draft.readme.trim()) {
    lines.push("## 详细介绍");
    lines.push("");
    lines.push(draft.readme.trim());
    lines.push("");
  }
  lines.push("## 安装与启用");
  lines.push("");
  lines.push("1. 启动器 → 模组 / 插件 → 打开 mods 目录，确认本目录已在其中");
  lines.push("2. 在模组列表里启用它（会把 `loader.js.disabled` 改名为 `loader.js`）");
  lines.push("3. 重启主服务器（本模组 `restart: game_server`）");
  lines.push("");
  lines.push("> 本模组不修改 `server/` 下任何文件，通过 `NODE_OPTIONS=--require` 注入运行内存。");
  lines.push("");
  return lines.join("\n");
}

function changelogFrom(draft: CreateModDraft): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "# 更新日志",
    "",
    "## " + (draft.version || "1.0.0") + " - " + today,
    "",
    "- 首个版本",
    ""
  ].join("\n");
}

/** loader.js 骨架：进程身份校验 + require.cache 等待 + 业务钩子 */
function loaderFrom(draft: CreateModDraft, template: ScaffoldTemplate): string {
  const tag = "[" + (draft.id || "mod") + "]";
  const biz =
    template.id === "blank"
      ? [
          "    /* TODO: 业务逻辑写在这里。",
          "       下面是可用的实测接口：",
          "         sessionRegistry.getSessions()                     -> 在线会话数组",
          "         sessionRegistry.resolveSessionCharacterID(s)      -> 角色 ID（未进入游戏时为 0）",
          "         chatHub.sendSystemMessage(session, \"消息\")        -> 在该角色本地频道发系统消息",
          "       改完记得重启主服务器，然后在游戏里验证。 */",
          "    console.log(TAG + \" 已启用（空白骨架）\");"
        ].join("\n")
      : [
          "    const seen = new Set();",
          "    const firstSeenAt = new Map();",
          "    globalThis.__EVEJS_SCAFFOLD_HOOK__ = { seen, firstSeenAt };",
          "",
          "    console.log(TAG + \" 已启用 · 每 \" + POLL_MS / 1000 + \" 秒扫描 · 上线 \" + GRACE_MS / 1000 + \" 秒后发送\");",
          "",
          "    const timer = setInterval(() => {",
          "      let sessions;",
          "      try {",
          "        sessions = sessionRegistry.getSessions() || [];",
          "      } catch {",
          "        return;",
          "      }",
          "",
          "      const now = Date.now();",
          "      const online = new Set();",
          "",
          "      for (const session of sessions) {",
          "        let characterID = 0;",
          "        try {",
          "          characterID = sessionRegistry.resolveSessionCharacterID(session);",
          "        } catch {",
          "          characterID = 0;",
          "        }",
          "        // 角色还没真正进入游戏（characterID 还是 0）时跳过，等下一轮",
          "        if (!characterID) continue;",
          "        online.add(characterID);",
          "",
          "        if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);",
          "        if (seen.has(characterID)) continue;",
          "        if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;",
          "",
          "        // sendSystemMessage 内部只认 session.characterID，",
          "        // 有些会话对象只带小写 charid，这里补一次，避免\"静默不发送\"。",
          "        try {",
          "          if (!Number(session.characterID || 0)) session.characterID = characterID;",
          "        } catch {",
          "          /* 只读对象就跳过这一步 */",
          "        }",
          "",
          "        try {",
          "          chatHub.sendSystemMessage(session, MESSAGE);",
          "          seen.add(characterID);",
          "          console.log(TAG + \" 已向角色 \" + characterID + \" 发送消息\");",
          "        } catch (error) {",
          "          console.log(TAG + \" 角色 \" + characterID + \" 尚未就绪，稍后重试：\" + error.message);",
          "        }",
          "      }",
          "",
          "      // 下线的角色清理掉，下次登录会重新触发",
          "      for (const characterID of Array.from(seen)) {",
          "        if (!online.has(characterID)) seen.delete(characterID);",
          "      }",
          "      for (const characterID of Array.from(firstSeenAt.keys())) {",
          "        if (!online.has(characterID)) firstSeenAt.delete(characterID);",
          "      }",
          "    }, POLL_MS);",
          "",
          "    if (timer && typeof timer.unref === \"function\") timer.unref();"
        ].join("\n");

  return [
    "\"use strict\";",
    "/**",
    " * " + draft.displayName + " —— EveJS 模组（kind: loader）",
    " * 由 EvEJS 启动器「创建模组」生成，骨架基准：mods/welcome-mod（= MOD_AUTHORING.md §6）。",
    " *",
    " * 原理：服务端就是同一个 Node 进程。Node 有模块缓存，loader 里 require 同一个服务端模块",
    " *   拿到的是**同一个实例**，所以可以直接调用服务端内部 API，而完全不需要修改服务端任何文件。",
    " *",
    " * 三处必须保留的写法（删掉任何一处都会出问题）：",
    " *   1) setImmediate + require.main.filename 身份校验 —— NODE_OPTIONS 会被",
    " *      npm(node) → node autostart.js → node .（真正的服务端）逐层继承，每层都会加载本文件，",
    " *      只在真正的服务端进程里启动逻辑；",
    " *   2) **不要直接 require 服务端大模块**（chatHub 会拉起约 456MB / 645 个模块），",
    " *      而是等 require.cache 里出现它之后再取引用，此时是缓存命中、零额外内存；",
    " *   3) timer.unref() —— 不让定时器阻止进程退出。",
    " */",
    "",
    "const path = require(\"path\");",
    "",
    "const TAG = \"" + tag + "\";",
    "/* ==== 可调参数 ==== */",
    "const POLL_MS = 3000;",
    "const WAIT_SERVER_MS = 500;",
    "const WAIT_SERVER_MAX_TRIES = 240;",
    "const GRACE_MS = 10000;",
    "const MESSAGE = \"欢迎回来，飞行员！本条消息由模组 " + draft.displayName + " 发送。\";",
    "",
    "console.log(TAG + \" preload 已执行 · pid=\" + process.pid);",
    "",
    "/** 兼容写法：部分环境下 require.main 在 preload 阶段尚未就绪 */",
    "function entryFile() {",
    "  try {",
    "    return require.main && require.main.filename ? require.main.filename : \"\";",
    "  } catch {",
    "    return \"\";",
    "  }",
    "}",
    "",
    "/** 只在真正的服务端进程里继续（排除 npm / autostart.js 包装进程） */",
    "function isRealServerProcess(entry) {",
    "  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === \"world\") return true;",
    "  return /(^|[\\\\/])index\\.js$/i.test(entry);",
    "}",
    "",
    "setImmediate(() => {",
    "  const entry = entryFile();",
    "  if (!isRealServerProcess(entry)) {",
    "    console.log(TAG + \" 跳过包装进程（entry=\" + (entry || \"?\") + \"）\");",
    "    return;",
    "  }",
    "  start(entry);",
    "});",
    "",
    "function start(entry) {",
    "  if (globalThis.__EVEJS_SCAFFOLD_STARTED__) {",
    "    console.log(TAG + \" 已启动过，忽略重复加载\");",
    "    return;",
    "  }",
    "  globalThis.__EVEJS_SCAFFOLD_STARTED__ = true;",
    "",
    "  const serverRoot = path.resolve(__dirname, \"..\", \"..\", \"server\");",
    "",
    "  whenServerChatLoaded(serverRoot, (sessionRegistry, chatHub) => {",
    biz,
    "  });",
    "}",
    "",
    "/** 等服务端自己把 chatHub 加载进 require.cache，再取引用（零额外内存、无第二份实例） */",
    "function whenServerChatLoaded(serverRoot, callback) {",
    "  const hubPath = path.join(serverRoot, \"src\", \"services\", \"chat\", \"chatHub.js\");",
    "  const registryPath = path.join(serverRoot, \"src\", \"services\", \"chat\", \"sessionRegistry.js\");",
    "",
    "  let hubResolved = null;",
    "  let registryResolved = null;",
    "  try {",
    "    hubResolved = require.resolve(hubPath);",
    "    registryResolved = require.resolve(registryPath);",
    "  } catch (error) {",
    "    console.error(TAG + \" 找不到服务端聊天模块，模组未生效：\" + error.message);",
    "    return;",
    "  }",
    "",
    "  let tries = 0;",
    "  const timer = setInterval(() => {",
    "    tries += 1;",
    "    if (!require.cache[hubResolved] || !require.cache[registryResolved]) {",
    "      if (tries >= WAIT_SERVER_MAX_TRIES) {",
    "        clearInterval(timer);",
    "        console.log(TAG + \" 等待服务端加载聊天模块超时（\" + WAIT_SERVER_MAX_TRIES * WAIT_SERVER_MS / 1000 + \"s），模组未生效\");",
    "      }",
    "      return;",
    "    }",
    "",
    "    clearInterval(timer);",
    "    try {",
    "      callback(require(registryResolved), require(hubResolved));",
    "    } catch (error) {",
    "      console.error(TAG + \" 加载服务端聊天模块失败：\" + error.message);",
    "    }",
    "  }, WAIT_SERVER_MS);",
    "",
    "  if (timer && typeof timer.unref === \"function\") timer.unref();",
    "}",
    ""
  ].join("\n");
}

function manifestFrom(draft: CreateModDraft, template: ScaffoldTemplate, evejsVersion: string): Record<string, unknown> {
  let author: Record<string, string> = {};
  try {
    const a = getAuthor().author;
    // publicKey 必须一起发布：市场索引里带上它，下载方才能验证作者签名（否则只能报「签名密钥不在信任列表」）
    author = { id: a.id, name: a.name, keyId: a.keyId, publicKey: a.publicKey };
  } catch {
    /* 读不到作者身份就先不写 author 块 */
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 3,
    id: draft.id,
    displayName: draft.displayName,
    version: draft.version || "1.0.0",
    description: draft.description || "",
    kind: "loader",
    supportedBackends: ["native", "docker"],
    activation: { strategy: "loader_rename" },
    restart: draft.requiresRestart === false ? "none" : "game_server",
    category: draft.category || template.category,
    tags: draft.tags && draft.tags.length ? draft.tags : template.tags,
    conflicts: draft.conflicts || []
  };
  if (Object.keys(author).length) manifest.author = author;
  if (/^\d+\.\d+/.test(evejsVersion)) manifest.compatibility = { evejsVersions: [evejsVersion] };
  return manifest;
}

/**
 * 创建模组：校验 → 写临时目录 → 整体移入 mods/<id> → 可选签名 / 启用。
 */
export function createMod(repoRoot: string, draft: CreateModDraft, evejsVersion: string): CreateModResult {
  const template = findTemplate(String(draft.templateId || "broadcast")) || SCAFFOLD_TEMPLATES[0];
  const id = normalizeModId(draft.id || "");
  if (!id) return { ok: false, reason: "标识（id）必须是字母 / 数字 / - _ . 组成的非空文本" };
  if (!String(draft.displayName || "").trim()) return { ok: false, reason: "模组名不能为空" };
  if (!/^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.\-]+)?$/.test(String(draft.version || "1.0.0"))) {
    return { ok: false, reason: "版本号格式必须像 1.0.0" };
  }

  const root = modsRoot(repoRoot);
  const target = path.join(root, id);
  if (fs.existsSync(target)) return { ok: false, reason: "mods/ 下已经存在同名目录：" + id };

  const stage = path.join(launcherTempDir(), "scaffold-" + id + "-" + Date.now());
  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(
      path.join(stage, "evejs-launcher.mod.json"),
      JSON.stringify(manifestFrom({ ...draft, id }, template, evejsVersion), null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(stage, "loader.js.disabled"), loaderFrom(draft, template), "utf8");
    fs.writeFileSync(path.join(stage, "README.md"), readmeFrom(draft, template), "utf8");
    fs.writeFileSync(path.join(stage, "CHANGELOG.md"), changelogFrom(draft), "utf8");
  } catch (e) {
    return { ok: false, reason: "写入临时目录失败: " + (e instanceof Error ? e.message : String(e)) };
  }

  // 先用真正的扫描器校验一遍，不合格就不落地
  const probe = readModDir(id, stage);
  if (!probe.valid) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响返回 */
    }
    return { ok: false, reason: "生成的清单没通过校验: " + probe.error };
  }

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.renameSync(stage, target);
  } catch (e) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, reason: "移动到 mods/ 失败: " + (e instanceof Error ? e.message : String(e)) };
  }

  const result: CreateModResult = { ok: true, folder: id, dir: target, files: template.files, signed: false };

  if (draft.sign) {
    const signed = signModFolder(repoRoot, id);
    if (signed.ok) {
      result.signed = true;
      result.keyId = signed.keyId;
    } else {
      result.reason = "模组已创建，但签名失败：" + (signed.reason || "");
    }
  }

  // 默认禁用（loader.js.disabled）；只有明确勾了「立即启用」才改名
  if (draft.enabled) {
    try {
      fs.renameSync(path.join(target, "loader.js.disabled"), path.join(target, "loader.js"));
    } catch {
      /* 改名失败就保持禁用 */
    }
  }

  return result;
}