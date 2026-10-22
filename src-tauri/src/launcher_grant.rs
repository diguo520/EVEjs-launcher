//! 启动器许可（grant）：向模组证明「这个服务端进程是由官方启动器拉起的」。
//!
//! 契约见 docs/faction-sim模组侧改动单-交付作者-2026-10-21.md 的 §2，
//! 启动器侧改动单是 docs/faction-sim启动器侧改动单-2026-10-21.md。要点：
//!
//!   - **契约冻结在 v: 1，永不升版**（§2.9 R1）。需要新能力时加可选字段，不要升版本号。
//!   - 签名是**多签数组** sigs: [{keyId, sig}]，任一条验过即可 —— 换密钥靠双签，
//!     不靠"逼用户更新模组"（§2.9 R2）。
//!   - 规范化与 mods::sign 同一套（去 sigs → key 递归升序 → 紧凑 JSON → UTF-8）；
//!     这里复用 sign::canonical_manifest_json（它只去掉 signature，而我们先把
//!     sigs 摘掉，两者合起来正是契约要的字节序列）。
//!   - keyId = sha256(raw 32 字节公钥).hex()[..12]，公钥是 raw 32 字节 base64。
//!
//! 三条刻意的设计：
//!
//!   1. **启动路径上不联网。** grant_env 只读本地缓存并验签，不做任何网络请求 ——
//!      它是在拉起服务端时被调用的，绝不能因为许可把游戏启动卡住。续期是独立动作
//!      （refresh_license），由调用方放在启动之外。
//!   2. **拿不到就返回 None。** 许可缺失 / 验签失败 / 已过期一律不下发 grant，
//!      让模组按自己的姿态降级，而不是让启动器去猜或去拦。
//!   3. **内置公钥表留空是刻意的。** 签发服务与公钥还没落地时，"没有可信公钥"
//!      就等于"不下发 grant"。落真实 infra 公钥后填 BUILTIN_LICENSE_KEYS 即可。
//!      **私钥永远不进本进程。**

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::mods::{pkg, sign};
use crate::net;
use crate::runtime::RuntimePaths;

/// 契约里 launcher 字段的固定值。
pub const LAUNCHER_ID: &str = "evejs-launcher";

/// 契约版本：**冻结在 1**（§2.9 R1）。这里不是"当前版本"，而是"唯一版本"。
const CONTRACT_VERSION: i64 = 1;

/// 许可缓存文件（相对 runtime.user_data）。
const LICENSE_FILE: &str = "launcher-license.json";
/// 安装标识文件（相对 runtime.user_data）。
const INSTALL_ID_FILE: &str = "launcher-install-id.txt";

/// 距过期不到这个窗口就值得续期（**两周**）。续期不参与启动关键路径。
///
/// 与 90 天有效期配套：每次启动都会试一次，两周窗口 = 过期前有十几次机会。
/// 那条链路在国内容易超时（见下），一次失败绝不能等于这段许可作废。
const REFRESH_WINDOW_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// 续期请求的超时。它不在启动路径上，但也不该无限挂着。
///
/// **30 秒，不是 8 秒**：国内到 `ping.5318.cm`（Cloudflare）实测就是 8–30 秒
/// （2026-10-22 实测：`/v1/health` 30s、正式签发 30.6s、版本闸门 403 8.6s）。
/// 8 秒会大概率在拿到许可之前就放弃；续期不在启动路径上，多等一会儿的代价只是
/// 后台线程多挂二十秒。
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// 签发服务地址。**留空表示还没有这个服务**：留空时 refresh_license 直接返回 false，
/// 启动器只用本地缓存（或什么都不发）。落服务后填真实地址，或用
/// EVEJS_LAUNCHER_LICENSE_URL 临时覆盖（联调用）。
const DEFAULT_LICENSE_URL: &str = "https://ping.5318.cm/launcher/license";

/// 内置签发公钥表 (keyId, raw 32 字节 base64)：**这是真实签发公钥**。
///
/// keyId = sha256(raw 32 字节公钥).hex()[..12]（可用 mods::sign::key_id_from_raw 核）。
/// **私钥不在仓里、也不在本进程**：它属于签发服务（本机放在 `.keys/launcher-license-key.pem`，
/// `.keys/` 已被 gitignore）。轮换时按 §2.2 走双签，不要直接替换这一条。
const BUILTIN_LICENSE_KEYS: &[(&str, &str)] = &[(
    "867242e85fc5",
    "UJXSqYWG/VrWTa03/Ppq3tAgYpOE9VRyQvTyszk5ihg=",
)];

