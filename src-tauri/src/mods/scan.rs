//! 模组扫描 / 清单校验 / 冲突鉴定：对齐现役版 `src/main/modManager.ts`（扫描部分）。
//!
//! schema 3 清单（`evejs-launcher.mod.json`）的校验规则、错误文案、冲突分类
//! （duplicate-id / declared / shared-module / missing-require）都逐条照搬，
//! 因为渲染层直接展示这些文案，且注入拦截（`planLoaders`）依赖 `valid` 与
//! `signatureState` 的组合语义。
use crate::mods::{plan, sign};
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const MANIFEST_NAME: &str = "evejs-launcher.mod.json";
/// 来源标记：从市场安装时写入，用来区分「本机创建」与「模组市场」
pub use super::MOD_SOURCE_FILE;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const KINDS: [&str; 4] = ["loader", "source-integrated", "client-package", "settings"];
const RESTART_VALUES: [&str; 4] = ["none", "game_server", "client", "launcher"];
pub const LOADER_ENABLED: &str = "loader.js";
pub const LOADER_DISABLED: &str = "loader.js.disabled";
pub const LOADER_DISABLED_ALT: [&str; 2] = ["loader.js.off", "loader.js.bak"];
const DEPENDENCY_FIELDS: [&str; 4] = ["requires", "loadAfter", "loadBefore", "conflicts"];
/// 统计模块引用时忽略的通用文件名
const IGNORED_MODULE_TOKENS: [&str; 5] = [
    "index.js",
    "main.js",
    "loader.js",
    "helper.js",
    "package.json",
];

/* ------------------------------ 基础判定 ------------------------------ */

/// 现役版 `isPlainText(value, max)`：trim 后长度在 1..=max
pub fn is_plain_text(value: &str, max: usize) -> bool {
    let trimmed = value.trim();
    let len = trimmed.chars().count();
    len > 0 && len <= max
}

/// 现役版 `isSafeId`：trim 后再判定，仅用于标识与依赖引用
pub fn is_safe_id(value: &str) -> bool {
    if !is_plain_text(value, 128) {
        return false;
    }
    let id = value.trim();
    if id.contains('\\') || id.contains('/') {
        return false;
    }
    if id == "." || id == ".." {
        return false;
    }
    if id.chars().any(|ch| (ch as u32) < 0x20) {
        return false;
    }
    if id.ends_with('.') || id.ends_with(' ') {
        return false;
    }
    true
}

/// 现役版 `readDependencyArray`：≤64 项、每项 ≤128 字符、大小写不敏感查重
fn read_dependency_array(
    manifest: &Map<String, Value>,
    field: &str,
) -> Result<Vec<String>, String> {
    let Some(raw) = manifest.get(field) else {
        return Ok(Vec::new());
    };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = raw.as_array() else {
        return Err(format!("{field} 必须是数组且最多 64 项"));
    };
    if items.len() > 64 {
        return Err(format!("{field} 必须是数组且最多 64 项"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(format!("{field} 里的 id 非法"));
        };
        if !is_plain_text(text, 128) {
            return Err(format!("{field} 里的 id 非法"));
        }
        let key = text.trim().to_lowercase();
        if seen.contains(&key) {
            return Err(format!("{field} 存在重复 id"));
        }
        seen.push(key);
        out.push(text.trim().to_string());
    }
    Ok(out)
}

/* ------------------------------ 目录统计 ------------------------------ */

/// 一次遍历同时算出占用字节数与「最新改动时间」（卡片上的更新时间用它）
pub fn dir_stats(dir: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut newest = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let full = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            let (sub_bytes, sub_newest) = dir_stats(&full);
            bytes += sub_bytes;
            if sub_newest > newest {
                newest = sub_newest;
            }
        } else if meta.is_file() {
            bytes += meta.len();
            if let Ok(modified) = meta.modified() {
                let ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as u64)
                    .unwrap_or(0);
                if ms > newest {
                    newest = ms;
                }
            }
        }
    }
    (bytes, newest)
}

