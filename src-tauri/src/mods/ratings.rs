//! 模组市场的**评价与评分**（启动器读路径）。
//!
//! 数据不在启动器本地，也不在 GitHub 索引里，而是由 `infra/` 那个 Cloudflare
//! 服务（Workers + D1）算出来的只读快照：
//!
//!   - `ratings.json`         → 所有模组的聚合分（本文件负责拉、验签、缓存、并入市场列表）
//!   - `reviews/<modId>.json` → 单个模组的评论正文，打开详情弹窗时才按需拉
//!
//! 三条硬约束：
//!   1. **必须验签**。快照由维护者的一把**独立**密钥签（`RATINGS_KEY_ID` / `RATINGS_PUBKEY`），
//!      不与自更新清单共用 —— 那把私钥在 Cloudflare 上，绝不能是能签出启动器更新的那一把。
//!      验签不过 = 这个镜像失败，跟索引的处理一致（不降级成「信任未签名数据」）。
//!   2. **评分是附加信息**。服务不通、验签失败、没配置公钥，市场列表都必须照常出，
//!      只是没有评分 —— 评价服务挂了不该让整个模组市场打不开。
//!   3. **读的是快照，不是接口**。跟索引一样多镜像 + 本地缓存兜底，理由同 `registry.rs`：
//!      启动器要能在服务不可达时照常工作。多镜像轮询 / 验签 / 缓存三段本身在
//!      `crate::snapshot` 里，与赞助人「补给线」名单共用同一份实现。
//!
//! 「装过才能评」的判定不在这里 —— 那是服务端拿 `mod_versions` 白名单做的，启动器只负责
//! 把本机装的是哪一份（modId + version + 包 sha256）如实报上去。
use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::mods::sign;
use crate::runtime::RuntimePaths;
use crate::snapshot;

/// 评价服务地址（主门 = 自定义域，备门 = GitHub 镜像，由定时任务单向生成）。
///
/// ⚠️ 与索引同一类陷阱：两条地址的路径形状必须都对。自定义域是 Worker 自己的路由，
/// 直接 `/v1/ratings.json`；GitHub 镜像是仓库 `docs/ratings/` 下的静态文件。
pub const DEFAULT_RATING_URLS: [&str; 2] = [
    "https://ping.5318.cm/v1/ratings.json",
    "https://diguo520.github.io/EVEjs-mods/ratings/ratings.json",
];

/// 维护者那把**服务快照专用**的签名密钥。与 `updater.rs` 的 `UPDATE_KEY_ID` / `UPDATE_PUBKEY`
/// 是两把不同的钥匙：这把私钥放在 Cloudflare 的 secret 里，泄露的后果只是「评分 / 赞助人名单
/// 可以被伪造」，而不是「可以推一个恶意启动器更新」。
///
/// 同一个 `infra/` 服务发布的所有快照都用它签 —— 现在有两份：评价聚合分和补给线名单。
/// 名字里的 `RATINGS_` 是历史包袱（先有的评分），别再按名字理解成「只签评分」。
///
/// 测试与本地演练用 `EVEJS_RATINGS_KEY_ID` / `EVEJS_RATINGS_PUBKEY` 覆盖，不必重编译。
pub const RATINGS_KEY_ID: &str = "evejs-ratings-2026-10-01";
pub const RATINGS_PUBKEY: &str = "6MxPBqHTbNgFk0sdBcNebLjgnEehk0wvrkYAZGpV7u0=";

const RATINGS_CACHE_FILE: &str = "mod-ratings.json";
const SHARD_CACHE_DIR: &str = "mod-reviews";
/// 聚合分的缓存有效期：5 分钟。快照本身每 10 分钟才重算一次，再快也没意义。
const RATINGS_TTL_MS: u128 = 5 * 60 * 1000;
/// 评论分片比聚合分大得多，缓存久一点：翻旧评论看到略旧的内容无所谓
const SHARD_TTL_MS: u128 = 30 * 60 * 1000;

