//! 本机作者身份（Ed25519 密钥身份）：对齐现役版 `src/main/authorStore.ts`。
//!
//! 设计要点（沿用现役版 + 迁移计划 §4 第 13 项、评审 A2）：
//!   - 署名（`name`）只是给人看的自由文本；认人的是 `id`（登记标识）与 `keyId`（公钥指纹）；
//!   - 真正的凭据是本机私钥：只落在 `_launcher/data/mod-keys/`，永不上传、永不打包；
//!   - 私钥落盘走 DPAPI 加密（决策 S2-D10），但**仍能读现役版写的明文 PEM**，老用户升级无感；
//!   - 丢失私钥就无法再以同一 keyId 签发更新，所以必须支持 `.eve-key` 导出 / 导入还原。
//!
//! 与现役版的一处刻意偏差（S2-D11）：`read_identity()` 只读、不自动创建身份。
//! 现役版 `trustLocalAuthor()` 会调 `getAuthor()` 顺手生成一套密钥，属于副作用；
//! 这里改成「验签不写盘」，身份只在作者对话框 / 导入导出时创建。
use crate::dialog::{self, DialogSpec};
use crate::mods::sign;
use crate::runtime::RuntimePaths;
use crate::secrets::{base64_decode, base64_encode, protect, unprotect};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

pub(crate) const AUTHOR_FILE: &str = "author.json";
pub(crate) const KEY_DIR: &str = "mod-keys";
const DEFAULT_NAME: &str = "指挥官";
const ID_PREFIX: &str = "au-";
const ID_MIN_TAIL: usize = 6;
const ID_MAX_TAIL: usize = 32;
const NOISE_WIDTH: usize = 4;
const NAME_MAX_CHARS: usize = 64;
const KEY_EXTENSION: &str = "eve-key";
/// 加密私钥文件头（自描述）：没有这一行且不含 PEM 标记时按损坏处理
const KEY_FILE_HEADER: &str = "# EveJS author key (DPAPI, v1)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorProfile {
    pub id: String,
    pub name: String,
    /// 拿到这个身份的时间（毫秒）
    pub since: i64,
    /// Ed25519 公钥指纹前 12 位
    pub key_id: String,
    /// base64 编码的 32 字节 Ed25519 原始公钥
    pub public_key: String,
    /// 相对 `_launcher/data` 的私钥路径，例如 `mod-keys/9f3c1a77b2e4.key`
    pub private_key_path: String,
}

/// 供验签 / 签名用的身份切片（`mods::sign::trust_local_author` 只要这四项）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorIdentity {
    pub id: String,
    pub name: String,
    pub key_id: String,
    pub public_key: String,
}

/* ------------------------------ 路径与工具 ------------------------------ */

fn data_dir(paths: &RuntimePaths) -> &Path {
    &paths.user_data
}

fn author_file(paths: &RuntimePaths) -> PathBuf {
    data_dir(paths).join(AUTHOR_FILE)
}

fn key_rel_path(key_id: &str) -> String {
    PathBuf::from(KEY_DIR)
        .join(format!("{key_id}.key"))
        .to_string_lossy()
        .to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// JS `Number.prototype.toString(36)` 的等价实现
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".to_string())
}

/// `au-<base36 毫秒时间戳><4 位 base36 噪声>`（对齐现役版 `mintAuthorId`）
fn mint_author_id() -> String {
    let stamp = base36(now_ms().max(0) as u64);
    let mut buffer = [0u8; 4];
    let noise = match getrandom::fill(&mut buffer) {
        Ok(()) => (u32::from_le_bytes(buffer) % 36u32.pow(NOISE_WIDTH as u32)) as u64,
        Err(_) => 0,
    };
    format!("au-{stamp}{:0>4}", base36(noise))
}

/// 现役版 `/^au-[a-z0-9]{6,32}$/i`
fn is_valid_id(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    let Some(tail) = lower.strip_prefix(ID_PREFIX) else {
        return false;
    };
    (ID_MIN_TAIL..=ID_MAX_TAIL).contains(&tail.len())
        && tail.chars().all(|ch| ch.is_ascii_alphanumeric())
}