/// 启发式扫描 loader 源码：取形如 `"xxx.js"` 的字符串字面量。
///
/// 等价于现役版的正则（引号 + [A-Za-z0-9_.-]+ + ".js" + 引号，三种引号都算），
/// 手写字符扫描即可，避免为这一处引入 regex 依赖。
fn scan_loader_modules(dir: &Path) -> Vec<String> {
    let mut candidates: Vec<PathBuf> = vec![dir.join(LOADER_ENABLED)];
    candidates.extend(LOADER_DISABLED_ALT.iter().map(|name| dir.join(name)));
    candidates.push(dir.join(LOADER_DISABLED));
    let Some(file) = candidates.into_iter().find(|path| path.is_file()) else {
        return Vec::new();
    };
    let Ok(source) = fs::read_to_string(&file) else {
        return Vec::new();
    };

    const TOKEN_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-";
    let bytes = source.as_bytes();
    let mut found: Vec<String> = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let quote = bytes[index];
        if quote != b'"' && quote != b'\'' && quote != b'`' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && TOKEN_CHARS.contains(&bytes[end]) {
            end += 1;
        }
        let closed =
            end < bytes.len() && (bytes[end] == b'"' || bytes[end] == b'\'' || bytes[end] == b'`');
        if closed {
            let token = &source[start..end];
            if token.len() >= 5 && token.ends_with(".js") {
                let lower = token.to_ascii_lowercase();
                if !IGNORED_MODULE_TOKENS.contains(&lower.as_str())
                    && !found.contains(&token.to_string())
                {
                    found.push(token.to_string());
                }
            }
        }
        index = if end > index { end } else { index + 1 };
    }
    found.sort();
    found
}
/* ------------------------------ 单条模组记录 ------------------------------ */

#[derive(Debug, Clone)]
pub struct ModRecord {
    pub folder: String,
    pub dir: PathBuf,
    pub manifest_path: PathBuf,
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub kind: String,
    pub restart: String,
    pub strategy: String,
    pub supported: bool,
    pub unsupported_reason: String,
    pub enabled: bool,
    pub loader_file: Option<String>,
    pub requires: Vec<String>,
    pub load_after: Vec<String>,
    pub load_before: Vec<String>,
    pub conflicts: Vec<String>,
    pub missing_requires: Vec<String>,
    pub active_conflicts: Vec<String>,
    pub valid: bool,
    pub error: String,
    pub size_bytes: u64,
    pub updated_at: u64,
    pub modules: Vec<String>,
    pub signature_state: String,
    pub signature_error: String,
    pub signature_key_id: String,
    pub signature_trusted: bool,
    pub author_id: String,
    pub author_name: String,
    pub category: String,
    pub tags: Vec<String>,
    pub source: String,
    pub source_repo: String,
    pub source_version: String,
    /// `README.md` 里的正文（「## 详细介绍」按空行拆成的段落）
    pub readme: Vec<String>,
    /// `README.md` 里「## 功能要点」的条目
    pub highlights: Vec<String>,
}

impl ModRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "folder": self.folder,
            "dir": self.dir.to_string_lossy(),
            "manifestPath": self.manifest_path.to_string_lossy(),
            "id": self.id,
            "displayName": self.display_name,
            "version": self.version,
            "description": self.description,
            "kind": self.kind,
            "restart": self.restart,
            "strategy": self.strategy,
            "supported": self.supported,
            "unsupportedReason": self.unsupported_reason,
            "enabled": self.enabled,
            "loaderFile": self.loader_file,
            "requires": self.requires,
            "loadAfter": self.load_after,
            "loadBefore": self.load_before,
            "conflicts": self.conflicts,
            "missingRequires": self.missing_requires,
            "activeConflicts": self.active_conflicts,
            "valid": self.valid,
            "error": self.error,
            "sizeBytes": self.size_bytes,
            "updatedAt": self.updated_at,
            "modules": self.modules,
            "signatureState": self.signature_state,
            "signatureError": self.signature_error,
            "signatureKeyId": self.signature_key_id,
            "signatureTrusted": self.signature_trusted,
            "authorId": self.author_id,
            "authorName": self.author_name,
            "category": self.category,
            "tags": self.tags,
            "source": self.source,
            "sourceRepo": self.source_repo,
            "sourceVersion": self.source_version,
            "readme": self.readme,
            "highlights": self.highlights,
        })
    }
}

fn empty_record(folder: &str, dir: &Path, manifest_path: &Path, error: &str) -> ModRecord {
    ModRecord {
        folder: folder.to_string(),
        dir: dir.to_path_buf(),
        manifest_path: manifest_path.to_path_buf(),
        id: folder.to_string(),
        display_name: folder.to_string(),
        version: String::new(),
        description: String::new(),
        kind: "loader".to_string(),
        restart: String::new(),
        strategy: String::new(),
        supported: false,
        unsupported_reason: String::new(),
        enabled: false,
        loader_file: None,
        requires: Vec::new(),
        load_after: Vec::new(),
        load_before: Vec::new(),
        conflicts: Vec::new(),
        missing_requires: Vec::new(),
        active_conflicts: Vec::new(),
        valid: false,
        error: error.to_string(),
        size_bytes: 0,
        updated_at: 0,
        modules: Vec::new(),
        signature_state: "none".to_string(),
        signature_error: String::new(),
        signature_key_id: String::new(),
        signature_trusted: false,
        author_id: String::new(),
        author_name: String::new(),
        category: String::new(),
        tags: Vec::new(),
        source: "local".to_string(),
        source_repo: String::new(),
        source_version: String::new(),
        readme: Vec::new(),
        highlights: Vec::new(),
    }
}

