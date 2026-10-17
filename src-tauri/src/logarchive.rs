//! 存档日志：「服务器日志」页右栏那份列表的数据来源。
//!
//! 三个分组，各有各的落地位置：
//!   - `server`  主服务器：服务端自己在 `<root>/_local/logs/` 按小时轮转
//!     （`server.<日期>_<时>.log`），启动器每轮另存一份 PTY 输出到 `_launcher/logs/archive/server/`；
//!   - `market`  市场服务：同一套 —— `market.<日期>_<时>.log` + 启动器的会话存档；
//!   - `client`  游戏客户端：客户端自己按 `/stdout=` `/stderr=` 写的 `.out.log` / `.err.log`。
//!
//! 为什么服务端日志读 `_local/logs` 而不是 `server/logs`：`server/logs` 放的是模组自己
//! 写的东西（evejs-mods、势力模拟的 jsonl），服务进程真正的控制台日志在 `_local/logs`。
//!
//! 活文件（`server.log` / `market.log`）**不进列表**：服务端正持有它的句柄，删了会踩到轮转锁，
//! 它也不算"存档"。列出来、能清掉的，都是已经封盘的轮转文件与启动器会话存档。
use crate::process::CLIENT;
use crate::runtime::RuntimePaths;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const SERVER: &str = "server";
pub const MARKET: &str = "market";

/// 页面上按这个顺序排：主服务器 → 市场服务 → 客户端
pub const GROUPS: [&str; 3] = [SERVER, MARKET, CLIENT];

/// 每组最多留几份**启动器**存档；超出时在下次启动前把最旧的删掉
pub const KEEP_PER_GROUP: usize = 20;

/// 列表里每组最多回几条（其余只报总数，免得面板被几百条撑爆）
const LIST_LIMIT: usize = 6;

/// 启动器自己那一组的目录。
///
/// 客户端沿用历史路径 `logs/client`（进程自己按 `/stdout=` 写在那儿，改路径会和现役版不兼容）；
/// 主服务器与市场服务放 `logs/archive/<group>/`。
pub fn group_dir(runtime: &RuntimePaths, group: &str) -> PathBuf {
    if group == CLIENT {
        runtime.logs.join(CLIENT)
    } else {
        runtime.logs.join("archive").join(group)
    }
}

/// `server.<日期段>.log` 这种才算存档；`server.log`（活文件）不算
fn is_rotated(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".log") else {
        return false;
    };
    stem.len() > 1 && stem.starts_with('.')
}

/// 文件按修改时间从新到旧排；读不到时间的当最旧。
///
/// `prefix` 给了就只收「带日期段的轮转文件」：`_local/logs` 里还躺着几十个模组自己的
/// debug 日志（space-warp-debug、sync-ledger……），不按前缀收会把它们全混进来。
fn files_newest_first(dir: &Path, prefix: Option<&str>) -> Vec<(PathBuf, u64, u64)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, u64, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if let Some(prefix) = prefix {
                let name = entry.file_name().to_string_lossy().to_string();
                if !is_rotated(&name, prefix) {
                    return None;
                }
            }
            let meta = fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64)
                .unwrap_or(0);
            Some((path, meta.len(), mtime))
        })
        .collect();
    files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    files
}

/// 一组的所有来源目录：服务端 `_local/logs`（只取轮转存档）+ 启动器的会话存档。
fn sources<'a>(
    runtime: &RuntimePaths,
    root: &Path,
    group: &'a str,
) -> Vec<(PathBuf, Option<&'a str>)> {
    let local_logs = root.join("_local").join("logs");
    match group {
        SERVER => vec![
            (local_logs, Some(SERVER)),
            (group_dir(runtime, SERVER), None),
        ],
        MARKET => vec![
            (local_logs, Some(MARKET)),
            (group_dir(runtime, MARKET), None),
        ],
        _ => vec![(group_dir(runtime, CLIENT), None)],
    }
}

/// 一组的全部存档（两个来源合并后按时间倒序）。
fn collect(runtime: &RuntimePaths, root: &Path, group: &str) -> Vec<(PathBuf, u64, u64)> {
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    for (dir, prefix) in sources(runtime, root, group) {
        files.extend(files_newest_first(&dir, prefix));
    }
    files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    files
}

/// 每组只留最新 `KEEP_PER_GROUP` 份**启动器**存档（服务端的轮转由服务端自己管）。
pub fn prune(runtime: &RuntimePaths, group: &str) {
    prune_in(&group_dir(runtime, group));
}