/// 运行时登记的签发公钥（联调 / 测试用，形状对齐 sign::trust_public_key）。
static RUNTIME_LICENSE_KEYS: LazyLock<Mutex<BTreeMap<String, String>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// 登记一把签发公钥（联调 / 测试）。生产走 BUILTIN_LICENSE_KEYS。
pub fn trust_license_key(key_id: &str, public_key_base64: &str) {
    let id = key_id.trim();
    let key = public_key_base64.trim();
    if id.is_empty() || key.is_empty() {
        return;
    }
    if let Ok(mut guard) = RUNTIME_LICENSE_KEYS.lock() {
        guard.insert(id.to_string(), key.to_string());
    }
}

/// 取某把签发公钥：先运行时登记，再内置表。
fn license_key(key_id: &str) -> Option<String> {
    let id = key_id.trim();
    if id.is_empty() {
        return None;
    }
    if let Ok(guard) = RUNTIME_LICENSE_KEYS.lock() {
        if let Some(found) = guard.get(id) {
            return Some(found.clone());
        }
    }
    BUILTIN_LICENSE_KEYS
        .iter()
        .find(|(builtin, _)| *builtin == id)
        .map(|(_, key)| (*key).to_string())
}

/// 现在是否已经有可用的签发公钥。没有就说明签发服务还没落地。
pub fn has_license_keys() -> bool {
    if BUILTIN_LICENSE_KEYS.iter().any(|(id, _)| !id.is_empty()) {
        return true;
    }
    RUNTIME_LICENSE_KEYS
        .lock()
        .map(|guard| guard.keys().any(|id| !id.is_empty()))
        .unwrap_or(false)
}

/* ------------------------------ 文件位置 ------------------------------ */

pub fn license_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.user_data.join(LICENSE_FILE)
}

fn install_id_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.user_data.join(INSTALL_ID_FILE)
}

/// 本机稳定安装标识：首次调用生成并落盘，之后每次读回同一个值。
pub fn install_id(runtime: &RuntimePaths) -> String {
    let path = install_id_path(runtime);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let Some(generated) = random_uuid_v4() else {
        return String::new();
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&path, generated.as_bytes()).is_err() {
        // 写不下去也要能用：本进程内仍然是一致的标识
        return generated;
    }
    generated
}

/* ------------------------------ 机器指纹 ------------------------------ */

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

/// getrandom 取随机字节（仓库里没有 uuid crate，自己拼一个 v4 形状的串）。
fn random_uuid_v4() -> Option<String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).ok()?;
    raw[6] = (raw[6] & 0x0f) | 0x40;
    raw[8] = (raw[8] & 0x3f) | 0x80;
    let hex = hex_lower(&raw);
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// 机器指纹的来源串：Windows 取注册表 MachineGuid，其它平台取主机名。
/// 两边都与模组侧的算法逐字一致（改动单 §2.7）。
fn machine_source() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(rest) = line.trim().strip_prefix("MachineGuid") {
                    // 形如 MachineGuid    REG_SZ    <guid>
                    if let Some(value) = rest.split_whitespace().nth(1) {
                        let value = value.trim().to_lowercase();
                        if !value.is_empty() {
                            return value;
                        }
                    }
                }
            }
        }
    }
    hostname_fallback()
}

fn hostname_fallback() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_lowercase();
            if !value.is_empty() {
                return value;
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string("/etc/hostname") {
        let value = text.trim().to_lowercase();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// sha256("evejs-machine-v1|" + source).hex()[..32]（§2.7）。
pub fn machine_hash() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"evejs-machine-v1|");
    hasher.update(machine_source().as_bytes());
    hex_lower(&hasher.finalize()).chars().take(32).collect()
}

