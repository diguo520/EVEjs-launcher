//! 静态数据热重载：把 `_local/gameStore/data/<表>/data.json` 的改动直接送进**正在运行**的
//! 服务端进程内存，不用停服、玩家不掉线。
//!
//! 为什么需要它：服务端启动时 `preloadAll()` 把所有表读进内存，之后只读内存
//! （`index.js` L1208 第一行 `if (preloaded) return`）。改文件不重启，游戏里看不到。
//!
//! 怎么做到的：启动器把 [`HOST_JS`] 写进 `_launcher/hotreload/host.js`，再通过
//! `NODE_OPTIONS=--require` 注入主服务器。host 只在真正的服务端入口进程里挂牌，
//! 收到请求后用服务端**自己的公开 API**（`gameStore.write(table, "/", data)`）整表覆盖内存副本，
//! 再清掉上位读缓存（`referenceData.clearReferenceCache` / `skillState.refreshSkillReference`）。
//! 服务端源码一个字节都不改，和模组注入总线（mod-host.js）互不干扰。
//!
//! 安全边界：
//!   - 拒绝 `SQLITE_TABLES` 里的运行时表 —— 那份缓存就是活的世界状态；
//!   - 坏 JSON 在 host 里就被拦下，内存里的旧副本保持不动；
//!   - 装不了 host（写盘失败 / 目录不是服务端）时整条链路安静降级，界面如实说明；
//!   - `EVEJS_HOTRELOAD=0` 可整体关闭。
//!
//! 请求与结果都走文件（`request.json` → `result.json`），不开监听端口。

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::runtime::RuntimePaths;

/// 编译期嵌进二进制的注入宿主（`_launcher/hotreload/host.js`）
pub(crate) const HOST_JS: &str = include_str!("host.js");
const HOST_FILE: &str = "host.js";
const BOOT_FILE: &str = "boot.json";
const SESSION_FILE: &str = "session.json";
const REQUEST_FILE: &str = "request.json";
const PROCESSING_FILE: &str = "request.processing.json";
const RESULT_FILE: &str = "result.json";
const BASELINE_FILE: &str = "baseline.json";
const SNAPSHOT_DIR: &str = "snapshots";
/// 保留多少份「重载前快照」
const MAX_SNAPSHOTS: usize = 10;
/// 写请求后等 host 回结果的上限：全量重载含 246MB 的 celestials，给足余量
const APPLY_TIMEOUT: Duration = Duration::from_secs(300);
/// 轮询间隔
const POLL_MS: u64 = 200;

/// 「改了必须重启主服务器才生效」的静态表。
///
/// 判定口径不是猜的：把服务端 `src/**` 里所有「模块级缓存 + 读静态表」的模块扫一遍，
/// 逐个看它有没有导出 `clear* / reset* / refresh*` 之类的重置入口。
/// - 有入口的表，host 会在重载时调用（见 host.js 的 DERIVED_RESETS），属于「即时生效」；
/// - 一个入口都没有的表，那份派生索引就永远停留在启动时的快照上 —— 列在这里。
///
/// `owners` 只是给界面解释「为什么」，取冻结它的模块名（可能不止一个）。
struct FrozenTable {
    name: &'static str,
    owners: &'static str,
}

