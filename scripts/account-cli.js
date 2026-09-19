#!/usr/bin/env node
"use strict";
/**
 * EvEJS 账号管理 CLI（启动器主进程通过 spawn 调用）
 * 依赖: 系统 Node + server\node_modules\better-sqlite3（服务端必有）
 *
 * 用法:
 *   node account-cli.js list <repoRoot> [--db <sqlite>]
 *   node account-cli.js create <repoRoot> <账号> <密码> [--gm]
 *   node account-cli.js delete <repoRoot> <账号key或角色名> [--apply]
 *   node account-cli.js check-running <repoRoot>   # 检测服务是否在运行(端口探活)
 *   node account-cli.js hash <user> <password>     # 输出客户端同款密码哈希(hex)
 *   node account-cli.js verify <repoRoot> <user> <password>   # 验证账号密码(只读)
 *   node account-cli.js set-password <repoRoot> <user> <newPassword>  # 修改密码(直接写库,热生效)
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const [,, cmd, repoRoot, arg1, arg2, arg3] = process.argv;
const APPLY = process.argv.includes("--apply");

/** 客户端同款密码哈希：SHA1(pw_utf16le + user_lower_utf16le) 迭代 1000 次（machobase.PasswordHash） */
function evePasswordHash(userName, password) {
  const salt = Buffer.from(String(userName).trim().toLowerCase(), "utf16le");
  const pw = Buffer.from(String(password), "utf16le");
  let h = crypto.createHash("sha1").update(Buffer.concat([pw, salt])).digest();
  for (let i = 0; i < 1000; i++) {
    h = crypto.createHash("sha1").update(Buffer.concat([h, salt])).digest();
  }
  return h.toString("hex");
}

function repoOf(root) {
  // 便携版：exe 所在目录即服务端根；开发/源码模式：仓库根
  return path.resolve(root || ".");
}

function dbOf(root) {
  return path.join(root, "_local", "gameStore", "gamestore.sqlite");
}

function betterSqlite(root) {
  const p = path.join(root, "server", "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(p, "package.json"))) {
    throw new Error("未找到 server/node_modules/better-sqlite3（服务端依赖不完整）");
  }
  return require(p);
}

/* ---------------- account helpers ---------------- */
const DEFAULT_STATION_ID = 60003760;
const DEFAULT_SOLAR_SYSTEM_ID = 30000142;
const GM_ACCOUNT_ROLE = "431255270151428096";
const GM_CHAT_ROLE = "90071993086640128";
const PLAYER_ACCOUNT_ROLE = "0";
const PLAYER_CHAT_ROLE = "538968064";

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function accountIsGM(accountData) {
  if (typeof accountData.isGM === "boolean") return accountData.isGM;
  return String(accountData.role || "0") !== "0";
}

function characterLocation(data) {
  const stationID = asNumber(data.stationID ?? data.stationid, 0);
  const solarSystemID = asNumber(data.solarSystemID ?? data.solarsystemid, 0);
  const worldSpaceID = asNumber(data.worldSpaceID ?? data.worldspaceid, 0);
  const systemName = solarSystemID === DEFAULT_SOLAR_SYSTEM_ID ? "Jita" : solarSystemID ? `System ${solarSystemID}` : "";
  const stationName = stationID === DEFAULT_STATION_ID
    ? "Jita IV - Moon 4 - Caldari Navy Assembly Plant"
    : stationID ? `Station ${stationID}` : "";
  return {
    stationID: stationID || null,
    stationName,
    solarSystemID: solarSystemID || null,
    solarSystemName: systemName,
    worldSpaceID: worldSpaceID || null,
    label: stationName || systemName || (worldSpaceID ? `Space ${worldSpaceID}` : "Unknown")
  };
}

function createAccountRecord(accountId, isGM, passwordhash) {
  return {
    passwordhash,
    id: accountId,
    isGM: !!isGM,
    role: isGM ? GM_ACCOUNT_ROLE : PLAYER_ACCOUNT_ROLE,
    chatRole: isGM ? GM_CHAT_ROLE : PLAYER_CHAT_ROLE,
    banned: false
  };
}

