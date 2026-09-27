#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const [,, cmd, repoRoot, arg1, arg2] = process.argv;
const APPLY = process.argv.includes("--apply");

function rootOf(value) {
  return path.resolve(value || ".");
}

function dbOf(root) {
  return path.join(root, "_local", "gameStore", "gamestore.sqlite");
}

function betterSqlite(root) {
  const modulePath = path.join(root, "server", "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(modulePath, "package.json"))) {
    throw new Error("未找到 server/node_modules/better-sqlite3");
  }
  return require(modulePath);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
}

function assertTable(db, table) {
  const name = String(table || "");
  if (!name || !tableNames(db).includes(name)) throw new Error(`数据表不存在: ${name}`);
  return name;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function primaryKeyColumns(columns) {
  return columns.filter((column) => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk));
}

function databaseOverview(root) {
  const dbPath = dbOf(root);
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const stat = fs.statSync(dbPath);
  const Database = betterSqlite(root);
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = tableNames(db).map((name) => {
      const quoted = quoteIdentifier(name);
      const columns = tableColumns(db, name);
      let rows = 0;
      let sizeBytes = null;
      let indexes = 0;
      try { rows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count) || 0; } catch { /* ignore */ }
      try { indexes = db.prepare(`PRAGMA index_list(${quoted})`).all().length; } catch { /* ignore */ }
      try { sizeBytes = Number(db.prepare("SELECT SUM(pgsize) AS size FROM dbstat WHERE name = ?").get(name).size) || 0; } catch { /* dbstat unavailable */ }
      return {
        name,
        rows,
        columns: columns.length,
        indexes,
        sizeBytes
      };
    });
    const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count) || 0;
    const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size) || 0;
    return {
      ok: true,
      path: dbPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      tables,
      tableCount: tables.length,
      totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
      pageCount,
      pageSize,
      journalMode: String(db.prepare("PRAGMA journal_mode").get().journal_mode || "unknown")
    };
  } finally {
    db.close();
  }
}

function tableRows(root, table, limit = 100, offset = 0) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root), { readonly: true });
  try {
    const name = assertTable(db, table);
    const columns = tableColumns(db, name);
    const primaryKeys = primaryKeyColumns(columns);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(name)} LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get().count) || 0;
    return { ok: true, table: name, columns, primaryKeys, rows, total, limit: safeLimit, offset: safeOffset };
  } finally {
    db.close();
  }
}

function normalizeValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function ensureBackup(root, db) {
  const dbPath = dbOf(root);
  const backup = dbPath + ".launcher-backup";
  if (!fs.existsSync(backup)) {
    try { db.pragma("wal_checkpoint(FULL)"); } catch { /* best effort */ }
    fs.copyFileSync(dbPath, backup);
  }
  return backup;
}

function primaryKeyValues(columns, values) {
  const primaryKeys = primaryKeyColumns(columns);
  if (!primaryKeys.length) throw new Error("该数据表没有可编辑主键");
  const result = [];
  for (const key of primaryKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, key.name)) throw new Error(`缺少主键字段: ${key.name}`);
    result.push({ column: key.name, value: values[key.name] });
  }
  return result;
}

