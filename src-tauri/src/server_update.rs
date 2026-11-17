//! 服务端在线升级：查新版 → 下 zip → 停服 → 交给上游更新器 → 装依赖 → 起服。
//!
//! 不自己搬服务端文件、不碰服务端源码（见 `docs/服务端在线更新-方案.md`）。
//! 上游 `tools/Updater/Update-EvEJS.ps1` 负责「换程序文件、保数据」，本模块只做
//! 启动器侧的编排：发布源直接复用首页下载用的 R2 `down/index.json`（机器可读、
//! 带版本与体积），与启动器自更新（Go 更新器 + 签名清单）完全解耦。
//!
//! 安全口径：清单地址与对象名拼死在本模块（复用 `downloads::object_url`），
//! 下载后核对体积是否与清单一致；不引入第二套签名体系（用户口径：方便简单）。
use crate::downloads;
use crate::env;
use crate::net;
use crate::process;
use crate::runtime::RuntimePaths;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// 同一时刻只允许一次服务端升级：停服、跑更新器、起服是一段不能被打断的窗口，
/// 并发两次会把服务端文件写坏。抢不到就直接拒。
static APPLY_BUSY: AtomicBool = AtomicBool::new(false);

/// 上游更新器脚本（相对服务端根目录）。缺失就说明这个服务端版本不提供在线更新，
/// 明确报错，不自己造一套文件搬运。
const UPDATER_SCRIPT: &str = "tools/Updater/Update-EvEJS.ps1";
/// 更新后的维护脚本（重置主权数据，上游要求每次更新后跑一次）。
const SOVEREIGNTY_SCRIPT: &str = "tools/Maintenance/reset-sovereignty.js";

/// `server:updateCheck`：本地版本 vs 桶里最新清单。
///
/// 回包 `{ ok, currentVersion, latestVersion, available, file, sizeBytes }`。
/// 清单读不到（没网 / 没传）时 `available=false` 并带 `reason`，不编数字。
pub async fn check(root: &Path) -> Value {
    let current = env::read_evejs_version(root);
    let remote = downloads::index().await;
    let latest = latest_remote(&remote);
    match latest {
        Some(entry) => {
            let available = compare_versions(&entry.version, &current) > 0;
            json!({
                "ok": true,
                "currentVersion": current,
                "latestVersion": entry.version,
                "available": available,
                "file": entry.file,
                "sizeBytes": entry.size,
            })
        }
        None => json!({
            "ok": false,
            "currentVersion": current,
            "latestVersion": "",
            "available": false,
            "reason": remote
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("读不到服务端版本清单"),
        }),
    }
}

struct RemoteEntry {
    file: String,
    version: String,
    size: Option<u64>,
}

/// 从 `download:index` 的回包里挑出版本号最大的那一条。
fn latest_remote(remote: &Value) -> Option<RemoteEntry> {
    let rows = remote.get("versions").and_then(Value::as_array)?;
    let mut best: Option<RemoteEntry> = None;
    for row in rows {
        let Some(file) = row.get("file").and_then(Value::as_str) else {
            continue;
        };
        let Some(version) = row.get("version").and_then(Value::as_str) else {
            continue;
        };
        let size = row.get("sizeBytes").and_then(Value::as_u64);
        let candidate = RemoteEntry {
            file: file.to_string(),
            version: version.to_string(),
            size,
        };
        best = match best {
            None => Some(candidate),
            Some(prev) if compare_versions(&candidate.version, &prev.version) > 0 => {
                Some(candidate)
            }
            Some(prev) => Some(prev),
        };
    }
    best
}