/// 读清单：`Err` 就是直接展示给用户的原因文案（对齐现役版 `readManifest`）
pub fn read_manifest(manifest_path: &Path) -> Result<Map<String, Value>, String> {
    let Ok(meta) = fs::metadata(manifest_path) else {
        return Err(format!("缺少 {MANIFEST_NAME}"));
    };
    if !meta.is_file() {
        return Err(format!("{MANIFEST_NAME} 不是文件"));
    }
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(format!("{MANIFEST_NAME} 超过 1 MiB"));
    }
    let Ok(raw) = fs::read_to_string(manifest_path) else {
        return Err(format!("{MANIFEST_NAME} 读取失败"));
    };
    let text = raw.trim_start_matches('\u{feff}');
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Err("清单 JSON 解析失败: 不是合法 JSON".to_string());
    };
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err("清单必须是 JSON 对象".to_string()),
    }
}

/// 读取市场安装标记（不存在就是本机创建/导入）
fn read_mod_source(dir: &Path) -> (String, String, String) {
    let fallback = ("local".to_string(), String::new(), String::new());
    let Ok(raw) = fs::read_to_string(dir.join(MOD_SOURCE_FILE)) else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return fallback;
    };
    if parsed.get("source").and_then(Value::as_str) != Some("market") {
        return fallback;
    }
    (
        "market".to_string(),
        parsed
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        parsed
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}
/// 读取单个模组目录（校验 manifest schema 3）
pub fn read_mod_dir(folder: &str, dir: &Path) -> ModRecord {
    let manifest_path = dir.join(MANIFEST_NAME);
    let manifest = match read_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => return empty_record(folder, dir, &manifest_path, &error),
    };

    let mut record = empty_record(folder, dir, &manifest_path, "");
    let mut problems: Vec<String> = Vec::new();

    if manifest.get("schemaVersion").and_then(Value::as_i64) != Some(3) {
        let shown = manifest
            .get("schemaVersion")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "undefined".to_string());
        problems.push(format!("schemaVersion 必须是 3（当前 {shown}）"));
    }
    let manifest_id = manifest.get("id").and_then(Value::as_str).unwrap_or("");
    if !is_safe_id(manifest_id) {
        problems.push("id 缺失或非法（≤128 字符、不能含路径分隔符）".to_string());
    }
    let display_name = manifest
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_plain_text(display_name, 100) {
        problems.push("displayName 缺失或超长（≤100）".to_string());
    }
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_plain_text(version, 64) {
        problems.push("version 缺失或超长（≤64）".to_string());
    }
    if let Some(description) = manifest.get("description") {
        let ok = description
            .as_str()
            .map(|text| text.chars().count() <= 1000)
            .unwrap_or(false);
        if !ok {
            problems.push("description 超长（≤1000）".to_string());
        }
    }
    let kind = manifest.get("kind").and_then(Value::as_str).unwrap_or("");
    if !KINDS.contains(&kind) {
        problems.push(format!("kind 必须是 {}", KINDS.join(" / ")));
    }
    let restart = manifest
        .get("restart")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !RESTART_VALUES.contains(&restart) {
        problems.push(format!("restart 必须是 {}", RESTART_VALUES.join(" / ")));
    }
    let strategy = manifest
        .get("activation")
        .and_then(Value::as_object)
        .and_then(|activation| activation.get("strategy"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if strategy.is_empty() {
        problems.push("缺少 activation.strategy".to_string());
    }

    let mut deps: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for field in DEPENDENCY_FIELDS {
        match read_dependency_array(&manifest, field) {
            Ok(values) => {
                deps.insert(field, values);
            }
            Err(error) => {
                problems.push(error);
                deps.insert(field, Vec::new());
            }
        }
    }

    record.id = if is_safe_id(manifest_id) {
        manifest_id.trim().to_string()
    } else {
        folder.to_string()
    };
    record.display_name = if is_plain_text(display_name, 100) {
        display_name.trim().to_string()
    } else {
        folder.to_string()
    };
    record.version = version.trim().to_string();
    record.description = manifest
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    record.kind = if KINDS.contains(&kind) {
        kind.to_string()
    } else {
        "loader".to_string()
    };
    record.restart = restart.to_string();
    record.strategy = strategy.to_string();
    record.requires = deps.get("requires").cloned().unwrap_or_default();
    record.load_after = deps.get("loadAfter").cloned().unwrap_or_default();
    record.load_before = deps.get("loadBefore").cloned().unwrap_or_default();
    record.conflicts = deps.get("conflicts").cloned().unwrap_or_default();

    let self_id = record.id.to_lowercase();
    for field in DEPENDENCY_FIELDS {
        let values = deps.get(field).cloned().unwrap_or_default();
        if values.iter().any(|value| value.to_lowercase() == self_id) {
            problems.push(format!("{field} 不能引用自己"));
        }
    }

    let enabled_loader = dir.join(LOADER_ENABLED);
    let has_enabled = enabled_loader.is_file();
    let mut disabled_name = LOADER_DISABLED_ALT
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file());
    if disabled_name.is_none() && dir.join(LOADER_DISABLED).is_file() {
        disabled_name = Some(dir.join(LOADER_DISABLED));
    }
    record.enabled = record.kind == "loader" && has_enabled;

    // M1 只实现 loader + loader_rename；其它 kind 明确标注「暂不支持」，绝不假装成功
    if record.kind == "loader" {
        if record.strategy != "loader_rename" {
            record.supported = false;
            record.unsupported_reason = "activation.strategy 必须是 loader_rename".to_string();
        } else if !has_enabled && disabled_name.is_none() {
            record.supported = false;
            record.unsupported_reason = "缺少 loader.js / loader.js.disabled".to_string();
        } else {
            record.supported = true;
        }
        if has_enabled {
            record.loader_file = Some(enabled_loader.to_string_lossy().to_string());
        }
    } else {
        record.supported = false;
        record.unsupported_reason = match record.kind.as_str() {
            "settings" => "settings 类型需要 launcher 1.0.x 的 settings 表单（M2）",
            "client-package" => "client-package 需要 helper verify/install（M2）",
            _ => "source-integrated 需要助手脚本操作服务端源码（M2）",
        }
        .to_string();
    }

    let author_block = manifest.get("author").and_then(Value::as_object);
    record.author_id = author_block
        .and_then(|block| block.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    record.author_name = author_block
        .and_then(|block| block.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    record.category = manifest
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    record.tags = manifest
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|tag| tag.to_string())
                .collect()
        })
        .unwrap_or_default();

    // 作者自签名的清单会带上自己的 publicKey（keyId 必须与签名一致），
    // 先注入信任表，下载方才能验证作者签名；没带 publicKey 的旧包仍按原逻辑处理。
    let signature_key_id = manifest
        .get("signature")
        .and_then(Value::as_object)
        .and_then(|block| block.get("keyId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let author_key_id = author_block
        .and_then(|block| block.get("keyId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let author_public_key = author_block
        .and_then(|block| block.get("publicKey"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !signature_key_id.is_empty()
        && !author_public_key.is_empty()
        && (author_key_id.is_empty() || author_key_id == signature_key_id)
    {
        sign::trust_public_key(&signature_key_id, &author_public_key);
    }

    let verdict = sign::verify_manifest_signature(&Value::Object(manifest));
    record.signature_state = verdict.state.as_str().to_string();
    record.signature_error = verdict.reason;
    record.signature_key_id = verdict.key_id;
    record.signature_trusted = verdict.trusted;

    record.valid = problems.is_empty();
    record.error = problems.join("；");
    if !record.valid {
        record.supported = false;
    }
    let (bytes, newest) = dir_stats(dir);
    record.size_bytes = bytes;
    record.updated_at = newest;
    record.modules = if record.kind == "loader" {
        scan_loader_modules(dir)
    } else {
        Vec::new()
    };
    let (source, source_repo, source_version) = read_mod_source(dir);
    record.source = source;
    record.source_repo = source_repo;
    record.source_version = source_version;
    record
}
/* ------------------------------ 冲突鉴定 ------------------------------ */

#[derive(Debug, Clone)]
pub struct ModConflict {
    pub kind: String,
    pub folders: Vec<String>,
    pub detail: String,
    pub i18n_key: String,
    pub i18n_args: Vec<String>,
    pub active: bool,
}

impl ModConflict {
    fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "folders": self.folders,
            "detail": self.detail,
            "i18nKey": self.i18n_key,
            "i18nArgs": self.i18n_args,
            "active": self.active,
        })
    }
}

/// 冲突鉴定：声明互斥 + 重复 id + 引用同一服务端模块 + 依赖缺失
fn detect_conflicts(mods: &[ModRecord]) -> Vec<ModConflict> {
    let mut conflicts: Vec<ModConflict> = Vec::new();

    // 用「有序分组」而不是 BTreeMap：现役版用的是 Map 的插入序，输出顺序要一致
    let mut by_id: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, item) in mods.iter().enumerate() {
        let key = item.id.to_lowercase();
        match by_id.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, indices)) => indices.push(index),
            None => by_id.push((key, vec![index])),
        }
    }

    for (id, indices) in &by_id {
        if indices.len() > 1 {
            conflicts.push(ModConflict {
                kind: "duplicate-id".to_string(),
                folders: indices.iter().map(|i| mods[*i].folder.clone()).collect(),
                detail: format!("有 {} 个模组使用了同一个 id「{id}」", indices.len()),
                i18n_key: "conflict.duplicateId".to_string(),
                i18n_args: vec![indices.len().to_string(), id.clone()],
                active: indices.iter().filter(|i| mods[**i].enabled).count() > 1,
            });
        }
    }

    let lookup = |id: &str| -> Option<usize> {
        let key = id.to_lowercase();
        by_id
            .iter()
            .find(|(existing, _)| *existing == key)
            .and_then(|(_, indices)| indices.first().copied())
    };

    let mut declared_seen: Vec<String> = Vec::new();
    for item in mods {
        for target_id in &item.conflicts {
            let Some(target_index) = lookup(target_id) else {
                continue;
            };
            let target = &mods[target_index];
            let mut pair = [item.folder.clone(), target.folder.clone()];
            pair.sort();
            let pair_key = pair.join("|");
            if declared_seen.contains(&pair_key) {
                continue;
            }
            declared_seen.push(pair_key);
            conflicts.push(ModConflict {
                kind: "declared".to_string(),
                folders: vec![item.folder.clone(), target.folder.clone()],
                detail: "清单里声明了互斥".to_string(),
                i18n_key: "conflict.declared".to_string(),
                i18n_args: Vec::new(),
                active: item.enabled && target.enabled,
            });
        }
    }

    for i in 0..mods.len() {
        for j in (i + 1)..mods.len() {
            let shared: Vec<String> = mods[i]
                .modules
                .iter()
                .filter(|name| mods[j].modules.contains(name))
                .cloned()
                .collect();
            if shared.is_empty() {
                continue;
            }
            conflicts.push(ModConflict {
                kind: "shared-module".to_string(),
                folders: vec![mods[i].folder.clone(), mods[j].folder.clone()],
                detail: format!("都引用了服务端模块 {}（可能互相影响）", shared.join(", ")),
                i18n_key: "conflict.sharedModule".to_string(),
                i18n_args: vec![shared.join(", ")],
                active: mods[i].enabled && mods[j].enabled,
            });
        }
    }

    for item in mods {
        if item.enabled && !item.missing_requires.is_empty() {
            conflicts.push(ModConflict {
                kind: "missing-require".to_string(),
                folders: vec![item.folder.clone()],
                detail: format!("缺少依赖 {}", item.missing_requires.join(", ")),
                i18n_key: "conflict.missingRequire".to_string(),
                i18n_args: vec![item.missing_requires.join(", ")],
                active: true,
            });
        }
    }

    conflicts
}

