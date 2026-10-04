#!/usr/bin/env node
"use strict";

/**
 * 市场库读取器（只读）。给启动器的「物品市场」页用。
 *
 *   node market-cli.js overview <服务端根目录>
 *   node market-cli.js catalog  <服务端根目录>
 *   node market-cli.js book     <服务端根目录> <typeID>
 *   node market-cli.js trades   <服务端根目录> [条数]
 *   node market-cli.js typeinfo <服务端根目录> [界面语言]
 *
 * 为什么是「直接读 market.sqlite 文件」而不是问服务端要：
 *   1. 服务没起的时候也要能看（玩家开着启动器查价，市场服务不一定在跑）；
 *   2. 那份库就是服务端自己写的那一份，游戏里买掉一艘船，seed_stock.quantity 当场少 1，
 *      所以只读同一份文件＝看到的就是活的库存与价格，不用另建快照、也不用等接口。
 *
 * 依赖与 database-cli.js 完全相同：服务端自带的 better-sqlite3（只读打开）。
 * 不引入新依赖，也不额外生成任何数据文件。
 *
 * 两个容易踩的坑（2026-10-02 实测）：
 *   - order_id 是 int64（2257714186837035293 > 2^53），默认读出来会被 JS 静默改写末几位，
 *     一律 CAST(... AS TEXT) 再返回；
 *   - 一个库可能有多个 region，region_summaries 是 (region_id, type_id) 主键，
 *     直接 join 会把物品行数翻倍，所以固定只取一个 region（见 pickRegion）。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const [,, cmd, repoRootArg, arg1] = process.argv;

function rootOf(value) {
  return path.resolve(value || ".");
}

function marketServerDir(root) {
  return path.join(root, "externalservices", "market-server");
}

/**
 * 库路径优先读 market-server.local.toml 的 [storage] database_path（相对 market-server 目录解析），
 * 没写配置才退回 seeder 的默认位置。用户把库换到别处时不用改启动器。
 */
function marketDbOf(root) {
  const serverDir = marketServerDir(root);
  const configFile = path.join(serverDir, "config", "market-server.local.toml");
  let relative = path.join("data", "generated", "market.sqlite");
  try {
    const text = fs.readFileSync(configFile, "utf8");
    const block = text.split(/^\[/m).find((part) => part.startsWith("storage]"));
    const hit = block && block.match(/database_path\s*=\s*"([^"]+)"/);
    if (hit) relative = hit[1];
  } catch {
    /* 没有本地配置：走默认路径 */
  }
  return path.isAbsolute(relative) ? relative : path.join(serverDir, relative);
}

function betterSqlite(root) {
  const modulePath = path.join(root, "server", "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(modulePath, "package.json"))) {
    throw new Error("未找到 server/node_modules/better-sqlite3");
  }
  return require(modulePath);
}

/** 只读打开；服务端在跑时 WAL 允许多读者，不会被写锁挡住 */
function openMarketDb(root) {
  const dbPath = marketDbOf(root);
  if (!fs.existsSync(dbPath)) {
    throw new Error("未找到市场数据库：" + dbPath + "（先跑 BuildMarketSeed 生成种子）");
  }
  const Database = betterSqlite(root);
  return { db: new Database(dbPath, { readonly: true }), dbPath };
}

function text(value) {
  return value == null ? "" : String(value);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/* ------------------------------ SDE（分类树的名字） ------------------------------ */

/**
 * 市场库里只有 market_group_id 这个数字：分类树的父子关系与中英文名在 SDE 里。
 * 这是**运行时读服务端自带的 jsonl**，不是启动器自带的副本；SDE 不在就退化成
 * 「只有英文物品组名」的平铺列表（界面照常能用，只是没有分类树）。
 */
function sdeDirOf(root) {
  const base = path.join(root, "_local", "sde");
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return null;
  }
  const hit = names
    .filter((name) => name.startsWith("eve-online-static-data-"))
    .sort()
    .pop();
  return hit ? path.join(base, hit) : null;
}

function readJsonl(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* 单行坏了不影响整份树 */
    }
  }
  return rows;
}

