"use strict";
/**
 * EveJS 模组注入总线（方案 D 的 host）。
 *
 * 由启动器作为 NODE_OPTIONS 里**第一条** `--require` 注入，独占唯一的
 * `Module.prototype._compile` 钩子，模组不再各自挂钩子。
 *
 * 为什么要有它：
 *   - 每个模组各自 hook `_compile` 时，谁先看到原始文件完全取决于加载顺序，
 *     其中一个模组按「整份文件 sha256」校验就会把后面所有人都挡掉（2026-10-01 实测：
 *     AutoMining 与 AutoLockFire 抢 server/src/network/tcp/handshake.js）；
 *   - 70 个模组就是 70 层包装，每次编译都要 70 次 path.resolve，顺序也不可复现。
 *
 * 现在的口径：
 *   - 启动器只注入本文件一条 `--require`，模组清单走 `EVEJS_MODS_PLAN`（JSON 文件），
 *     于是模组目录名里的中文/空格不再进 NODE_OPTIONS（那里会被转义/分词吃掉）；
 *   - 模组用 `globalThis.__evejsMods.register({ id, target, marker, slot, apply })`
 *     声明「改哪个文件、加什么、用什么标记」；
 *   - 同一个目标文件的阶段按 (slot, 注册先后) 排序后串链，每个阶段拿到的是
 *     **前一层已经改过**的内容；
 *   - 阶段抛错只跳过它自己，保留上一层结果；带 marker 的阶段检测到标记已存在就跳过；
 *   - 旧式模组（自己 hook `_compile`）不受影响：它们在本文件之后挂钩子，处于外层，
 *     总线阶段永远看到「所有旧式模组的产出」。
 *
 * 报告：真服务端进程（entry 是 index.js）会把「每个 loader 花了多久 / 每个目标文件
 * 应用了哪几层、成功还是失败」写进 `EVEJS_MODS_REPORT` 指向的 JSON。
 */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const API = 1;
const HOST_VERSION = "1.0.0";
const TAG = "[EveJS-MOD]";

const startedAt = Date.now();
const planFile = String(process.env.EVEJS_MODS_PLAN || "");
const reportFile = String(process.env.EVEJS_MODS_REPORT || "");
const rootHint = String(process.env.EVEJS_MODS_ROOT || "");

/** 模组清单里的 target 是相对 EveJS 根目录写的 */
const repoRoot = (function () {
  if (rootHint) return path.resolve(rootHint);
  try {
    return path.resolve(__dirname, "..", "..");
  } catch (error) {
    return process.cwd();
  }
})();

const registrations = [];
const targets = new Map();
const outcomes = [];
const loaders = [];
const memo = new Map();
let loadersDoneMs = 0;

function normalize(file) {
  const resolved = path.resolve(String(file)).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveTarget(target) {
  const text = String(target || "").trim();
  if (!text) return "";
  if (path.isAbsolute(text)) return normalize(text);
  return normalize(path.join(repoRoot, text));
}

/**
 * 进程入口文件。
 *
 * 不能只看 `require.main`：本文件是 `--require` 预加载进来的，Node 在创建预加载模块的
 * require 时就快照了 `process.mainModule`，那时主模块还没加载 —— 于是**永远**是空字符串
 * （2026-10-01 实测：8 个进程 entry 全空，总报告因此没人写）。
 * 回退到 `process.argv[1]`：`npm start` 里是 `node ... .`，argv[1] 是 `server` 目录，
 * 按 package.json 的 main 补成 `server/index.js`。
 */
function entryFile() {
  try {
    if (require.main && require.main.filename) return String(require.main.filename);
  } catch (error) {
    /* 预加载阶段没有主模块，往下走 argv */
  }
  const argv1 = process.argv && process.argv[1] ? String(process.argv[1]) : "";
  if (!argv1) return "";
  try {
    if (fs.statSync(argv1).isDirectory()) {
      const pkg = JSON.parse(fs.readFileSync(path.join(argv1, "package.json"), "utf8"));
      return path.join(argv1, String(pkg.main || "index.js"));
    }
  } catch (error) {
    /* 不是目录 / 读不到 package.json：当普通文件路径用 */
  }
  return argv1;
}

/** 真服务端进程：`npm start` 的入口就是 server/index.js（worker / fork 出来的进程 entry 不是它） */
function isIndexEntry() {
  if (!require("node:worker_threads").isMainThread) return false;
  return /(^|[\\/])index\.js$/i.test(entryFile());
}

function idOf(file) {
  try {
    return path.basename(path.dirname(String(file)));
  } catch (error) {
    return String(file);
  }
}

/* ------------------------------ 注册 ------------------------------ */

function register(spec) {
  const item = spec || {};
  const id = String(item.id || "").trim();
  const target = String(item.target || "").trim();
  if (!id) return { ok: false, reason: "register 缺少 id" };
  if (!target) return { ok: false, reason: "register 缺少 target" };
  if (typeof item.apply !== "function") return { ok: false, reason: "register 缺少 apply(source)" };

  const key = resolveTarget(target);
  if (!key) return { ok: false, reason: "target 解析失败：" + target };

  const stage = {
    id: id,
    target: target,
    marker: String(item.marker || "").trim(),
    slot: Number.isFinite(item.slot) ? item.slot : 0,
    seq: registrations.length,
    apply: item.apply,
  };
  registrations.push(stage);
  const list = targets.get(key) || [];
  list.push(stage);
  list.sort(function (left, right) {
    if (left.slot !== right.slot) return left.slot - right.slot;
    return left.seq - right.seq;
  });
  targets.set(key, list);
  console.log(TAG + " 注册 " + id + " -> " + target + "（该目标共 " + list.length + " 层）");
  return { ok: true };
}

/* ------------------------------ 注入 ------------------------------ */

function memoKey(filename) {
  const raw = String(filename);
  let value = memo.get(raw);
  if (value === undefined) {
    value = normalize(raw);
    if (memo.size < 20000) memo.set(raw, value);
  }
  return value;
}

const originalCompile = Module.prototype._compile;
function compileWithBus(content, filename) {
  const stages = targets.get(memoKey(filename));
  if (!stages || stages.length === 0) return originalCompile.call(this, content, filename);

  const before = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  let current = before;
  for (const stage of stages) {
    if (stage.marker && current.indexOf(stage.marker) !== -1) {
      outcomes.push({ target: stage.target, id: stage.id, outcome: "already", ms: 0 });
      continue;
    }
    const at = Date.now();
    try {
      const next = stage.apply(current, { id: stage.id, target: stage.target, file: String(filename) });
      const ms = Date.now() - at;
      if (typeof next === "string" && next !== current) {
        current = next;
        outcomes.push({ target: stage.target, id: stage.id, outcome: "applied", ms: ms });
      } else {
        outcomes.push({ target: stage.target, id: stage.id, outcome: "no-change", ms: ms });
      }
    } catch (error) {
      const reason = String((error && error.message) || error);
      outcomes.push({ target: stage.target, id: stage.id, outcome: "failed", reason: reason, ms: Date.now() - at });
      console.error(TAG + " " + stage.id + " 补丁失败，保留上一层结果：" + reason);
    }
  }
  if (current !== before) {
    console.log(TAG + " " + String(filename) + " 注入 " + stages.length + " 层（" + before.length + " -> " + current.length + " 字节）");
    writeReport();
  }
  return originalCompile.call(this, current, filename);
}
Module.prototype._compile = compileWithBus;

/* ------------------------------ 计划 ------------------------------ */

function readPlan() {
  const empty = { loaders: [], reason: "" };
  if (!planFile) {
    empty.reason = "没有 EVEJS_MODS_PLAN";
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(planFile, "utf8"));
    const list = (Array.isArray(parsed.loaders) ? parsed.loaders : []).filter(function (item) {
      return typeof item === "string" && item;
    });
    return { loaders: list, reason: "" };
  } catch (error) {
    empty.reason = String((error && error.message) || error);
    return empty;
  }
}

