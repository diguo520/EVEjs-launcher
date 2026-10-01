//! 评价与回复的**写路径**：本机身份签名 → POST 给评价服务 → 服务端验签入库。
//!
//! 读路径在 `ratings.rs`（多镜像 + 缓存 + 验签），写路径只有主门一个地址 ——
//! GitHub 那份是定时任务单向生成的**静态镜像**，收不了 POST。
//!
//! 三条硬约定，逐条对应服务端 `infra/src/write.js`：
//!   1. **签的就是发的**。服务端拿收到的原值验签，绝不「先 trim 再验签」——那样客户端少做
//!      一步就会收到「签名不匹配」这种跟真实原因无关的报错。所以正文一律先在本地规范化
//!      （去首尾空白、换行统一 `\n`），modId / sha256 用小写；形状不对服务端会**带原因拒掉**。
//!   2. **身份是懒建的**。本机还没有作者身份时，第一次打分就地建一套（`ensure_identity_at`）。
//!      这是对 S2-D11「读不建」的**有意偏离**：若只给发过模组的人建身份，等于「只有作者能评价」，
//!      而评价的主体恰恰是装过模组的普通玩家。私钥照旧只落本机（`_launcher/data/authors/`）。
//!   3. **不维护本地台账**。写成功后服务端会顺手重算快照，界面拿 `mods:reviews` 重拉一次就能看到
//!      自己那条（`mine` 是按本机 keyId 比出来的）。再存一份本地副本只会和服务器打架。
use std::time::Duration;

use ed25519_dalek::SigningKey;
use serde_json::{json, Map, Value};

use crate::author::{self, AuthorIdentity};
use crate::config;
use crate::mods::pkg;
use crate::mods::sign;
use crate::net;
use crate::runtime::RuntimePaths;

/// 写接口地址。默认只有自定义域这一个入口。
///
/// 本地演练（离线 e2e）用设置里的 `modReviewWriteUrls` 指到 `http://127.0.0.1:.../v1/reviews`，
/// 与读路径的 `modRatingUrls` 是**两个**键：读可以只读镜像，写必须有真后端。
pub const DEFAULT_REVIEW_WRITE_URLS: [&str; 1] = ["https://ping.5318.cm/v1/reviews"];

const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// 与服务端 `MAX_REVIEW_BODY` / `MAX_REPLY_BODY` 对齐再多留一点，超了在本地就拦下来，
/// 不用等服务端回一趟。
const MAX_REVIEW_BODY_CHARS: usize = 2000;
const MAX_REPLY_BODY_CHARS: usize = 1000;
const MAX_REPORT_REASON_CHARS: usize = 500;

/// 写地址：优先设置里的 `modReviewWriteUrls`，否则用默认那一条。
pub fn write_urls(runtime: &RuntimePaths) -> Vec<String> {
    let settings = config::read_settings(&runtime.settings_file());
    if let Some(items) = settings.get("modReviewWriteUrls").and_then(Value::as_array) {
        let list: Vec<String> = items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| item.starts_with("http://") || item.starts_with("https://"))
            .map(str::to_string)
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    DEFAULT_REVIEW_WRITE_URLS
        .iter()
        .map(|item| item.to_string())
        .collect()
}

/// 正文规范化。服务端会拒「首尾有空白」和「带 CR」，所以这一步必须发生在**签名之前**。
fn normalise_body(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

/// 幂等键。服务端只在**第一次**插入时用它，之后改分是 UPSERT，所以够唯一就行。
fn new_review_id() -> String {
    format!("rv-{}-{}", pkg::epoch_ms(), std::process::id())
}

fn text_field(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 本机身份 + 私钥。没有身份就现建一套（见文件头第 2 条）。
fn signing_identity(paths: &RuntimePaths) -> Result<(AuthorIdentity, SigningKey), String> {
    let identity = author::ensure_identity_at(paths)?;
    let key = author::read_signing_key(paths).ok_or_else(|| "本机身份私钥读不出来".to_string())?;
    Ok((identity, key))
}

/// 补上身份字段、签名、然后按顺序 POST 每个写地址（第一个成功就返回）。
fn post_signed(paths: &RuntimePaths, fields: Map<String, Value>, kind: &str) -> Value {
    let (identity, key) = match signing_identity(paths) {
        Ok(pair) => pair,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    let mut body = fields;
    body.insert("identityId".to_string(), json!(identity.id));
    body.insert("publicKey".to_string(), json!(identity.public_key));
    let mut payload = Value::Object(body);
    let signature = sign::sign_manifest(&payload, &key);
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "signature".to_string(),
            json!({ "alg": "ed25519", "keyId": identity.key_id, "sig": signature }),
        );
    }

    let urls = write_urls(paths);
    if urls.is_empty() {
        return json!({ "ok": false, "reason": "没有配置评价写地址" });
    }
    let mut failures: Vec<String> = Vec::new();
    for url in urls {
        match post_one(&url, &payload) {
            Ok(value) => {
                let mut out = value;
                if let Some(object) = out.as_object_mut() {
                    object.insert("server".to_string(), json!(url));
                }
                return out;
            }
            Err(reason) => failures.push(format!("{url} → {reason}")),
        }
    }
    json!({ "ok": false, "reason": format!("{kind}失败：{}", failures.join("；")) })
}

fn post_one(url: &str, payload: &Value) -> Result<Value, String> {
    let body = serde_json::to_vec(payload).map_err(|err| format!("序列化请求失败：{err}"))?;
    let response = net::send(
        "POST",
        url,
        &[("Accept", "application/json")],
        Some((body.as_slice(), "application/json")),
        WRITE_TIMEOUT,
    )?;
    let parsed = response.json().unwrap_or(Value::Null);
    let reason = parsed
        .get("reason")
        .and_then(Value::as_str)
        .map(str::to_string);
    if !(200..300).contains(&response.status) {
        return Err(reason.unwrap_or_else(|| format!("HTTP {}", response.status)));
    }
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reason.unwrap_or_else(|| "服务端没有返回 ok".to_string()));
    }
    Ok(parsed)
}

