//! 赞助人「补给线」名单（启动器读路径）。
//!
//! 名单**不随包发版**：它由 `infra/` 那个 Cloudflare 服务（Workers + KV）定时签出来，
//! 与模组市场的评分共用一套读法（多镜像 + 本地缓存 + 验签，实现在 `crate::snapshot`）。
//! 服务端那边的名单本体是 `infra/src/sponsors.js`，改名单只动那一个文件。
//!
//! 一份 `sponsors.json` 长这样（`signature` 由服务端补上）：
//!
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "generatedAt": 1790842714426,
//!   "sponsors": [
//!     { "id": "sponsor-01", "name": "星海孤舟", "amount": 666, "currency": "CNY" },
//!     { "id": "sponsor-15", "name": "Cmdr. Nova", "amount": 50, "currency": "USD" }
//!   ]
//! }
//! ```
//!
//! 三条与评价一致的硬约束（详见 `mods/ratings.rs` 的文件头）：
//!   1. **必须验签**，用的还是评价那把公钥（同一个服务、同一把钥匙）；
//!   2. 拿不到就退到**随包那份演示名单**（在渲染层），这块面板不能开天窗；
//!   3. 读快照而不是接口 —— 离线、服务宕机、GitHub 镜像都还能读。
//!
//! 名单是**用户数据**：名字一律不翻译，币种按 `currency` 挑符号；条目本身不再校验，
//! 校验口径只有一份，在渲染层的 `ui/src/lib/sponsor-source.ts`。
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::mods::ratings;
use crate::runtime::RuntimePaths;
use crate::snapshot;

/// 补给线名单地址（主门 = 自定义域，备门 = GitHub 镜像，与评价那份同一个镜像目录）。
pub const DEFAULT_SPONSOR_URLS: [&str; 2] = [
    "https://ping.5318.cm/v1/sponsors.json",
    "https://diguo520.github.io/EVEjs-mods/ratings/sponsors.json",
];

/// 缓存有效期：10 分钟。名单几天才动一次，比评分的 5 分钟更宽松 ——
/// 这块面板挂在设置页，没必要每次打开都出网。
const SPONSORS_TTL_MS: u128 = 10 * 60 * 1000;

pub fn cache_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.cache.join("sponsors.json")
}

/// 名单地址：优先设置里的 `sponsorUrls`（只认 http/https），否则用默认两条。
/// 与评价源分开两个键：用户可能只想换其中一个。
pub fn sponsor_urls(runtime: &RuntimePaths) -> Vec<String> {
    snapshot::urls_from_settings(runtime, "sponsorUrls", &DEFAULT_SPONSOR_URLS)
}

/// `sponsors:snapshot`：拉名单。返回体形状与 `mods:reviews` 一路：
/// `{ ok, sponsors, generatedAt, cached, source, fetchedAt, reason }`。
pub fn fetch_sponsors(runtime: &RuntimePaths, force: bool) -> Value {
    let fetched = snapshot::fetch_with_cache(
        sponsor_urls(runtime),
        cache_path(runtime),
        SPONSORS_TTL_MS,
        force,
        "补给线",
        &ratings::verify_snapshot,
    );
    if !fetched.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "reason": fetched
                .get("reason")
                .cloned()
                .unwrap_or_else(|| json!("取不到赞助人名单")),
        });
    }

    let payload = fetched.get("payload").cloned().unwrap_or(Value::Null);
    json!({
        "ok": true,
        "sponsors": payload.get("sponsors").cloned().unwrap_or_else(|| json!([])),
        "generatedAt": payload.get("generatedAt").cloned().unwrap_or_else(|| json!(0)),
        "cached": fetched.get("cached").cloned().unwrap_or(Value::Bool(false)),
        "source": fetched.get("source").cloned().unwrap_or(Value::Null),
        "fetchedAt": fetched.get("fetchedAt").cloned().unwrap_or_else(|| json!(0)),
        // 用了缓存又是因为源挂了，就带一句原因 —— 界面上不显示，日志里有
        "reason": fetched.get("reason").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::sign;
    use std::path::Path;

    /// §5.2 交叉验证：服务端（`infra/src/canonical.js`，WebCrypto）签的名单，Rust 必须验得过。
    ///
    /// 与评价那份向量同一个夹具密钥，但**多带了浮点金额**（32.66 / 12.5）：
    /// JS 与 serde_json 对 double 的「最短往返」格式化只要有一处不一样，这里当场就红。
    #[test]
    fn js_signed_sponsor_snapshot_verifies_in_rust() {
        const FIXTURE_KEY_ID: &str = "evejs-ratings-parity-fixture";
        const FIXTURE_PUBKEY: &str = "P5Ff2fawc4t4PhYpYq2m2aBu2CQvwC5T7D4T3uO/A0Y=";
        let valid: Value = serde_json::from_str(include_str!(
            "../../tests/parity/fixtures/ratings/sponsors-valid.json"
        ))
        .expect("sponsors-valid.json 必须是合法 JSON");
        let tampered: Value = serde_json::from_str(include_str!(
            "../../tests/parity/fixtures/ratings/sponsors-tampered.json"
        ))
        .expect("sponsors-tampered.json 必须是合法 JSON");

        sign::verify_signature_with_key(&valid, FIXTURE_KEY_ID, FIXTURE_PUBKEY)
            .expect("Rust 必须能验过 JS 签出的补给线名单");
        assert!(
            sign::verify_signature_with_key(&tampered, FIXTURE_KEY_ID, FIXTURE_PUBKEY).is_err(),
            "改动一位赞助人的金额后必须拒绝"
        );

        // 夹具里的形状就是渲染层要吃的形状：这一条同时钉住字段名
        let sponsors = valid
            .get("sponsors")
            .and_then(Value::as_array)
            .expect("sponsors 是数组");
        assert_eq!(sponsors.len(), 4);
        assert_eq!(
            sponsors[1].get("currency").and_then(Value::as_str),
            Some("USD")
        );
        assert_eq!(
            sponsors[2].get("amount").and_then(Value::as_f64),
            Some(32.66)
        );
    }

    /// 默认两条地址的形状：自定义域走 `/v1/`，GitHub 镜像在评价镜像的同级目录
    #[test]
    fn default_urls_point_at_the_published_snapshot() {
        assert!(DEFAULT_SPONSOR_URLS[0].starts_with("https://ping.5318.cm/v1/"));
        assert!(DEFAULT_SPONSOR_URLS[0].ends_with("/sponsors.json"));
        assert!(DEFAULT_SPONSOR_URLS[1].starts_with("https://diguo520.github.io/"));
        assert!(DEFAULT_SPONSOR_URLS[1].ends_with("/sponsors.json"));
    }

    /// 缓存落在别人的地盘上就是 bug：它是 runtime 的 cache 目录，不是服务端目录
    #[test]
    fn cache_file_lives_under_the_runtime_cache_dir() {
        let runtime = RuntimePaths {
            root: PathBuf::from("C:/repo"),
            user_data: PathBuf::from("C:/ud"),
            session_data: PathBuf::from("C:/sd"),
            cache: PathBuf::from("C:/ud/cache"),
            temp: PathBuf::from("C:/tmp"),
            logs: PathBuf::from("C:/logs"),
            crash_dumps: PathBuf::from("C:/crash"),
        };
        let path = cache_path(&runtime);
        assert!(path.starts_with(Path::new("C:/ud/cache")), "{path:?}");
        assert_eq!(
            path.file_name().and_then(|item| item.to_str()),
            Some("sponsors.json")
        );
    }
}