/** 中英文名各取一边；缺一边退另一边，保证界面上永远有字 */
function zippedName(node) {
  const zh = text(node && node.name && node.name.zh);
  const en = text(node && node.name && node.name.en);
  return [zh || en, en || zh];
}

/* ------------------------------ 查询 ------------------------------ */

/** 有多个 region 时固定用同一个，否则 join 会把物品行数翻倍 */
function pickRegion(db) {
  const row = db.prepare("SELECT region_id, region_name FROM regions ORDER BY region_id LIMIT 1").get();
  return row ? { id: num(row.region_id), name: text(row.region_name) } : { id: 0, name: "" };
}

function manifestOf(db) {
  try {
    const row = db.prepare("SELECT value FROM manifest WHERE key = 'manifest_json'").get();
    if (!row) return {};
    const parsed = JSON.parse(text(row.value));
    return {
      generatedAt: text(parsed.generated_at),
      selectionLabel: text(parsed.selection_label),
      seedQuantity: num(parsed.default_quantity_per_station_type),
      historyDays: num(parsed.history_days_seeded),
      markupPercent: num(parsed.seed_markup_percent),
    };
  } catch {
    return {};
  }
}

function stationRows(db) {
  return db.prepare(
    "SELECT s.station_id, s.station_name, s.solar_system_id, ss.solar_system_name, s.security " +
      "FROM stations s LEFT JOIN solar_systems ss ON ss.solar_system_id = s.solar_system_id " +
      "ORDER BY s.station_id"
  ).all();
}

function overview(root) {
  const { db, dbPath } = openMarketDb(root);
  try {
    const stat = fs.statSync(dbPath);
    const region = pickRegion(db);
    const counts = {
      types: num(db.prepare("SELECT COUNT(*) AS c FROM market_types WHERE published = 1").get().c),
      stations: num(db.prepare("SELECT COUNT(*) AS c FROM stations").get().c),
      systems: num(db.prepare("SELECT COUNT(*) AS c FROM solar_systems").get().c),
      stockRows: num(db.prepare("SELECT COUNT(*) AS c FROM seed_stock").get().c),
      buyRows: num(db.prepare("SELECT COUNT(*) AS c FROM seed_buy_orders").get().c),
      liveOrders: num(db.prepare("SELECT COUNT(*) AS c FROM market_orders WHERE state = 'open'").get().c),
      fills: num(db.prepare("SELECT COUNT(*) AS c FROM market_fill_receipts").get().c),
      trades: num(db.prepare("SELECT COUNT(*) AS c FROM market_fill_receipts WHERE fill_quantity > 0").get().c),
      touched: num(db.prepare("SELECT COUNT(*) AS c FROM seed_stock WHERE quantity <> initial_quantity").get().c),
      historyDays: num(db.prepare("SELECT COUNT(DISTINCT day) AS c FROM price_history").get().c),
    };
    const last = db.prepare(
      "SELECT MAX(updated_at) AS at FROM (" +
        "SELECT updated_at FROM seed_stock UNION ALL " +
        "SELECT updated_at FROM market_orders UNION ALL " +
        "SELECT updated_at FROM region_summaries)"
    ).get();
    return {
      ok: true,
      path: dbPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      journalMode: text(db.prepare("PRAGMA journal_mode").get().journal_mode),
      region,
      systems: db.prepare(
        "SELECT solar_system_id, solar_system_name, security FROM solar_systems ORDER BY solar_system_id"
      ).all().map((row) => ({
        id: num(row.solar_system_id),
        name: text(row.solar_system_name),
        security: num(row.security),
      })),
      counts,
      lastChangeAt: text(last && last.at),
      manifest: manifestOf(db),
    };
  } finally {
    db.close();
  }
}

