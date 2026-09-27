//! 模组清单签名（Ed25519）：对齐现役版 `src/main/modSigner.ts`。
//!
//! 定位：签名 = 「来源标记 + 完整性校验」，**不是**防恶意模组。三态：
//!   - `none`    没有 `signature` 字段（老模组 / 手工模组）→ 绝不拦截
//!   - `valid`   密钥可信且签名匹配 → 放行
//!   - `invalid` 有签名字段但校验不通过 → 由 `trusted` 决定是否拦截
//!
//! 与 Node 的逐位等价（已用跨语言黄金夹具锁定）：
//!   - 签名数据 = `canonicalManifestJson()`（递归 key 升序、去掉签名块、紧凑 JSON、UTF-8）
//!   - `crypto.verify(null, …)` = 纯 Ed25519（RFC 8032），签名确定性
//!   - keyId = `sha256(32 字节原始公钥).hex()[..12]`
//!   - 私钥 PEM = PKCS8 DER（固定前缀 `302e020100300506032b657004220420` + 32 字节种子）
//!
//! 为什么手写 PKCS8/PEM 而不引 `pkcs8` crate：Ed25519 的 PKCS8 就是固定 16 字节前缀 +
//! 种子的确定性结构，写死前缀比多拉一条依赖树更小更稳（且能被黄金夹具验证）。
use crate::secrets::{base64_decode, base64_encode};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

/// 内置公钥表：**索引签名公钥**（整个模组生态的信任根，keygen 生成 2026-09-22）
const BUILTIN_PUBKEYS: [(&str, &str); 1] = [(
    "944f9c6ed4b6",
    "9Q3MNumeqcdGAZuwNRjjWRAwZhrlz1P8HkGraes6+eM=",
)];

/// 运行时注册的公钥（本机作者 + 签名索引注入）
static RUNTIME_KEYS: LazyLock<Mutex<BTreeMap<String, String>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Ed25519 PKCS8 私钥 DER 固定前缀（`302e020100300506032b657004220420`）
const PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
const RAW_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureState {
    None,
    Valid,
    Invalid,
}