/* ------------------------------ 私钥落盘 ------------------------------ */

/// 取 PEM 段（现役版 `parseKeyFile` 的同一套切片规则）
fn extract_pem(text: &str) -> Option<String> {
    let begin = text.find("-----BEGIN")?;
    let end = text.rfind("-----END")?;
    if end <= begin {
        return None;
    }
    let line_end = text[end..].find('\n').map(|offset| end + offset);
    Some(
        text[begin..line_end.unwrap_or(text.len())]
            .trim()
            .to_string(),
    )
}

/// 解密回 PEM：兼容现役版写入的明文 PEM，也认自己的 `# header + base64(DPAPI)`
fn decode_key_file(raw: &str) -> Option<String> {
    let text = raw.trim_start_matches('\u{feff}');
    if let Some(pem) = extract_pem(text) {
        return Some(pem);
    }
    let body: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("");
    if body.trim().is_empty() {
        return None;
    }
    let cipher = base64_decode(body.trim())?;
    let plain = unprotect(&cipher)?;
    let pem = String::from_utf8(plain).ok()?;
    if pem.trim().is_empty() {
        return None;
    }
    extract_pem(&pem).or_else(|| Some(pem.trim().to_string()))
}

/// DPAPI 加密后的自描述文本；DPAPI 不可用时返回 `None`（调用方退化为写明文，等价现役版）
fn encode_key_file(pem: &str) -> Option<String> {
    let cipher = protect(pem.as_bytes())?;
    Some(format!("{KEY_FILE_HEADER}\n{}\n", base64_encode(&cipher)))
}

fn write_private_key(paths: &RuntimePaths, relative: &str, pem: &str) -> std::io::Result<()> {
    let file = data_dir(paths).join(relative);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    match encode_key_file(pem) {
        Some(encrypted) => fs::write(file, encrypted),
        None => fs::write(file, pem),
    }
}

fn read_private_key_pem(paths: &RuntimePaths, profile: &AuthorProfile) -> Option<String> {
    if profile.private_key_path.trim().is_empty() {
        return None;
    }
    let raw = fs::read_to_string(data_dir(paths).join(&profile.private_key_path)).ok()?;
    decode_key_file(&raw)
}

/// 本机私钥（签名用）；身份缺失 / 私钥不可用时返回 `None`
pub fn read_signing_key(paths: &RuntimePaths) -> Option<SigningKey> {
    let profile = read_profile(paths)?;
    let pem = read_private_key_pem(paths, &profile)?;
    let seed = sign::seed_from_private_key_pem(&pem)?;
    sign::signing_key_from_seed(&seed)
}

/* ------------------------------ profile 读写 ------------------------------ */

fn profile_json(profile: &AuthorProfile) -> Value {
    json!({
        "id": profile.id,
        "name": profile.name,
        "since": profile.since,
        "keyId": profile.key_id,
        "publicKey": profile.public_key,
        "privateKeyPath": profile.private_key_path,
    })
}

