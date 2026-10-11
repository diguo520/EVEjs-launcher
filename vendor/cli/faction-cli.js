#!/usr/bin/env node
"use strict";

/**
 * 势力推演面板（evejs-faction-sim 模组）的**只读**侧车。
 *
 * 启动器要用模组自带的 Web 面板 API（127.0.0.1:26410）重新画一套界面，而面板的
 * 每一个请求都要 `Authorization: Bearer <panelToken>`。这枚令牌由模组自己生成并
 * 持久化在它自己的推演库里（`setting` 表的 `panelToken`），**没有**任何对外读取入口
 * （`/api/session` 本身也要令牌），所以只能从库里读。
 *
 * 为什么不重写进 Rust：与服务端共用同一套 SQLite 表结构，而启动器已经约定
 * 「数据库相关走随包 Node CLI + 服务端自带的 better-sqlite3」（见 src-tauri/src/db.rs
 * 与 sidecar 模块的迁移决策）。这里沿用同一条链路，**不新增原生依赖**。
 *
 * 只读约束：
 *   - 一律 `readonly: true` 打开，绝不建表、不写盘、不改动 WAL；
 *   - 模组进程可能正在写这个库，所以设 `busy_timeout` 并只做单条 SELECT。
 *
 * 用法：
 *   node faction-cli.js token <repoRoot>
 * 输出（stdout，单行 JSON）：
 *   成功 { ok: true, token: "<hex>", database: "<路径>" }
 *   失败 { ok: false, reason: "<中文原因>" }
 */

const fs = require("fs");
const path = require("path");

const [command, repoRootArg] = process.argv.slice(2);

function rootOf(value) {
  return path.resolve(value || ".");
}

/** 服务端自带的 better-sqlite3（与 database-cli.js 同一条查找与报错口径） */
function betterSqlite(root) {
  const modulePath = path.join(root, "server", "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(modulePath, "package.json"))) {
    throw new Error("未找到 server/node_modules/better-sqlite3");
  }
  return require(modulePath);
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

/**
 * 推演库的候选路径。模组的默认状态目录是 `<repoRoot>/_local/faction-sim`，
 * 但它也被 `EVEJS_FACTIONSIM_STATE_DIR` 改过，所以按「环境变量 → 约定目录 →
 * `_local/*` 扫描」三步找，命中第一个真正带 panelToken 的库就收工。
 */
function databaseCandidates(root) {
  const out = [];
  const push = (file) => {
    if (file && isFile(file) && !out.includes(file)) out.push(file);
  };
  const fromEnv = process.env.EVEJS_FACTIONSIM_STATE_DIR;
  if (fromEnv) push(path.join(path.resolve(fromEnv), "faction.sqlite"));
  push(path.join(root, "_local", "faction-sim", "faction.sqlite"));
  const local = path.join(root, "_local");
  let entries = [];
  try {
    entries = fs.readdirSync(local, { withFileTypes: true });
  } catch (_error) {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    push(path.join(local, entry.name, "faction.sqlite"));
  }
  // 兜底：`_local` 下一层里任何 .sqlite 都试一遍（状态目录被改名过的情况）
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(local, entry.name);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_error) {
      files = [];
    }
    for (const name of files) {
      if (name.endsWith(".sqlite")) push(path.join(dir, name));
    }
  }
  return out;
}

/** 从一个库里读 panelToken；读不到（无表 / 无键）回 null，读不了回抛错由调用方决定 */
function readTokenFrom(database, Database) {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 2000");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setting'")
      .get();
    if (!table) return null;
    const row = db.prepare("SELECT value_json FROM setting WHERE key = 'panelToken'").get();
    if (!row || typeof row.value_json !== "string") return null;
    const parsed = JSON.parse(row.value_json);
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } finally {
    db.close();
  }
}

function findToken(root) {
  const candidates = databaseCandidates(root);
  if (candidates.length === 0) {
    throw new Error("没有找到推演库（_local/faction-sim/faction.sqlite）：势力推演模组可能还没装或还没跑过");
  }
  const Database = betterSqlite(root);
  let lastError = null;
  for (const database of candidates) {
    try {
      const token = readTokenFrom(database, Database);
      if (token) return { token, database };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error("推演库里还没有 panelToken：模组还没启动过面板");
}

function main() {
  try {
    if (command !== "token") {
      throw new Error("用法：node faction-cli.js token <repoRoot>");
    }
    const root = rootOf(repoRootArg);
    const { token, database } = findToken(root);
    process.stdout.write(JSON.stringify({ ok: true, token, database }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: String((error && error.message) || error) }) + "\n"
    );
    process.exitCode = 1;
  }
}

main();
