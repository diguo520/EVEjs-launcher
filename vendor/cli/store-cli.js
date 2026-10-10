#!/usr/bin/env node
"use strict";
/**
 * 新伊甸商城（服务端 `newEdenStore` 权威数据）侧车。
 *
 * 为什么是侧车而不是重写进 Rust：商品目录的形状、PLEX 定价、发货规则（fulfillment）、
 * 整棵写盘与缓存失效全都在服务端 `server/src/services/newEdenStore/storeState.js` 里。
 * 启动器只做「整棵读出来 / 整棵写回去」的搬运 —— 抄一份进 Rust 等于制造第二套真相，
 * 服务端升版必然漂移。
 *
 * 用法（都由启动器调用，不面向用户）：
 *   node store-cli.js snapshot --root <服务端根目录>
 *   node store-cli.js save     --root <服务端根目录>   # 走 stdin: {"authority":{...}}
 *   node store-cli.js item-lookup --root <服务端根目录>  # 走 stdin: {"typeIDs":[42685,...]}
 *     → 上架新商品时用：校验 typeID 在不在服务端物品库里，并解析它的客户端图标路径。
 *       图标规则来自实测：imageUrl = itemIcons.iconsByID[itemTypes[typeID].iconID]，
 *       iconID 为 null 的物品在客户端里没有图标（游戏内会画问号占位），要如实告知。
 *
 * 约定：
 *   · 无论成功失败都以退出码 0 结束，结论写在 stdout 的 JSON 里（ok / supported / reason），
 *     免得 Rust 侧把「这个服务端没有商城」和「node 崩了」混成一种错误。
 *   · `saveEditorAuthority` 是**整棵覆盖** `newEdenStore` 表，所以写回必须是
 *     「快照原样 + 改过的字段」，不能只送差异。
 *   · 服务在跑时**由启动器侧拒绝写**（服务端进程自己持有商城缓存并会对同一张表写入，
 *     购买结算会追加流水），侧车不做这个判断 —— 它看不到服务状态。
 *   · 写要**声明离线维护角色**：gameStore 按「进程角色」放行写入（server/src/gameStore/
 *     persistenceRoles.js），未标注的进程一律是 reader，只能读。newEdenStore 的 durable
 *     owner 是 world，而同一份文件把 maintenance 列进了 UNRESTRICTED_ROLES，注释也写明
 *     「admin/reporting code must opt into a maintenance role before it can mutate durable
 *     state」—— 离线维护工具正是这条闸门留的口子。角色在模块加载时读取，所以必须在
 *     require 之前设好。
 *   · 写完之后显式交还 owner 租约：maintenance 工具不装 process 级关闭钩子
 *     （见服务端 ownerProcessShutdown.js 的注释），不显式释放的话租约要等到期
 *     （默认 30 秒）才回收，会把下一次服务端启动拖慢。
 */
const fs = require("fs");
const path = require("path");

const AUTHORITY_TABLE = "newEdenStore";
const RUNTIME_TABLE = "newEdenStoreRuntime";

/**
 * 服务端的 logger 是直接往 **stdout** 写的（例如
 * `19:45:09  DB   acquired persistence owner maintenance epoch=1 …`）。
 * 侧车的协议是「stdout 上**只有一份 JSON**」，被日志混进去 Rust 侧就解析失败，
 * 报成「商城侧车返回的不是 JSON」。
 *
 * 这里不依赖服务端 logger 的内部实现（它没有关日志/改流向的开关，模块路径也不固定），
 * 而是把**整个进程**的 stdout 转发到 stderr，自己只留一个原始 stdout 的引用发结论 ——
 * 这样无论日志什么时候冒出来都污染不到协议。读路径（reader 角色）本来不写日志，
 * 只有写路径会触发 owner 租约日志，所以这个坑是写通路才暴露的。
 */
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function writeToStderr(chunk, encoding, callback) {
  return process.stderr.write(chunk, encoding, callback);
};

function emit(payload) {
  rawStdoutWrite(JSON.stringify(payload));
}

/** 有服务端，但这次调用失败了（用法错误 / 数据坏了） */
function fail(reason) {
  emit({ ok: false, supported: true, reason: String(reason) });
}

/** 这台机器的服务端根本没有商城这套东西 */
function unsupported(reason) {
  emit({ ok: false, supported: false, reason: String(reason) });
}

function parseArgs(argv) {
  const result = { command: argv[0] || "", root: "" };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      result.root = argv[i + 1] || "";
      i += 1;
    }
  }
  return result;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    return "";
  }
}