/** 分类树：被引用的市场组 + 它们的祖先；名字与父子关系来自 SDE */
function buildTree(db, sdeDir) {
  const used = new Set();
  for (const row of db.prepare("SELECT DISTINCT market_group_id AS id FROM market_types WHERE published = 1").all()) {
    used.add(num(row.id));
  }
  if (!sdeDir) return { tree: [], sde: false };

  const byId = new Map();
  for (const row of readJsonl(path.join(sdeDir, "marketGroups.jsonl"))) {
    const [zh, en] = zippedName(row);
    byId.set(num(row._key), {
      zh,
      en,
      parent: Number.isInteger(row.parentGroupID) ? row.parentGroupID : -1,
    });
  }

  const wanted = new Set();
  for (const id of used) {
    let cur = id;
    const seen = new Set();
    while (byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      wanted.add(cur);
      cur = byId.get(cur).parent;
    }
  }

  const tree = [...wanted]
    .sort((left, right) => left - right)
    .map((id) => [id, byId.get(id).parent, byId.get(id).zh, byId.get(id).en]);
  return { tree, sde: true };
}

function buildGroups(db, sdeDir) {
  const used = new Set();
  for (const row of db.prepare("SELECT DISTINCT group_id AS id FROM market_types WHERE published = 1").all()) {
    used.add(num(row.id));
  }
  if (!sdeDir) return [];
  const byId = new Map();
  for (const row of readJsonl(path.join(sdeDir, "groups.jsonl"))) {
    const [zh, en] = zippedName(row);
    byId.set(num(row._key), [zh, en]);
  }
  return [...used]
    .sort((left, right) => left - right)
    .map((id) => [id, (byId.get(id) || ["", ""])[0], (byId.get(id) || ["", ""])[1]]);
}

function buildCategories(db, sdeDir) {
  const used = new Set();
  for (const row of db.prepare("SELECT DISTINCT category_id AS id FROM market_types WHERE published = 1").all()) {
    used.add(num(row.id));
  }
  if (!sdeDir) return [];
  const byId = new Map();
  for (const row of readJsonl(path.join(sdeDir, "categories.jsonl"))) {
    const [zh, en] = zippedName(row);
    byId.set(num(row._key), [zh, en]);
  }
  return [...used]
    .sort((left, right) => left - right)
    .map((id) => [id, (byId.get(id) || ["", ""])[0], (byId.get(id) || ["", ""])[1]]);
}

/**
 * 全量目录 + 每个物品的**当前**最优卖价/买价与挂单量（region_summaries 由服务端随成交维护）。
 * 每行不下发 updated_at：19,352 条 × 30 字符会白占 0.5 MB，页面只关心最新的那一条（见 overview）。
 */
function catalog(root) {
  const { db, dbPath } = openMarketDb(root);
  try {
    const region = pickRegion(db);
    const rows = db.prepare(
      "SELECT t.type_id, t.market_group_id, t.group_id, t.category_id, t.name, " +
        "       t.base_price, t.volume, t.portion_size, " +
        "       r.best_ask_price, r.total_ask_quantity, r.best_ask_station_id, " +
        "       r.best_bid_price, r.total_bid_quantity, r.best_bid_station_id " +
        "  FROM market_types t " +
        "  LEFT JOIN region_summaries r " +
        "         ON r.type_id = t.type_id AND r.region_id = ? " +
        " WHERE t.published = 1 " +
        " ORDER BY t.type_id"
    ).all(region.id);

    const sdeDir = sdeDirOf(root);
    const { tree, sde } = buildTree(db, sdeDir);

    return {
      ok: true,
      path: dbPath,
      modifiedAt: fs.statSync(dbPath).mtimeMs,
      region,
      sde,
      stations: stationRows(db),
      tree,
      groups: buildGroups(db, sdeDir),
      categories: buildCategories(db, sdeDir),
      types: rows.map((row) => [
        num(row.type_id),
        num(row.market_group_id),
        num(row.group_id),
        num(row.category_id),
        text(row.name),
        num(row.base_price),
        num(row.volume),
        num(row.portion_size),
        row.best_ask_price == null ? null : num(row.best_ask_price),
        num(row.total_ask_quantity),
        row.best_ask_station_id == null ? null : num(row.best_ask_station_id),
        row.best_bid_price == null ? null : num(row.best_bid_price),
        num(row.total_bid_quantity),
        row.best_bid_station_id == null ? null : num(row.best_bid_station_id),
      ]),
    };
  } finally {
    db.close();
  }
}