const FROZEN_TABLES: [FrozenTable; 25] = [
    FrozenTable {
        name: "solarSystems",
        owners: "worldData / mapService / configService",
    },
    FrozenTable {
        name: "stations",
        owners: "worldData / configService / agentMissionRuntime",
    },
    FrozenTable {
        name: "stationTypes",
        owners: "worldData",
    },
    FrozenTable {
        name: "stargates",
        owners: "worldData / gateSkinCommand / configService",
    },
    FrozenTable {
        name: "stargateTypes",
        owners: "worldData / gateSkinCommand",
    },
    FrozenTable {
        name: "celestials",
        owners: "worldData / planetMgrService / configService",
    },
    FrozenTable {
        name: "asteroidBelts",
        owners: "worldData / asteroidData / configService",
    },
    FrozenTable {
        name: "moonMiningPoints",
        owners: "worldData",
    },
    FrozenTable {
        name: "movementAttributes",
        owners: "worldData",
    },
    FrozenTable {
        name: "itemTypes",
        owners: "itemTypeRegistry / liveFittingState / configService 等 10 处",
    },
    FrozenTable {
        name: "typeDogma",
        owners: "liveFittingState / dogmaService / skillTradingAuthority 等 6 处",
    },
    FrozenTable {
        name: "shipDogmaAttributes",
        owners: "liveFittingState",
    },
    FrozenTable {
        name: "shipTypes",
        owners: "wreckRadius / shipTypeRegistry",
    },
    FrozenTable {
        name: "dynamicItemAttributes",
        owners: "dynamicItemService",
    },
    FrozenTable {
        name: "skillTypes",
        owners: "weaponDogma / certificateRuntime",
    },
    FrozenTable {
        name: "skillTrainingAlphaCaps",
        owners: "skillCloneRestrictions",
    },
    FrozenTable {
        name: "npcProfiles",
        owners: "miningNpcCatalog / empireSecurityNpcCatalog",
    },
    FrozenTable {
        name: "npcLoadouts",
        owners: "miningNpcCatalog / empireSecurityNpcCatalog",
    },
    FrozenTable {
        name: "npcSpawnPools",
        owners: "miningNpcCatalog",
    },
    FrozenTable {
        name: "npcSpawnGroups",
        owners: "empireSecurityNpcCatalog",
    },
    FrozenTable {
        name: "structureTypes",
        owners: "structureState",
    },
    FrozenTable {
        name: "shipCosmeticsCatalog",
        owners: "shipCosmeticsState",
    },
    FrozenTable {
        name: "asteroidFieldStyles",
        owners: "asteroidData",
    },
    FrozenTable {
        name: "asteroidTypesBySolarSystemID",
        owners: "miningVisuals",
    },
    FrozenTable {
        name: "clientEntityStandings",
        owners: "clientEntityStandings",
    },
];

/// 太空场景几何：这几张表还额外决定「已经在跑的星系」里有什么，光重载内存副本不够，
/// 得等场景重建（玩家跳出去再进来）或直接重启主服务器。
const SCENE_TABLES: [&str; 6] = [
    "celestials",
    "asteroidBelts",
    "moonMiningPoints",
    "stargates",
    "stations",
    "solarSystems",
];

fn frozen_table(name: &str) -> Option<&'static FrozenTable> {
    FROZEN_TABLES.iter().find(|entry| entry.name == name)
}

fn epoch_ms() -> u128 {
    crate::mods::pkg::epoch_ms()
}

/// 热重载工作目录：`_launcher/hotreload/`
pub fn dir(runtime: &RuntimePaths) -> PathBuf {
    runtime.root.join("hotreload")
}

fn data_dir(root: &Path) -> PathBuf {
    root.join("_local").join("gameStore").join("data")
}