pub fn cache_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.cache.join(RATINGS_CACHE_FILE)
}

fn shard_cache_path(runtime: &RuntimePaths, mod_id: &str) -> PathBuf {
    runtime
        .cache
        .join(SHARD_CACHE_DIR)
        .join(format!("{mod_id}.json"))
}

/// 评价地址：优先设置里的 `modRatingUrls`（只认 http/https），否则用默认两条。
/// 与 `registry::index_urls` 同一个形状 —— 用户可以只换评价源而不动索引源。
pub fn rating_urls(runtime: &RuntimePaths) -> Vec<String> {
    snapshot::urls_from_settings(runtime, "modRatingUrls", &DEFAULT_RATING_URLS)
}

/// 评论分片地址：把聚合地址的 `ratings.json` 换成 `reviews/<modId>.json`。
///
/// 两条默认地址的目录结构不同（自定义域 `/v1/`，GitHub 镜像 `docs/ratings/`），
/// 所以按「最后一个 `/`」切，而不是硬拼 `/v1/reviews/...`。
pub fn shard_urls(runtime: &RuntimePaths, mod_id: &str) -> Vec<String> {
    rating_urls(runtime)
        .into_iter()
        .filter_map(|url| {
            let base = url.strip_suffix("ratings.json")?;
            if base.is_empty() {
                return None;
            }
            Some(format!("{base}reviews/{mod_id}.json"))
        })
        .collect()
}