/**
 * 单个物品的账本：每个空间站的库存（被买走的会少）、还没成交的玩家挂单、
 * 30 天价格史、以及这个物品的成交流水。选物品时调一次，数据量小（23 站 + 30 天）。
 */
function book(root, typeId) {
  const id = Number(typeId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("typeID 不合法：" + text(typeId));
  const { db, dbPath } = openMarketDb(root);
  try {
    const type = db.prepare(
      "SELECT type_id, market_group_id, group_id, category_id, name, group_name, base_price, volume, portion_size FROM market_types WHERE type_id = ?"
    ).get(id);
    if (!type) throw new Error("市场库里没有 typeID=" + id + " 的物品");

    const region = pickRegion(db);
    const summary = db.prepare(
      "SELECT best_ask_price, total_ask_quantity, best_ask_station_id, best_bid_price, total_bid_quantity, best_bid_station_id, updated_at " +
        "FROM region_summaries WHERE region_id = ? AND type_id = ?"
    ).get(region.id, id);

    const stock = db.prepare(
      "SELECT s.station_id, st.station_name, ss.solar_system_name, s.price, s.quantity, s.initial_quantity, s.updated_at " +
        "FROM seed_stock s " +
        "LEFT JOIN stations st ON st.station_id = s.station_id " +
        "LEFT JOIN solar_systems ss ON ss.solar_system_id = st.solar_system_id " +
        "WHERE s.type_id = ? ORDER BY s.price"
    ).all(id);

    const orders = db.prepare(
      "SELECT CAST(order_id AS TEXT) AS order_id, owner_id, station_id, price, vol_remaining, vol_entered, min_volume, bid, issued_at, state " +
        "FROM market_orders WHERE type_id = ? AND state = 'open' ORDER BY price"
    ).all(id);

    const history = db.prepare(
      "SELECT day, low_price, high_price, avg_price, volume, order_count FROM price_history WHERE type_id = ? ORDER BY day"
    ).all(id);

    const fills = db.prepare(
      "SELECT json_extract(response_json,'$.price') AS price, " +
        "       json_extract(response_json,'$.filled_quantity') AS quantity, " +
        "       json_extract(response_json,'$.station_id') AS station_id, " +
        "       json_extract(response_json,'$.bid') AS bid, created_at " +
        "FROM market_fill_receipts WHERE json_extract(response_json,'$.type_id') = ? " +
        "ORDER BY created_at DESC LIMIT 50"
    ).all(id);

    return {
      ok: true,
      path: dbPath,
      region,
      type: {
        typeId: num(type.type_id),
        mgId: num(type.market_group_id),
        groupId: num(type.group_id),
        catId: num(type.category_id),
        name: text(type.name),
        groupName: text(type.group_name),
        basePrice: num(type.base_price),
        volume: num(type.volume),
        portionSize: num(type.portion_size),
      },
      summary: summary
        ? {
            bestAsk: summary.best_ask_price == null ? null : num(summary.best_ask_price),
            askQty: num(summary.total_ask_quantity),
            askStation: summary.best_ask_station_id == null ? null : num(summary.best_ask_station_id),
            bestBid: summary.best_bid_price == null ? null : num(summary.best_bid_price),
            bidQty: num(summary.total_bid_quantity),
            bidStation: summary.best_bid_station_id == null ? null : num(summary.best_bid_station_id),
            updatedAt: text(summary.updated_at),
          }
        : null,
      stock: stock.map((row) => ({
        stationId: num(row.station_id),
        stationName: text(row.station_name),
        systemName: text(row.solar_system_name),
        price: num(row.price),
        quantity: num(row.quantity),
        initialQuantity: num(row.initial_quantity),
        updatedAt: text(row.updated_at),
      })),
      orders: orders.map((row) => ({
        orderId: text(row.order_id),
        ownerId: num(row.owner_id),
        stationId: num(row.station_id),
        price: num(row.price),
        volRemaining: num(row.vol_remaining),
        volEntered: num(row.vol_entered),
        minVolume: num(row.min_volume),
        bid: num(row.bid) === 1,
        issuedAt: text(row.issued_at),
      })),
      history: history.map((row) => ({
        day: text(row.day),
        low: num(row.low_price),
        high: num(row.high_price),
        avg: num(row.avg_price),
        volume: num(row.volume),
        orders: num(row.order_count),
      })),
      fills: fills.map((row) => ({
        at: text(row.created_at),
        price: num(row.price),
        quantity: num(row.quantity),
        stationId: num(row.station_id),
        bid: num(row.bid) === 1,
      })),
    };
  } finally {
    db.close();
  }
}

/** 全服最近成交：一句话回答「市场到底有没有在动」 */
function trades(root, limitArg) {
  const limit = Math.max(1, Math.min(200, Number(limitArg) || 40));
  const { db, dbPath } = openMarketDb(root);
  try {
    const rows = db.prepare(
      "SELECT r.created_at, " +
        "       json_extract(r.response_json,'$.type_id') AS type_id, " +
        "       json_extract(r.response_json,'$.price') AS price, " +
        "       json_extract(r.response_json,'$.filled_quantity') AS quantity, " +
        "       json_extract(r.response_json,'$.station_id') AS station_id, " +
        "       json_extract(r.response_json,'$.bid') AS bid " +
        "FROM market_fill_receipts r ORDER BY r.created_at DESC LIMIT ?"
    ).all(limit);

    const stationNames = new Map(stationRows(db).map((row) => [num(row.station_id), text(row.station_name)]));
    const names = new Map(
      db.prepare("SELECT type_id, name FROM market_types").all().map((row) => [num(row.type_id), text(row.name)])
    );

    return {
      ok: true,
      path: dbPath,
      rows: rows.map((row) => ({
        at: text(row.created_at),
        typeId: num(row.type_id),
        name: names.get(num(row.type_id)) || "",
        price: num(row.price),
        quantity: num(row.quantity),
        stationId: num(row.station_id),
        stationName: stationNames.get(num(row.station_id)) || "",
        bid: num(row.bid) === 1,
      })),
    };
  } finally {
    db.close();
  }
}

/* ------------------------- 简介 / 属性（悬停提示用） ------------------------- */

/**
 * SDE 里的简介与属性名都带 `{de,en,es,fr,ja,ko,ru,zh}` 八种语言，而启动器的界面语言里
 * **nl（荷兰语）不在其中** —— 一律退英文：宁可让荷兰用户看英文，也不能给他看中文。
 * 认不出的语言码同样退英文。
 */
const SDE_LANGS = ["zh", "en", "ja", "ko", "fr", "de", "ru", "es"];

function sdeLang(value) {
  const code = text(value).toLowerCase().split(/[-_]/)[0];
  return SDE_LANGS.includes(code) ? code : "en";
}

/** SDE 的本地化字段可能是 `{de,en,…}`，也可能已经是纯字符串 */
function localized(node, lang) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  return text(node[lang]) || text(node.en);
}