function writeRow(root, table, values, update) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root));
  db.pragma("busy_timeout = 5000");
  try {
    const name = assertTable(db, table);
    const columns = tableColumns(db, name);
    const columnNames = new Set(columns.map((column) => column.name));
    const data = values && typeof values === "object" ? values : {};
    if (!update) {
      const keys = Object.keys(data).filter((key) => columnNames.has(key));
      if (!keys.length) throw new Error("没有可写入字段");
      ensureBackup(root, db);
      const sql = `INSERT INTO ${quoteIdentifier(name)} (${keys.map(quoteIdentifier).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
      db.prepare(sql).run(...keys.map((key) => normalizeValue(data[key])));
      return { ok: true, action: "insert" };
    }
    const primaryKeys = primaryKeyValues(columns, data);
    const editableKeys = Object.keys(data).filter((key) => columnNames.has(key) && !primaryKeys.some((item) => item.column === key));
    if (!editableKeys.length) throw new Error("没有可更新字段");
    ensureBackup(root, db);
    const sql = `UPDATE ${quoteIdentifier(name)} SET ${editableKeys.map((key) => `${quoteIdentifier(key)} = ?`).join(", ")} WHERE ${primaryKeys.map((item) => `${quoteIdentifier(item.column)} = ?`).join(" AND ")}`;
    const result = db.prepare(sql).run(...editableKeys.map((key) => normalizeValue(data[key])), ...primaryKeys.map((item) => normalizeValue(item.value)));
    if (!result.changes) throw new Error("没有找到要更新的行");
    return { ok: true, action: "update", changes: result.changes };
  } finally {
    db.close();
  }
}

function deleteRow(root, table, values) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root));
  db.pragma("busy_timeout = 5000");
  try {
    const name = assertTable(db, table);
    const primaryKeys = primaryKeyValues(tableColumns(db, name), values || {});
    ensureBackup(root, db);
    const sql = `DELETE FROM ${quoteIdentifier(name)} WHERE ${primaryKeys.map((item) => `${quoteIdentifier(item.column)} = ?`).join(" AND ")}`;
    const result = db.prepare(sql).run(...primaryKeys.map((item) => item.value));
    if (!result.changes) throw new Error("没有找到要删除的行");
    return { ok: true, action: "delete", changes: result.changes };
  } finally {
    db.close();
  }
}

function backupDirectory(root) {
  return path.join(root, "__backup", "databackup");
}

function backupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniqueBackupPath(root, prefix) {
  const directory = backupDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const base = `${prefix}-${backupTimestamp()}`;
  let candidate = path.join(directory, `${base}.sqlite.bak`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${String(suffix).padStart(2, "0")}.sqlite.bak`);
    suffix += 1;
  }
  return candidate;
}

async function createBackup(root, prefix = "gamestore") {
  const dbPath = dbOf(root);
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const destination = uniqueBackupPath(root, prefix);
  const Database = betterSqlite(root);
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  const stat = fs.statSync(destination);
  return {
    ok: true,
    name: path.basename(destination),
    path: destination,
    sizeBytes: stat.size,
    createdAt: stat.mtimeMs,
    directory: backupDirectory(root)
  };
}

function listBackups(root) {
  const directory = backupDirectory(root);
  if (!fs.existsSync(directory)) return { ok: true, directory, backups: [] };
  const backups = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".sqlite.bak"))
    .map((name) => {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      return { name, path: file, sizeBytes: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
  return { ok: true, directory, backups };
}

async function restoreBackup(root, name) {
  const directory = backupDirectory(root);
  const safeName = path.basename(String(name || ""));
  const source = path.join(directory, safeName);
  const resolvedDirectory = path.resolve(directory) + path.sep;
  if (!path.resolve(source).startsWith(resolvedDirectory) || !fs.existsSync(source)) {
    throw new Error(`备份不存在: ${safeName}`);
  }
  const safety = await createBackup(root, "pre-restore");
  const dbPath = dbOf(root);
  fs.copyFileSync(source, dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
  return { ok: true, restored: safeName, safetyBackup: safety.name };
}

(async () => {
  const root = rootOf(repoRoot);
  if (cmd === "overview") console.log(JSON.stringify(databaseOverview(root)));
  else if (cmd === "table") console.log(JSON.stringify(tableRows(root, arg1, arg2 || 100, process.argv[6] || 0)));
  else if (cmd === "save") {
    const values = JSON.parse(arg2 || "{}");
    console.log(JSON.stringify(writeRow(root, arg1, values, true)));
  } else if (cmd === "insert") {
    const values = JSON.parse(arg2 || "{}");
    console.log(JSON.stringify(writeRow(root, arg1, values, false)));
  } else if (cmd === "delete") {
    if (!APPLY) throw new Error("delete 需要 --apply");
    const values = JSON.parse(arg2 || "{}");
    console.log(JSON.stringify(deleteRow(root, arg1, values)));
  } else if (cmd === "backup") {
    console.log(JSON.stringify(await createBackup(root, arg1 || "gamestore")));
  } else if (cmd === "backups") {
    console.log(JSON.stringify(listBackups(root)));
  } else if (cmd === "restore") {
    if (!APPLY) throw new Error("restore 需要 --apply");
    if (!arg1) throw new Error("restore 需要备份文件名");
    console.log(JSON.stringify(await restoreBackup(root, arg1)));
  } else {
    throw new Error(`未知命令: ${cmd}`);
  }
})().catch((error) => {
  console.error(`[database-cli] ${error && error.message ? error.message : error}`);
  process.exit(1);
});