fn read_profile(paths: &RuntimePaths) -> Option<AuthorProfile> {
    let raw = fs::read_to_string(author_file(paths)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let object = parsed.as_object()?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let id = text("id");
    let name = text("name");
    let key_id = text("keyId");
    let public_key = text("publicKey");
    if id.is_empty() || name.is_empty() || key_id.is_empty() || public_key.is_empty() {
        return None;
    }
    let since = object
        .get("since")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .map(|value| value as i64)
        .unwrap_or_else(now_ms);
    let raw_path = text("privateKeyPath");
    Some(AuthorProfile {
        id,
        name,
        since,
        private_key_path: if raw_path.is_empty() {
            key_rel_path(&key_id)
        } else {
            raw_path
        },
        key_id,
        public_key,
    })
}

fn write_profile(paths: &RuntimePaths, profile: &AuthorProfile) -> std::io::Result<()> {
    fs::create_dir_all(data_dir(paths))?;
    let text = serde_json::to_string(&profile_json(profile)).unwrap_or_default();
    fs::write(author_file(paths), text)
}

fn create_profile(paths: &RuntimePaths, name: &str) -> Option<AuthorProfile> {
    let key = sign::generate_signing_key()?;
    let key_id = sign::key_id_of(&key);
    let trimmed = name.trim();
    let profile = AuthorProfile {
        id: mint_author_id(),
        name: if trimmed.is_empty() {
            DEFAULT_NAME.to_string()
        } else {
            trimmed.to_string()
        },
        since: now_ms(),
        private_key_path: key_rel_path(&key_id),
        key_id,
        public_key: sign::public_key_base64(&key),
    };
    write_private_key(
        paths,
        &profile.private_key_path,
        &sign::private_key_pem(&key),
    )
    .ok()?;
    Some(profile)
}

/// 读现有身份；没有就现建一套并落盘（对齐现役版 `getAuthor`）；`bool` = 是否新建
fn ensure_profile(paths: &RuntimePaths) -> Option<(AuthorProfile, bool)> {
    if let Some(profile) = read_profile(paths) {
        return Some((profile, false));
    }
    let created = create_profile(paths, DEFAULT_NAME)?;
    write_profile(paths, &created).ok()?;
    Some((created, true))
}

fn state_json(paths: &RuntimePaths, profile: &AuthorProfile, reason: Option<&str>) -> Value {
    let mut value = json!({
        "ok": true,
        "author": profile_json(profile),
        "privateKeyExists": read_private_key_pem(paths, profile).is_some(),
        "dataDir": data_dir(paths).to_string_lossy(),
    });
    if let Some(reason) = reason {
        if let Some(object) = value.as_object_mut() {
            object.insert("reason".to_string(), Value::String(reason.to_string()));
        }
    }
    value
}

fn failure_json(paths: &RuntimePaths) -> Value {
    json!({
        "ok": false,
        "author": Value::Null,
        "privateKeyExists": false,
        "dataDir": data_dir(paths).to_string_lossy(),
        "reason": "无法建立作者身份（系统随机数或磁盘写入不可用）",
    })
}

fn insert_bool(value: &mut Value, key: &str, flag: bool) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), Value::Bool(flag));
    }
}

/* ------------------------------ 对外通道 ------------------------------ */

/// `author:get`
pub fn get_state(paths: &RuntimePaths) -> Value {
    match ensure_profile(paths) {
        Some((profile, created)) => state_json(
            paths,
            &profile,
            if created { Some("created") } else { None },
        ),
        None => failure_json(paths),
    }
}

/// `author:setName`
pub fn set_name(paths: &RuntimePaths, name: &str) -> Value {
    let Some((current, _)) = ensure_profile(paths) else {
        return failure_json(paths);
    };
    let next = name.trim();
    if next.is_empty() {
        let mut value = state_json(paths, &current, Some("empty"));
        insert_bool(&mut value, "renamed", false);
        return value;
    }
    if next == current.name {
        let mut value = state_json(paths, &current, None);
        insert_bool(&mut value, "renamed", false);
        return value;
    }
    let updated = AuthorProfile {
        name: next.chars().take(NAME_MAX_CHARS).collect(),
        ..current
    };
    if let Err(err) = write_profile(paths, &updated) {
        return json!({ "ok": false, "reason": err.to_string() });
    }
    let mut value = state_json(paths, &updated, None);
    insert_bool(&mut value, "renamed", true);
    value
}

/// `.eve-key` 文件的注释头 + PEM（对齐现役版 `buildKeyFileContent`）
fn build_key_file_content(profile: &AuthorProfile, private_key_pem: &str) -> String {
    [
        "# EveJS Launcher Author Key v1".to_string(),
        "# 警告：本文件包含私钥，请勿分享给任何人。".to_string(),
        "# 丢失后无法再以同一 keyId 签发更新；导入本文件即可在新机器上还原这个身份。".to_string(),
        format!("# id: {}", profile.id),
        format!("# name: {}", profile.name),
        format!("# keyId: {}", profile.key_id),
        format!("# since: {}", profile.since),
        format!("# createdAt: {}", crate::process::iso_timestamp()),
        private_key_pem.trim_end().to_string(),
        String::new(),
    ]
    .join("\n")
}

