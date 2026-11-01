//! 首页横幅的下载：客户端种子文件 + 服务端各版本，都走「系统另存为 + 启动器内下载」。
//!
//! 用户口径（2026-11-01）：**不要跳浏览器**，就在启动器里另存为。所以这一层 =
//! 「另存为」对话框（`dialog.rs`，与 `mods:saveText` 同一套 Win32 FFI）+
//! `net::download_cancellable`（分段 / 断点续传 / 可取消，与启动器自更新同一套）。
//!
//! 安全口径：渲染层只给**一个对象名**（白名单字符，且不许 ..），域名与 `down/` 前缀
//! 拼死在 Rust 侧 —— 这条通道既开不了任意主机，也写不到用户选定的目标文件之外，
//! 与 `mods::join_within` 同一套「名字不进路径语义」的写法。
use crate::dialog::{self, DialogSpec};
use crate::net;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// 下载桶：Cloudflare R2 自定义域 + `down/` 前缀。
/// 与 `ui/src/lib/mock.ts` 的 `DOWNLOAD_BASE_URL` 是同一个地址 —— 改一边要改两边。
const BASE_URL: &str = "https://evejs.5318.cm/down";

/// 进度事件（数组载荷，与 `mod:downloadProgress` 同形）
const PROGRESS_EVENT: &str = "download:progress";

/// 同一时刻只允许一条下载：横幅上就那几个入口，两条流同时写盘没有意义；
/// 上一条没结束就再点一次，直接说「已有下载在进行」比默默排队或并发写同一个文件好解释。
static BUSY: AtomicBool = AtomicBool::new(false);

/// 取消标志：`net::download_cancellable` 每读一块问一次
static CANCEL: AtomicBool = AtomicBool::new(false);

/// 对象名白名单：**只允许一个路径段**。R2 上的名字里有空格、点、短横线与中文，
/// 所以放开的面要够宽，但路径分隔符、上级引用与 Windows 保留字符一个都不放行。
fn safe_file_name(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return None;
    }
    let allowed = trimmed.chars().all(|ch| {
        ch.is_alphanumeric() || ch == ' ' || matches!(ch, '.' | '-' | '_' | '(' | ')' | '[' | ']')
    });
    if !allowed || trimmed.contains("..") {
        return None;
    }
    Some(trimmed)
}

/// 对象名 → 下载地址。转义口径与渲染层的 `encodeURIComponent` 同向
/// （种子名里有空格；原样发出去有些网关直接回 400），多转义几个符号无害。
fn object_url(file: &str) -> String {
    let mut out = String::with_capacity(BASE_URL.len() + file.len() + 1);
    out.push_str(BASE_URL);
    out.push('/');
    for byte in file.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `download:cancel`：只置标志，真正的停手在下载循环里
/// （`net::download_cancellable` 每读一块问一次，所以最多浪费一段）。
pub fn cancel() -> Value {
    CANCEL.store(true, Ordering::SeqCst);
    json!({ "ok": true })
}

/// `download:saveAs`：弹「另存为」，用户选好位置后**在启动器里**下。
///
/// 三种回包：`{ok:true, path, bytes}` / `{ok:false, canceled:true}`（选路径时取消、
/// 或下载中点取消 —— 渲染层据此不报错）/ `{ok:false, reason}`（名字非法、已有下载、
/// 网络或写盘失败）。
pub async fn save_as(app: &AppHandle, file: &str, suggested_name: &str) -> Value {
    let Some(file) = safe_file_name(file) else {
        return json!({ "ok": false, "reason": "下载文件名非法" });
    };
    // 抢不到就直接拒：并发两条流写盘只会出坏包，排队又要多一套队列状态
    if BUSY.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "reason": "已有下载在进行" });
    }
    let result = save_as_inner(app, file, suggested_name.trim()).await;
    // 出口统一清标志：中途任何 return 都不能把 BUSY 卡住，否则之后再也下不了
    BUSY.store(false, Ordering::SeqCst);
    result
}

async fn save_as_inner(app: &AppHandle, file: &str, suggested_name: &str) -> Value {
    let default_name = if suggested_name.is_empty() {
        file
    } else {
        suggested_name
    };
    let ext = Path::new(file)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let spec = DialogSpec::save("Save as", default_name, ext)
        .filter("EveJS downloads", &["zip", "torrent"]);
    let target = match dialog::pick(app, spec).await {
        Ok(Some(path)) => path,
        Ok(None) => return json!({ "ok": false, "canceled": true }),
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    // 目标已存在就先删掉：`net::download_cancellable` 会把已有文件当「半截包」接着下，
    // 而这里承诺的是「另存为覆盖」—— 用户确认覆盖之后还拿旧文件的前缀拼，出来的包是坏的。
    // （启动器自更新保留续传，是因为它每次写同一个临时路径，语义不同。）
    let _ = std::fs::remove_file(&target);

    CANCEL.store(false, Ordering::SeqCst);
    let url = object_url(file);
    let file_name = file.to_string();
    let progress_path = target.to_string_lossy().to_string();
    let download_path: PathBuf = target.clone();
    let app_for_emit = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        net::download_cancellable(
            &url,
            &download_path,
            None,
            || CANCEL.load(Ordering::SeqCst),
            |received, total| {
                let _ = app_for_emit.emit(
                    PROGRESS_EVENT,
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

    let path_text = target.to_string_lossy().to_string();
    match outcome {
        Ok(Ok(done)) => json!({ "ok": true, "path": path_text, "bytes": done.bytes }),
        Ok(Err(reason)) => {
            // 半截包一律不留（取消也一样）：用户要的是「这个文件」，
            // 留个残缺的同名包在盘上只会被当成下好了 —— 下次解压才发现是坏的。
            let _ = std::fs::remove_file(&target);
            if reason == net::CANCELLED {
                json!({ "ok": false, "canceled": true })
            } else {
                json!({ "ok": false, "reason": reason })
            }
        }
        Err(err) => {
            let _ = std::fs::remove_file(&target);
            json!({ "ok": false, "reason": format!("后台任务失败：{err}") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_a_single_path_segment() {
        assert_eq!(
            safe_file_name("EveJS-261028.1.zip"),
            Some("EveJS-261028.1.zip")
        );
        assert_eq!(
            safe_file_name("EVE Online - 3396210.zip.torrent"),
            Some("EVE Online - 3396210.zip.torrent")
        );
        assert_eq!(safe_file_name("  EveJS.zip  "), Some("EveJS.zip"));
        for bad in [
            "",
            "   ",
            "../secret.zip",
            "..",
            "a/b.zip",
            "a\\b.zip",
            "C:\\Windows\\evil.zip",
            "a:b.zip",
            "a|b.zip",
            "a*b.zip",
            "a?b.zip",
            "a<b.zip",
            "a>b.zip",
        ] {
            assert_eq!(safe_file_name(bad), None, "{bad} 应被拒绝");
        }
        assert_eq!(safe_file_name(&"a".repeat(201)), None, "过长名字应被拒绝");
    }

    #[test]
    fn url_is_built_from_the_fixed_bucket() {
        assert_eq!(
            object_url("EveJS-261028.1.zip"),
            "https://evejs.5318.cm/down/EveJS-261028.1.zip"
        );
        // 种子名里的空格必须转义（%20），与渲染层的 encodeURIComponent 同口径
        assert_eq!(
            object_url("EVE Online - 3396210.zip.torrent"),
            "https://evejs.5318.cm/down/EVE%20Online%20-%203396210.zip.torrent"
        );
    }
}