/// 机器绑定是否收紧为"硬拦"。v1 一律软校验（§2.7）：指纹会因系统重装/网卡变化漂移，
/// 硬拦会误伤真实用户。等遥测确认误报率可接受后，才用这个开关打开。
pub fn hard_machine_binding() -> bool {
    std::env::var("EVEJS_LAUNCHER_HARD_MACHINE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

/* ------------------------------ 许可读写 ------------------------------ */

fn read_license(runtime: &RuntimePaths) -> Option<Value> {
    let text = std::fs::read_to_string(license_path(runtime)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.is_object().then_some(parsed)
}

/// 契约形状 + 至少一条签名验过（§2.5）。逐条尝试：表里没有的 keyId 只算**该条**失败。
fn verify_license(license: &Value) -> bool {
    if license.get("v").and_then(Value::as_i64) != Some(CONTRACT_VERSION) {
        return false;
    }
    if license.get("launcher").and_then(Value::as_str) != Some(LAUNCHER_ID) {
        return false;
    }
    let Some(sigs) = license.get("sigs").and_then(Value::as_array) else {
        return false;
    };
    if sigs.is_empty() {
        return false;
    }
    for entry in sigs {
        let key_id = entry
            .get("keyId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let sig = entry.get("sig").and_then(Value::as_str).unwrap_or("");
        let Some(public_key) = license_key(key_id) else {
            continue;
        };
        // 复用 sign 的验签：把这一条包成 signature 字段，
        // canonical_manifest_json 会把它摘掉 —— 于是待验数据正好是"去掉 sigs 的许可"。
        let mut probe = license.clone();
        if let Some(object) = probe.as_object_mut() {
            object.remove("sigs");
            object.insert(
                "signature".to_string(),
                json!({ "alg": "ed25519", "keyId": key_id, "sig": sig }),
            );
        }
        if sign::verify_signature_with_key(&probe, key_id, &public_key).is_ok() {
            return true;
        }
    }
    false
}

/// 许可是否仍在有效期内（expiresAt 是 RFC3339 UTC）。
fn is_valid_now(license: &Value) -> bool {
    let Some(text) = license.get("expiresAt").and_then(Value::as_str) else {
        return false;
    };
    match pkg::ms_from_iso_date(text) {
        Some(expires) => expires > now_ms(),
        None => false,
    }
}

fn expires_at_ms(license: &Value) -> Option<u64> {
    pkg::ms_from_iso_date(license.get("expiresAt").and_then(Value::as_str)?)
}

/// 组装要下发给模组的 grant（环境变量 EVEJS_LAUNCHER_GRANT 的值）。
///
/// **只读缓存、只验签，不联网**（见模块头注释 1）。任何一步不成立就返回 None，
/// 交给模组按自己的姿态降级 —— 许可失败绝不能挡住游戏启动。
pub fn grant_env(runtime: &RuntimePaths) -> Option<String> {
    let license = read_license(runtime)?;
    if !verify_license(&license) || !is_valid_now(&license) {
        return None;
    }
    serde_json::to_string(&license).ok()
}

/// 应急降级令牌（环境变量 EVEJS_FACTIONSIM_GUARD_MODE 的值）。
///
/// 它的值**必须是签名令牌**：裸开关等于给竞品开门（实测可复现，改动单 §2.9 R4）。
/// 令牌由签发服务随许可一并下发（字段 observeToken），启动器只做**透传 + 粗筛**，
/// 真正的验签在模组侧（用同一把钉死公钥）。
pub fn observe_token(runtime: &RuntimePaths) -> Option<String> {
    let license = read_license(runtime)?;
    let token = license.get("observeToken")?.as_object()?;
    if token.get("mode").and_then(Value::as_str) != Some("observe") {
        return None;
    }
    let expires = token.get("expiresAt").and_then(Value::as_str)?;
    if pkg::ms_from_iso_date(expires)? <= now_ms() {
        return None;
    }
    serde_json::to_string(&Value::Object(token.clone())).ok()
}

/* ------------------------------ 续期（不在启动路径上） ------------------------------ */

fn license_endpoint() -> Option<String> {
    if let Ok(value) = std::env::var("EVEJS_LAUNCHER_LICENSE_URL") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let builtin = DEFAULT_LICENSE_URL.trim();
    builtin.starts_with("http").then(|| builtin.to_string())
}

/// 许可是否值得现在去续期（没有 / 距过期不足窗口）。
pub fn needs_refresh(runtime: &RuntimePaths) -> bool {
    match read_license(runtime) {
        Some(license) => match expires_at_ms(&license) {
            Some(expires) => expires <= now_ms() + REFRESH_WINDOW_MS,
            None => true,
        },
        None => true,
    }
}

/// 向签发服务续期许可并落盘。**会联网，不要在启动关键路径上调它。**
///
/// 返回是否真的换到了新许可。任何失败都只是返回 false：旧缓存（如果在有效期内）
/// 仍然可用，模组照旧工作。
///
/// 请求形状按改动单 §2.1：**POST** + JSON 体（`installId` / `machineHash` / `launcherVersion`）。
/// 服务端的版本闸门会在这里回 403（启动器太旧）—— 那种情况下我们**什么也不做**：
/// 拿不到新许可，模组那边自然按 enforce 判定，绝不让这一步的失败去挡游戏启动。
pub fn refresh_license(runtime: &RuntimePaths) -> bool {
    let Some(endpoint) = license_endpoint() else {
        return false;
    };
    let body = serde_json::json!({
        "installId": install_id(runtime),
        "machineHash": machine_hash(),
        "launcherVersion": env!("CARGO_PKG_VERSION"),
    });
    let Ok(payload) = serde_json::to_vec(&body) else {
        return false;
    };
    let Ok(response) = net::send(
        "POST",
        &endpoint,
        &[("Accept", "application/json")],
        Some((payload.as_slice(), "application/json")),
        HTTP_TIMEOUT,
    ) else {
        return false;
    };
    // 只有 200 才是「拿到了一份许可」；403 是版本闸门，其余是服务端故障。
    // 三种都只是返回 false：缓存里那份（若还在有效期内）继续用。
    if response.status != 200 {
        return false;
    }
    let Some(value) = response.json() else {
        return false;
    };
    if !verify_license(&value) {
        return false;
    }
    let Ok(text) = serde_json::to_string_pretty(&value) else {
        return false;
    };
    let path = license_path(runtime);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, text.as_bytes()).is_ok()
}

// （原先的 urlencode 只服务于占位 GET 的查询串；改成 POST 后没有调用点，已删。）

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    /// 临时 RuntimePaths（只有 user_data 会被用到）。
    fn temp_runtime(tag: &str) -> RuntimePaths {
        let base = std::env::temp_dir().join(format!(
            "evejs-grant-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::create_dir_all(&base);
        RuntimePaths {
            root: base.clone(),
            user_data: base.clone(),
            session_data: base.clone(),
            cache: base.clone(),
            temp: base.clone(),
            logs: base.clone(),
            crash_dumps: base,
        }
    }

    fn test_key() -> SigningKey {
        sign::generate_signing_key().expect("测试密钥生成失败")
    }

    fn base_license() -> Value {
        json!({
            "v": CONTRACT_VERSION,
            "launcher": LAUNCHER_ID,
            "launcherVersion": "0.5.1",
            "installId": "inst-test",
            "machineHash": machine_hash(),
            "issuedAt": "2026-10-21T00:00:00Z",
            "expiresAt": pkg::iso_from_ms(now_ms() + 180 * 24 * 60 * 60 * 1000),
            "mods": ["evejs-faction-sim"],
        })
    }

    /// 按契约签字：签的是"去掉 sigs 的许可"，再把签名放进 sigs。
    fn sign_license(license: &mut Value, key: &SigningKey) {
        let mut stripped = license.clone();
        if let Some(object) = stripped.as_object_mut() {
            object.remove("sigs");
        }
        let sig = sign::sign_manifest(&stripped, key);
        let key_id = sign::key_id_of(key);
        if let Some(object) = license.as_object_mut() {
            object.insert("sigs".to_string(), json!([{ "keyId": key_id, "sig": sig }]));
        }
    }

    fn write_license(runtime: &RuntimePaths, license: &Value) {
        let text = serde_json::to_string_pretty(license).expect("序列化失败");
        std::fs::write(license_path(runtime), text.as_bytes()).expect("写许可失败");
    }

    fn trust(key: &SigningKey) {
        trust_license_key(&sign::key_id_of(key), &sign::public_key_base64(key));
    }

    #[test]
    fn grant_is_none_without_any_license() {
        assert!(grant_env(&temp_runtime("none")).is_none());
    }

    #[test]
    fn grant_is_none_when_no_key_is_trusted() {
        let runtime = temp_runtime("nokey");
        let key = test_key();
        let mut license = base_license();
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        // 公钥表为空 => 无法验签 => 不下发（签发服务没落地时的正确行为）
        assert!(grant_env(&runtime).is_none());
    }

    #[test]
    fn valid_license_yields_grant() {
        let runtime = temp_runtime("valid");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        let grant = grant_env(&runtime).expect("应下发 grant");
        let parsed: Value = serde_json::from_str(&grant).expect("grant 必须是 JSON");
        assert_eq!(parsed.get("v").and_then(Value::as_i64), Some(1));
        assert_eq!(
            parsed.get("launcher").and_then(Value::as_str),
            Some(LAUNCHER_ID)
        );
    }

    #[test]
    fn tampered_license_is_rejected() {
        let runtime = temp_runtime("tamper");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        sign_license(&mut license, &key);
        if let Some(object) = license.as_object_mut() {
            object.insert("installId".to_string(), json!("someone-else"));
        }
        write_license(&runtime, &license);
        assert!(grant_env(&runtime).is_none());
    }

    #[test]
    fn expired_license_is_rejected() {
        let runtime = temp_runtime("expired");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        license["expiresAt"] = json!("2020-01-01T00:00:00Z");
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        assert!(grant_env(&runtime).is_none());
    }

    #[test]
    fn contract_version_above_one_is_rejected() {
        let runtime = temp_runtime("v2");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        license["v"] = json!(2);
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        // 契约冻结在 1：2 不是"更新的契约"，而是不该出现的东西
        assert!(grant_env(&runtime).is_none());
    }

    #[test]
    fn multi_sig_partial_hit_still_passes() {
        let runtime = temp_runtime("multisig");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        sign_license(&mut license, &key);
        if let Some(object) = license.as_object_mut() {
            let mut sigs = object.get("sigs").cloned().unwrap_or_else(|| json!([]));
            if let Some(list) = sigs.as_array_mut() {
                // 前面塞一条表里没有的 keyId：只算该条失败，不得整体失败
                list.insert(0, json!({ "keyId": "deadbeef0000", "sig": "AAAA" }));
            }
            object.insert("sigs".to_string(), sigs);
        }
        write_license(&runtime, &license);
        assert!(grant_env(&runtime).is_some());
    }

    #[test]
    fn rotation_dual_signature_still_passes_for_old_key() {
        let runtime = temp_runtime("rotate");
        let old_key = test_key();
        let new_key = test_key();
        // 只信旧钥匙（模拟"用户手里的旧模组"）
        trust(&old_key);
        let mut license = base_license();
        sign_license(&mut license, &old_key);
        // 新钥匙那一条塞进签名集（双签）。先在外面算好，别在可变借用作用域里再 clone。
        let mut stripped = license.clone();
        if let Some(inner) = stripped.as_object_mut() {
            inner.remove("sigs");
        }
        let extra = json!({ "keyId": sign::key_id_of(&new_key), "sig": sign::sign_manifest(&stripped, &new_key) });
        if let Some(object) = license.as_object_mut() {
            let mut sigs = object.get("sigs").cloned().unwrap_or_else(|| json!([]));
            if let Some(list) = sigs.as_array_mut() {
                list.push(extra);
            }
            object.insert("sigs".to_string(), sigs);
        }
        write_license(&runtime, &license);
        assert!(grant_env(&runtime).is_some(), "双签时必须能用旧钥匙验过");
    }

    #[test]
    fn observe_token_requires_expiry_and_mode() {
        let runtime = temp_runtime("valve");
        let key = test_key();
        trust(&key);
        let mut license = base_license();
        license["observeToken"] = json!({
            "mode": "observe",
            "keyId": sign::key_id_of(&key),
            "sig": "AAAA",
            "expiresAt": pkg::iso_from_ms(now_ms() + 86_400_000),
        });
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        assert!(observe_token(&runtime).is_some());
        license["observeToken"]["expiresAt"] = json!("2020-01-01T00:00:00Z");
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        assert!(observe_token(&runtime).is_none(), "过期令牌不算");
    }

    #[test]
    fn install_id_is_stable_and_persisted() {
        let runtime = temp_runtime("install");
        let first = install_id(&runtime);
        assert!(!first.is_empty());
        assert_eq!(first, install_id(&runtime), "两次调用必须一致");
        assert!(install_id_path(&runtime).exists(), "必须落盘");
    }

    #[test]
    fn machine_hash_is_stable_and_32_hex() {
        let hash = machine_hash();
        assert_eq!(hash.len(), 32);
        assert_eq!(hash, machine_hash());
        assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn needs_refresh_true_when_missing() {
        assert!(needs_refresh(&temp_runtime("refresh")));
    }

    #[test]
    fn hard_machine_binding_defaults_to_soft() {
        assert!(!hard_machine_binding() || std::env::var("EVEJS_LAUNCHER_HARD_MACHINE").is_ok());
    }

    /// 跨语言端到端夹具：把一份**按契约签名**的许可写出去，交给模组侧的 JS 校验器验。
    ///
    /// 这是契约里最危险的那条假设（"Rust 与 JS 对同一份 JSON 得出同一串字节"）的端到端证据。
    /// 默认 `#[ignore]`：它要写文件，且必须和 JS 一起跑。用法见 docs/faction-sim-contract-verify.mjs 文件头。
    #[test]
    #[ignore = "跨语言核对手工跑：EVEJS_GRANT_FIXTURE=<写出路径> cargo test --lib emit_grant_fixture -- --ignored"]
    fn emit_grant_fixture() {
        let Ok(target) = std::env::var("EVEJS_GRANT_FIXTURE") else {
            panic!("需要 EVEJS_GRANT_FIXTURE=<写出路径>");
        };
        let key = test_key();
        let runtime = temp_runtime("fixture");
        trust(&key);
        let mut license = base_license();
        sign_license(&mut license, &key);
        write_license(&runtime, &license);
        let grant = grant_env(&runtime).expect("夹具必须能生成 grant");
        let payload = json!({
            "keyId": sign::key_id_of(&key),
            "publicKey": sign::public_key_base64(&key),
            "grant": serde_json::from_str::<Value>(&grant).expect("grant 必须是 JSON"),
        });
        let text = serde_json::to_string_pretty(&payload).expect("序列化夹具失败");
        std::fs::write(&target, text.as_bytes()).expect("写夹具失败");
        println!("fixture written: {target}");
    }

    /// **跨语言互操作（正向）**：这份许可是 **Worker 侧 JS（Cloudflare WebCrypto）** 签出来的，
    /// 这里只问一句「Rust 能不能验过并下发」。
    ///
    /// 与上面的 `emit_grant_fixture` 正好是一对：那边是 Rust 签 → JS 验，这条是 JS 签 → Rust 验。
    /// 钉住的是三边共用同一套规范化（递归 key 升序、摘掉 `sigs`、紧凑 JSON）——
    /// 任何一边改了排序 / 摘字段 / 紧凑化，这条立刻红。
    ///
    /// 夹具由 `infra/test/license.test.mjs` 同一套种子派生（Ed25519 是确定性签名），所以常量稳定；
    /// `expiresAt` 故意放到 2099，免得这条测试某天自己过期。
    #[test]
    fn worker_javascript_signed_grant_verifies_in_rust() {
        const WORKER_KEY_ID: &str = "ef49ec5bc5a0";
        const WORKER_PUBLIC_KEY: &str = "AeJxjOMff/hQAMgsXIsq10PtkAToe/zMkIkXfWCfVH8=";
        const WORKER_SIGNED_GRANT: &str = r#"
{
  "expiresAt": "2099-01-01T00:00:00.000Z",
  "installId": "install-interop01",
  "issuedAt": "2026-10-22T12:00:00.000Z",
  "launcher": "evejs-launcher",
  "launcherVersion": "0.5.5",
  "machineHash": "cccccccccccccccccccccccccccccccc",
  "mods": ["evejs-faction-sim", "evejs-npc-fleet", "evejs-perf-fix", "evejs-captains-quarters"],
  "sigs": [{ "keyId": "ef49ec5bc5a0", "sig": "DmB7OwJroLXMDB9V+5KX7QoM0qFGezAGaZyGQNeCdqGqGIC2sNtOKO70l+6ajqzP2f/JLp9YeOKp1C0HtccjCw==" }],
  "v": 1
}"#;
        let license: Value = serde_json::from_str(WORKER_SIGNED_GRANT).expect("夹具应是合法 JSON");
        trust_license_key(WORKER_KEY_ID, WORKER_PUBLIC_KEY);

        let runtime = temp_runtime("interop-js");
        write_license(&runtime, &license);
        let grant = grant_env(&runtime).expect("Worker 签出来的许可必须被 Rust 验过并下发");
        let parsed: Value = serde_json::from_str(&grant).expect("grant 必须是 JSON");
        assert_eq!(
            parsed.get("launcherVersion").and_then(Value::as_str),
            Some("0.5.5")
        );
        assert_eq!(
            parsed.get("mods").and_then(Value::as_array).map(Vec::len),
            Some(4)
        );

        // 动任何被签名覆盖的字段 → 必须变成「不下发」
        let mut tampered = license.clone();
        tampered["mods"] = json!(["evejs-free-lunch"]);
        let runtime2 = temp_runtime("interop-js-tampered");
        write_license(&runtime2, &tampered);
        assert!(grant_env(&runtime2).is_none(), "动过 mods 的许可不该被认");
    }
}