/// 这个仓库根目录看起来是不是 EveJS 服务端（没有 gameStore 就不注入，避免误伤）
pub fn server_has_gamestore(root: &Path) -> bool {
    root.join("server")
        .join("src")
        .join("gameStore")
        .join("index.js")
        .is_file()
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, format!("{text}\n"))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn file_stamp(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

/// 主服务器启动前调用：写 host.js 与 boot.json，返回要塞进 `NODE_OPTIONS` 的
/// `--require "<...>"` 参数（正斜杠 + 双引号，NODE_OPTIONS 的转义要求）。
///
/// 任何一步失败都返回 None：注入不能因为启动器临时目录写不进去就拖垮服务端启动。
pub fn prepare(runtime: &RuntimePaths, root: &Path) -> Option<String> {
    if !server_has_gamestore(root) {
        return None;
    }
    let dir = dir(runtime);
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(dir.join(HOST_FILE), HOST_JS).ok()?;
    // 上一轮的请求 / 结果必须清掉：新进程不该读到旧请求，启动器也不该读到旧结果
    for name in [REQUEST_FILE, PROCESSING_FILE, RESULT_FILE, SESSION_FILE] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    let boot_id = format!("{}-{}", epoch_ms(), std::process::id());
    write_json(
        &dir.join(BOOT_FILE),
        &json!({
            "bootId": boot_id,
            "root": root.to_string_lossy().replace('\\', "/"),
            "startedAt": epoch_ms() as u64,
        }),
    )
    .ok()?;
    Some(format!(
        "--require \"{}\"",
        dir.join(HOST_FILE).to_string_lossy().replace('\\', "/")
    ))
}

/// 主服务器进程要拿到的环境变量：host 就是从它找到请求目录的
pub fn env_dir(runtime: &RuntimePaths) -> String {
    dir(runtime).to_string_lossy().to_string()
}

fn boot_id(runtime: &RuntimePaths) -> Option<String> {
    read_json(&dir(runtime).join(BOOT_FILE))?
        .get("bootId")?
        .as_str()
        .map(str::to_string)
}

/// 服务端是不是「这一轮由启动器带 host 起来的」。
pub fn armed(runtime: &RuntimePaths) -> bool {
    let Some(boot) = boot_id(runtime) else {
        return false;
    };
    match read_json(&dir(runtime).join(SESSION_FILE)) {
        Some(session) => session.get("bootId").and_then(Value::as_str) == Some(boot.as_str()),
        None => false,
    }
}

/* ------------------------------ 表清单 ------------------------------ */

/// 从服务端 `gameStore/index.js` 里解析 `SQLITE_TABLES`（运行时表）。
///
/// 为什么解析文本而不是 require 服务端模块：启动器进程里 require 游戏的 gameStore
/// 会以 `reader` 角色把它缓存进 require.cache，属于副作用；而这份名单只是用来过滤界面。
/// 解析结果少于 20 条时一律当**解析失败**处理（宁可不出清单，也不能把运行时表当成
/// 可热重载的静态表 —— 那等于用磁盘旧副本覆盖玩家数据）。
fn sqlite_tables(root: &Path) -> Option<BTreeSet<String>> {
    let text = std::fs::read_to_string(
        root.join("server")
            .join("src")
            .join("gameStore")
            .join("index.js"),
    )
    .ok()?;
    let marker = "SQLITE_TABLES = new Set([";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let end = rest.find("]);")?;
    let block = &rest[..end];
    let mut set = BTreeSet::new();
    let mut chars = block.split('"');
    let _ = chars.next();
    for candidate in chars.step_by(2) {
        let name = candidate.trim();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            set.insert(name.to_string());
        }
    }
    if set.len() < 20 {
        return None;
    }
    Some(set)
}

/// 一条静态表的界面读数。
fn table_entry(name: &str, file: &Path) -> Value {
    let (size, mtime) = file_stamp(file).unwrap_or((0, 0));
    let frozen = frozen_table(name);
    json!({
        "name": name,
        "path": file.to_string_lossy().replace('\\', "/"),
        "sizeBytes": size,
        "mtimeMs": mtime,
        "needsRestart": frozen.is_some(),
        "sceneBound": SCENE_TABLES.contains(&name),
        "frozenBy": frozen.map(|entry| entry.owners).unwrap_or(""),
        "dirty": false,
    })
}

fn list_static_tables(root: &Path) -> (Vec<Value>, usize) {
    let Some(sqlite) = sqlite_tables(root) else {
        return (Vec::new(), 0);
    };
    let dir = data_dir(root);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return (Vec::new(), 0);
    };
    let mut runtime_count = 0usize;
    let mut tables = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let file = entry.path().join("data.json");
        if !file.is_file() {
            continue;
        }
        if sqlite.contains(&name) {
            runtime_count += 1;
            continue;
        }
        tables.push(table_entry(&name, &file));
    }
    tables.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or("")
            .cmp(right["name"].as_str().unwrap_or(""))
    });
    (tables, runtime_count)
}