/**
 * 载入服务端的商城模块。侧车是随包分发的，只有「宿主项目自己的 node_modules」可用，
 * 所以路径全部按 --root 拼，不 require 启动器自己的依赖。
 */
function loadStoreState(root) {
  if (!root) {
    return { error: "缺少 --root（服务端根目录）" };
  }
  const statePath = path.join(root, "server", "src", "services", "newEdenStore", "storeState.js");
  if (!fs.existsSync(statePath)) {
    return { missing: statePath };
  }
  // 商城目录的 PLEX 换算要用到配置系统；配置初始化失败不该挡住建读，
  // 但写回时拿不到 centsPerPlex 会把定价算错，所以那种情况单独报错。
  let config = null;
  try {
    config = require(path.join(root, "server", "src", "config"));
    if (typeof config.initializeConfigFiles === "function") {
      config.initializeConfigFiles();
    }
  } catch (error) {
    config = null;
  }
  try {
    return { state: require(statePath), config };
  } catch (error) {
    return { error: `载入服务端商城模块失败：${(error && error.message) || error}` };
  }
}

/**
 * 物品库（`itemTypes` + `itemIcons`）在数据根下，不在 SQLite 里，而且有两万多个 typeID：
 * 只在 item-lookup 时按需加载，不让快照背上这个开销。
 * 数据根走服务端自己的解析器（`server/src/config/dataRoot.js`），这样 `EVEJS_DATA_ROOT`
 * 被改过也能对上。
 */
function loadItemCatalog(root) {
  let dataDir = "";
  try {
    const dataRoot = require(path.join(root, "server", "src", "config", "dataRoot.js"));
    dataDir = dataRoot.resolveDataRootPath("gameStore", "data");
  } catch (error) {
    dataDir = path.join(root, "_local", "gameStore", "data");
  }
  const typesPath = path.join(dataDir, "itemTypes", "data.json");
  const iconsPath = path.join(dataDir, "itemIcons", "data.json");
  if (!fs.existsSync(typesPath)) {
    return { error: `找不到服务端物品库：${typesPath}` };
  }
  let types = [];
  let icons = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(typesPath, "utf8"));
    types = Array.isArray(parsed?.types) ? parsed.types : [];
    if (fs.existsSync(iconsPath)) {
      icons = JSON.parse(fs.readFileSync(iconsPath, "utf8"))?.iconsByID || {};
    }
  } catch (error) {
    return { error: `读取服务端物品库失败：${(error && error.message) || error}` };
  }
  return { types, icons };
}

function commandItemLookup(root, rawStdin) {
  const catalog = loadItemCatalog(root);
  if (catalog.error) {
    return fail(catalog.error);
  }

  let payload = null;
  try {
    payload = JSON.parse(rawStdin || "");
  } catch (error) {
    return fail(`stdin 不是合法 JSON：${(error && error.message) || error}`);
  }
  const requested = Array.isArray(payload && payload.typeIDs) ? payload.typeIDs : [];
  if (requested.length === 0) {
    return fail("stdin 里缺少 typeIDs 数组");
  }

  const byTypeID = new Map();
  for (const row of catalog.types) {
    byTypeID.set(Number(row && row.typeID), row);
  }

  const items = requested.map((raw) => {
    const typeID = Number(raw);
    const record = Number.isFinite(typeID) ? byTypeID.get(typeID) : null;
    if (!record) {
      return { typeID, known: false, name: "", groupName: "", iconID: null, imageUrl: "" };
    }
    const iconID = record.iconID === null || record.iconID === undefined ? null : Number(record.iconID);
    const imageUrl = iconID === null ? "" : String(catalog.icons[String(iconID)] || "");
    return {
      typeID,
      known: true,
      name: String(record.name || ""),
      groupName: String(record.groupName || ""),
      categoryID: record.categoryID ?? null,
      iconID,
      imageUrl,
    };
  });

  // iconsByID["0"] 是客户端「没有图标」时的占位路径 —— 实测 Sunesis / Drake 的 imageUrl
  // 就是它，游戏里画问号/斜叉。界面拿它区分「已知能显示的图」与占位符。
  emit({
    ok: true,
    supported: true,
    placeholderImageUrl: String(catalog.icons["0"] || ""),
    items,
  });
}

function countKeys(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return Object.keys(value).length;
}