/// 现役版：不以 `.eve-key` 结尾就补上扩展名
fn with_key_extension(dest: &Path) -> PathBuf {
    let lower = dest.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(&format!(".{KEY_EXTENSION}")) {
        return dest.to_path_buf();
    }
    let mut os = dest.as_os_str().to_os_string();
    os.push(format!(".{KEY_EXTENSION}"));
    PathBuf::from(os)
}

fn export_to(paths: &RuntimePaths, profile: &AuthorProfile, dest: &Path) -> Value {
    let Some(pem) = read_private_key_pem(paths, profile) else {
        return json!({
            "ok": false,
            "reason": "私钥文件缺失，无法导出（请重建身份或导入备份）"
        });
    };
    let file = with_key_extension(dest);
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = fs::create_dir_all(parent);
        }
    }
    match fs::write(&file, build_key_file_content(profile, &pem)) {
        Ok(()) => json!({
            "ok": true,
            "path": file.to_string_lossy(),
            "keyId": profile.key_id,
        }),
        Err(err) => json!({ "ok": false, "reason": err.to_string() }),
    }
}

/// `author:exportKey`（弹「另存为」，用户取消返回 `canceled`）
pub async fn export_key(app: &AppHandle, paths: &RuntimePaths) -> Value {
    let Some((profile, _)) = ensure_profile(paths) else {
        return failure_json(paths);
    };
    let spec = DialogSpec::save(
        "导出作者密钥",
        &format!("author-{}.eve-key", now_ms()),
        KEY_EXTENSION,
    )
    .filter("EveJS author key", &[KEY_EXTENSION])
    .filter("所有文件", &["*"])
    .initial_dir(data_dir(paths).to_string_lossy().to_string());
    match dialog::pick(app, spec).await {
        Ok(Some(dest)) => export_to(paths, &profile, &dest),
        Ok(None) => json!({ "ok": false, "canceled": true }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

struct ParsedKeyFile {
    pem: String,
    id: String,
    name: String,
    since: i64,
    key_id: String,
}

/// 现役版 `^\s*#\s*<key>\s*:\s*(.+)$`（正则带 `i` 标志，这里大小写不敏感）
fn pick_header(header: &str, key: &str) -> String {
    for line in header.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix('#') else {
            continue;
        };
        let Some((name, value)) = rest.trim_start().split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case(key) && !value.trim().is_empty() {
            return value.trim().to_string();
        }
    }
    String::new()
}

fn parse_key_file(content: &str) -> Option<ParsedKeyFile> {
    let text = content.trim_start_matches('\u{feff}');
    let begin = text.find("-----BEGIN")?;
    let pem = extract_pem(text)?;
    let header = &text[..begin];
    let since = pick_header(header, "since")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as i64)
        .unwrap_or_else(now_ms);
    Some(ParsedKeyFile {
        pem,
        id: pick_header(header, "id"),
        name: pick_header(header, "name"),
        since,
        key_id: pick_header(header, "keyId"),
    })
}

/// 导入前把旧文件挪成 `*.bak`（失败不影响导入，对齐现役版）
fn backup_file(path: &Path) {
    if !path.exists() {
        return;
    }
    let mut target = path.as_os_str().to_os_string();
    target.push(".bak");
    let _ = fs::rename(path, PathBuf::from(target));
}

fn import_from(paths: &RuntimePaths, source: &Path) -> Value {
    let Ok(content) = fs::read_to_string(source) else {
        return json!({ "ok": false, "reason": "读不到密钥文件（路径无效或没有权限）" });
    };
    let Some(parsed) = parse_key_file(&content) else {
        return json!({ "ok": false, "reason": "不是有效的 .eve-key 文件（缺少 PEM 私钥段）" });
    };
    let Some(seed) = sign::seed_from_private_key_pem(&parsed.pem) else {
        return json!({
            "ok": false,
            "reason": "私钥无法解析：不是 Ed25519 PKCS8 私钥（当前格式不支持）"
        });
    };
    let Some(key) = sign::signing_key_from_seed(&seed) else {
        return json!({ "ok": false, "reason": "私钥无法解析：种子长度不是 32 字节" });
    };
    let derived = sign::key_id_of(&key);
    if !parsed.key_id.is_empty() && parsed.key_id != derived {
        return json!({
            "ok": false,
            "reason": format!(
                "密钥指纹与文件头不一致（头 {}，实际 {}），已拒绝导入",
                parsed.key_id, derived
            ),
        });
    }

    let _ = fs::create_dir_all(data_dir(paths));
    backup_file(&author_file(paths));
    backup_file(&data_dir(paths).join(key_rel_path(&derived)));

    let profile = AuthorProfile {
        id: if is_valid_id(&parsed.id) {
            parsed.id
        } else {
            mint_author_id()
        },
        name: if parsed.name.is_empty() {
            DEFAULT_NAME.to_string()
        } else {
            parsed.name
        },
        since: parsed.since,
        private_key_path: key_rel_path(&derived),
        key_id: derived.clone(),
        public_key: sign::public_key_base64(&key),
    };

    let pem = format!("{}\n", parsed.pem);
    if let Err(err) = write_private_key(paths, &profile.private_key_path, &pem) {
        return json!({ "ok": false, "reason": format!("写入失败：{err}") });
    }
    if let Err(err) = write_profile(paths, &profile) {
        return json!({ "ok": false, "reason": format!("写入失败：{err}") });
    }
    // 新身份立刻进信任表：同一进程内的后续验签不必等下一次读盘
    sign::trust_public_key(&profile.key_id, &profile.public_key);
    json!({ "ok": true, "path": source.to_string_lossy(), "keyId": derived })
}

/// `author:importKey`（弹「打开文件」）
pub async fn import_key(app: &AppHandle, paths: &RuntimePaths) -> Value {
    let spec = DialogSpec::open("导入作者密钥")
        .filter("EveJS author key", &[KEY_EXTENSION, "pem", "key"])
        .filter("所有文件", &["*"])
        .initial_dir(data_dir(paths).to_string_lossy().to_string());
    match dialog::pick(app, spec).await {
        Ok(Some(source)) => import_from(paths, &source),
        Ok(None) => json!({ "ok": false, "canceled": true }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// `author:openKeyFolder`：在资源管理器里打开 `_launcher/data`
pub fn open_key_folder(app: &AppHandle, paths: &RuntimePaths) -> Value {
    let dir = data_dir(paths).to_path_buf();
    let _ = fs::create_dir_all(&dir);
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
        Ok(()) => json!({ "ok": true, "dir": dir.to_string_lossy() }),
        Err(err) => json!({
            "ok": false,
            "reason": err.to_string(),
            "dir": dir.to_string_lossy(),
        }),
    }
}

/* ------------------------------ 只读身份 ------------------------------ */

/// 只读本机身份（不建身份、不写盘）。给 `mods::sign::trust_local_author` 用。
pub fn read_identity_at(paths: &RuntimePaths) -> Result<AuthorIdentity, String> {
    let profile = read_profile(paths).ok_or_else(|| "本机作者身份不存在".to_string())?;
    Ok(AuthorIdentity {
        id: profile.id,
        name: profile.name,
        key_id: profile.key_id,
        public_key: profile.public_key,
    })
}

/// 当前署名是不是允许发布到市场：空名与未修改的默认名都只留给本地创建 / 测试。
pub(crate) fn is_publishable_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed != DEFAULT_NAME
}

/// 用进程级运行时路径读身份（签名 / 验签路径上没有 `AppState` 可用）
pub fn read_identity() -> Result<AuthorIdentity, String> {
    read_identity_at(crate::runtime::active())
}

/// 读身份，没有就现建一套再读（与 `author:get` 同一个动作，只是不回给界面）。
///
/// 给「找回旧模组」的候选扫描用：归属保护要知道「哪些模组不是我签的」，
/// 而身份**还不存在**的时候恰恰最需要找回（重装系统后还没进过作者面板）：
/// 那时回一个「读不到身份」等于把入口藏起来，见 `mods/claim.rs`（2026-09-30 报障）。
pub fn ensure_identity_at(paths: &RuntimePaths) -> Result<AuthorIdentity, String> {
    let (profile, _) = ensure_profile(paths).ok_or_else(|| "无法建立本机作者身份".to_string())?;
    Ok(AuthorIdentity {
        id: profile.id,
        name: profile.name,
        key_id: profile.key_id,
        public_key: profile.public_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `mods/sign.rs` 的黄金夹具同源：均由 Node `crypto.generateKeyPairSync("ed25519")`
    /// 生成后固化，用来证明「现役版写的明文私钥文件」能被读出来。
    const GOLDEN_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIhfrPuvjHa1fTs+mj0/NKQe78d42+qxVDqTzNCRaeLq\n-----END PRIVATE KEY-----\n";
    const GOLDEN_PUBKEY_B64: &str = "u+H9syVu7cmdmN8073Eef0IdISAUNyKysfLki9Twl5I=";
    const GOLDEN_KEY_ID: &str = "f03359e919c1";

    fn temp_paths(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-author-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能创建测试目录");
        RuntimePaths::from_root(dir, true)
    }

    #[test]
    fn author_ids_match_electron_shape() {
        for _ in 0..8 {
            let id = mint_author_id();
            assert!(is_valid_id(&id), "{id} 应通过现役版正则");
            assert!(id.starts_with("au-"));
            assert!(id.len() >= 3 + ID_MIN_TAIL, "{id} 太短");
        }
        for bad in [
            "",
            "au-",
            "au-abc",
            "au-abcde",
            "xx-abcdef",
            "au-abcdefgh!",
            "au-abcdef_",
        ] {
            assert!(!is_valid_id(bad), "{bad} 不应通过");
        }
        assert!(is_valid_id(&format!("au-{}", "a".repeat(32))));
        assert!(!is_valid_id(&format!("au-{}", "a".repeat(33))));
        assert!(is_valid_id("AU-ABC123"), "现役版正则带 i 标志");
    }

    #[test]
    fn base36_matches_js() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        // Node: (1758000000000).toString(36) === "mfm3t5hc"
        assert_eq!(base36(1_758_000_000_000), "mfm3t5hc");
    }

    #[test]
    fn get_state_creates_then_reuses_identity() {
        let paths = temp_paths("create");
        let first = get_state(&paths);
        assert_eq!(first["ok"], json!(true));
        assert_eq!(first["reason"], json!("created"));
        assert!(first["privateKeyExists"].as_bool().unwrap());
        let author = &first["author"];
        let key_id = author["keyId"].as_str().unwrap().to_string();
        assert!(is_valid_id(author["id"].as_str().unwrap()));
        assert_eq!(author["name"], json!(DEFAULT_NAME));
        assert_eq!(key_id.len(), 12);
        assert_eq!(author["privateKeyPath"], json!(key_rel_path(&key_id)));
        assert!(author["since"].as_i64().unwrap() > 0);
        assert_eq!(first["dataDir"], json!(paths.user_data.to_string_lossy()));

        let second = get_state(&paths);
        assert!(second["reason"].is_null(), "第二次不该再报 created");
        assert_eq!(second["author"]["id"], first["author"]["id"]);

        // 落盘的 author.json 形状与现役版一致
        let raw = fs::read_to_string(author_file(&paths)).expect("author.json 应存在");
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        for key in [
            "id",
            "name",
            "since",
            "keyId",
            "publicKey",
            "privateKeyPath",
        ] {
            assert!(parsed.get(key).is_some(), "缺字段 {key}");
        }
    }

    #[test]
    fn private_key_is_encrypted_at_rest_but_readable() {
        let paths = temp_paths("encrypted");
        let state = get_state(&paths);
        let relative = state["author"]["privateKeyPath"]
            .as_str()
            .unwrap()
            .to_string();
        let raw = fs::read_to_string(paths.user_data.join(&relative)).expect("私钥文件应存在");
        assert!(
            !raw.contains("-----BEGIN PRIVATE KEY-----"),
            "私钥不该明文落盘"
        );
        assert!(raw.starts_with(KEY_FILE_HEADER));

        let profile = read_profile(&paths).unwrap();
        let pem = read_private_key_pem(&paths, &profile).unwrap();
        assert!(pem.contains("-----BEGIN PRIVATE KEY-----"));
        // 私钥必须能还原成可用的签名密钥
        assert!(read_signing_key(&paths).is_some());
    }

    #[test]
    fn legacy_plaintext_pem_key_file_is_readable() {
        let paths = temp_paths("legacy");
        fs::create_dir_all(paths.user_data.join(KEY_DIR)).unwrap();
        fs::write(
            paths.user_data.join(key_rel_path(GOLDEN_KEY_ID)),
            GOLDEN_PEM,
        )
        .unwrap();
        fs::write(
            author_file(&paths),
            json!({
                "id": "au-legacy000000",
                "name": "老用户",
                "since": 1_700_000_000_000i64,
                "keyId": GOLDEN_KEY_ID,
                "publicKey": GOLDEN_PUBKEY_B64,
                "privateKeyPath": key_rel_path(GOLDEN_KEY_ID),
            })
            .to_string(),
        )
        .unwrap();

        let state = get_state(&paths);
        assert_eq!(state["privateKeyExists"], json!(true));
        assert_eq!(state["author"]["id"], json!("au-legacy000000"));
        let profile = read_profile(&paths).unwrap();
        assert_eq!(
            read_private_key_pem(&paths, &profile).unwrap(),
            GOLDEN_PEM.trim()
        );
    }

    #[test]
    fn legacy_forward_slash_key_path_is_readable() {
        // 现役版 author.json 由 `path.join` 写成反斜杠；但手工改过或跨版本搬运来的
        // 文件可能是正斜杠。两种写法都必须能定位到私钥文件（探针回归）。
        let paths = temp_paths("legacy-forward");
        fs::create_dir_all(paths.user_data.join(KEY_DIR)).unwrap();
        let rel = format!("{KEY_DIR}/{GOLDEN_KEY_ID}.key");
        fs::write(paths.user_data.join(&rel), GOLDEN_PEM).unwrap();
        fs::write(
            author_file(&paths),
            json!({
                "id": "au-legacy000001",
                "name": "老用户",
                "since": 1_700_000_000_000i64,
                "keyId": GOLDEN_KEY_ID,
                "publicKey": GOLDEN_PUBKEY_B64,
                "privateKeyPath": rel,
            })
            .to_string(),
        )
        .unwrap();

        let state = get_state(&paths);
        assert_eq!(state["privateKeyExists"], json!(true));
        assert_eq!(state["author"]["keyId"], json!(GOLDEN_KEY_ID));
        assert!(read_signing_key(&paths).is_some());
    }

    #[test]
    fn missing_private_key_reports_flag_false() {
        let paths = temp_paths("missing");
        fs::create_dir_all(&paths.user_data).unwrap();
        fs::write(
            author_file(&paths),
            json!({
                "id": "au-deadbeef0000",
                "name": "被删了私钥",
                "since": 1_700_000_000_000i64,
                "keyId": GOLDEN_KEY_ID,
                "publicKey": GOLDEN_PUBKEY_B64,
                "privateKeyPath": key_rel_path(GOLDEN_KEY_ID),
            })
            .to_string(),
        )
        .unwrap();
        let state = get_state(&paths);
        assert_eq!(state["ok"], json!(true));
        assert_eq!(state["privateKeyExists"], json!(false));
        assert!(read_signing_key(&paths).is_none());
    }

    #[test]
    fn set_name_trims_truncates_and_flags() {
        let paths = temp_paths("rename");
        let created = get_state(&paths);
        assert_eq!(created["author"]["name"], json!(DEFAULT_NAME));

        let renamed = set_name(&paths, "  影歌  ");
        assert_eq!(renamed["renamed"], json!(true));
        assert_eq!(renamed["author"]["name"], json!("影歌"));
        // 改名不动密钥
        assert_eq!(renamed["author"]["keyId"], created["author"]["keyId"]);

        let same = set_name(&paths, "影歌");
        assert_eq!(same["renamed"], json!(false));

        let empty = set_name(&paths, "   ");
        assert_eq!(empty["renamed"], json!(false));
        assert_eq!(empty["reason"], json!("empty"));
        assert_eq!(empty["author"]["name"], json!("影歌"));

        let long = set_name(&paths, &"x".repeat(100));
        assert_eq!(
            long["author"]["name"].as_str().unwrap().chars().count(),
            NAME_MAX_CHARS
        );
    }

    #[test]
    fn export_writes_importable_eve_key_file() {
        let source = temp_paths("export-src");
        let state = get_state(&source);
        let key_id = state["author"]["keyId"].as_str().unwrap().to_string();
        let profile = read_profile(&source).unwrap();

        let target = temp_paths("export-dst");
        let dest = target.root.join("backup");
        let result = export_to(&source, &profile, &dest);
        assert_eq!(result["ok"], json!(true));
        let file = PathBuf::from(result["path"].as_str().unwrap());
        assert!(file.ends_with("backup.eve-key"), "应自动补扩展名：{file:?}");
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("# id: "));
        assert!(text.contains("-----BEGIN PRIVATE KEY-----"));

        // 导入到另一台「机器」，keyId / id 必须原样还原
        let imported = import_from(&target, &file);
        assert_eq!(imported["ok"], json!(true));
        assert_eq!(imported["keyId"], json!(key_id));
        let restored = get_state(&target);
        assert_eq!(restored["author"]["keyId"], json!(key_id));
        assert_eq!(restored["author"]["id"], state["author"]["id"]);
        assert_eq!(restored["privateKeyExists"], json!(true));
        // 导出的私钥导入后仍能签名（公钥逐字节一致）
        assert_eq!(
            sign::public_key_base64(&read_signing_key(&target).unwrap()),
            restored["author"]["publicKey"]
        );
    }

    #[test]
    fn import_rejects_unsupported_and_mismatched_files() {
        let paths = temp_paths("import-bad");
        let missing = import_from(&paths, Path::new("Z:\\nope\\none.eve-key"));
        assert_eq!(missing["ok"], json!(false));

        let junk = paths.root.join("junk.eve-key");
        fs::write(&junk, "hello").unwrap();
        assert_eq!(import_from(&paths, &junk)["ok"], json!(false));

        let wrong_id = paths.root.join("mismatch.eve-key");
        fs::write(&wrong_id, format!("# keyId: 000000000000\n{GOLDEN_PEM}")).unwrap();
        let result = import_from(&paths, &wrong_id);
        assert_eq!(result["ok"], json!(false));
        assert!(
            result["reason"].as_str().unwrap().contains("不一致"),
            "{}",
            result["reason"]
        );
    }

    #[test]
    fn parse_key_file_reads_headers_case_insensitively() {
        let text = format!(
            "# EveJS Launcher Author Key v1\n# ID: au-abcdef123456\n# Name: 影歌\n# KEYID: {GOLDEN_KEY_ID}\n# since: 1700000000000\n{GOLDEN_PEM}"
        );
        let parsed = parse_key_file(&text).expect("应能解析");
        assert_eq!(parsed.id, "au-abcdef123456");
        assert_eq!(parsed.name, "影歌");
        assert_eq!(parsed.key_id, GOLDEN_KEY_ID);
        assert_eq!(parsed.since, 1_700_000_000_000);
        assert_eq!(parsed.pem, GOLDEN_PEM.trim());

        // 没有 PEM 段 → 拒绝；since 非法 → 用当前时间
        assert!(parse_key_file("hello").is_none());
        let bad_since = parse_key_file(&format!("# since: abc\n{GOLDEN_PEM}")).unwrap();
        assert!(bad_since.since > 1_700_000_000_000);
    }

    #[test]
    fn read_identity_is_read_only() {
        let paths = temp_paths("identity");
        assert!(read_identity_at(&paths).is_err(), "没有身份时应当失败");
        assert!(
            !author_file(&paths).exists(),
            "只读路径不得创建 author.json"
        );

        get_state(&paths);
        let identity = read_identity_at(&paths).expect("建好身份后应能读到");
        assert_eq!(identity.key_id.len(), 12);
        assert!(!identity.public_key.is_empty());
    }

    #[test]
    fn name_survives_astral_characters() {
        let paths = temp_paths("astral");
        let result = set_name(&paths, "🚀".repeat(70).as_str());
        // 按字符（code point）截断，不会把代理对劈成半个字符
        assert_eq!(
            result["author"]["name"].as_str().unwrap().chars().count(),
            NAME_MAX_CHARS
        );
    }
}
