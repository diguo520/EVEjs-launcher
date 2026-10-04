//! 模组管理：对齐现役版 `src/main/modManager.ts` / `modSigner.ts` / `modPack.ts` /
//! `modScaffold.ts` / `modRegistry.ts` / `modSubmit.ts` 六个模块。
//!
//! 拆分方式（与 `docs/Tauri2迁移执行计划.md` §4 第 8–12 项一致）：
//!   - `sign.rs`      签名与信任表（Ed25519，纯函数 + 信任表）
//!   - `scan.rs`      目录扫描 / 清单校验 / 冲突鉴定
//!   - `plan.rs`      loader 注入顺序、启停、排序、卸载、README
//!   - `scaffold.rs`  模组脚手架与内置制作规范文档
//!   - `pkg.rs`       ZIP 打包 / 导入 / 覆盖安装
//!   - `desktop.rs`   系统对话框 / 资源管理器集成
//!   - `registry.rs`  模组市场索引与安装
//!   - `submit.rs`    提交台账与 GitHub 提交
//!   - `claim.rs`     作者身份丢失后的归属认领（重装系统后继续更新旧模组）
pub mod claim;
pub mod desktop;
pub mod pkg;
pub mod plan;
pub mod preflight;
pub mod ratings;
pub mod registry;
pub mod review;
pub mod scaffold;
pub mod scan;
pub mod sign;
pub mod submit;

/// `loader.js` 骨架正文：新机制（注入总线 · 方案 D）的默认写法
mod scaffold_loader;

use std::path::{Path, PathBuf};

/// 模组根目录：`<EveJS 根>/mods`
pub fn mods_root(repo_root: &Path) -> PathBuf {
    repo_root.join("mods")
}

/// 只接受简单目录名：先 trim（对齐现役版 `isSafeId` 的 `value.trim()`），
/// 再挡掉 `..`/路径分隔符/Windows 非法字符/控制字符/以点或空格结尾/超长。
///
/// 比现役版 `isSafeId` 更严的一点：额外拒绝 `: * ? " < > |` —— 这些是本函数要真的拿去
/// 建目录/写文件的，Windows 文件名规则必须守住（`isSafeId` 只管标识语义）。
/// 市场安装标记文件名（`.evejs-source.json`）：`scan` 读取、`registry` 写入、`plan` 断言，
/// 由本模块单一来源提供（S3 查重）。
pub const MOD_SOURCE_FILE: &str = ".evejs-source.json";

pub fn safe_folder_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return String::new();
    }
    if trimmed.contains('\\') || trimmed.contains('/') {
        return String::new();
    }
    if trimmed.contains(':') || trimmed.contains('*') || trimmed.contains('?') {
        return String::new();
    }
    if trimmed.contains('"')
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.contains('|')
    {
        return String::new();
    }
    if trimmed.chars().any(|ch| (ch as u32) < 0x20) {
        return String::new();
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return String::new();
    }
    if trimmed.len() > 128 {
        return String::new();
    }
    trimmed.to_string()
}

/// 现役版 `safeFolderName`：把非法字符的**连续段**换成单个 `-`、删掉控制字符、
/// 去掉首尾的点/空格、截断到 80 个字符。
///
/// 与 [`safe_folder_name`] 的分工：那个是「不合法就拒绝」，这个是「尽量救回一个可用名字」，
/// 现役版用它处理 README / ZIP 导入时的目录名（`toast` 里展示 `imported-folder`）。
pub fn sanitize_folder_name(value: &str) -> String {
    let mut out = String::new();
    let mut in_illegal_run = false;
    for ch in value.trim().chars() {
        let illegal = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if illegal {
            if !in_illegal_run {
                out.push('-');
                in_illegal_run = true;
            }
            continue;
        }
        in_illegal_run = false;
        if (ch as u32) < 0x20 {
            continue;
        }
        out.push(ch);
    }
    out.trim_matches(|ch| ch == '.' || ch == ' ')
        .chars()
        .take(80)
        .collect()
}