function nextAccountId(db) {
  let maxId = 0;
  for (const row of db.prepare("SELECT json FROM accounts").all()) {
    try {
      maxId = Math.max(maxId, asNumber(JSON.parse(row.json).id, 0));
    } catch { /* ignore malformed row */ }
  }
  return maxId + 1;
}

/* ---------------- list ---------------- */
function listAccounts(root) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root), { readonly: true });
  const accounts = db.prepare("SELECT key, json FROM accounts").all();
  const chars = db.prepare("SELECT key, json FROM characters").all();
  const items = db.prepare("SELECT key, json FROM items").all();
  db.close();
  const itemNames = new Map();
  for (const item of items) {
    try {
      const data = JSON.parse(item.json);
      if (data.itemName) itemNames.set(String(item.key), data.itemName);
    } catch { /* ignore malformed item */ }
  }
  const out = [];
  for (const a of accounts) {
    let ad;
    try { ad = JSON.parse(a.json); } catch { continue; }
    const roles = chars
      .map((c) => ({ key: c.key, json: c.json }))
      .filter((c) => {
        try { return String(JSON.parse(c.json).accountId) === String(ad.id); } catch { return false; }
      })
      .map((c) => {
        const d = JSON.parse(c.json);
        const shipName = d.shipName || itemNames.get(String(d.shipID)) || (d.shipTypeID ? `Type ${d.shipTypeID}` : "Unknown");
        return {
          characterId: c.key,
          characterName: d.characterName || c.key,
          isk: asNumber(d.balance ?? d.isk, 0),
          skillPoints: asNumber(d.skillPoints ?? d.sp, 0),
          shipName,
          shipTypeID: asNumber(d.shipTypeID, 0) || null,
          location: characterLocation(d),
          securityStatus: d.securityStatus ?? d.securityRating ?? null
        };
      });
    out.push({
      accountKey: a.key,
      accountId: ad.id,
      isGM: accountIsGM(ad),
      banned: !!ad.banned,
      roles
    });
  }
  console.log(JSON.stringify(out));
}

/* ---------------- create ---------------- */
function createAccount(root, accKey, password, isGM) {
  const key = String(accKey || "").trim();
  if (!key) throw new Error("账号名不能为空");
  if (!password || String(password).length < 4) throw new Error("密码至少 4 位");
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root));
  try {
    const existing = db.prepare("SELECT key FROM accounts WHERE key=?").get(key);
    if (existing) throw new Error(`账号 '${key}' 已存在`);
    const record = createAccountRecord(nextAccountId(db), isGM, evePasswordHash(key, password));
    db.prepare("INSERT INTO accounts (key, json) VALUES (?, ?)").run(key, JSON.stringify(record));
    console.log(JSON.stringify({ ok: true, accountKey: key, accountId: record.id, isGM: record.isGM }));
  } finally {
    db.close();
  }
}

/* ---------------- delete（移植 delete-account.py v2 逻辑） ---------------- */
const OWNER_FIELDS = ["accountId", "accountID", "characterID", "characterId", "ownerID", "ownerId"];
const ROW_TABLES = [          // 行级: key 直接等于角色 id
  "skills", "skillQueues", "skillPlans", "savedFittings",
  "industryBlueprintState", "industryFacilityState", "researchRuntimeState",
  "miningLedger", "missionRuntimeState", "dungeonRuntimeState", "corpSkillPlans"
];
const KEY_EXACT_TABLES = ["walletAuthorityState"];   // key = "character:<角色id>"
const KEY_NS_TABLES = ["mail", "notifications"];     // key 含 \x1f<角色id>
const JSON_ROW_TABLES = ["items", "industryJobs", "bookmarks"]; // 行 json 含归属字段
const JSON_ARRAY_TABLES = ["structures"];            // 行 json 数组, 过滤元素