/// 内置的验签身份（可用环境变量覆盖，便于本地演练指向自建源）
pub fn signature_pair() -> (String, String) {
    let key_id = std::env::var("EVEJS_RATINGS_KEY_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| RATINGS_KEY_ID.to_string());
    let pubkey = std::env::var("EVEJS_RATINGS_PUBKEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| RATINGS_PUBKEY.to_string());
    (key_id, pubkey)
}

/// 校验一份快照。公钥没配置时**返回失败**而不是放行：宁可不显示评分，
/// 也不能把「没配公钥」变成「谁都塞得进来」。
///
/// 补给线名单也走它 —— 同一个服务、同一把钥匙。
pub fn verify_snapshot(payload: &Value) -> Result<(), String> {
    let (key_id, pubkey) = signature_pair();
    sign::verify_signature_with_key(payload, &key_id, &pubkey)
}

/// 拉聚合分（`ratings.json`）
pub fn fetch_ratings(runtime: &RuntimePaths, force: bool) -> Value {
    snapshot::fetch_with_cache(
        rating_urls(runtime),
        cache_path(runtime),
        RATINGS_TTL_MS,
        force,
        "评价",
        &verify_snapshot,
    )
}

/// 拉某个模组的评论正文（`reviews/<modId>.json`）。`mod_id` 必须已经过白名单过滤。
pub fn fetch_review_shard(runtime: &RuntimePaths, mod_id: &str, force: bool) -> Value {
    let urls = shard_urls(runtime, mod_id);
    if urls.is_empty() {
        return json!({ "ok": false, "reason": "评价源地址里没有可用的分片路径" });
    }
    snapshot::fetch_with_cache(
        urls,
        shard_cache_path(runtime, mod_id),
        SHARD_TTL_MS,
        force,
        "评论",
        &verify_snapshot,
    )
}

/// 把聚合分并进市场条目。
///
/// 线上形状是 `{"ratings": {modId: {average, count, withText, histogram}}}`，取不到就写 0/0；
/// `average` 是给卡片和排序用的，`withText` 是「玩家评价 · N 条」那个数（**不是** `count`：
/// 打分的人远多于写评论的人，两个口径分开是刻意的）。
pub fn apply_ratings(entries: &mut [Value], ratings: Option<&Value>) {
    let empty = Map::new();
    let table = ratings
        .and_then(|value| value.get("mods"))
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    for entry in entries.iter_mut() {
        let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        let row = table.get(id);
        let average = row
            .and_then(|value| value.get("average"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let count = row
            .and_then(|value| value.get("count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let with_text = row
            .and_then(|value| value.get("withText"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let histogram = row
            .and_then(|value| value.get("histogram"))
            .cloned()
            .unwrap_or_else(|| json!([0, 0, 0, 0, 0]));
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        object.insert("ratingAvg".into(), json!(average));
        object.insert("ratingCount".into(), json!(count));
        object.insert("ratingWithText".into(), json!(with_text));
        object.insert("ratingHistogram".into(), histogram);
    }
}

/// `mods:reviews`：某个模组的评论正文 + 本机是否已经投过票。
///
/// 本地匹配用 `keyId`（本机作者身份的指纹）：写在快照里的每条评论都带它，
/// 一比就知道哪条是自己写的，不需要服务端存「谁是谁」。
pub fn reviews_for(runtime: &RuntimePaths, mod_id: &str, force: bool) -> Value {
    let id = mod_id.trim().to_lowercase();
    if !is_safe_mod_id(&id) {
        return json!({ "ok": false, "reason": "模组标识不合法" });
    }
    let fetched = fetch_review_shard(runtime, &id, force);
    if !fetched.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "modId": id,
            "reason": fetched.get("reason").cloned().unwrap_or(json!("取不到评论")),
        });
    }
    let payload = fetched.get("payload").cloned().unwrap_or(Value::Null);
    let local_key_id = crate::author::read_identity()
        .map(|identity| identity.key_id)
        .unwrap_or_default();
    let reviews: Vec<Value> = payload
        .get("reviews")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut review = item.clone();
                    let mine = !local_key_id.is_empty()
                        && item.get("keyId").and_then(Value::as_str) == Some(local_key_id.as_str());
                    if let Some(object) = review.as_object_mut() {
                        object.insert("mine".into(), json!(mine));
                    }
                    review
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "ok": true,
        "modId": id,
        "reviews": reviews,
        "cached": fetched.get("cached").cloned().unwrap_or(json!(false)),
        "fetchedAt": fetched.get("fetchedAt").cloned().unwrap_or(json!(0)),
        "reason": fetched.get("reason").cloned().unwrap_or(Value::Null),
    })
}

/// 只接受小写字母 / 数字 / 短横（创建表单就限这些），因为它要进缓存文件名与 URL 路径。
fn is_safe_mod_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    value.len() <= 64
        && value
            .chars()
            .all(|item| item.is_ascii_lowercase() || item.is_ascii_digit() || item == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §5.2 交叉验证：Cloudflare 那边（`infra/src/canonical.js`，WebCrypto）签出的快照，
    /// Rust 必须能验过。这条用例锁的是**规范化规则逐字节一致** ——
    /// 两边各有各的 JSON 实现（JS 的 JSON.stringify / serde_json），规则一漂这里立刻红。
    #[test]
    fn js_signed_snapshot_verifies_in_rust() {
        // 固定向量：种子 = sha256("evejs-s4-ratings-fixture")，见 tests/parity/gen-ratings-fixtures.mjs
        const FIXTURE_KEY_ID: &str = "evejs-ratings-parity-fixture";
        const FIXTURE_PUBKEY: &str = "P5Ff2fawc4t4PhYpYq2m2aBu2CQvwC5T7D4T3uO/A0Y=";
        let valid: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/fixtures/ratings/valid.json"
        ))
        .expect("valid.json 必须是合法 JSON");
        let tampered: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/fixtures/ratings/tampered.json"
        ))
        .expect("tampered.json 必须是合法 JSON");
        let bad: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/fixtures/ratings/bad-signature.json"
        ))
        .expect("bad-signature.json 必须是合法 JSON");

        sign::verify_signature_with_key(&valid, FIXTURE_KEY_ID, FIXTURE_PUBKEY)
            .expect("Rust 必须能验过 JS 签出的评价快照");
        assert!(
            sign::verify_signature_with_key(&tampered, FIXTURE_KEY_ID, FIXTURE_PUBKEY).is_err(),
            "改一个时间戳后必须拒绝"
        );
        assert!(
            sign::verify_signature_with_key(&bad, FIXTURE_KEY_ID, FIXTURE_PUBKEY).is_err(),
            "签名被改动后必须拒绝"
        );
        assert!(
            sign::verify_signature_with_key(&valid, "someone-else", FIXTURE_PUBKEY).is_err(),
            "换 keyId 冒充必须拒绝"
        );
    }

    /// 公钥没配置时**必须拒绝**：这是「评价服务没配好」与「谁都能塞评分」之间的那道线
    #[test]
    fn unconfigured_public_key_rejects_instead_of_trusting() {
        let payload = json!({
            "schemaVersion": 1,
            "generatedAt": 1,
            "mods": {},
            "signature": { "alg": "ed25519", "keyId": "x", "sig": "AAAA" }
        });
        // 常量在本仓是空串（公钥由维护者生成后填），所以这里直接断言 verify 的失败语义
        assert!(sign::verify_signature_with_key(&payload, "", "").is_err());
    }

    #[test]
    fn ratings_merge_into_entries() {
        let mut entries = vec![
            json!({ "id": "evejs-automining", "version": "1.0.0" }),
            json!({ "id": "evejs-unknown", "version": "1.0.0" }),
        ];
        let ratings = json!({
            "mods": {
                "evejs-automining": { "average": 4.62, "count": 13, "withText": 4, "histogram": [0,1,1,3,8] }
            }
        });
        apply_ratings(&mut entries, Some(&ratings));
        assert_eq!(entries[0]["ratingAvg"], json!(4.62));
        assert_eq!(entries[0]["ratingCount"], json!(13));
        assert_eq!(entries[0]["ratingWithText"], json!(4));
        assert_eq!(entries[0]["ratingHistogram"], json!([0, 1, 1, 3, 8]));
        // 没有评分的模组也要有齐字段，否则界面要到处判空
        assert_eq!(entries[1]["ratingAvg"], json!(0.0));
        assert_eq!(entries[1]["ratingCount"], json!(0));
        assert_eq!(entries[1]["ratingHistogram"], json!([0, 0, 0, 0, 0]));
    }

    #[test]
    fn ratings_missing_leaves_zeros() {
        let mut entries = vec![json!({ "id": "evejs-x" })];
        apply_ratings(&mut entries, None);
        assert_eq!(entries[0]["ratingAvg"], json!(0.0));
        assert_eq!(entries[0]["ratingCount"], json!(0));
    }

    #[test]
    fn shard_urls_follow_each_mirror_shape() {
        let urls = vec![
            "https://ping.5318.cm/v1/ratings.json".to_string(),
            "https://diguo520.github.io/EVEjs-mods/ratings/ratings.json".to_string(),
        ];
        let shards: Vec<String> = urls
            .into_iter()
            .filter_map(|url| url.strip_suffix("ratings.json").map(str::to_string))
            .map(|base| format!("{base}reviews/evejs-x.json"))
            .collect();
        assert_eq!(shards[0], "https://ping.5318.cm/v1/reviews/evejs-x.json");
        assert_eq!(
            shards[1],
            "https://diguo520.github.io/EVEjs-mods/ratings/reviews/evejs-x.json"
        );
    }

    #[test]
    fn unsafe_mod_ids_are_rejected() {
        assert!(is_safe_mod_id("evejs-automining"));
        assert!(is_safe_mod_id("a1"));
        assert!(!is_safe_mod_id("../etc/passwd"));
        assert!(!is_safe_mod_id("EVEJS-X"));
        assert!(!is_safe_mod_id("中文"));
        assert!(!is_safe_mod_id(""));
        assert!(!is_safe_mod_id("-lead"));
        assert!(!is_safe_mod_id(&"a".repeat(65)));
    }
}