impl SignatureState {
    pub fn as_str(self) -> &'static str {
        match self {
            SignatureState::None => "none",
            SignatureState::Valid => "valid",
            SignatureState::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SignatureVerdict {
    pub state: SignatureState,
    pub key_id: String,
    pub trusted: bool,
    pub reason: String,
}

/* ------------------------------ 信任表 ------------------------------ */

pub fn trust_public_key(key_id: &str, public_key_base64: &str) {
    let id = key_id.trim();
    let key = public_key_base64.trim();
    if id.is_empty() || key.is_empty() {
        return;
    }
    if let Ok(mut guard) = RUNTIME_KEYS.lock() {
        guard.insert(id.to_string(), key.to_string());
    }
}

pub fn trusted_key_ids() -> Vec<String> {
    let mut ids: Vec<String> = BUILTIN_PUBKEYS
        .iter()
        .map(|(id, _)| (*id).to_string())
        .collect();
    if let Ok(guard) = RUNTIME_KEYS.lock() {
        for id in guard.keys() {
            if !ids.iter().any(|item| item == id) {
                ids.push(id.clone());
            }
        }
    }
    ids
}

pub fn trusted_public_key(key_id: &str) -> String {
    if let Ok(guard) = RUNTIME_KEYS.lock() {
        if let Some(found) = guard.get(key_id) {
            return found.clone();
        }
    }
    BUILTIN_PUBKEYS
        .iter()
        .find(|(id, _)| *id == key_id)
        .map(|(_, key)| (*key).to_string())
        .unwrap_or_default()
}

/// 确保本机作者的密钥在信任表里（读不到身份就跳过，不影响其它密钥的校验）
pub fn trust_local_author() {
    if let Ok(identity) = crate::author::read_identity() {
        trust_public_key(&identity.key_id, &identity.public_key);
    }
}

/* ------------------------------ 规范化 ------------------------------ */

/// 递归按 key 升序（数组保持原序）——签名与验证必须用同一个函数
fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// manifest 去掉 signature 后的规范化 JSON（紧凑、key 升序）
pub fn canonical_manifest_json(manifest: &Value) -> String {
    let mut clone = manifest.clone();
    if let Some(object) = clone.as_object_mut() {
        object.remove("signature");
    }
    serde_json::to_string(&canonicalize(&clone)).unwrap_or_default()
}

/* ------------------------------ 签名 / 验签 ------------------------------ */

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// base64 签名格式：`^[A-Za-z0-9+/]{80,}={0,2}$`
fn is_signature_base64(value: &str) -> bool {
    let trimmed = value.trim();
    let body = trimmed.trim_end_matches('=');
    let padding = trimmed.len() - body.len();
    if padding > 2 || body.len() < 80 {
        return false;
    }
    body.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/')
}

struct SignatureField {
    key_id: String,
    sig: String,
}

fn read_signature_field(manifest: &Value) -> Result<Option<SignatureField>, String> {
    let Some(raw) = manifest.get("signature") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    if !is_plain_object(raw) {
        return Err("signature 格式非法（应为 {alg, keyId, sig}）".to_string());
    }
    let alg = raw
        .get("alg")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let key_id = raw
        .get("keyId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let sig = raw
        .get("sig")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if alg != "ed25519" {
        let shown = if alg.is_empty() {
            "缺失"
        } else {
            alg.as_str()
        };
        return Err(format!("signature.alg 必须是 ed25519（当前：{shown}）"));
    }
    if key_id.is_empty() {
        return Err("signature.keyId 缺失".to_string());
    }
    if !is_signature_base64(&sig) {
        return Err("signature.sig 格式非法（应为 base64）".to_string());
    }
    Ok(Some(SignatureField { key_id, sig }))
}

fn verdict(state: SignatureState, key_id: &str, trusted: bool, reason: &str) -> SignatureVerdict {
    SignatureVerdict {
        state,
        key_id: key_id.to_string(),
        trusted,
        reason: reason.to_string(),
    }
}

/// 校验 manifest 的 signature 字段（对齐 `verifyManifestSignature`）
pub fn verify_manifest_signature(manifest: &Value) -> SignatureVerdict {
    trust_local_author();
    let field = match read_signature_field(manifest) {
        Ok(Some(field)) => field,
        Ok(None) => return verdict(SignatureState::None, "", false, ""),
        Err(reason) => return verdict(SignatureState::Invalid, "", false, &reason),
    };

    // 清单里声明的作者 keyId 必须和签名用的 keyId 一致（防张冠李戴）
    let declared = manifest
        .get("author")
        .filter(|value| is_plain_object(value))
        .and_then(|value| value.get("keyId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !declared.is_empty() && declared != field.key_id {
        return verdict(
            SignatureState::Invalid,
            &field.key_id,
            true,
            &format!(
                "清单 author.keyId 与 signature.keyId 不一致（{declared} ≠ {}）",
                field.key_id
            ),
        );
    }

    let public_key_base64 = trusted_public_key(&field.key_id);
    if public_key_base64.is_empty() {
        return verdict(
            SignatureState::Invalid,
            &field.key_id,
            false,
            &format!("签名密钥不在信任列表（keyId {}）", field.key_id),
        );
    }
    let Some(public_key) = verifying_key_from_base64(&public_key_base64) else {
        return verdict(
            SignatureState::Invalid,
            &field.key_id,
            false,
            "信任表里的公钥格式非法",
        );
    };

    let Some(signature_bytes) = base64_decode(&field.sig) else {
        return verdict(
            SignatureState::Invalid,
            &field.key_id,
            true,
            "签名 base64 解码失败",
        );
    };
    if signature_bytes.len() != SIGNATURE_BYTES {
        return verdict(
            SignatureState::Invalid,
            &field.key_id,
            true,
            "签名长度不是 64 字节",
        );
    }
    let mut array = [0u8; SIGNATURE_BYTES];
    array.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&array);
    let data = canonical_manifest_json(manifest);
    match public_key.verify_strict(data.as_bytes(), &signature) {
        Ok(()) => verdict(SignatureState::Valid, &field.key_id, true, ""),
        Err(_) => verdict(
            SignatureState::Invalid,
            &field.key_id,
            true,
            "签名不匹配（manifest 已被修改）",
        ),
    }
}

/// 校验 mod-index.json 的索引签名
pub fn verify_index_signature(index: &Value) -> Result<(), String> {
    let verdict = verify_manifest_signature(index);
    match verdict.state {
        SignatureState::Valid => Ok(()),
        SignatureState::None => Err("索引没有签名（mod-index.json 必须由维护者签名）".to_string()),
        SignatureState::Invalid => Err(if verdict.reason.is_empty() {
            "索引签名校验失败".to_string()
        } else {
            verdict.reason
        }),
    }
}

/// 用**指定公钥**校验任意 JSON 的 `signature` 字段（不查信任表、不比对 `author.keyId`）。
///
/// 与 `verify_manifest_signature` 的分工：那个服务模组（多作者、信任表、`author.keyId` 一致性），
/// 这个服务「只有一个可信签发者、公钥编译进二进制」的场景 —— 启动器自更新清单（A1）。
pub fn verify_signature_with_key(
    payload: &Value,
    expected_key_id: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    if expected_key_id.trim().is_empty() || public_key_base64.trim().is_empty() {
        return Err("尚未配置维护者公钥".to_string());
    }
    let field = match read_signature_field(payload)? {
        Some(field) => field,
        None => return Err("缺少 signature 字段（清单必须由维护者签名）".to_string()),
    };
    if field.key_id != expected_key_id {
        return Err(format!("签名密钥不受信任（keyId {}）", field.key_id));
    }
    let Some(public_key) = verifying_key_from_base64(public_key_base64) else {
        return Err("内置维护者公钥格式非法".to_string());
    };
    let Some(signature_bytes) = base64_decode(&field.sig) else {
        return Err("签名 base64 解码失败".to_string());
    };
    if signature_bytes.len() != SIGNATURE_BYTES {
        return Err("签名长度不是 64 字节".to_string());
    }
    let mut array = [0u8; SIGNATURE_BYTES];
    array.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&array);
    let data = canonical_manifest_json(payload);
    public_key
        .verify_strict(data.as_bytes(), &signature)
        .map_err(|_| "签名不匹配（清单已被修改）".to_string())
}

/* ------------------------------ 密钥工具 ------------------------------ */

fn verifying_key_from_base64(public_key_base64: &str) -> Option<VerifyingKey> {
    let raw = base64_decode(public_key_base64)?;
    if raw.len() != RAW_KEY_BYTES {
        return None;
    }
    let mut array = [0u8; RAW_KEY_BYTES];
    array.copy_from_slice(&raw);
    VerifyingKey::from_bytes(&array).ok()
}

pub fn signing_key_from_seed(seed: &[u8]) -> Option<SigningKey> {
    if seed.len() != RAW_KEY_BYTES {
        return None;
    }
    let mut array = [0u8; RAW_KEY_BYTES];
    array.copy_from_slice(seed);
    Some(SigningKey::from_bytes(&array))
}

/// 生成新密钥对（CSPRNG 取 32 字节种子）
pub fn generate_signing_key() -> Option<SigningKey> {
    let mut seed = [0u8; RAW_KEY_BYTES];
    getrandom::fill(&mut seed).ok()?;
    Some(SigningKey::from_bytes(&seed))
}

/// 32 字节原始公钥的 base64（清单 `author.publicKey` 用这个格式）
pub fn public_key_base64(key: &SigningKey) -> String {
    base64_encode(key.verifying_key().to_bytes().as_slice())
}

/// keyId = `sha256(原始公钥).hex()[..12]`
pub fn key_id_of(key: &SigningKey) -> String {
    key_id_from_raw(&key.verifying_key().to_bytes())
}

pub fn key_id_from_raw(raw: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex.chars().take(12).collect()
}

/// PKCS8 私钥 PEM（与 Node `export({type:"pkcs8",format:"pem"})` 同结构：64 列换行）
pub fn private_key_pem(key: &SigningKey) -> String {
    let mut der = Vec::with_capacity(48);
    der.extend_from_slice(&PKCS8_PREFIX);
    der.extend_from_slice(key.to_bytes().as_slice());
    let body = base64_encode(&der);
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    let bytes = body.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let end = (index + 64).min(bytes.len());
        pem.push_str(&body[index..end]);
        pem.push('\n');
        index = end;
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    pem
}

/// 解析 PKCS8 私钥 PEM，取出 32 字节种子
pub fn seed_from_private_key_pem(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    if body.trim().is_empty() {
        return None;
    }
    let der = base64_decode(body.trim())?;
    if der.len() >= PKCS8_PREFIX.len() + RAW_KEY_BYTES && der[..PKCS8_PREFIX.len()] == PKCS8_PREFIX
    {
        return Some(der[der.len() - RAW_KEY_BYTES..].to_vec());
    }
    // 兜底：找最后一个 `04 20`（OCTET STRING，长度 32）标记
    let mut found: Option<Vec<u8>> = None;
    for index in 0..der.len().saturating_sub(RAW_KEY_BYTES + 1) {
        if der[index] == 0x04 && der[index + 1] == 0x20 {
            found = Some(der[index + 2..index + 2 + RAW_KEY_BYTES].to_vec());
        }
    }
    found
}

/// 用签名密钥给 manifest 签名（base64）
pub fn sign_manifest(manifest: &Value, key: &SigningKey) -> String {
    let data = canonical_manifest_json(manifest);
    base64_encode(key.sign(data.as_bytes()).to_bytes().as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 黄金夹具：由 Node `crypto`（现役版同一套 API）现场生成，见 tests 注释
    const GOLDEN_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIhfrPuvjHa1fTs+mj0/NKQe78d42+qxVDqTzNCRaeLq\n-----END PRIVATE KEY-----\n";
    const GOLDEN_PUBKEY_B64: &str = "u+H9syVu7cmdmN8073Eef0IdISAUNyKysfLki9Twl5I=";
    const GOLDEN_KEY_ID: &str = "f03359e919c1";
    const GOLDEN_CANONICAL: &str = "{\"activation\":{\"strategy\":\"loader_rename\"},\"author\":{\"id\":\"au-abc123\",\"keyId\":\"f03359e919c1\",\"name\":\"指挥官\",\"publicKey\":\"u+H9syVu7cmdmN8073Eef0IdISAUNyKysfLki9Twl5I=\"},\"description\":\"这是一段说明\",\"displayName\":\"示例模组\",\"id\":\"demo-mod\",\"kind\":\"loader\",\"requires\":[\"other\"],\"restart\":\"none\",\"schemaVersion\":3,\"tags\":[\"a\",\"b\"],\"version\":\"1.0.0\"}";
    const GOLDEN_SIG: &str =
        "YfI07nv3fKdwqWp4aqYyDOhrbsC+tqhC/o9XUm7OeDgI+JJQpDmXqKip5mpklr2z/TNtFSlAV9pSW1nJrjYHDA==";

    fn golden_manifest() -> Value {
        json!({
            "schemaVersion": 3,
            "id": "demo-mod",
            "displayName": "示例模组",
            "version": "1.0.0",
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" },
            "description": "这是一段说明",
            "tags": ["a", "b"],
            "author": {
                "id": "au-abc123",
                "name": "指挥官",
                "keyId": GOLDEN_KEY_ID,
                "publicKey": GOLDEN_PUBKEY_B64
            },
            "requires": ["other"]
        })
    }

    #[test]
    fn canonical_json_matches_node_json_stringify() {
        // 逐字节对齐 Node：递归 key 升序 + 紧凑 JSON + 原始 UTF-8（中文不转义）
        assert_eq!(
            canonical_manifest_json(&golden_manifest()),
            GOLDEN_CANONICAL
        );
    }

    #[test]
    fn pem_round_trips_and_matches_node_keypair() {
        let seed = seed_from_private_key_pem(GOLDEN_PEM).expect("应能解析 Node 生成的 PKCS8 PEM");
        let key = signing_key_from_seed(&seed).expect("32 字节种子应可用");
        assert_eq!(public_key_base64(&key), GOLDEN_PUBKEY_B64);
        assert_eq!(key_id_of(&key), GOLDEN_KEY_ID);
        // 重新导出的 PEM 必须与 Node 的输出一致（64 列换行 + 结尾换行）
        assert_eq!(private_key_pem(&key), GOLDEN_PEM);
    }

    #[test]
    fn signature_is_byte_identical_to_node() {
        let seed = seed_from_private_key_pem(GOLDEN_PEM).expect("应能解析私钥");
        let key = signing_key_from_seed(&seed).expect("应能构造签名密钥");
        // Ed25519 是确定性签名：同一密钥 + 同一消息 → 逐字节相同的签名
        assert_eq!(sign_manifest(&golden_manifest(), &key), GOLDEN_SIG);
    }

    #[test]
    fn verify_accepts_node_signature_and_detects_tampering() {
        trust_public_key(GOLDEN_KEY_ID, GOLDEN_PUBKEY_B64);
        let mut signed = golden_manifest();
        signed["signature"] = json!({
            "alg": "ed25519",
            "keyId": GOLDEN_KEY_ID,
            "sig": GOLDEN_SIG,
            "signedAt": "2026-09-25T00:00:00.000Z"
        });
        let verdict = verify_manifest_signature(&signed);
        assert_eq!(verdict.state, SignatureState::Valid, "{}", verdict.reason);
        assert!(verdict.trusted);

        // 改一个字符 → 可信密钥 + 不匹配 → 拦截
        signed["version"] = json!("1.0.1");
        let tampered = verify_manifest_signature(&signed);
        assert_eq!(tampered.state, SignatureState::Invalid);
        assert!(tampered.trusted, "签名块里的 keyId 仍可信");
        assert!(
            tampered.reason.contains("签名不匹配"),
            "{}",
            tampered.reason
        );
    }

    #[test]
    fn unknown_key_is_invalid_but_untrusted() {
        let mut manifest = golden_manifest();
        manifest["author"] = json!({ "id": "au-x", "keyId": "ffffffffffff" });
        manifest["signature"] = json!({
            "alg": "ed25519",
            "keyId": "ffffffffffff",
            "sig": GOLDEN_SIG,
            "signedAt": "2026-09-25T00:00:00.000Z"
        });
        let verdict = verify_manifest_signature(&manifest);
        assert_eq!(verdict.state, SignatureState::Invalid);
        assert!(!verdict.trusted, "未知密钥不拦截（只红标）");
    }

    #[test]
    fn missing_signature_is_none() {
        assert_eq!(
            verify_manifest_signature(&golden_manifest()).state,
            SignatureState::None
        );
        let mut bad = golden_manifest();
        bad["signature"] = json!("nope");
        let verdict = verify_manifest_signature(&bad);
        assert_eq!(verdict.state, SignatureState::Invalid);
        assert!(!verdict.trusted);
    }

    #[test]
    fn mismatched_author_keyid_is_rejected() {
        let mut manifest = golden_manifest();
        manifest["author"] = json!({ "id": "au-x", "keyId": "000000000000" });
        manifest["signature"] = json!({
            "alg": "ed25519",
            "keyId": GOLDEN_KEY_ID,
            "sig": GOLDEN_SIG,
            "signedAt": "2026-09-25T00:00:00.000Z"
        });
        let verdict = verify_manifest_signature(&manifest);
        assert_eq!(verdict.state, SignatureState::Invalid);
        assert!(verdict.trusted);
        assert!(verdict.reason.contains("不一致"), "{}", verdict.reason);
    }

    #[test]
    fn generated_keys_round_trip() {
        let key = generate_signing_key().expect("系统随机数应可用");
        let pem = private_key_pem(&key);
        let seed = seed_from_private_key_pem(&pem).expect("应能解析自己写出的 PEM");
        assert_eq!(seed.as_slice(), key.to_bytes().as_slice());
        assert_eq!(key_id_of(&key).len(), 12);

        let mut manifest = golden_manifest();
        manifest["author"] = json!({ "id": "au-new", "keyId": key_id_of(&key) });
        let sig = sign_manifest(&manifest, &key);
        manifest["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id_of(&key),
            "sig": sig,
            "signedAt": "2026-09-25T00:00:00.000Z"
        });
        trust_public_key(&key_id_of(&key), &public_key_base64(&key));
        assert_eq!(
            verify_manifest_signature(&manifest).state,
            SignatureState::Valid
        );
    }
}