/* ------------------------------ 整体扫描 ------------------------------ */

pub struct ModScanResult {
    pub root: PathBuf,
    pub exists: bool,
    pub mods: Vec<ModRecord>,
    pub conflicts: Vec<ModConflict>,
    /// 用户自定义排序（模组目录名数组）
    pub order: Vec<String>,
}

impl ModScanResult {
    pub fn stats_json(&self) -> Value {
        json!({
            "total": self.mods.len(),
            "enabled": self.mods.iter().filter(|item| item.enabled).count(),
            "disabled": self.mods.iter().filter(|item| !item.enabled).count(),
            "conflicts": self.conflicts.iter().filter(|item| item.active).count(),
            "bytes": self.mods.iter().map(|item| item.size_bytes).sum::<u64>(),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "ok": true,
            "root": self.root.to_string_lossy(),
            "exists": self.exists,
            "mods": self.mods.iter().map(ModRecord::to_json).collect::<Vec<_>>(),
            "stats": self.stats_json(),
            "conflicts": self.conflicts.iter().map(ModConflict::to_json).collect::<Vec<_>>(),
            "order": self.order,
        })
    }
}

fn empty_scan(root: PathBuf) -> ModScanResult {
    ModScanResult {
        root,
        exists: false,
        mods: Vec::new(),
        conflicts: Vec::new(),
        order: Vec::new(),
    }
}