/// 本地先挡一遍形状：不合规的直接给原因，不用等一趟网络往返。
fn bad_mod_id(mod_id: &str) -> bool {
    mod_id.is_empty()
        || mod_id.len() > 64
        || !mod_id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        || mod_id.starts_with('-')
}

fn shape_error(args: &Value, kind: &str) -> Option<String> {
    if bad_mod_id(&text_field(args, "modId")) {
        return Some("模组 id 不合法".to_string());
    }
    if let Some(review_id) = args.get("reviewId") {
        let value = review_id.as_str().unwrap_or_default();
        if value.is_empty()
            || !value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' || ch == '_')
        {
            return Some(format!("{kind}的 reviewId 不合法"));
        }
    }
    None
}

/* ------------------------------ 对外动作 ------------------------------ */

/// 打分 / 改分（可只打分不写字）。改分是覆盖，不是追加 —— 服务端 `UNIQUE(mod_id, public_key)`。
pub fn submit_review(runtime: &RuntimePaths, args: &Value) -> Value {
    if let Some(reason) = shape_error(args, "评价") {
        return json!({ "ok": false, "reason": reason });
    }
    let stars = args.get("stars").and_then(Value::as_i64).unwrap_or(-1);
    if !(1..=5).contains(&stars) {
        return json!({ "ok": false, "reason": "打分只能是 1 到 5 星" });
    }
    let body = normalise_body(args.get("body").and_then(Value::as_str).unwrap_or_default());
    if body.chars().count() > MAX_REVIEW_BODY_CHARS {
        return json!({ "ok": false, "reason": format!("评价最多 {MAX_REVIEW_BODY_CHARS} 个字") });
    }
    let version = text_field(args, "version");
    if version.is_empty() {
        return json!({ "ok": false, "reason": "缺少版本号 —— 重新刷新一次模组市场再来" });
    }
    let pkg_sha256 = text_field(args, "pkgSha256").to_lowercase();
    if pkg_sha256.len() != 64 || !pkg_sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return json!({ "ok": false, "reason": "这个模组的安装包指纹拿不到，无法确认你真的装过" });
    }

    let mut fields = Map::new();
    fields.insert("action".to_string(), json!("review.upsert"));
    fields.insert("modId".to_string(), json!(text_field(args, "modId")));
    fields.insert("version".to_string(), json!(version));
    fields.insert("pkgSha256".to_string(), json!(pkg_sha256));
    fields.insert("stars".to_string(), json!(stars));
    fields.insert("body".to_string(), json!(body));
    fields.insert("reviewId".to_string(), json!(new_review_id()));
    fields.insert("createdAt".to_string(), json!(pkg::epoch_ms() as u64));
    post_signed(runtime, fields, "提交评价")
}

/// 撤回自己的评价
pub fn retract_review(runtime: &RuntimePaths, args: &Value) -> Value {
    if let Some(reason) = shape_error(args, "撤回") {
        return json!({ "ok": false, "reason": reason });
    }
    let mut fields = Map::new();
    fields.insert("action".to_string(), json!("review.retract"));
    fields.insert("modId".to_string(), json!(text_field(args, "modId")));
    fields.insert("at".to_string(), json!(pkg::epoch_ms() as u64));
    post_signed(runtime, fields, "撤回评价")
}