/// 记一笔「这一轮是外部启动的」。
///
/// 场景：服务已经在跑了（端口已监听，通常是你自己用 `StartServer.bat` /
/// `StartMarketServer.bat` 起的），启动器只判 `already-running`、不接管进程 ——
/// 那就**没有输出可抓**。以前这种情况列表里什么都没有，看起来像"存档功能没生效"；
/// 现在留一条几十字节的说明，把「什么时候点过、为什么没有内容」写清楚。
pub fn mark_external(runtime: &RuntimePaths, group: &str, port: u16) {
    let dir = group_dir(runtime, group);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let label = if group == MARKET {
        "市场服务"
    } else {
        "主服务器"
    };
    let name = format!("{}-external.log", crate::process::iso_log_stamp());
    let body = format!(
        "# {label}本轮由外部启动：端口 {port} 已在监听，启动器没有接管进程，所以抓不到输出。\n\
         # 想要这一轮的输出存档：先在外部把它停掉，再从启动器点「启动」。\n"
    );
    let _ = fs::write(dir.join(name), body);
}

/// 同上，按目录给：客户端那条路只知道 `logs/` 在哪（见 process::start_client），
/// 不该为了裁几个旧文件再绕回去要一份 RuntimePaths。
pub fn prune_in(dir: &Path) {
    for (path, _, _) in files_newest_first(dir, None)
        .into_iter()
        .skip(KEEP_PER_GROUP)
    {
        let _ = fs::remove_file(path);
    }
}