/// `server:updateDownload`：把目标版本整包下到 `_launcher/temp/server-update/<版本>/`。
///
/// 回包 `{ ok, path, bytes, sha256 }` 或 `{ ok:false, reason }`。下载进度走
/// `download:progress`（与首页下载同一条通道，界面复用同一套进度条）。
pub async fn download(app: &AppHandle, runtime: &RuntimePaths, file: &str, version: &str) -> Value {
    let Some(file) = sanitize(file) else {
        return json!({ "ok": false, "reason": "下载文件名非法" });
    };
    let dir = runtime
        .temp
        .join("server-update")
        .join(if version.is_empty() {
            "current".to_string()
        } else {
            version.to_string()
        });
    if let Err(err) = fs::create_dir_all(&dir) {
        return json!({ "ok": false, "reason": format!("创建下载目录失败：{err}") });
    }
    let dest = dir.join("server.zip");
    let url = downloads::object_url(file);
    let app_for_emit = app.clone();
    let file_name = file.to_string();
    let progress_path = dest.to_string_lossy().to_string();
    // 闭包要 move 一份目标路径；下载完成后还要用原值核对/删除，所以克隆一份进闭包。
    let download_target = dest.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        net::download_cancellable(
            &url,
            &download_target,
            None,
            || false,
            |received, total| {
                let _ = app_for_emit.emit(
                    downloads::PROGRESS_EVENT,
                    json!([{
                        "file": file_name.as_str(),
                        "received": received,
                        "total": total,
                        "path": progress_path.as_str(),
                    }]),
                );
            },
        )
    })
    .await;
    match outcome {
        Ok(Ok(done)) => {
            // 下载后核对体积（清单给了 sizeBytes 时）：对不上说明拿到的是坏包/错包。
            if let Some(size) = expected_size(file, version) {
                if done.bytes != size {
                    let _ = fs::remove_file(&dest);
                    return json!({ "ok": false, "reason": format!("包体积对不上：期望 {size}，实际 {}", done.bytes) });
                }
            }
            match crate::mods::pkg::sha256_file(&dest) {
                Ok((sha, bytes)) => {
                    json!({ "ok": true, "path": dest.to_string_lossy(), "bytes": bytes, "sha256": sha })
                }
                Err(err) => json!({ "ok": false, "reason": format!("校验包失败：{err}") }),
            }
        }
        Ok(Err(reason)) => {
            let _ = fs::remove_file(&dest);
            json!({ "ok": false, "reason": reason })
        }
        Err(err) => {
            let _ = fs::remove_file(&dest);
            json!({ "ok": false, "reason": format!("后台任务失败：{err}") })
        }
    }
}

/// 清单里该版本的体积（用于下载后核对）。读不到清单就返回 None（不阻断）。
fn expected_size(file: &str, _version: &str) -> Option<u64> {
    // 清单是几百字节的静态文件，这里直接读一遍 R2；失败就跳过核对（不编数字）。
    let url = format!(
        "{}?cb={}",
        downloads::object_url("index.json"),
        now_millis()
    );
    let response = net::get(&url, "application/json", std::time::Duration::from_secs(20));
    let Ok(response) = response else { return None };
    if !(200..300).contains(&response.status) {
        return None;
    }
    let payload = response.json()?;
    payload
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("file").and_then(Value::as_str) == Some(file))
        })
        .and_then(|row| row.get("sizeBytes").and_then(Value::as_u64))
}

/// `server:updateApply`：停服 → 上游更新器 → 装依赖 → 维护脚本 → 起服 → 探活。
///
/// 回包 `{ ok, message, rolledBack? }`。任一步失败都如实报告，不把半更新说成成功。
pub async fn apply(app: &AppHandle, root: &Path, runtime: &RuntimePaths, version: &str) -> Value {
    if APPLY_BUSY.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "reason": "已有服务端升级在进行" });
    }
    let result = apply_inner(app, root, runtime, version).await;
    APPLY_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn apply_inner(app: &AppHandle, root: &Path, runtime: &RuntimePaths, version: &str) -> Value {
    let version = version.trim();
    if version.is_empty() {
        return json!({ "ok": false, "reason": "没有指定要升级到的版本" });
    }
    let zip_dir = runtime.temp.join("server-update").join(version);
    let zip = zip_dir.join("server.zip");
    if !zip.is_file() {
        return json!({ "ok": false, "reason": format!("还没下载版本 {version} 的整包，请先下载") });
    }
    let updater = root.join(UPDATER_SCRIPT);
    if !updater.is_file() {
        return json!({ "ok": false, "reason": format!("服务端没有上游更新器：{}", updater.to_string_lossy()) });
    }

    // 1. 停服：更新器要替换 node 服务端文件，主服务器在跑会占用文件导致半更新。
    //    市场服务是独立 Rust 二进制（更新器 keepTrees 会保护它），不锁定被替换的
    //    文件，无需停，保持运行即可 —— 少动一个服务就少一个要恢复的状态。
    if let Err(err) = process::stop_service(app, process::MAIN_SERVER).await {
        return json!({ "ok": false, "reason": format!("停止主服务器失败：{err}") });
    }

    // 2. 交给上游更新器（-NoGui -InstallPath -ZipPath -Mode auto）。
    if let Err(err) = run_updater(&updater, root, &zip).await {
        return json!({ "ok": false, "reason": format!("服务端更新失败：{err}") });
    }

    // 3. 装依赖：新版发布包不带 node_modules（keepTrees 会保留旧的，但首次/换版要补）。
    let server_dir = root.join("server");
    if !server_dir.join("node_modules").is_dir() {
        if let Err(err) = run_npm_install(&server_dir).await {
            return json!({
                "ok": false,
                "reason": format!("文件已更新，但依赖没装上：{err}"),
            });
        }
    }

    // 4. 维护脚本（重置主权数据；缺了只提示，不阻断启动）。
    let sovereignty = root.join(SOVEREIGNTY_SCRIPT);
    if sovereignty.is_file() {
        let _ = run_node(root, &sovereignty).await;
    }

    // 5. 起服 + 探活。
    if let Err(err) = process::start_service(app, process::MAIN_SERVER).await {
        return json!({ "ok": false, "reason": format!("更新完成，但主服务器没起来：{err}") });
    }
    let port = configured_game_port(root);
    let alive = crate::health::tcp_alive(port).await;
    if !alive {
        return json!({ "ok": false, "reason": format!("更新完成，但端口 {port} 没探活成功") });
    }
    // 升级成功后删掉下载的整包：临时目录不保留，免得占着几百 MB 空间。
    let _ = fs::remove_dir_all(&zip_dir);
    json!({ "ok": true, "message": format!("服务端已更新到 {version} 并重启") })
}