function countList(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 给界面用的摘要。**权威数据本身不在这里裁剪** —— 调用方拿到的是整棵 authority，
 * 因为它要原样写回去。摘要只回答「大概有多少东西」，界面不必自己遍历。
 */
function buildSummary(authority, runtime) {
  const stores = (authority && authority.stores) || {};
  const legacyOfferCount = Object.values(stores).reduce(
    (total, store) => total + countList(store && store.offers),
    0,
  );
  const fastCheckout = (authority && authority.fastCheckout) || {};
  const completed = (runtime && runtime.completedPurchases) || {};
  return {
    stores: countKeys(stores),
    publicOffers: countKeys(authority && authority.publicOffers),
    legacyOffers: legacyOfferCount,
    fastCheckoutOffers: countList(fastCheckout.offers),
    quickPayTokens: countKeys(fastCheckout.tokensByID),
    completedPurchases: countKeys(completed),
    purchaseLogEntries: countList(runtime && runtime.purchaseLog),
    runtimeAccounts: countKeys(runtime && runtime.accounts),
  };
}

/** 权威数据整棵 + 摘要 + 配置，供界面渲染与「原样写回」 */
function buildSnapshot(loaded) {
  const snapshot = loaded.state.getEditorSnapshot();
  const config = loaded.state.getStoreConfig ? loaded.state.getStoreConfig() : null;
  return {
    ok: true,
    supported: true,
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    authorityTable: AUTHORITY_TABLE,
    runtimeTable: RUNTIME_TABLE,
    summary: buildSummary(snapshot.authority, snapshot.runtime),
    config,
    authority: snapshot.authority,
  };
}

function commandSnapshot(root) {
  const loaded = loadStoreState(root);
  if (loaded.missing) {
    return unsupported(`这个服务端没有 ${path.relative(root, loaded.missing)}，读不到商城目录`);
  }
  if (loaded.error) {
    return fail(loaded.error);
  }
  try {
    emit(buildSnapshot(loaded));
  } catch (error) {
    fail(`读商城失败：${(error && error.message) || error}`);
  }
}

/**
 * 交还 owner 租约：把脏表刷盘、停掉持久化 worker、释放租约。
 * 释放失败不该把「已经写成功」报成失败 —— 租约到期会自然回收。
 */
async function releaseOwnerLease(root) {
  try {
    const database = require(path.join(root, "server", "src", "gameStore"));
    if (typeof database.shutdown === "function") {
      const result = await database.shutdown("store-cli:save");
      return result ? result.released !== false : false;
    }
  } catch (error) {
    return false;
  }
  return false;
}

async function commandSave(root, rawStdin) {
  // 必须赶在 loadStoreState 之前：gameStore 在模块加载时就把角色固化了
  if (!process.env.EVEJS_GAMESTORE_OWNER_ROLE) {
    process.env.EVEJS_GAMESTORE_OWNER_ROLE = "maintenance";
  }
  const loaded = loadStoreState(root);
  if (loaded.missing) {
    return unsupported(`这个服务端没有 ${path.relative(root, loaded.missing)}，写不了商城目录`);
  }
  if (loaded.error) {
    return fail(loaded.error);
  }

  let payload = null;
  try {
    payload = JSON.parse(rawStdin || "");
  } catch (error) {
    return fail(`stdin 不是合法 JSON：${(error && error.message) || error}`);
  }
  const authority = payload && payload.authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    return fail("stdin 里缺少 authority 对象");
  }
  // 整棵覆盖前先做一次形状自检：把 meta/stores 丢掉会把商城写空，
  // 那种损坏在界面上看不见，只能在这里挡住。
  for (const key of ["meta", "stores"]) {
    if (!authority[key] || typeof authority[key] !== "object" || Array.isArray(authority[key])) {
      return fail(`authority.${key} 缺失或不是对象，拒绝整棵覆盖（会把商城写空）`);
    }
  }

  let result = null;
  try {
    result = loaded.state.saveEditorAuthority(authority);
  } catch (error) {
    fail(`写商城失败：${(error && error.message) || error}`);
    return;
  }
  const ownerLeaseReleased = await releaseOwnerLease(root);
  emit({
    ok: true,
    supported: true,
    savedAt: new Date().toISOString(),
    ownerLeaseReleased,
    summary: buildSummary(result.authority, result.runtime),
    authority: result.authority,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "snapshot":
      commandSnapshot(args.root);
      break;
    case "save":
      await commandSave(args.root, readStdin());
      break;
    case "item-lookup":
      commandItemLookup(args.root, readStdin());
      break;
    default:
      // 用法错误是「这个侧车不支持」，不是「服务端不支持」—— 但两者都要 ok:false
      fail(`未知命令：${args.command || "(空)"}；可用：snapshot / save / item-lookup`);
      break;
  }
}

main().catch((error) => {
  fail(`侧车异常：${(error && error.message) || error}`);
});