/* 角色肖像文件（对齐服务端 clearCharacterPortraits：runtime 根 + legacy 根, 6 尺寸, jpg/png） */
const PORTRAIT_DIRS = (root) => [
  path.join(root, "_local", "gameStore", "images", "Character"),
  path.join(root, "server", "src", "_secondary", "image", "generated", "Character")
];
const PORTRAIT_SIZES = [32, 64, 128, 256, 512, 1024];
const PORTRAIT_EXTS = ["jpg", "png"];

function collectPortraitFiles(root, charIds) {
  const files = [];
  for (const dir of PORTRAIT_DIRS(root)) {
    for (const c of charIds) {
      for (const size of PORTRAIT_SIZES) {
        for (const ext of PORTRAIT_EXTS) {
          const f = path.join(dir, `${c}_${size}.${ext}`);
          if (fs.existsSync(f)) files.push(f);
        }
      }
    }
  }
  return files;
}

function idVariants(v) {
  const s = String(v);
  return new Set([s, `"${s}"`]);
}

function deleteAccount(root, target, apply) {
  const Database = betterSqlite(root);
  const dbPath = dbOf(root);
  if (!fs.existsSync(dbPath)) throw new Error("未找到 gamestore.sqlite: " + dbPath);
  const db = new Database(dbPath, { readonly: true });

  // 1) 找账号(账号key 或 角色名反查)
  let accRow = db.prepare("SELECT key, json FROM accounts WHERE key=?").get(target);
  let accKey = accRow ? accRow.key : null;
  if (!accRow) {
    const chars = db.prepare("SELECT key, json FROM characters").all();
    for (const c of chars) {
      let d; try { d = JSON.parse(c.json); } catch { continue; }
      if (d.characterName === target) {
        for (const a of db.prepare("SELECT key, json FROM accounts").all()) {
          let ad; try { ad = JSON.parse(a.json); } catch { continue; }
          if (String(ad.id) === String(d.accountId)) { accRow = a; accKey = a.key; break; }
        }
        if (accRow) break;
      }
    }
    if (!accRow) throw new Error("账号/角色不存在: " + target);
    console.log(`[提示] 已按角色名 '${target}' 反查到账号 key='${accKey}'`);
  }
  const acc = JSON.parse(accRow.json);
  const accId = acc.id;
  console.log(`账号: ${accKey}  id=${accId}  isGM=${acc.isGM ? "true" : "false"}`);

  // 2) 角色
  const charsAll = db.prepare("SELECT key, json FROM characters").all();
  const charRows = charsAll.filter((c) => {
    try { return String(JSON.parse(c.json).accountId) === String(accId); } catch { return false; }
  });
  const charIds = charRows.map((c) => c.key);
  console.log(`关联角色 ${charIds.length} 个: ${charIds.join(", ")}`);
  const variants = idVariants(accId);
  for (const c of charIds) for (const v of idVariants(c)) variants.add(v);

  // 3) 计划
  const plan = [];
  const countRow = (label, n) => { if (n > 0) { plan.push([label, n, null]); } };
  countRow("accounts", 1);
  countRow("characters", charRows.length);
  for (const t of ROW_TABLES) {
    try {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE key IN (${charIds.map(() => "?").join(",")})`).get(...charIds).n;
      countRow(t, n);
    } catch { /* 表不存在跳过 */ }
  }
  for (const t of KEY_EXACT_TABLES) {
    try {
      let n = 0;
      for (const c of charIds) {
        n += db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE key=?`).get("character:" + c).n;
      }
      countRow(t, n);
    } catch { }
  }
  for (const t of KEY_NS_TABLES) {
    try {
      let n = 0;
      for (const c of charIds) {
        n += db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE key LIKE ?`).get("%\x1f" + c).n;
      }
      countRow(t, n);
    } catch { }
  }
  for (const t of JSON_ROW_TABLES) {
    try {
      let n = 0;
      for (const row of db.prepare(`SELECT key, json FROM "${t}"`).all()) {
        for (const f of OWNER_FIELDS) {
          const m = row.json.match(new RegExp(`"${f}"\\s*:\\s*"?([0-9]+)"?`));
          if (m && variants.has(m[1])) { n++; break; }
        }
      }
      countRow(t, n);
    } catch { }
  }
  // 集合表(数组) —— 只统计
  const arrayPlan = [];
  for (const t of JSON_ARRAY_TABLES) {
    try {
      for (const row of db.prepare(`SELECT key, json FROM "${t}"`).all()) {
        let arr; try { arr = JSON.parse(row.json); } catch { continue; }
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((e) => !OWNER_FIELDS.some((f) => e && variants.has(String(e[f] ?? ""))));
        if (kept.length !== arr.length) arrayPlan.push({ table: t, key: row.key, json: JSON.stringify(kept), n: arr.length - kept.length });
      }
    } catch { }
  }
  let total = 0;
  const portraitFiles = collectPortraitFiles(root, charIds);
  console.log("\n================ 删除计划 ================");
  for (const [label, n] of plan) { console.log(`  ${label.padEnd(26)} ${n} 行`); total += n; }
  for (const p of arrayPlan) { console.log(`  ${p.table.padEnd(26)} ${p.n} 条(集合内过滤)`); total += p.n; }
  if (portraitFiles.length > 0) {
    console.log(`  ${"角色肖像".padEnd(26)} ${portraitFiles.length} 个文件（游戏内头像）`);
    total += portraitFiles.length;
  }
  console.log("==========================================");
  console.log(`合计: ${total} 条`);
  db.close();

  if (!apply) {
    console.log("\n[预览模式] 未修改任何数据。确认无误后加 --apply 执行。");
    return;
  }

  // 4) 备份 + 执行
  const bak = dbPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.copyFileSync(dbPath, bak);
  console.log(`\n[备份] ${bak}`);

  const wdb = new Database(dbPath);
  const tx = wdb.transaction(() => {
    wdb.prepare("DELETE FROM accounts WHERE key=?").run(accKey);
    for (const c of charIds) wdb.prepare("DELETE FROM characters WHERE key=?").run(c);
    for (const t of ROW_TABLES) {
      try {
        wdb.prepare(`DELETE FROM "${t}" WHERE key IN (${charIds.map(() => "?").join(",")})`).run(...charIds);
      } catch { }
    }
    for (const t of KEY_EXACT_TABLES) {
      try { for (const c of charIds) wdb.prepare(`DELETE FROM "${t}" WHERE key=?`).run("character:" + c); } catch { }
    }
    for (const t of KEY_NS_TABLES) {
      try { for (const c of charIds) wdb.prepare(`DELETE FROM "${t}" WHERE key LIKE ?`).run("%\x1f" + c); } catch { }
    }
    for (const t of JSON_ROW_TABLES) {
      try {
        for (const row of wdb.prepare(`SELECT key, json FROM "${t}"`).all()) {
          let del = false;
          for (const f of OWNER_FIELDS) {
            const m = row.json.match(new RegExp(`"${f}"\\s*:\\s*"?([0-9]+)"?`));
            if (m && variants.has(m[1])) { del = true; break; }
          }
          if (del) wdb.prepare(`DELETE FROM "${t}" WHERE key=?`).run(row.key);
        }
      } catch { }
    }
    for (const p of arrayPlan) {
      try { wdb.prepare(`UPDATE "${p.table}" SET json=? WHERE key=?`).run(p.json, p.key); } catch { }
    }
  });
  tx();
  wdb.close();
  // 4b) 删除角色肖像文件（游戏内头像一并清除）
  for (const f of portraitFiles) {
    try { fs.unlinkSync(f); console.log(`  [已删头像] ${f}`); } catch (e) { console.log(`  [头像删除失败] ${f}: ${e.message}`); }
  }
  console.log(`\n[完成] 账号 '${accKey}' 已删除（含 ${portraitFiles.length} 个头像文件）。请重启服务器生效。`);
}

/* ---------------- 密码哈希 / 验证 / 修改 ---------------- */
function readAccountPasswordHash(root, accKey) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root), { readonly: true });
  let hash = null;
  try {
    const row = db.prepare("SELECT json FROM accounts WHERE key=?").get(String(accKey));
    if (row) {
      try { hash = JSON.parse(row.json).passwordhash || null; } catch { hash = null; }
    }
  } finally {
    db.close();
  }
  return hash;
}

function verifyAccount(root, accKey, password) {
  const stored = readAccountPasswordHash(root, accKey);
  if (stored === null) return { user: String(accKey), ok: false, reason: "账号不存在" };
  const calc = evePasswordHash(accKey, password);
  const ok = stored.toLowerCase() === calc.toLowerCase();
  return { user: String(accKey), ok, reason: ok ? undefined : "密码错误", stored: stored.slice(0, 8) + "…", calc: calc.slice(0, 8) + "…" };
}

function setPassword(root, accKey, newPassword) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root));
  try {
    const row = db.prepare("SELECT json FROM accounts WHERE key=?").get(String(accKey));
    if (!row) throw new Error(`账号 '${accKey}' 不存在`);
    let ad;
    try { ad = JSON.parse(row.json); } catch { throw new Error(`账号 '${accKey}' 数据损坏`); }
    ad.passwordhash = evePasswordHash(accKey, newPassword);
    db.prepare("UPDATE accounts SET json=? WHERE key=?").run(JSON.stringify(ad), String(accKey));
    // 服务端 handshake 每次登录都重新读取 accounts 表 → 新密码立即生效（热生效）
    console.log(`[完成] 账号 '${accKey}' 密码已更新（无需重启服务器）`);
  } finally {
    db.close();
  }
}

/* ---------------- 服务运行检测(本地监听端口, 毫秒级) ---------------- */
function checkRunning(root) {
  const cfgPath = path.join(root, "config", "server.json");
  let ports = [26000, 26001, 26002, 40110];
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const extract = (o) => {
      if (!o) return [];
      if (typeof o === "number") return [o];
      if (typeof o === "string") return [parseInt(o, 10)].filter((n) => !isNaN(n));
      if (Array.isArray(o)) return o.flatMap(extract);
      if (typeof o === "object") return Object.values(o).flatMap(extract);
      return [];
    };
    const found = extract(cfg);
    if (found.length) ports = [...new Set(found)];
  } catch { /* 用默认端口 */ }
  let listening = new Set();
  try {
    const out = cp.execSync("netstat -ano -p tcp", { encoding: "utf8", timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i);
      if (m) listening.add(parseInt(m[1], 10));
    }
  } catch { }
  const running = ports.some((p) => listening.has(p));
  console.log(JSON.stringify({ running, ports, listening: [...listening].filter((p) => ports.includes(p)) }));
}

try {
  if (cmd === "list") {
    listAccounts(repoOf(repoRoot));
} else if (cmd === "delete") {
    if (!arg1) throw new Error("delete 需要账号key或角色名");
    deleteAccount(repoOf(repoRoot), arg1, APPLY);
  } else if (cmd === "create") {
    if (!arg1 || !arg2) throw new Error("create 需要 <repoRoot> <账号> <密码> [--gm]");
    createAccount(repoOf(repoRoot), arg1, arg2, process.argv.includes("--gm"));
  } else if (cmd === "check-running") {
    checkRunning(repoOf(repoRoot));
  } else if (cmd === "hash") {
    // hash <user> <password> —— 无需 repoRoot，user 位于第 2 位参数槽
    const user = repoRoot;
    const pw = arg1;
    if (!user || !pw) throw new Error("hash 需要 <user> <password>");
    console.log(evePasswordHash(user, pw));
  } else if (cmd === "verify") {
    if (!arg1 || !arg2) throw new Error("verify 需要 <repoRoot> <user> <password>");
    console.log(JSON.stringify(verifyAccount(repoOf(repoRoot), arg1, arg2)));
  } else if (cmd === "set-password") {
    if (!arg1 || !arg2) throw new Error("set-password 需要 <repoRoot> <user> <newPassword>");
    setPassword(repoOf(repoRoot), arg1, arg2);
  } else {
    console.error("未知命令: " + cmd);
    process.exit(1);
  }
} catch (e) {
  console.error("[account-cli] " + (e && e.message ? e.message : e));
  process.exit(1);
}