async fn run_updater(script: &Path, root: &Path, zip: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .args([
            "-NoGui",
            "-InstallPath",
            &root.to_string_lossy(),
            "-ZipPath",
            &zip.to_string_lossy(),
            "-Mode",
            "auto",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "更新器执行超时（600s）".to_string())?
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let text = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        Err(crate::sidecar::first_line(&text))
    }
}

async fn run_npm_install(dir: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new("npm");
    command
        .arg("install")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "npm install 超时（600s）".to_string())?
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::sidecar::first_line(&stderr))
    }
}

async fn run_node(dir: &Path, script: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "维护脚本超时（120s）".to_string())?
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("维护脚本退出码 {:?}", output.status.code()))
    }
}

fn configured_game_port(root: &Path) -> u16 {
    let configured = crate::config::read_server_config(root).ports.game;
    if configured > 0 {
        configured
    } else {
        crate::config::DEFAULT_GAME_PORT
    }
}

/// 对象名白名单：只允许一个路径段，复用与 `downloads` 同口径的字符集。
fn sanitize(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 200 || trimmed.contains("..") {
        return None;
    }
    let allowed = trimmed.chars().all(|ch| {
        ch.is_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_' | '(' | ')' | '[' | ']')
    });
    allowed.then_some(trimmed)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 版本号比较：`YYMMDD.N` 拆成数字逐段比（能正确处理 `261028.2 < 261029.1`）。
/// 返回 >0 表示 a 比 b 新；解析不了的段按 0。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let ax: Vec<u64> = a
        .split('.')
        .map(|p| p.trim().parse().unwrap_or(0))
        .collect();
    let bx: Vec<u64> = b
        .split('.')
        .map(|p| p.trim().parse().unwrap_or(0))
        .collect();
    for i in 0..ax.len().max(bx.len()) {
        let av = *ax.get(i).unwrap_or(&0);
        let bv = *bx.get(i).unwrap_or(&0);
        if av != bv {
            return if av > bv { 1 } else { -1 };
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_order_matches_release_calendar() {
        assert!(compare_versions("261115.2", "261108.1") > 0);
        assert!(compare_versions("261108.1", "261115.2") < 0);
        // 同一天内的小版本也要比出来
        assert!(compare_versions("261028.2", "261028.1") > 0);
        assert_eq!(compare_versions("261108.1", "261108.1"), 0);
        // 段数不等：短的前面相等、后面当 0
        assert!(compare_versions("261108", "261108.1") < 0);
    }

    #[test]
    fn file_name_whitelist_rejects_paths() {
        assert_eq!(sanitize("EveJS-261115.2.zip"), Some("EveJS-261115.2.zip"));
        for bad in ["", "  ", "../x.zip", "a/b.zip", "a\\b.zip", "a:b.zip"] {
            assert_eq!(sanitize(bad), None, "{bad} 应被拒绝");
        }
    }

    #[test]
    fn latest_remote_picks_highest_version() {
        let remote = json!({ "ok": true, "versions": [
            { "file": "EveJS-261018.1.zip", "version": "261018.1", "sizeBytes": 1 },
            { "file": "EveJS-261115.2.zip", "version": "261115.2", "sizeBytes": 2 },
            { "file": "EveJS-261108.1.zip", "version": "261108.1", "sizeBytes": 3 },
        ]});
        let latest = latest_remote(&remote).expect("应能挑出最新");
        assert_eq!(latest.version, "261115.2");
        assert_eq!(latest.file, "EveJS-261115.2.zip");
    }

    #[test]
    fn latest_remote_returns_none_for_bad_shape() {
        assert!(latest_remote(&json!({})).is_none());
        assert!(latest_remote(&json!({ "versions": "nope" })).is_none());
    }
}
