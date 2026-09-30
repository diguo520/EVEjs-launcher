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
 *   node account-cli.js delete-character <repoRoot> <角色名或角色ID> [--apply]  # 只删角色，账号保留
 *   node account-cli.js check-running <repoRoot>   # 检测服务是否在运行(端口探活)
 *   node account-cli.js hash <user> <password>     # 输出客户端同款密码哈希(hex)
 *   node account-cli.js verify <repoRoot> <user> <password>   # 验证账号密码(只读)
 *   node account-cli.js set-password <repoRoot> <user> <newPassword>  # 修改密码(直接写库,热生效)
 *
 * 密码可以从标准输入读（启动器默认走这条，避免密码出现在进程命令行里）：
 *   node account-cli.js create <repoRoot> <账号> --password-stdin [--gm]
 *   node account-cli.js verify <repoRoot> <user> --password-stdin
 *   node account-cli.js set-password <repoRoot> <user> --password-stdin
 *   node account-cli.js hash <user> --password-stdin
 */const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const [,, cmd, repoRoot, arg1, arg2, arg3] = process.argv;
const APPLY = process.argv.includes("--apply");
const PW_STDIN = process.argv.includes("--password-stdin");

/** --password-stdin：密码从标准输入读，绝不放进 argv（进程列表里看不到）。
 *  读不到就报错，不静默当空密码——否则会写进一个谁也登不上的哈希。 */
function passwordFromStdin() {
  let text = "";
  try {
    text = fs.readFileSync(0, "utf8");
  } catch (e) {
    throw new Error("--password-stdin 读取标准输入失败：" + (e && e.message ? e.message : e));
  }
  const value = text.replace(/\r?\n$/, "");
  if (!value) throw new Error("--password-stdin 没有读到密码");
  return value;
}

/** 取密码：声明走 stdin 时忽略 argv 占位符（调用方在密码位放 --password-stdin） */
function resolvePassword(fallback) {
  return PW_STDIN ? passwordFromStdin() : fallback;
}
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

/* ---------------- 军团 / 联盟名称 ---------------- */

/**
 * corporations / alliances 两张表都是 key→json 的 KV，同一个键能装两种东西：
 *   "records"            → 整张 id→记录 的映射（NPC 军团就这么存的）
 *   "records\u001f<id>"  → 单条记录（玩家军团 / 联盟落库后长这样）
 * 真实数据里映射行**不带** records 外层，本体就是那张映射，所以这里按
 * 「有没有 id/name 字段」区分是单条还是映射。_meta 之类既没 id 也没 name
 * 的行会被映射分支遍历到，但值不是对象，add() 会跳过。
 * 表不存在（老服务端）不算错，返回空表即可。
 */
function nameIndex(db, table, idKey, nameKey) {
  const index = new Map();
  let rows;
  try {
    rows = db.prepare(`SELECT key, json FROM ${table}`).all();
  } catch {
    return index;
  }
  const add = (record, fallbackKey) => {
    if (!record || typeof record !== "object") return;
    const id = record[idKey] != null ? record[idKey] : fallbackKey;
    const name = record[nameKey];
    if (id != null && name !== undefined && name !== null && String(name) !== "") {
      index.set(String(id), String(name));
    }
  };
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.json); } catch { continue; }
    if (!data || typeof data !== "object") continue;
    if (data[idKey] != null || data[nameKey] != null) {
      add(data, null);
      continue;
    }
    const map = data.records && typeof data.records === "object" ? data.records : data;
    for (const [key, record] of Object.entries(map)) add(record, key);
  }
  return index;
}

/**
 * 钱包余额表：key = "character:<角色ID>"，json 里的 balance 是**实时**余额。
 * 表不存在（老服务端）不算错，返回空表。
 */