/// 三组存档的清单。每组给最新的几条 + 总数/总字节，够面板一眼看出「有没有、多新、多大」。
pub fn list(runtime: &RuntimePaths, root: &Path) -> Value {
    let groups: Vec<Value> = GROUPS
        .iter()
        .map(|group| {
            let files = collect(runtime, root, group);
            let total_bytes: u64 = files.iter().map(|item| item.1).sum();
            let rows: Vec<Value> = files
                .iter()
                .take(LIST_LIMIT)
                .map(|(path, bytes, mtime)| {
                    json!({
                        "name": path
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        "dir": path
                            .parent()
                            .map(|dir| dir.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        "bytes": bytes,
                        "mtime": mtime,
                    })
                })
                .collect();
            json!({
                "id": group,
                "count": files.len(),
                "bytes": total_bytes,
                "files": rows,
            })
        })
        .collect();
    json!({ "ok": true, "root": root.to_string_lossy(), "groups": groups })
}

/// 清空三组存档（只删文件，目录留着）。
///
/// 删的范围就是 `list` 能列出来的那些：启动器的会话存档 + 服务端 `_local/logs` 里的
/// **轮转**文件。活着的 `server.log` / `market.log` 不在列表里，也就不会被删。
pub fn clear(runtime: &RuntimePaths, root: &Path) -> Value {
    let mut removed = 0u64;
    let mut freed = 0u64;
    let mut failed: Vec<String> = Vec::new();
    for group in GROUPS {
        for (path, bytes, _) in collect(runtime, root, group) {
            match fs::remove_file(&path) {
                Ok(()) => {
                    removed += 1;
                    freed += bytes;
                }
                Err(err) => failed.push(format!(
                    "{}（{err}）",
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default()
                )),
            }
        }
    }
    if failed.is_empty() {
        json!({ "ok": true, "removed": removed, "freedBytes": freed })
    } else {
        json!({
            "ok": false,
            "removed": removed,
            "freedBytes": freed,
            "reason": format!("有 {} 个文件删不掉：{}", failed.len(), failed.join("、")),
        })
    }
}

/// 用系统默认程序打开某一份存档（就是列表里每行那个「打开」）。
///
/// 只接受「组 id + 文件名」，真正的路径由 `collect` 现算再按文件名匹配 ——
/// 渲染层给不了路径，越界打开也就无从谈起。
pub fn open(
    app: &tauri::AppHandle,
    runtime: &RuntimePaths,
    root: &Path,
    group: &str,
    name: &str,
) -> Value {
    let Some((path, _, _)) = collect(runtime, root, group)
        .into_iter()
        .find(|(path, _, _)| {
            path.file_name()
                .map(|file| file.to_string_lossy() == name)
                .unwrap_or(false)
        })
    else {
        return json!({ "ok": false, "reason": format!("没有这份存档：{name}") });
    };
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_path(path.to_string_lossy(), None::<&str>) {
        Ok(()) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(err) => json!({ "ok": false, "reason": err.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("evejs-logarchive-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个「服务端根」：`_local/logs` 里放活日志 + 轮转存档 + 一份无关日志
    fn server_root(label: &str) -> (PathBuf, RuntimePaths) {
        let root = scratch(label);
        let runtime = RuntimePaths::from_root(root.clone(), false);
        let local = root.join("_local").join("logs");
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("server.log"), vec![0u8; 7]).unwrap();
        fs::write(local.join("server.2026-10-17_15.log"), vec![0u8; 11]).unwrap();
        fs::write(local.join("market.2026-10-17_15.log"), vec![0u8; 13]).unwrap();
        fs::write(local.join("space-warp-debug.log"), vec![0u8; 5]).unwrap();
        (root, runtime)
    }

    #[test]
    fn groups_live_in_separate_directories() {
        let root = scratch("dirs");
        let runtime = RuntimePaths::from_root(root.clone(), false);
        assert!(
            group_dir(&runtime, SERVER).ends_with(Path::new("logs").join("archive").join("server"))
        );
        assert!(
            group_dir(&runtime, MARKET).ends_with(Path::new("logs").join("archive").join("market"))
        );
        assert!(group_dir(&runtime, CLIENT).ends_with(Path::new("logs").join("client")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rotated_names_only() {
        assert!(is_rotated("server.2026-10-17_15.log", SERVER));
        assert!(is_rotated("market.2026-10-16_10.log", MARKET));
        assert!(!is_rotated("server.log", SERVER), "活文件不算存档");
        assert!(!is_rotated("market.log", MARKET));
        assert!(!is_rotated("market.2026-10-16_10.log", SERVER), "不能串组");
    }

    #[test]
    fn list_merges_server_root_and_launcher_archives() {
        let (root, runtime) = server_root("list");
        let archive = group_dir(&runtime, SERVER);
        fs::create_dir_all(&archive).unwrap();
        fs::write(
            archive.join("2026-10-18T01-00-00-000Z-42.log"),
            vec![0u8; 3],
        )
        .unwrap();

        let value = list(&runtime, &root);
        let groups = value["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 3, "三组都要报，哪怕目录不存在");
        assert_eq!(groups[0]["id"], json!(SERVER));
        assert_eq!(groups[0]["count"], json!(2), "_local 的轮转 + 启动器存档");
        assert_eq!(groups[0]["bytes"], json!(14));
        assert_eq!(groups[1]["id"], json!(MARKET));
        assert_eq!(groups[1]["count"], json!(1), "market 只认 market.* 轮转");
        assert_eq!(groups[1]["bytes"], json!(13));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_reports_counts_and_newest_first() {
        let root = scratch("order");
        let runtime = RuntimePaths::from_root(root.clone(), false);
        let dir = group_dir(&runtime, CLIENT);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old.log"), vec![0u8; 3]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("new.log"), vec![0u8; 5]).unwrap();

        let value = list(&runtime, &root);
        let client = &value["groups"].as_array().unwrap()[2];
        assert_eq!(client["id"], json!(CLIENT));
        assert_eq!(client["count"], json!(2));
        assert_eq!(client["files"][0]["name"], json!("new.log"), "最新的排最前");
        assert_eq!(client["files"][1]["name"], json!("old.log"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_removes_archives_but_never_the_live_log() {
        let (root, runtime) = server_root("clear");
        let client = group_dir(&runtime, CLIENT);
        fs::create_dir_all(&client).unwrap();
        fs::write(client.join("client-x.out.log"), vec![0u8; 6]).unwrap();
        let keep = runtime.logs.join("mod-load-report.json");
        fs::write(&keep, b"{}").unwrap();

        let value = clear(&runtime, &root);
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["removed"], json!(3), "server./market./client 各一份");
        assert_eq!(value["freedBytes"], json!(30));

        let local = root.join("_local").join("logs");
        assert!(local.join("server.log").exists(), "活日志不能删");
        assert!(!local.join("server.2026-10-17_15.log").exists());
        assert!(!local.join("market.2026-10-17_15.log").exists());
        assert!(
            local.join("space-warp-debug.log").exists(),
            "无关日志不能动"
        );
        assert!(keep.exists(), "三个分组之外的文件不能动");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn external_start_leaves_a_note() {
        let root = scratch("external");
        let runtime = RuntimePaths::from_root(root.clone(), false);
        mark_external(&runtime, MARKET, 40110);

        let files = files_newest_first(&group_dir(&runtime, MARKET), None);
        assert_eq!(files.len(), 1, "外部启动要留下一条记录");
        let text = fs::read_to_string(&files[0].0).unwrap();
        assert!(text.contains("市场服务"), "{text}");
        assert!(text.contains("40110"), "{text}");

        // 这条记录同样属于存档，清空日志时一并清掉
        let value = clear(&runtime, &root);
        assert_eq!(value["removed"], json!(1));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_keeps_only_the_newest() {
        let root = scratch("prune");
        let runtime = RuntimePaths::from_root(root.clone(), false);
        let dir = group_dir(&runtime, SERVER);
        fs::create_dir_all(&dir).unwrap();
        for index in 0..(KEEP_PER_GROUP + 3) {
            fs::write(dir.join(format!("{index:02}.log")), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        prune(&runtime, SERVER);
        assert_eq!(files_newest_first(&dir, None).len(), KEEP_PER_GROUP);
        let _ = fs::remove_dir_all(&root);
    }
}
