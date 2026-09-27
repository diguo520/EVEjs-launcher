//! 模组页的桌面集成：打开 mods 目录 / 定位单个模组 / 选 ZIP 导入 / 另存为文本。
//!
//! 对齐现役版 `ipc.ts` 里的 `mods:openFolder` / `mods:openModFolder` /
//! `mods:importZip` / `mods:saveText` 四个 handler：它们自己不含业务逻辑，
//! 只是「弹系统对话框 / 调资源管理器」再转交给 `mods::pkg` 或 `mods::scan`。
use crate::dialog::{self, DialogSpec};
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

/// `mods:openFolder`：建好 mods 目录并在资源管理器里打开
pub fn open_mods_folder(app: &AppHandle, repo_root: &Path) -> Value {
    let root = crate::mods::mods_root(repo_root);
    // 目录可能已存在；建不出来也要继续尝试打开（对齐现役版 try/catch 后继续）
    let _ = fs::create_dir_all(&root);
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_path(root.to_string_lossy(), None::<&str>) {
        Ok(()) => json!({ "ok": true, "root": root.to_string_lossy() }),
        Err(err) => json!({
            "ok": false,
            "reason": err.to_string(),
            "root": root.to_string_lossy()
        }),
    }
}

/// `mods:openModFolder`：在资源管理器里选中某个模组目录
pub fn open_mod_folder(repo_root: &Path, folder: &str) -> Value {
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "目录名非法" });
    };
    if !dir.exists() {
        return json!({ "ok": false, "reason": format!("目录不存在：{}", dir.display()) });
    }
    match shell::reveal_in_explorer(&dir) {
        Ok(()) => json!({ "ok": true, "dir": dir.to_string_lossy() }),
        Err(reason) => json!({ "ok": false, "reason": reason, "dir": dir.to_string_lossy() }),
    }
}

/// `mods:importZip`：弹「打开文件」选 ZIP 再导入。
///
/// 取消 → `{ok:false, canceled:true}`（渲染层据此不弹错误提示）。
pub async fn import_zip(app: &AppHandle, repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let spec = DialogSpec::open("Import mod ZIP").filter("Mod ZIP", &["zip"]);
    match dialog::pick(app, spec).await {
        Ok(None) => json!({ "ok": false, "canceled": true }),
        Ok(Some(path)) => super::pkg::import_mod_zip(repo_root, &path.to_string_lossy(), runtime),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// `mods:saveText`：弹「另存为」把文本写到用户选的位置。
///
/// 扩展名补全交给 Win32（`lpstrDefExt`）：用户没写扩展名时系统补 `.txt`，
/// 写了 `.csv` / `.json` 就照用户的选择 —— 与现役版 Electron 的行为一致。
pub async fn save_text(app: &AppHandle, default_name: &str, content: &str) -> Value {
    let name = default_name.trim();
    let spec = DialogSpec::save(
        "Save text",
        if name.is_empty() { "export.txt" } else { name },
        "txt",
    )
    .filter("Text", &["txt", "csv", "json"]);
    let target = match dialog::pick(app, spec).await {
        Ok(Some(path)) => path,
        Ok(None) => return json!({ "ok": false, "canceled": true }),
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    match fs::write(&target, content) {
        Ok(()) => json!({ "ok": true, "path": target.to_string_lossy() }),
        Err(err) => json!({ "ok": false, "reason": err.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_mod_folder_rejects_path_semantics() {
        let root = std::env::temp_dir().join("evejs-mods-desktop-repo");
        for bad in ["", "   ", "a/b", "a\\b"] {
            let value = open_mod_folder(&root, bad);
            assert_eq!(value["reason"], json!("目录名非法"), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn open_mod_folder_reports_missing_directory() {
        let root = std::env::temp_dir().join("evejs-mods-desktop-repo");
        let value = open_mod_folder(&root, "not-installed");
        assert_eq!(value["ok"], json!(false));
        assert!(value["reason"]
            .as_str()
            .unwrap()
            .starts_with("目录不存在："));
    }
}
