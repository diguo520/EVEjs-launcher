//! 危险操作：清空缓存 / 重置配置 / 擦除世界数据。
//!
//! 三条都挂在「设置 → 危险操作」上，共同口径：
//!   - 只动启动器自有数据与服务端可重建的数据；不碰 exe、不碰身份 key 与令牌；
//!   - 能备份的先备份（配置整份拷贝、世界存档整目录改名），手滑了还能捡回来；
//!   - 服务在跑时一律拒绝：边写边删会把库或配置撕坏。
//!
//! 为什么不写在 ipc/mod.rs 里：这三条都有磁盘副作用和前置条件，塞进分发层会让
//! 「哪些通道会真的动用户数据」变得不显眼。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use crate::gameconfig;
use crate::runtime::RuntimePaths;
use crate::AppState;

/// 清空缓存的白名单：只删这些名字，其余一律保留。
///
/// 为什么必须是白名单而不是「清空目录」：老 Electron 版把 Chromium 的 Local State
/// （OSCrypt 密钥）留在同一个运行时 cache 目录下，那份密钥是解密老 GitHub 令牌与
/// 身份 key 的钥匙。整目录清掉等于让老用户重新配置令牌 —— 正是迁移时明确要避免的事。
/// 名单外的东西（含 Local State）一律不动。
const CACHE_WHITELIST: [&str; 5] = [
    "mod-index.json",
    "mod-ratings.json",
    "mod-reviews",
    "sponsors.json",
    "gh-login.json",
];

/// 重置配置的超时：侧车要先读 6 个域文件再原子写回，给足时间
const RESET_TIMEOUT: Duration = Duration::from_secs(120);

/// 目录占用（递归）。读不到的项按 0 计：这个数字只用来告诉用户释放了多少。
fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|entry| dir_size(&entry.path())).sum()
}

/// 文件名安全版 UTC 时间戳：2026-10-04T09-15-30。
/// 形状对齐现役版本机里已有的 gamestore.sqlite.bak-2026-09-30T04-40-13。
fn stamp_utc() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    let days = (ms / 86_400_000) as i64;
    let rem = ms % 86_400_000;
    let (year, month, day) = crate::process::civil_from_days(days);
    let hour = rem / 3_600_000;
    let minute = (rem / 60_000) % 60;
    let second = (rem / 1000) % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}")
}

/// 正在跑的（含正在停止的）服务名。破坏性操作前必须全空。
///
/// 为什么把 stopping 也算上：进程还没退干净时文件仍可能被占，改名会失败或更糟 ——
/// 让用户等一下，比赌一把好。
fn running_services(state: &AppState) -> Vec<String> {
    state
        .services
        .snapshot()
        .into_iter()
        .filter(|info| {
            info.pid.is_some() || matches!(info.state.as_str(), "running" | "starting" | "stopping")
        })
        .map(|info| info.name)
        .collect()
}

/// 「服务在跑时拒绝写」的统一判断。清档、重置配置、改商城都走这里 ——
/// 服务端进程会把内存里的状态回写覆盖进程外的改动，各写各的必然互相踩。
pub(crate) fn blocked_by_services(state: &AppState) -> Option<String> {
    let running = running_services(state);
    if running.is_empty() {
        return None;
    }
    Some(format!(
        "请先停止：{}。服务在跑时改配置或清档会被进程回写覆盖，也可能删坏正在写的库",
        running.join("、")
    ))
}

/// 清空缓存：只删白名单里的联网快照，返回删了什么、留了什么、释放了多少字节。
pub fn clear_cache(runtime: &RuntimePaths) -> Value {
    let dir = &runtime.cache;
    let Ok(entries) = fs::read_dir(dir) else {
        return json!({
            "ok": false,
            "reason": format!("读不到缓存目录：{}", dir.display())
        });
    };

    let mut removed: Vec<String> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut freed: u64 = 0;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !CACHE_WHITELIST.contains(&name.as_str()) {
            kept.push(name);
            continue;
        }
        let path = entry.path();
        let size = dir_size(&path);
        let outcome = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match outcome {
            Ok(()) => {
                freed += size;
                removed.push(name);
            }
            Err(err) => failed.push(format!("{name}（{err}）")),
        }
    }

    removed.sort();
    kept.sort();
    if failed.is_empty() {
        json!({ "ok": true, "removed": removed, "kept": kept, "freedBytes": freed })
    } else {
        json!({
            "ok": false,
            "reason": format!("有 {} 项没能删掉：{}", failed.len(), failed.join("、")),
            "removed": removed,
            "kept": kept,
            "freedBytes": freed
        })
    }
}