/// 作者回复 / 改回复。鉴权在服务端：签名者的 keyId 必须命中该模组索引里记的作者 keyId。
pub fn submit_reply(runtime: &RuntimePaths, args: &Value) -> Value {
    if let Some(reason) = shape_error(args, "回复") {
        return json!({ "ok": false, "reason": reason });
    }
    let body = normalise_body(args.get("body").and_then(Value::as_str).unwrap_or_default());
    if body.is_empty() {
        return json!({ "ok": false, "reason": "回复不能是空的" });
    }
    if body.chars().count() > MAX_REPLY_BODY_CHARS {
        return json!({ "ok": false, "reason": format!("回复最多 {MAX_REPLY_BODY_CHARS} 个字") });
    }
    let mut fields = Map::new();
    fields.insert("action".to_string(), json!("reply.upsert"));
    fields.insert("modId".to_string(), json!(text_field(args, "modId")));
    fields.insert("reviewId".to_string(), json!(text_field(args, "reviewId")));
    fields.insert("body".to_string(), json!(body));
    fields.insert("at".to_string(), json!(pkg::epoch_ms() as u64));
    post_signed(runtime, fields, "发布回复")
}

pub fn retract_reply(runtime: &RuntimePaths, args: &Value) -> Value {
    if let Some(reason) = shape_error(args, "撤回回复") {
        return json!({ "ok": false, "reason": reason });
    }
    let mut fields = Map::new();
    fields.insert("action".to_string(), json!("reply.retract"));
    fields.insert("modId".to_string(), json!(text_field(args, "modId")));
    fields.insert("reviewId".to_string(), json!(text_field(args, "reviewId")));
    fields.insert("at".to_string(), json!(pkg::epoch_ms() as u64));
    post_signed(runtime, fields, "撤回回复")
}

/// 举报。服务端只入库、不自动处置：宁可攒着人工看，也不要随手机器审掉一条正常评价。
pub fn report_review(runtime: &RuntimePaths, args: &Value) -> Value {
    if let Some(reason) = shape_error(args, "举报") {
        return json!({ "ok": false, "reason": reason });
    }
    let reason_text = normalise_body(
        args.get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if reason_text.chars().count() > MAX_REPORT_REASON_CHARS {
        return json!({ "ok": false, "reason": format!("举报理由最多 {MAX_REPORT_REASON_CHARS} 个字") });
    }
    let mut fields = Map::new();
    fields.insert("action".to_string(), json!("report.create"));
    fields.insert("modId".to_string(), json!(text_field(args, "modId")));
    fields.insert("reviewId".to_string(), json!(text_field(args, "reviewId")));
    fields.insert("reason".to_string(), json!(reason_text));
    fields.insert("at".to_string(), json!(pkg::epoch_ms() as u64));
    post_signed(runtime, fields, "举报")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_paths(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-review-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能创建测试目录");
        RuntimePaths::from_root(dir, true)
    }

    #[test]
    fn body_is_normalised_before_signing() {
        // 服务端拒 CR / 首尾空白，所以规范化必须发生在签名之前（否则报「签名不匹配」）
        assert_eq!(normalise_body("  你好  "), "你好");
        assert_eq!(normalise_body("第一行\r\n第二行"), "第一行\n第二行");
        assert_eq!(normalise_body("第一行\r第二行"), "第一行\n第二行");
        assert_eq!(normalise_body("   \n  "), "");
    }

    #[test]
    fn review_id_shape_matches_server_whitelist() {
        let id = new_review_id();
        assert!(
            id.len() >= 8 && id.len() <= 64,
            "长度要落在服务端白名单里：{id}"
        );
        assert!(id.starts_with("rv-"), "统一前缀好排查：{id}");
        assert!(id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' || ch == '_'));
    }

    #[test]
    fn local_shape_checks_reject_before_hitting_the_network() {
        let bad = json!({ "modId": "EVEJS-AutoLockFire" });
        assert!(
            shape_error(&bad, "评价").is_some(),
            "大写 modId 本地就该拦下"
        );
        let ok = json!({ "modId": "evejs-autolockfire", "reviewId": "rv-1" });
        assert!(shape_error(&ok, "评价").is_none());
        assert!(bad_mod_id("-leading"));
        assert!(bad_mod_id("中文"));
        assert!(!bad_mod_id("evejs-autolockfire"));
    }

    #[test]
    fn submit_review_checks_stars_and_package_fingerprint_offline() {
        let paths = temp_paths("shape");
        let bad_stars = json!({
            "modId": "evejs-autolockfire", "version": "1.0.0",
            "pkgSha256": "a".repeat(64), "stars": 9
        });
        let verdict = submit_review(&paths, &bad_stars);
        assert_eq!(verdict.get("ok").and_then(Value::as_bool), Some(false));
        assert!(verdict
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("1 到 5"));

        let bad_sha = json!({
            "modId": "evejs-autolockfire", "version": "1.0.0",
            "pkgSha256": "zz", "stars": 5
        });
        let verdict = submit_review(&paths, &bad_sha);
        assert!(verdict
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("安装包指纹"));
    }
}