function walletBalanceIndex(db) {
  const index = new Map();
  let rows;
  try {
    rows = db.prepare("SELECT key, json FROM walletAuthorityState").all();
  } catch {
    return index;
  }
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.json); } catch { continue; }
    if (!data || typeof data !== "object") continue;
    const id = data.characterID != null
      ? String(data.characterID)
      : String(row.key).replace(/^character:/, "");
    const balance = Number(data.balance);
    if (id && Number.isFinite(balance)) index.set(id, balance);
  }
  return index;
}

/* ---------------- list ---------------- */
function listAccounts(root) {
  const Database = betterSqlite(root);
  const db = new Database(dbOf(root), { readonly: true });
  const accounts = db.prepare("SELECT key, json FROM accounts").all();
  const chars = db.prepare("SELECT key, json FROM characters").all();
  const items = db.prepare("SELECT key, json FROM items").all();
  // 角色行里只有 corporationID / allianceID，名字得从这两张表反查（拿不到就留空）
  const corporationNames = nameIndex(db, "corporations", "corporationID", "corporationName");
  const allianceNames = nameIndex(db, "alliances", "allianceID", "allianceName");
  // 徽标那枚 20px 小图看不清字，卡片上再给一个短标识（军团 ticker / 联盟简称）
  const corporationTickers = nameIndex(db, "corporations", "corporationID", "tickerName");
  const allianceTickers = nameIndex(db, "alliances", "allianceID", "shortName");
  // 钱包真值在 walletAuthorityState（key = "character:<角色ID>"）；characters.balance 只是
  // 建号时的初始值，之后在游戏里赚的钱只写钱包表 —— 两个都读，以钱包为准
  const walletBalances = walletBalanceIndex(db);
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
        // 军团 / 联盟：0 表示"没有"，统一换成 null，界面按"没记录"处理
        const corporationID = asNumber(d.corporationID, 0) || null;
        const allianceID = asNumber(d.allianceID, 0) || null;
        return {
          characterId: c.key,
          characterName: d.characterName || c.key,
          // 钱包表有记录就用它（实时余额），否则回落到角色表里的建号初始值
          isk: walletBalances.has(String(c.key))
            ? walletBalances.get(String(c.key))
            : asNumber(d.balance ?? d.isk, 0),
          skillPoints: asNumber(d.skillPoints ?? d.sp, 0),
          shipName,
          shipTypeID: asNumber(d.shipTypeID, 0) || null,
          location: characterLocation(d),
          securityStatus: d.securityStatus ?? d.securityRating ?? null,
          // 种族档案：服务端在角色表里就存在，之前没带出来，界面只好画"未记录"
          raceID: asNumber(d.raceID, 0) || null,
          bloodlineID: asNumber(d.bloodlineID, 0) || null,
          // 性别只有 0/1/2 三个合法值（服务端 characterIdentity.normalizeCharacterGender），别的当没记录
          gender: d.gender === 0 || d.gender === 1 || d.gender === 2 ? d.gender : null,
          corporationID,
          corporationName: corporationID ? corporationNames.get(String(corporationID)) || null : null,
          corporationTicker: corporationID ? corporationTickers.get(String(corporationID)) || null : null,
          allianceID,
          allianceName: allianceID ? allianceNames.get(String(allianceID)) || null : null,
          allianceTicker: allianceID ? allianceTickers.get(String(allianceID)) || null : null
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

/**
 * 收集「归属这些角色」的所有行（只读）：
 *   plan       整行删除清单（行级 / key 精确 / key 命名空间 / json 含归属字段）
 *   arrayPlan  数组内过滤清单（structures 这类集合表只摘掉元素，不删整行）
 *   variants   误伤判定用的 ID 变体（裸数字与 JSON 串里的数字）
 * extraVariants 给删账号用：账号 ID 也要算进去（有些行挂的是 accountId）。
 */
function collectCharacterRows(db, charIds, extraVariants) {
  const variants = new Set(extraVariants || []);
  for (const c of charIds) for (const v of idVariants(c)) variants.add(v);

  const plan = [];
  const countRow = (label, n) => { if (n > 0) { plan.push([label, n, null]); } };
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
  return { variants, plan, arrayPlan };
}

/** 把 collectCharacterRows 的清单落到库上（调用方负责开事务、删账号行） */
function deleteCharacterRows(wdb, charIds, arrayPlan, variants) {
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
}

/** 删除计划（删账号与删角色共用同一套口径与打印格式） */
function printDeletionPlan(plan, arrayPlan, portraitFiles) {
  let total = 0;
  console.log("\n================ 删除计划 ================");
  for (const [label, n] of plan) { console.log(`  ${label.padEnd(26)} ${n} 行`); total += n; }
  for (const p of arrayPlan) { console.log(`  ${p.table.padEnd(26)} ${p.n} 条(集合内过滤)`); total += p.n; }
  if (portraitFiles.length > 0) {
    console.log(`  ${"角色肖像".padEnd(26)} ${portraitFiles.length} 个文件（游戏内头像）`);
    total += portraitFiles.length;
  }
  console.log("==========================================");
  console.log(`合计: ${total} 条`);
}

/** 写库前先备份，返回备份路径 */
function backupDatabase(dbPath) {
  const bak = dbPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.copyFileSync(dbPath, bak);
  return bak;
}

/** 删除角色肖像文件（游戏内头像） */
function removePortraitFiles(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); console.log(`  [已删头像] ${f}`); }
    catch (e) { console.log(`  [头像删除失败] ${f}: ${e.message}`); }
  }
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

  // 3) 计划（账号 ID 一并算进误伤判定：有些行挂的是 accountId）
  const { plan, arrayPlan, variants } = collectCharacterRows(db, charIds, idVariants(accId));
  const fullPlan = [["accounts", 1, null]];
  if (charRows.length > 0) fullPlan.push(["characters", charRows.length, null]);
  fullPlan.push(...plan);
  const portraitFiles = collectPortraitFiles(root, charIds);
  printDeletionPlan(fullPlan, arrayPlan, portraitFiles);
  db.close();

  if (!apply) {
    console.log("\n[预览模式] 未修改任何数据。确认无误后加 --apply 执行。");
    return;
  }

  // 4) 备份 + 执行
  const bak = backupDatabase(dbPath);
  console.log(`\n[备份] ${bak}`);

  const wdb = new Database(dbPath);
  const tx = wdb.transaction(() => {
    wdb.prepare("DELETE FROM accounts WHERE key=?").run(accKey);
    deleteCharacterRows(wdb, charIds, arrayPlan, variants);
  });
  tx();
  wdb.close();
  // 4b) 删除角色肖像文件（游戏内头像一并清除）
  removePortraitFiles(portraitFiles);
  console.log(`\n[完成] 账号 '${accKey}' 已删除（含 ${portraitFiles.length} 个头像文件）。请重启服务器生效。`);
}