/// 基线：每张表上一次「已被服务端吃进去」的 mtime / 大小。变了就是脏表。
fn load_baseline(runtime: &RuntimePaths, tables: &mut [Value]) {
    let path = dir(runtime).join(BASELINE_FILE);
    let current_boot = boot_id(runtime).unwrap_or_default();
    let stored = read_json(&path);
    let usable = stored
        .as_ref()
        .and_then(|value| value.get("bootId"))
        .and_then(Value::as_str)
        .map(|value| value == current_boot)
        .unwrap_or(false);
    if !usable {
        save_baseline(runtime, tables);
        return;
    }
    let map = stored
        .as_ref()
        .and_then(|value| value.get("tables"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    for table in tables.iter_mut() {
        let name = table["name"].as_str().unwrap_or("").to_string();
        let known = map.get(&name);
        let same = match known {
            Some(entry) => {
                entry.get("mtimeMs").and_then(Value::as_i64) == table["mtimeMs"].as_i64()
                    && entry.get("sizeBytes").and_then(Value::as_u64) == table["sizeBytes"].as_u64()
            }
            None => false,
        };
        table["dirty"] = json!(!same);
    }
}

fn save_baseline(runtime: &RuntimePaths, tables: &[Value]) {
    let mut map = serde_json::Map::new();
    for table in tables {
        if let Some(name) = table["name"].as_str() {
            map.insert(
                name.to_string(),
                json!({
                    "mtimeMs": table["mtimeMs"],
                    "sizeBytes": table["sizeBytes"],
                }),
            );
        }
    }
    let _ = write_json(
        &dir(runtime).join(BASELINE_FILE),
        &json!({
            "bootId": boot_id(runtime).unwrap_or_default(),
            "updatedAt": epoch_ms() as u64,
            "tables": Value::Object(map),
        }),
    );
}

/* ------------------------------ 状态 ------------------------------ */

/// 给界面的总状态：能不能用、有哪些表、上次重载结果、快照列表。
pub fn state(root: &Path, runtime: &RuntimePaths, server_pid: Option<u32>) -> Value {
    let supported = server_has_gamestore(root);
    let (mut tables, runtime_count) = list_static_tables(root);
    let session = read_json(&dir(runtime).join(SESSION_FILE));
    let session_pid = session
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(Value::as_u64);
    let session_boot = session
        .as_ref()
        .and_then(|value| value.get("bootId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let current_boot = boot_id(runtime);
    // 「已激活」= 这一轮服务端启动时写了 boot.json，host 挂牌的 bootId 与它一致，
    // 且 pid 正是启动器现在看着的主服务器进程。
    let pid_matches = match (session_pid, server_pid) {
        (Some(left), Some(right)) => left == right as u64,
        _ => false,
    };
    let is_armed =
        supported && session_boot.is_some() && session_boot == current_boot && pid_matches;
    if supported {
        load_baseline(runtime, &mut tables);
    }
    let dirty_count = tables
        .iter()
        .filter(|table| table["dirty"].as_bool().unwrap_or(false))
        .count();
    json!({
        "ok": true,
        "supported": supported,
        "armed": is_armed,
        "bootId": current_boot,
        "serverPid": server_pid,
        "sessionPid": session_pid,
        "sessionBootId": session_boot,
        "dir": dir(runtime).to_string_lossy(),
        "dataDir": data_dir(root).to_string_lossy(),
        "sqliteRuntimeTables": runtime_count,
        "frozenCount": FROZEN_TABLES.len(),
        "frozenTables": FROZEN_TABLES
            .iter()
            .map(|entry| json!({
                "name": entry.name,
                "owners": entry.owners,
                "scene": SCENE_TABLES.contains(&entry.name),
            }))
            .collect::<Vec<Value>>(),
        "dirtyCount": dirty_count,
        "tables": tables,
        "last": read_json(&dir(runtime).join(RESULT_FILE)),
        "snapshots": snapshots(runtime),
    })
}

/* ------------------------------ 快照 ------------------------------ */

fn snapshot_root(runtime: &RuntimePaths) -> PathBuf {
    dir(runtime).join(SNAPSHOT_DIR)
}

fn snapshots(runtime: &RuntimePaths) -> Vec<Value> {
    let root = snapshot_root(runtime);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut list: Vec<Value> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| read_json(&entry.path().join("meta.json")))
        .collect();
    list.sort_by(|left, right| {
        right["at"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&left["at"].as_i64().unwrap_or(0))
    });
    list
}

fn make_snapshot(root: &Path, runtime: &RuntimePaths, tables: &[String]) -> Option<String> {
    if tables.is_empty() {
        return None;
    }
    let id = format!("{}", epoch_ms());
    let target = snapshot_root(runtime).join(&id);
    std::fs::create_dir_all(&target).ok()?;
    let mut saved = Vec::new();
    for table in tables {
        let from = data_dir(root).join(table).join("data.json");
        if !from.is_file() {
            continue;
        }
        std::fs::copy(&from, target.join(format!("{table}.json"))).ok()?;
        saved.push(table.clone());
    }
    write_json(
        &target.join("meta.json"),
        &json!({
            "id": id,
            "at": epoch_ms() as u64,
            "bootId": boot_id(runtime).unwrap_or_default(),
            "tables": saved,
        }),
    )
    .ok()?;
    prune_snapshots(runtime);
    Some(id)
}

fn prune_snapshots(runtime: &RuntimePaths) {
    let mut list = snapshots(runtime);
    if list.len() <= MAX_SNAPSHOTS {
        return;
    }
    for stale in list.split_off(MAX_SNAPSHOTS) {
        if let Some(id) = stale["id"].as_str() {
            let _ = std::fs::remove_dir_all(snapshot_root(runtime).join(id));
        }
    }
}

/* ------------------------------ 发起重载 ------------------------------ */

/// 把请求交给 host 并等结果。
pub async fn apply(
    root: &Path,
    runtime: &RuntimePaths,
    tables: Option<Vec<String>>,
    with_snapshot: bool,
) -> Value {
    if !server_has_gamestore(root) {
        return json!({
            "ok": false,
            "supported": false,
            "reason": "这台机器的服务端没有 gameStore，静态数据热重载不可用",
        });
    }
    if !armed(runtime) {
        return json!({
            "ok": false,
            "supported": true,
            "armed": false,
            "reason": "当前主服务器不是由本启动器启动的，无法热重载。请在启动器的「主控台」里启动主服务器。",
        });
    }
    let Some(boot) = boot_id(runtime) else {
        return json!({ "ok": false, "supported": true, "reason": "读不到本轮启动标记（boot.json）" });
    };

    // 表清单：不给就整库静态表
    let (listed, _) = list_static_tables(root);
    let available: Vec<String> = listed
        .iter()
        .filter_map(|table| table["name"].as_str().map(str::to_string))
        .collect();
    let targets: Vec<String> = match &tables {
        Some(requested) if !requested.is_empty() => requested
            .iter()
            .map(|name| name.trim().to_string())
            .filter(|name| available.contains(name))
            .collect(),
        _ => available.clone(),
    };
    if targets.is_empty() {
        return json!({ "ok": false, "supported": true, "reason": "没有可重载的静态表" });
    }

    let snapshot_id = if with_snapshot {
        make_snapshot(root, runtime, &targets)
    } else {
        None
    };

    let request_id = format!("{}-{}", epoch_ms(), std::process::id());
    let dir = dir(runtime);
    if std::fs::create_dir_all(&dir).is_err() {
        return json!({ "ok": false, "supported": true, "reason": "写不进启动器运行时目录" });
    }
    let request = json!({
        "api": 1,
        "requestId": request_id,
        "bootId": boot,
        "tables": targets,
        "snapshotId": snapshot_id,
        "requestedAt": epoch_ms() as u64,
    });
    if write_json(&dir.join(REQUEST_FILE), &request).is_err() {
        return json!({ "ok": false, "supported": true, "reason": "请求写盘失败" });
    }

    let deadline = std::time::Instant::now() + APPLY_TIMEOUT;
    let mut outcome: Option<Value> = None;
    while std::time::Instant::now() < deadline {
        if let Some(value) = read_json(&dir.join(RESULT_FILE)) {
            let matching = value.get("requestId").and_then(Value::as_str)
                == Some(request_id.as_str())
                && value.get("bootId").and_then(Value::as_str) == Some(boot.as_str());
            if matching {
                outcome = Some(value);
                break;
            }
        }
        let _ = std::fs::remove_file(dir.join(PROCESSING_FILE));
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    let _ = std::fs::remove_file(dir.join(REQUEST_FILE));

    let Some(mut result) = outcome else {
        return json!({
            "ok": false,
            "supported": true,
            "armed": true,
            "requestId": request_id,
            "snapshotId": snapshot_id,
            "reason": format!("热重载超时（{} 秒内没有回结果），服务端可能正忙或已退出", APPLY_TIMEOUT.as_secs()),
        });
    };
    if let Some(object) = result.as_object_mut() {
        object.insert("snapshotId".to_string(), json!(snapshot_id));
    }

    // 成功换掉的表写回基线，界面上的「有改动」标记随之熄灭
    if let Some(reloaded) = result.get("reloaded").and_then(Value::as_array) {
        let names: Vec<String> = reloaded
            .iter()
            .filter_map(|item| {
                item.get("table")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        refresh_baseline_for(root, runtime, &names);
    }
    result
}

fn refresh_baseline_for(root: &Path, runtime: &RuntimePaths, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let path = dir(runtime).join(BASELINE_FILE);
    let mut stored = read_json(&path).unwrap_or_else(|| json!({ "tables": {} }));
    let boot = boot_id(runtime).unwrap_or_default();
    if stored.get("bootId").and_then(Value::as_str) != Some(boot.as_str()) {
        stored = json!({ "bootId": boot, "tables": {} });
    }
    if let Some(map) = stored.get_mut("tables").and_then(Value::as_object_mut) {
        for name in names {
            if let Some((size, mtime)) = file_stamp(&data_dir(root).join(name).join("data.json")) {
                map.insert(name.clone(), json!({ "mtimeMs": mtime, "sizeBytes": size }));
            }
        }
    }
    if let Some(object) = stored.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(epoch_ms() as u64));
    }
    let _ = write_json(&path, &stored);
}

/* ------------------------------ 回滚 ------------------------------ */

/// 用某份快照覆盖回磁盘，然后立刻热重载那几张表。
pub async fn restore(root: &Path, runtime: &RuntimePaths, snapshot_id: Option<&str>) -> Value {
    let list = snapshots(runtime);
    let chosen = match snapshot_id {
        Some(id) => list
            .iter()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id))
            .cloned(),
        None => list.first().cloned(),
    };
    let Some(meta) = chosen else {
        return json!({ "ok": false, "reason": "没有可用的快照" });
    };
    let Some(id) = meta.get("id").and_then(Value::as_str) else {
        return json!({ "ok": false, "reason": "快照记录不完整" });
    };
    let source = snapshot_root(runtime).join(id);
    let mut tables = Vec::new();
    let mut failed = Vec::new();
    if let Some(items) = meta.get("tables").and_then(Value::as_array) {
        for item in items {
            let Some(name) = item.as_str() else { continue };
            let from = source.join(format!("{name}.json"));
            let to = data_dir(root).join(name).join("data.json");
            match std::fs::copy(&from, &to) {
                Ok(_) => tables.push(name.to_string()),
                Err(err) => failed.push(json!({ "table": name, "error": err.to_string() })),
            }
        }
    }
    if tables.is_empty() {
        return json!({ "ok": false, "reason": "快照里没有可还原的表", "failed": failed });
    }
    let mut applied = apply(root, runtime, Some(tables.clone()), false).await;
    if let Some(object) = applied.as_object_mut() {
        object.insert("restoredFrom".to_string(), json!(id));
        object.insert("restoredTables".to_string(), json!(tables));
        object.insert("restoreFailed".to_string(), json!(failed));
    }
    applied
}

/* ------------------------------ 单测 ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个独立目录。
    ///
    /// 只按毫秒时间戳命名会撞车：cargo 默认并行跑测试，两个用例落在同一毫秒时共用
    /// 一个目录，先跑完的那个 `remove_dir_all` 会把另一个的文件删掉（表现为随机的
    /// NotFound / 计数为 0）。所以再叠一个进程内自增序号 + 进程号。
    fn fixture_root() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "evejs-hotreload-{}-{}-{seq}",
            std::process::id(),
            epoch_ms()
        ))
    }

    /// 服务端 `gameStore/index.js` 的 SQLITE_TABLES 必须能被解析出来，
    /// 否则界面会把运行时表当成静态表（用旧副本覆盖玩家数据，最坏的一种错）。
    #[test]
    fn sqlite_table_list_parses_or_fails_closed() {
        let root = fixture_root();
        let target = root.join("server").join("src").join("gameStore");
        std::fs::create_dir_all(&target).unwrap();
        assert_eq!(sqlite_tables(&root), None, "文件不存在时必须失败关闭");
        let mut names = String::new();
        for index in 0..30 {
            names.push_str(&format!("  \"runtime{index}\",\n"));
        }
        std::fs::write(
            target.join("index.js"),
            format!("const SQLITE_TABLES = new Set([\n{names}]);\n"),
        )
        .unwrap();
        let parsed = sqlite_tables(&root).expect("应能解析");
        assert_eq!(parsed.len(), 30);
        assert!(parsed.contains("runtime0"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 没有 host 注入时，`armed` 必须是 false：界面据此如实说「不是启动器启动的」。
    #[test]
    fn armed_requires_matching_boot_ids() {
        let root = fixture_root();
        let runtime = RuntimePaths::from_root(root.join("_launcher"), false);
        std::fs::create_dir_all(dir(&runtime)).unwrap();
        assert!(!armed(&runtime));
        write_json(&dir(&runtime).join(BOOT_FILE), &json!({ "bootId": "abc" })).unwrap();
        assert!(!armed(&runtime), "只有 boot.json 还不算激活");
        write_json(
            &dir(&runtime).join(SESSION_FILE),
            &json!({ "bootId": "abc", "pid": 42 }),
        )
        .unwrap();
        assert!(armed(&runtime));
        write_json(
            &dir(&runtime).join(SESSION_FILE),
            &json!({ "bootId": "old", "pid": 42 }),
        )
        .unwrap();
        assert!(!armed(&runtime), "上一轮服务端的 session 不算数");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 静态表清单只认「有 data.json 且不在 SQLITE_TABLES 里」的目录
    #[test]
    fn static_tables_exclude_runtime_tables() {
        let root = fixture_root();
        let store = root.join("server").join("src").join("gameStore");
        std::fs::create_dir_all(&store).unwrap();
        let mut names = String::new();
        for index in 0..25 {
            names.push_str(&format!("  \"runtime{index}\",\n"));
        }
        std::fs::write(
            store.join("index.js"),
            format!("const SQLITE_TABLES = new Set([\n{names}]);\n"),
        )
        .unwrap();
        let data = data_dir(&root);
        for table in ["itemTypes", "runtime0"] {
            std::fs::create_dir_all(data.join(table)).unwrap();
            std::fs::write(data.join(table).join("data.json"), "{}").unwrap();
        }
        let (tables, runtime_count) = list_static_tables(&root);
        assert_eq!(runtime_count, 1);
        let listed: Vec<&str> = tables
            .iter()
            .filter_map(|table| table["name"].as_str())
            .collect();
        assert_eq!(listed, vec!["itemTypes"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 「需重启」清单是**据实**列的，不是随手挑 4 张：
    /// 判据来自扫服务端 `src/**`（模块级缓存 + 读静态表 + 没有 clear/reset/refresh 导出），
    /// 所以这里钉住规模与几条最关键的事实，防止被误删回「只有天体/星系/星门/空间站」。
    #[test]
    fn frozen_tables_cover_every_index_the_server_never_invalidates() {
        // 兵家必争之地：改舰船/装备属性是这功能最常见的用法，而它们的索引偏偏清不掉
        for name in ["itemTypes", "typeDogma", "shipDogmaAttributes", "shipTypes"] {
            assert!(frozen_table(name).is_some(), "{name} 应被标为需重启");
        }
        // 地理/场景那几张
        for name in ["celestials", "solarSystems", "stargates", "stations"] {
            assert!(frozen_table(name).is_some(), "{name} 应被标为需重启");
        }
        // 有钩子的表不能误标（host 会调它们的 clear*，属于即时生效）
        for name in ["mapTagsAuthority", "missionAuthority", "planetSchematics"] {
            assert!(
                frozen_table(name).is_none(),
                "{name} 有重置入口，不该标成需重启"
            );
        }
        assert_eq!(FROZEN_TABLES.len(), 25);
        // 场景表必须是需重启表的子集：场景读的就是 worldData 那份被冻结的索引
        for name in SCENE_TABLES {
            assert!(
                frozen_table(name).is_some(),
                "{name} 在场景表里却不在需重启表里"
            );
        }
        // 表名不许重复
        let mut names: Vec<&str> = FROZEN_TABLES.iter().map(|entry| entry.name).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "FROZEN_TABLES 里有重复表名");
        // owners 是界面上的「为什么」，不能空着
        for entry in FROZEN_TABLES {
            assert!(!entry.owners.is_empty(), "{} 缺 owners", entry.name);
            assert!(!entry.owners.starts_with(' ') && !entry.owners.ends_with(' '));
        }
    }
}
