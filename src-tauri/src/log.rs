//! 服务端日志读取：对齐现役版 log:read（server/logs/server.log 尾部 5000 行）。
//!
//! 候选顺序也照搬现役版 ipc.ts（便携版目录 → exe 目录 → cwd → 仓库根）：
//! 便携版把 exe 和 server/ 放在同一层，四种写法通常指向同一文件，
//! 但用户把 exe 丢到别处时，这个顺序决定了能否找到真实日志。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn server_log_path(repo_root: &Path) -> std::path::PathBuf {
    let candidates = server_log_candidates(repo_root);
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// 与现役版 serverLogPath() 的候选顺序逐条对应
pub fn server_log_candidates(repo_root: &Path) -> Vec<PathBuf> {
    let relative = Path::new("server").join("logs").join("server.log");
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = std::env::var_os("PORTABLE_EXECUTABLE_DIR") {
        if !dir.is_empty() {
            candidates.push(PathBuf::from(dir).join(&relative));
        }
    }
    // 现役版此处判 app.isPackaged；开发态（cargo run）跳过 exe 目录更贴近语义
    if !cfg!(debug_assertions) {
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
        {
            candidates.push(dir.join(&relative));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(&relative));
    }
    candidates.push(repo_root.join(&relative));
    candidates
}

pub fn read_server_log(repo_root: &Path) -> Value {
    let path = server_log_path(repo_root);
    let path_text = path.to_string_lossy().to_string();

    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(err) => {
            let missing = err.kind() == std::io::ErrorKind::NotFound;
            return json!({
                "ok": missing,
                "path": path_text,
                "exists": false,
                "size": 0,
                "mtime": 0,
                "lines": [],
                "reason": if missing { Value::Null } else { Value::String(err.to_string()) }
            });
        }
    };

    if !meta.is_file() {
        return json!({
            "ok": true, "path": path_text, "exists": false, "size": 0, "mtime": 0, "lines": []
        });
    }

    let raw = std::fs::read(&path).unwrap_or_default();
    let text = String::from_utf8_lossy(&raw);
    let mut lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() > 5000 {
        lines = lines.split_off(lines.len() - 5000);
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0);

    json!({
        "ok": true,
        "path": path_text,
        "exists": true,
        "size": meta.len(),
        "mtime": mtime,
        "lines": lines
    })
}