/// 词法归一化：去掉 `.` 与重复分隔符，解析 `..`（不碰磁盘，因此不解析符号链接）。
/// `..` 越过根/盘符时停止（`PathBuf::pop` 对根返回 false），不会把 `C:\` 弹成空串。
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 组件级包含判定：`child` 必须等于 `root` 或在 `root` 之下。
///
/// B1：现役版用字符串 `startsWith` 判越界，`mods-evil` 会被 `mods` 误放行；
/// 这里比较的是**路径组件**，因此 `E:\repo\mods-evil` 不会被 `E:\repo\mods` 判为子路径。
pub fn contains_path(root: &Path, child: &Path) -> bool {
    let root = normalize_lexical(root);
    let child = normalize_lexical(child);
    if root == child {
        return true;
    }
    child.starts_with(&root)
}

/// 把「用户/远端给的目录名」拼到 `root` 下，并断言结果没有逃出 `root`。
/// 不合法（名字非法、`..`/绝对路径/盘符、或逃出 root）一律返回 `None`。
pub fn join_within(root: &Path, name: &str) -> Option<PathBuf> {
    let safe = safe_folder_name(name);
    if safe.is_empty() {
        return None;
    }
    let candidate = root.join(&safe);
    contains_path(root, &candidate).then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_folder_name_rejects_path_semantics() {
        assert_eq!(safe_folder_name(" MyMod "), "MyMod");
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "trailing.",
            "ctrl\u{1}",
        ] {
            assert_eq!(safe_folder_name(bad), "", "{bad} 应被拒绝");
        }
        // 现役版 isSafeId 先 trim 再判定，所以首尾空白是可接受的（拿到的是 trim 后的名字）
        assert_eq!(safe_folder_name("trailing "), "trailing");
        assert_eq!(safe_folder_name(" leading"), "leading");
        assert_eq!(safe_folder_name(&"x".repeat(128)), "x".repeat(128));
        assert_eq!(safe_folder_name(&"x".repeat(129)), "");
    }

    #[test]
    fn mods_root_is_repo_mods() {
        assert!(mods_root(Path::new("E:\\repo")).ends_with("mods"));
    }

    #[test]
    fn contains_path_uses_components_not_string_prefix() {
        let root = Path::new("E:\\repo\\mods");
        // B1 回归：同级目录 mods-evil 与 mods 前缀相同，但必须判为越界
        assert!(!contains_path(root, Path::new("E:\\repo\\mods-evil")));
        assert!(contains_path(root, Path::new("E:\\repo\\mods\\demo")));
        assert!(contains_path(root, Path::new("E:\\repo\\mods")));
        // 归一路径：`.` 与 `..` 都不应造成误判
        assert!(contains_path(
            root,
            Path::new("E:\\repo\\mods\\.\\demo\\..\\demo")
        ));
        assert!(!contains_path(root, Path::new("E:\\repo\\mods\\..\\other")));
        assert!(!contains_path(root, Path::new("E:\\repo")));
    }

    #[test]
    fn join_within_rejects_escapes() {
        let root = Path::new("E:\\repo\\mods");
        for bad in [
            "..",
            ".",
            "..\\mods-evil",
            "../mods-evil",
            "E:\\evil",
            "a/b",
            "a\\b",
            "",
            "   ",
        ] {
            assert!(join_within(root, bad).is_none(), "{bad} 应被拒绝");
        }
        assert_eq!(join_within(root, " demo "), Some(root.join("demo")));
        assert_eq!(join_within(root, "demo"), Some(root.join("demo")));
    }

    #[test]
    fn sanitize_folder_name_matches_electron() {
        assert_eq!(sanitize_folder_name(" demo-mod "), "demo-mod");
        // 连续非法字符只换成一个 '-'
        assert_eq!(sanitize_folder_name("a//b:::c"), "a-b-c");
        // 首尾的点/空格被去掉，中间的点保留
        assert_eq!(sanitize_folder_name("..hidden.dir. "), "hidden.dir");
        // 控制字符直接删除（且不参与「连续段」合并）
        assert_eq!(sanitize_folder_name("a\u{1}/\u{2}b"), "a-b");
        assert_eq!(sanitize_folder_name(&"z".repeat(120)).len(), 80);
        assert_eq!(sanitize_folder_name(""), "");
    }
}