/// 重置配置：由服务端自己的配置管理器把 config 域写回默认值（侧车 reset）。
/// 默认值只有服务端有，启动器不抄第二套，所以这里只做搬运。
pub async fn reset_config(state: &AppState, root: &Path) -> Value {
    if let Some(reason) = blocked_by_services(state) {
        return json!({ "ok": false, "reason": reason });
    }
    let args = vec![
        "reset".to_string(),
        "--root".to_string(),
        root.to_string_lossy().to_string(),
    ];
    gameconfig::call(root, args, None, RESET_TIMEOUT).await
}

/// 擦除世界数据：整目录改名（不是删除）后，复用现成的初始化 db 任务重建。
pub fn erase_world(app: &AppHandle, state: &AppState, root: &Path) -> Value {
    if let Some(reason) = blocked_by_services(state) {
        return json!({ "ok": false, "reason": reason });
    }

    let store: PathBuf = root.join("_local").join("gameStore");
    if !store.is_dir() {
        return json!({
            "ok": false,
            "reason": format!("没有找到世界存档：{}", store.display())
        });
    }
    let backup = store.with_file_name(format!("gameStore.bak-{}", stamp_utc()));
    if backup.exists() {
        return json!({
            "ok": false,
            "reason": format!("备份目录已存在，先处理它再重试：{}", backup.display())
        });
    }
    if let Err(err) = fs::rename(&store, &backup) {
        return json!({
            "ok": false,
            "reason": format!("改名世界存档失败（可能有进程占用）：{err}")
        });
    }

    // 复用环境自检里的 db 任务：CreateDatabase.bat /force 会把 manifest 与 sqlite 一起重建，
    // 进度与输出都走既有的 init:changed / terminal:data，作者不用手动换存档。
    let rebuild = crate::init::run_init(app, "db");
    json!({
        "ok": true,
        "backupDir": backup.to_string_lossy(),
        "rebuild": rebuild
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-danger-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clear_cache_removes_only_the_whitelist() {
        let root = scratch("cache");
        let cache = root.join("cache");
        fs::create_dir_all(cache.join("mod-reviews")).unwrap();
        fs::write(cache.join("mod-reviews").join("abc.json"), b"{}").unwrap();
        fs::write(cache.join("mod-index.json"), b"{}").unwrap();
        fs::write(cache.join("sponsors.json"), b"{}").unwrap();
        // 这两份必须留下：Local State 是老令牌的钥匙，unknown 是不认识的用户文件
        fs::write(cache.join("Local State"), b"key").unwrap();
        fs::write(cache.join("user-notes.txt"), b"keep me").unwrap();

        let runtime = RuntimePaths::from_root(root.clone(), false);
        let value = clear_cache(&runtime);

        assert_eq!(value["ok"], json!(true));
        assert!(!cache.join("mod-index.json").exists());
        assert!(!cache.join("sponsors.json").exists());
        assert!(!cache.join("mod-reviews").exists());
        assert!(cache.join("Local State").exists(), "Local State 不能被删");
        assert!(cache.join("user-notes.txt").exists(), "名单外文件不能被删");
        let kept = value["kept"].as_array().unwrap();
        assert!(kept.iter().any(|item| item.as_str() == Some("Local State")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_is_filename_safe() {
        let stamp = stamp_utc();
        assert!(!stamp.contains(':'), "{stamp} 里有冒号，不能做文件名");
        assert!(stamp.contains('T'), "{stamp} 形状应是 YYYY-MM-DDTHH-MM-SS");
        assert_eq!(stamp.len(), 19, "{stamp} 长度应为 19");
    }

    #[test]
    fn dir_size_walks_directories() {
        let root = scratch("size");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a").join("one.bin"), vec![0u8; 10]).unwrap();
        fs::write(root.join("two.bin"), vec![0u8; 5]).unwrap();
        assert_eq!(dir_size(&root), 15);
        let _ = fs::remove_dir_all(&root);
    }
}
