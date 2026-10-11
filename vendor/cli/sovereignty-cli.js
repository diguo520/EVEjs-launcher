#!/usr/bin/env node
"use strict";

/**
 * 玩家主权（游戏侧）的**只读**侧车。
 *
 * 为什么需要它：模组的 `/api/realm` 只描述它自己模拟出来的 NPC 政体版图，不知道玩家军团 /
 * 联盟的主权；而游戏库 `_local/gameStore/gamestore.sqlite` 里有权威的 `sovereignty` 表
 * （`systems␟<星系>` 一行一个声明，带 allianceID / corporationID / 主权结构）。
 * 星图要「统计到玩家领地」就必须读它。
 *
 * 只读约束与 `database-cli.js` 一致：`readonly: true` + `busy_timeout`，只 SELECT，不写盘。
 * 表是 KV 结构（`key` / `json` 两列，key 用 0x1F 分隔命名空间），所以这里把 JSON 解出来，
 * 拼成一份渲染层直接能用的形状，省得界面去解析游戏内部结构。
 *
 * 用法：node sovereignty-cli.js claims <repoRoot>
 * 输出（stdout，单行 JSON）：
 *   { ok, at, systems: [{ systemID, allianceID, corporationID, claimStructureID, claimTime }],
 *     alliances: { "<id>": { name, shortName } }, corporations: { "<id>": name },
 *     structureCounts: { "<systemID>": n } }
 */

const fs = require("fs");
const path = require("path");

const [command, repoRootArg] = process.argv.slice(2);
const SEP = "\u001f";

function rootOf(value) {
  return path.resolve(value || ".");
}

function betterSqlite(root) {
  const modulePath = path.join(root, "server", "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(modulePath, "package.json"))) {
    throw new Error("未找到 server/node_modules/better-sqlite3");
  }
  return require(modulePath);
}

/** KV 表里按命名空间取行：key = "<ns>" 或 "<ns>␟<id>"（后者才是数据行） */
function rowsIn(db, table, namespace) {
  const like = `${namespace}${SEP}%`;
  return db
    .prepare(`SELECT key, json FROM "${table}" WHERE key = ? OR key LIKE ?`)
    .all(namespace, like)
    .filter((row) => row.key !== namespace);
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch (_error) {
    return null;
  }
}

function collect(root) {
  const database = path.join(root, "_local", "gameStore", "gamestore.sqlite");
  if (!fs.existsSync(database)) {
    throw new Error(`游戏库不存在：${database}`);
  }
  const Database = betterSqlite(root);
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 3000");

    const systems = rowsIn(db, "sovereignty", "systems")
      .map((row) => parseJson(row.json))
      .filter(Boolean)
      .map((entry) => ({
        systemID: Number(entry.solarSystemID) || 0,
        allianceID: Number(entry.allianceID) || 0,
        corporationID: Number(entry.corporationID) || 0,
        claimStructureID: Number(entry.claimStructureID) || 0,
        claimTime: String(entry.claimTime || ""),
      }))
      .filter((entry) => entry.systemID > 0);

    // 主权枢纽（hubs）与建筑只用来回答「这个星系里真有东西吗」，星系数以 systems 那行为准
    const hubs = rowsIn(db, "sovereignty", "hubs")
      .map((row) => parseJson(row.json))
      .filter(Boolean);
    const structures = (() => {
      const row = db.prepare("SELECT json FROM structures WHERE key = 'structures'").get();
      const value = row ? parseJson(row.json) : null;
      return Array.isArray(value) ? value : [];
    })();
    const structureCounts = {};
    for (const item of structures.concat(hubs)) {
      const systemID = Number(item && item.solarSystemID) || 0;
      if (systemID <= 0) continue;
      structureCounts[systemID] = (structureCounts[systemID] || 0) + 1;
    }

    const alliances = {};
    for (const row of rowsIn(db, "alliances", "records")) {
      const entry = parseJson(row.json);
      const id = Number(entry && entry.allianceID) || 0;
      if (id <= 0) continue;
      alliances[String(id)] = {
        name: String(entry.allianceName || ""),
        shortName: String(entry.shortName || ""),
      };
    }

    const corporations = {};
    const corpRow = db.prepare("SELECT json FROM corporations WHERE key = 'records' LIMIT 1").get();
    const corpRecords = corpRow ? parseJson(corpRow.json) : null;
    if (corpRecords && typeof corpRecords === "object") {
      for (const entry of Object.values(corpRecords)) {
        const id = Number(entry && entry.corporationID) || 0;
        if (id > 0) corporations[String(id)] = String(entry.corporationName || "");
      }
    }

    return { ok: true, at: Date.now(), systems, alliances, corporations, structureCounts };
  } finally {
    db.close();
  }
}

function main() {
  try {
    if (command !== "claims") {
      throw new Error("用法：node sovereignty-cli.js claims <repoRoot>");
    }
    process.stdout.write(JSON.stringify(collect(rootOf(repoRootArg))) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: String((error && error.message) || error) }) + "\n"
    );
    process.exitCode = 1;
  }
}

main();