/**
 * 只删一个角色，账号与账号下其他角色原样保留。
 * target = 角色 ID（characters.key）或角色名。
 * 老版 delete 是「按角色名反查账号 → 连账号一起删」，那是数据破坏级的行为；
 * 界面上的「删除角色」必须走这条独立路径。
 */
function deleteCharacter(root, target, apply) {
  const Database = betterSqlite(root);
  const dbPath = dbOf(root);
  if (!fs.existsSync(dbPath)) throw new Error("未找到 gamestore.sqlite: " + dbPath);
  const db = new Database(dbPath, { readonly: true });

  const want = String(target || "").trim();
  if (!want) throw new Error("delete-character 需要角色名或角色 ID");

  // 1) 找角色：先当角色 ID，再当角色名
  let charRow = db.prepare("SELECT key, json FROM characters WHERE key=?").get(want);
  if (!charRow) {
    for (const row of db.prepare("SELECT key, json FROM characters").all()) {
      let d; try { d = JSON.parse(row.json); } catch { continue; }
      if (d.characterName === want) { charRow = row; break; }
    }
  }
  if (!charRow) throw new Error("角色不存在: " + want);
  let charData; try { charData = JSON.parse(charRow.json); } catch { throw new Error("角色数据损坏: " + want); }
  const charId = String(charRow.key);
  const accId = charData.accountId;

  const allChars = db.prepare("SELECT key, json FROM characters").all();
  const accRow = db.prepare("SELECT key, json FROM accounts").all().find((a) => {
    try { return String(JSON.parse(a.json).id) === String(accId); } catch { return false; }
  });
  const accKey = accRow ? accRow.key : String(accId);
  console.log(`角色: ${charData.characterName || charId}  id=${charId}`);
  console.log(`所属账号: ${accKey}  id=${accId}（本操作只删角色，账号保留）`);
  const siblings = allChars.filter((c) => {
    if (String(c.key) === charId) return false;
    try { return String(JSON.parse(c.json).accountId) === String(accId); } catch { return false; }
  }).length;
  console.log(`账号下其余角色 ${siblings} 个，不会被动到`);

  // 2) 计划（只按角色 ID 判定，不把账号 ID 算进来）
  const charIds = [charId];
  const { plan, arrayPlan, variants } = collectCharacterRows(db, charIds);
  const portraitFiles = collectPortraitFiles(root, charIds);
  printDeletionPlan(plan, arrayPlan, portraitFiles);
  db.close();

  if (!apply) {
    console.log("\n[预览模式] 未修改任何数据。确认无误后加 --apply 执行。");
    return;
  }

  const bak = backupDatabase(dbPath);
  console.log(`\n[备份] ${bak}`);

  const wdb = new Database(dbPath);
  const tx = wdb.transaction(() => {
    deleteCharacterRows(wdb, charIds, arrayPlan, variants);
  });
  tx();
  wdb.close();
  removePortraitFiles(portraitFiles);
  console.log(`\n[完成] 角色 '${charData.characterName || charId}' 已删除（含 ${portraitFiles.length} 个头像文件），账号 '${accKey}' 与其他角色保留。请重启服务器生效。`);
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
  } else if (cmd === "delete-character") {
    if (!arg1) throw new Error("delete-character 需要角色名或角色 ID");
    deleteCharacter(repoOf(repoRoot), arg1, APPLY);
  } else if (cmd === "create") {
    if (!arg1 || (!arg2 && !PW_STDIN)) throw new Error("create 需要 <repoRoot> <账号> <密码|--password-stdin> [--gm]");
    createAccount(repoOf(repoRoot), arg1, resolvePassword(arg2), process.argv.includes("--gm"));
  } else if (cmd === "check-running") {
    checkRunning(repoOf(repoRoot));
  } else if (cmd === "hash") {
    // hash <user> <password> —— 无需 repoRoot，user 位于第 2 位参数槽
    const user = repoRoot;
    if (!user || (!arg1 && !PW_STDIN)) throw new Error("hash 需要 <user> <密码|--password-stdin>");
    console.log(evePasswordHash(user, resolvePassword(arg1)));
  } else if (cmd === "verify") {
    if (!arg1 || (!arg2 && !PW_STDIN)) throw new Error("verify 需要 <repoRoot> <user> <密码|--password-stdin>");
    console.log(JSON.stringify(verifyAccount(repoOf(repoRoot), arg1, resolvePassword(arg2))));
  } else if (cmd === "set-password") {
    if (!arg1 || (!arg2 && !PW_STDIN)) throw new Error("set-password 需要 <repoRoot> <user> <密码|--password-stdin>");
    setPassword(repoOf(repoRoot), arg1, resolvePassword(arg2));
  } else {
    console.error("未知命令: " + cmd);
    process.exit(1);
  }
} catch (e) {
  console.error("[account-cli] " + (e && e.message ? e.message : e));
  process.exit(1);
}