function runPlan() {
  const plan = readPlan();
  if (!plan.loaders.length) {
    console.error(TAG + " 模组清单为空或读不到：" + plan.reason);
    return;
  }
  let failed = 0;
  for (const file of plan.loaders) {
    const at = Date.now();
    let ok = true;
    let reason = "";
    try {
      require(file);
    } catch (error) {
      ok = false;
      reason = String((error && error.message) || error);
      failed += 1;
    }
    const ms = Date.now() - at;
    loaders.push({ id: idOf(file), path: file, ms: ms, ok: ok, reason: reason });
    console.log(TAG + " loader " + (ok ? "就绪" : "失败") + " " + idOf(file) + " " + ms + "ms" + (ok ? "" : " :: " + reason));
  }
  loadersDoneMs = Date.now() - startedAt;
  console.log(TAG + " loaders-done total=" + plan.loaders.length + " failed=" + failed + " ms=" + loadersDoneMs);
  writeReport();
}

/* ------------------------------ 报告 ------------------------------ */

function targetSummary() {
  const list = [];
  for (const [key, stages] of targets) {
    list.push({
      target: key,
      stages: stages.map(function (stage) {
        return { id: stage.id, slot: stage.slot, marker: stage.marker };
      }),
    });
  }
  return list;
}

function writeReport() {
  if (!reportFile) return;
  const payload = {
    api: API,
    hostVersion: HOST_VERSION,
    pid: process.pid,
    entry: entryFile(),
    role: String(process.env.EVEJS_GAMESTORE_OWNER_ROLE || ""),
    thread: require("node:worker_threads").isMainThread ? "main" : "worker",
    repoRoot: repoRoot,
    planFile: planFile,
    startedAt: startedAt,
    writtenAt: Date.now(),
    loadersDoneMs: loadersDoneMs,
    loaders: loaders,
    targets: targetSummary(),
    outcomes: outcomes,
  };
  const text = JSON.stringify(payload, null, 2) + "\n";
  const write = function (target) {
    try {
      const temporary = target + "." + process.pid + ".tmp";
      fs.writeFileSync(temporary, text, "utf8");
      fs.renameSync(temporary, target);
    } catch (error) {
      /* 报告写不了不能影响服务端 */
    }
  };
  // 每个进程写自己那份（排查用）；总报告只让真服务端写 ——
  // 服务端会 fork / 起 worker，谁最后写谁赢会让报告串台（2026-10-01 实测）。
  write(reportFile + "." + process.pid + ".json");
  if (isIndexEntry()) write(reportFile);
}

// preload 阶段 `require.main` 还没就绪（实测：每个进程的 entry 都是空），
// 延到 setImmediate 再判一次并补写总报告；判定口径见 entryFile()。
setImmediate(function () {
  writeReport();
});

globalThis.__evejsMods = {
  api: API,
  version: HOST_VERSION,
  repoRoot: repoRoot,
  register: register,
  loaders: function () {
    return loaders.slice();
  },
  registered: function () {
    return registrations.map(function (stage) {
      return { id: stage.id, target: stage.target, marker: stage.marker, slot: stage.slot };
    });
  },
  outcomes: function () {
    return outcomes.slice();
  },
  report: writeReport,
};

runPlan();