/**
 * 简介里带客户端标记（`<a href=showinfo:34>Tritanium</a>`、`<br>`、`&amp;`）——
 * 启动器里没有客户端的容器与路由，剥成纯文本：链接文字留下，标签与实体丢掉。
 */
function cleanDescription(value) {
  if (!value) return "";
  return text(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 一条加成：`[数值, 单位 id, 文字]`。
 *
 * - `bonus` 缺省（例如「可以安装拦截泡发射器」）表示这条只有文字，界面不画数字；
 * - 顺序按 SDE 的 `importance` 排 —— 游戏里就是这么排的：护盾值加成 15% 排在
 *   信号半径惩罚 10% 前面，而 SDE 数组里的顺序正好相反。
 */
function bonusEntries(list, lang) {
  const rows = (Array.isArray(list) ? list : [])
    .map((row) => {
      const value =
        row && typeof row.bonus === "number" && Number.isFinite(row.bonus) ? row.bonus : null;
      return {
        value,
        unit: value == null || row.unitID == null ? null : Number(row.unitID),
        label: cleanDescription(localized(row && row.bonusText, lang)),
        importance: Number(row && row.importance) || 0,
      };
    })
    .filter((row) => row.label);
  rows.sort((left, right) => left.importance - right.importance);
  return rows.map((row) => [row.value, row.unit, row.label]);
}

/** unitID=116 是「typeID」：属性值指向另一个物品（技能、弹药…），界面要显示名字而不是数字 */
const TYPE_REF_UNIT = 116;

function readJsonlFile(file) {
  return fs.existsSync(file) ? readJsonl(file) : [];
}

/**
 * 悬停提示用的索引：简介（SDE 的 `types.jsonl`）+ 属性（服务端静态表 `typeDogma` 的值、
 * SDE 的属性元数据与单位符号）。
 *
 * 为什么一次返回**整个市场目录**的索引（约 7 MB JSON）：悬停是毫秒级交互，而扫一遍
 * 144 MB 的 `types.jsonl` 要一秒多 —— 每次悬停起一个 node 进程去扫是等不起的。启动器侧
 * 拿到后常驻内存（按界面语言失效），之后每次悬停只是内存查表。不落任何磁盘产物。
 */
async function typeinfo(root, langArg) {
  const lang = sdeLang(langArg);
  const sde = sdeDirOf(root);
  if (!sde) {
    throw new Error(
      "未找到 SDE 目录：" + path.join(root, "_local", "sde") + "（简介与属性名都在 SDE 里）"
    );
  }

  // 1) 属性元数据：只留 published 且有名字的，口径与客户端 Attributes 页一致
  const meta = new Map();
  for (const row of readJsonlFile(path.join(sde, "dogmaAttributes.jsonl"))) {
    const id = Number(row && row._key);
    if (!id || row.published !== true) continue;
    const name = localized(row.displayName, lang) || text(row.name);
    if (!name) continue;
    meta.set(id, {
      name,
      unit: row.unitID == null ? null : Number(row.unitID),
      highIsGood: row.highIsGood === true,
      displayWhenZero: row.displayWhenZero === true,
      category: Number(row.attributeCategoryID) || 0,
    });
  }

  // 2) 单位符号与分类名：都用 SDE 原话，不自己编对照表
  const units = new Map();
  for (const row of readJsonlFile(path.join(sde, "dogmaUnits.jsonl"))) {
    const id = Number(row && row._key);
    const symbol = localized(row && row.displayName, lang) || localized(row && row.description, lang);
    if (id && symbol) units.set(id, symbol);
  }
  const categories = new Map();
  for (const row of readJsonlFile(path.join(sde, "dogmaAttributeCategories.jsonl"))) {
    const id = Number(row && row._key);
    if (id && text(row.name)) categories.set(id, text(row.name));
  }

  // 3) 只做在售物品：全量 2.6 万个类型里有一半不在市场上
  const { db } = openMarketDb(root);
  let marketIds;
  try {
    marketIds = new Set(
      db
        .prepare("SELECT type_id FROM market_types WHERE published = 1")
        .all()
        .map((row) => num(row.type_id))
    );
  } finally {
    db.close();
  }

  // 4) 每个物品的属性值（服务端自己的静态表：服务端升级后启动器不用跟着发版）
  const dogmaFile = path.join(root, "_local", "gameStore", "data", "typeDogma", "data.json");
  let dogma;
  try {
    dogma = JSON.parse(fs.readFileSync(dogmaFile, "utf8"));
  } catch {
    throw new Error("未找到服务端静态表：" + dogmaFile + "（属性值读它）");
  }
  const byType = (dogma && dogma.typesByTypeID) || {};
  const values = new Map();
  const referenced = new Set();
  let attributeRows = 0;
  for (const id of marketIds) {
    const entry = byType[String(id)];
    if (!entry || !entry.attributes) continue;
    const rows = [];
    for (const key of Object.keys(entry.attributes)) {
      const attributeId = Number(key);
      const info = meta.get(attributeId);
      if (!info) continue;
      const value = Number(entry.attributes[key]);
      if (!Number.isFinite(value)) continue;
      // 值为 0 且属性标了 displayWhenZero=false 的不列出来（与客户端同一条规则）
      if (value === 0 && !info.displayWhenZero) continue;
      if (info.unit === TYPE_REF_UNIT && value > 0) referenced.add(value);
      rows.push([attributeId, value]);
    }
    if (rows.length === 0) continue;
    // 先按分类、再按属性 id：界面拿到就能分组，不用自己再排一遍
    rows.sort(
      (left, right) =>
        meta.get(left[0]).category - meta.get(right[0]).category || left[0] - right[0]
    );
    values.set(id, rows);
    attributeRows += rows.length;
  }

  // 5) 加成（技能加成 / 特有加成）：SDE 的 typeBonus.jsonl 只有 650 种类型，整份读很快。
  //    技能名（「小型射弹炮台每升一级：」）也要一起给，所以技能 typeID 也进 referenced。
  const bonuses = new Map();
  for (const row of readJsonlFile(path.join(sde, "typeBonus.jsonl"))) {
    const id = Number(row && row._key);
    if (!id || !marketIds.has(id)) continue;
    const sections = [];
    for (const skill of Array.isArray(row.types) ? row.types : []) {
      const skillId = Number(skill && skill._key);
      const entries = bonusEntries(skill && skill._value, lang);
      if (!entries.length) continue;
      if (skillId) referenced.add(skillId);
      sections.push([skillId, entries]);
    }
    const role = bonusEntries(row.roleBonuses, lang);
    if (role.length) sections.push([0, role]);
    if (sections.length) bonuses.set(id, sections);
  }

  // 6) 简介 + 「值指向的类型」的名字：流式扫 types.jsonl（144 MB，别整份读进内存）
  const descriptions = new Map();
  const names = new Map();
  await new Promise((resolve, reject) => {
    const reader = readline.createInterface({
      input: fs.createReadStream(path.join(sde, "types.jsonl")),
      crlfDelay: Infinity,
    });
    reader.on("line", (line) => {
      if (!line || (line.indexOf('"description"') < 0 && line.indexOf('"name"') < 0)) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return;
      }
      const id = Number(row && row._key);
      if (!id) return;
      if (marketIds.has(id)) {
        const brief = cleanDescription(localized(row.description, lang));
        if (brief) descriptions.set(id, brief);
      }
      if (referenced.has(id)) {
        const name = localized(row.name, lang);
        if (name) names.set(id, name);
      }
    });
    reader.on("close", resolve);
    reader.on("error", reject);
  });

  return {
    ok: true,
    lang,
    sde: path.basename(sde),
    counts: {
      marketTypes: marketIds.size,
      described: descriptions.size,
      attributed: values.size,
      attributeRows,
      bonused: bonuses.size,
      referencedTypes: names.size,
    },
    units: Object.fromEntries(units),
    categories: Object.fromEntries(categories),
    attributes: Object.fromEntries(
      [...meta].map(([id, info]) => [
        id,
        { name: info.name, unit: info.unit, highIsGood: info.highIsGood, category: info.category },
      ])
    ),
    types: Object.fromEntries(values),
    descriptions: Object.fromEntries(descriptions),
    names: Object.fromEntries(names),
    bonuses: Object.fromEntries(bonuses),
  };
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  const root = rootOf(repoRootArg);
  switch (cmd) {
    case "overview":
      return overview(root);
    case "catalog":
      return catalog(root);
    case "book":
      return book(root, arg1);
    case "trades":
      return trades(root, arg1);
    case "typeinfo":
      return typeinfo(root, arg1);
    default:
      throw new Error("未知子命令：" + text(cmd));
  }
}

// 预期的失败（库不存在 / SDE 不在 / typeID 不合法）也走 ok:false，让界面能显示原因；
// 退出码保持 0，避免 sidecar 把它当成崩溃并丢掉 reason。typeinfo 要流式读 SDE，所以是异步。
main().then(
  (result) => process.stdout.write(JSON.stringify(result)),
  (error) =>
    process.stdout.write(JSON.stringify({ ok: false, reason: String((error && error.message) || error) }))
);