/// 扫描 `<EveJS 根>/mods`（排序文件在 `_launcher/mods`，所以要 runtime）
pub fn scan_mods(repo_root: &Path, runtime: &RuntimePaths) -> ModScanResult {
    let root = crate::mods::mods_root(repo_root);
    let mut result = empty_scan(root.clone());
    if !root.is_dir() {
        return result;
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return result;
    };
    result.exists = true;

    let mut by_id: BTreeMap<String, usize> = BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_dir() || name.starts_with('.') {
            continue;
        }
        // 没有清单的目录不是模组（可能是 .git / 文档 / 杂物目录），忽略
        if !entry.path().join(MANIFEST_NAME).is_file() {
            continue;
        }
        let mut record = read_mod_dir(&name, &entry.path());
        // README 正文与功能要点跟着 `mods:list` 一起回（复用提交时那套解析）：
        // 作者改完信息、或本机草稿还没上架时，详情页也要能立刻看到内容，
        // 不能等索引刷新 —— 索引要审核合并之后才更新。
        let (readme, highlights) = super::submit::readme_for_listing(repo_root, &name);
        record.readme = readme;
        record.highlights = highlights;
        by_id.insert(record.id.to_lowercase(), result.mods.len());
        result.mods.push(record);
    }

    // 依赖/冲突检查（只做提示与注入拦截，M2 再做完整 resolver）
    let snapshot: Vec<ModRecord> = result.mods.clone();
    for item in result.mods.iter_mut() {
        item.missing_requires = item
            .requires
            .iter()
            .filter(|id| match by_id.get(&id.to_lowercase()) {
                Some(index) => {
                    let target = &snapshot[*index];
                    !target.valid || !target.enabled
                }
                None => true,
            })
            .cloned()
            .collect();
        item.active_conflicts = item
            .conflicts
            .iter()
            .filter(|id| match by_id.get(&id.to_lowercase()) {
                Some(index) => snapshot[*index].enabled,
                None => false,
            })
            .cloned()
            .collect();
    }

    // 自定义排序优先，其余按显示名（系统区域排序，对齐 localeCompare）
    let order = plan::read_mod_order(runtime);
    let rank = |folder: &str| -> usize {
        order
            .iter()
            .position(|item| item == folder)
            .unwrap_or(usize::MAX)
    };
    result.mods.sort_by(|a, b| {
        let (ra, rb) = (rank(&a.folder), rank(&b.folder));
        if ra != rb {
            return ra.cmp(&rb);
        }
        shell::locale_compare(&a.display_name, &b.display_name)
    });

    result.order = result.mods.iter().map(|item| item.folder.clone()).collect();
    result.conflicts = detect_conflicts(&result.mods);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn runtime_for(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-scan-rt-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能建测试目录");
        RuntimePaths::from_root(dir, true)
    }

    fn repo_for(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-scan-repo-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("mods")).expect("应能建 mods 目录");
        dir
    }

    fn write_mod(repo: &Path, folder: &str, manifest: Value, loader: Option<&str>) {
        let dir = repo.join("mods").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        if let Some(source) = loader {
            fs::write(dir.join(LOADER_ENABLED), source).unwrap();
        }
    }

    fn manifest(id: &str, extra: Value) -> Value {
        let mut base = json!({
            "schemaVersion": 3,
            "id": id,
            "displayName": id,
            "version": "1.0.0",
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" }
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    #[test]
    fn is_safe_id_matches_electron() {
        assert!(is_safe_id("demo-mod"));
        assert!(is_safe_id("  demo  "));
        for bad in ["", "   ", "a/b", "a\\b", ".", "..", "trailing.", "a\u{1}b"] {
            assert!(!is_safe_id(bad), "{bad} 应被拒绝");
        }
        // 现役版先 trim 再判定，所以首尾空白本身不算非法（用的是 trim 后的 id）
        assert!(is_safe_id("trailing "));
        assert!(!is_safe_id(&"x".repeat(129)));
        assert!(is_safe_id(&"x".repeat(128)));
    }

    #[test]
    fn dependency_arrays_reject_bad_shapes() {
        let mut good = Map::new();
        good.insert("requires".to_string(), json!(["One", "two"]));
        assert_eq!(
            read_dependency_array(&good, "requires").unwrap(),
            vec!["One".to_string(), "two".to_string()]
        );

        let mut dup = Map::new();
        dup.insert("requires".to_string(), json!(["one", "ONE"]));
        assert!(read_dependency_array(&dup, "requires")
            .unwrap_err()
            .contains("重复"));

        let mut too_many = Map::new();
        too_many.insert(
            "requires".to_string(),
            json!((0..65).map(|i| format!("m{i}")).collect::<Vec<_>>()),
        );
        assert!(read_dependency_array(&too_many, "requires")
            .unwrap_err()
            .contains("64"));

        let mut wrong_type = Map::new();
        wrong_type.insert("requires".to_string(), json!("nope"));
        assert!(read_dependency_array(&wrong_type, "requires").is_err());
        assert!(read_dependency_array(&Map::new(), "requires")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn loader_modules_are_extracted_like_the_regex() {
        let dir = std::env::temp_dir().join("evejs-scan-modules");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(LOADER_ENABLED),
            "const a = require(\"inventory.js\");\n\
             const b = require('market.js');\n\
             const c = require(\"index.js\");\n\
             const d = require(\"ab\");\n\
             const e = require(\"loader.js\");\n\
             const f = require(\"deep/thing.js\");\n\
             const g = require(\"./skipped.js\");\n",
        )
        .unwrap();
        assert_eq!(
            scan_loader_modules(&dir),
            vec!["inventory.js".to_string(), "market.js".to_string()]
        );

        // 禁用态也要能扫到：loader.js.disabled / .off / .bak 都是候选
        fs::remove_file(dir.join(LOADER_ENABLED)).unwrap();
        fs::write(dir.join(LOADER_DISABLED), "require(\"chat.js\");").unwrap();
        assert_eq!(scan_loader_modules(&dir), vec!["chat.js".to_string()]);
    }

    #[test]
    fn dir_stats_walks_recursively() {
        let dir = std::env::temp_dir().join("evejs-scan-stats");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.txt"), vec![b'x'; 10]).unwrap();
        fs::write(dir.join("nested").join("b.txt"), vec![b'y'; 25]).unwrap();
        let (bytes, newest) = dir_stats(&dir);
        assert_eq!(bytes, 35);
        assert!(newest > 1_600_000_000_000, "应拿到 mtime：{newest}");
    }

    #[test]
    fn read_mod_dir_reports_schema_problems() {
        let repo = repo_for("schema");
        let dir = repo.join("mods").join("bad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_NAME),
            json!({
                "schemaVersion": 2,
                "id": "bad/mod",
                "displayName": "",
                "version": "",
                "description": "x".repeat(1001),
                "kind": "weird",
                "restart": "sometimes",
                "activation": {},
                "requires": ["bad"]
            })
            .to_string(),
        )
        .unwrap();
        let record = read_mod_dir("bad", &dir);
        assert!(!record.valid);
        for fragment in [
            "schemaVersion 必须是 3",
            "id 缺失或非法",
            "displayName 缺失或超长",
            "version 缺失或超长",
            "description 超长",
            "kind 必须是",
            "restart 必须是",
            "缺少 activation.strategy",
            "requires 不能引用自己",
        ] {
            assert!(
                record.error.contains(fragment),
                "缺 {fragment}：{}",
                record.error
            );
        }
        // 失效清单不给任何注入机会
        assert!(!record.supported);
        assert_eq!(record.id, "bad", "非法 id 回退成目录名");
        assert_eq!(record.display_name, "bad");
        assert_eq!(record.kind, "loader");
        assert_eq!(record.signature_state, "none");
    }

    #[test]
    fn scan_mods_classifies_conflicts_and_stats() {
        let repo = repo_for("conflicts");
        // 两个同 id 且共享模块，都启用
        write_mod(
            &repo,
            "alpha",
            manifest("dup", json!({ "displayName": "Alpha" })),
            Some("require(\"inventory.js\");"),
        );
        write_mod(
            &repo,
            "beta",
            manifest("DUP", json!({ "displayName": "beta" })),
            Some("require(\"inventory.js\");"),
        );
        // 声明互斥 + 缺依赖
        write_mod(
            &repo,
            "gamma",
            manifest(
                "gamma",
                json!({ "displayName": "Gamma", "conflicts": ["dup"], "requires": ["ghost"] }),
            ),
            Some("require(\"market.js\");"),
        );
        // 没有清单的目录必须被忽略；点开头的目录也忽略
        fs::create_dir_all(repo.join("mods").join("docs")).unwrap();
        fs::create_dir_all(repo.join("mods").join(".git")).unwrap();

        let runtime = runtime_for("conflicts");
        let result = scan_mods(&repo, &runtime);
        assert!(result.exists);
        assert_eq!(result.mods.len(), 3, "只收有清单的非点目录");
        assert_eq!(result.order.len(), 3);

        let kinds: Vec<String> = result.conflicts.iter().map(|c| c.kind.clone()).collect();
        assert!(kinds.contains(&"duplicate-id".to_string()), "{kinds:?}");
        assert!(kinds.contains(&"shared-module".to_string()), "{kinds:?}");
        assert!(kinds.contains(&"declared".to_string()), "{kinds:?}");
        assert!(kinds.contains(&"missing-require".to_string()), "{kinds:?}");

        let gamma = result.mods.iter().find(|m| m.folder == "gamma").unwrap();
        assert_eq!(gamma.missing_requires, vec!["ghost".to_string()]);
        assert_eq!(gamma.active_conflicts, vec!["dup".to_string()]);

        let stats = result.stats_json();
        assert_eq!(stats["total"], json!(3));
        assert_eq!(stats["enabled"], json!(3));
        assert_eq!(stats["disabled"], json!(0));
        assert!(stats["conflicts"].as_u64().unwrap() >= 3);
        assert!(stats["bytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn custom_order_wins_then_display_name() {
        let repo = repo_for("order");
        for folder in ["aaa", "bbb", "ccc"] {
            write_mod(
                &repo,
                folder,
                manifest(folder, json!({ "displayName": folder })),
                Some("// noop"),
            );
        }
        let runtime = runtime_for("order");
        // 默认：按显示名
        let default = scan_mods(&repo, &runtime);
        assert_eq!(default.order, vec!["aaa", "bbb", "ccc"]);

        // 自定义顺序：ccc 提到最前，其余仍按显示名
        plan::set_mod_order(&runtime, &["ccc".to_string()]);
        let custom = scan_mods(&repo, &runtime);
        assert_eq!(custom.order, vec!["ccc", "aaa", "bbb"]);

        // 排序文件落在 _launcher/mods/mod-order.json
        let file = runtime.root.join("mods").join(plan::ORDER_FILE);
        assert!(file.is_file());
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"order\""));
    }

    #[test]
    fn market_source_marker_is_read() {
        let repo = repo_for("source");
        write_mod(
            &repo,
            "frommarket",
            manifest("frommarket", json!({})),
            Some("// noop"),
        );
        let dir = repo.join("mods").join("frommarket");
        assert_eq!(read_mod_dir("frommarket", &dir).source, "local");
        fs::write(
            dir.join(MOD_SOURCE_FILE),
            json!({ "source": "market", "repo": "https://example.com/x", "version": "2.0.0" })
                .to_string(),
        )
        .unwrap();
        let record = read_mod_dir("frommarket", &dir);
        assert_eq!(record.source, "market");
        assert_eq!(record.source_repo, "https://example.com/x");
        assert_eq!(record.source_version, "2.0.0");
    }

    #[test]
    fn non_loader_kinds_are_marked_unsupported() {
        let repo = repo_for("kinds");
        write_mod(
            &repo,
            "settingsmod",
            manifest("settingsmod", json!({ "kind": "settings" })),
            None,
        );
        write_mod(
            &repo,
            "clientpkg",
            manifest("clientpkg", json!({ "kind": "client-package" })),
            None,
        );
        write_mod(
            &repo,
            "srcint",
            manifest("srcint", json!({ "kind": "source-integrated" })),
            None,
        );
        for (folder, fragment) in [
            ("settingsmod", "settings 类型需要"),
            ("clientpkg", "client-package 需要"),
            ("srcint", "source-integrated 需要"),
        ] {
            let record = read_mod_dir(folder, &repo.join("mods").join(folder));
            assert!(record.valid, "{folder} 清单本身应当有效");
            assert!(!record.supported);
            assert!(record.unsupported_reason.contains(fragment));
            assert!(!record.enabled);
        }
    }

    #[test]
    fn mods_list_carries_readme_and_highlights() {
        let repo = repo_for("readme");
        write_mod(
            &repo,
            "withreadme",
            manifest("withreadme", json!({})),
            Some("// noop"),
        );
        fs::write(
            repo.join("mods").join("withreadme").join("README.md"),
            "# With README\n\n一句话简介\n\n## 功能要点\n\n- 要点一\n\n- 要点一\n\n## 详细介绍\n\n正文第一段\n\n正文第二段\n\n## 安装与启用\n\n1. 启用它\n",
        )
        .unwrap();
        write_mod(
            &repo,
            "noreadme",
            manifest("noreadme", json!({})),
            Some("// noop"),
        );

        let runtime = runtime_for("readme");
        let scan = scan_mods(&repo, &runtime);
        let with = scan
            .mods
            .iter()
            .find(|item| item.id == "withreadme")
            .expect("应扫到 withreadme");
        assert_eq!(
            with.readme,
            vec!["正文第一段".to_string(), "正文第二段".to_string()]
        );
        // 重复的要点只留一条（与上架时同一套去重口径）
        assert_eq!(with.highlights, vec!["要点一".to_string()]);

        // 没有 README 的目录给空数组：详情页按「空 = 没有说明」画
        let without = scan
            .mods
            .iter()
            .find(|item| item.id == "noreadme")
            .expect("应扫到 noreadme");
        assert!(without.readme.is_empty());
        assert!(without.highlights.is_empty());

        // 回包里必须带上：详情页读的是 `mods:list`
        let json = scan.to_json();
        let first = json["mods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "withreadme")
            .unwrap();
        assert_eq!(first["readme"][1], "正文第二段");
        assert_eq!(first["highlights"][0], "要点一");
    }
}
