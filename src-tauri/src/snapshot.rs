//! **签名快照**的读路径 —— 模组市场的评价评分、赞助人「补给线」名单共用这一份。
//!
//! 调用方只管三件事：网址是什么、缓存写哪个文件、拿哪把公钥验签；
//! 剩下的在这里一次做完：
//!
//!   1. **多镜像轮询**：按顺序试，超了总预算就跳过剩下的（第一条卡住不能把后面全堵死）；
//!      每条都挂一个 `t=` 时间戳，绕开中间层缓存；
//!   2. **验签**：验不过就当这个镜像失败 —— 不降级成「信任未签名数据」。
//!      验签函数刻意**不给默认实现**：默认放行等于谁都塞得进来；
//!   3. **本地缓存兜底**：TTL 内直接用缓存；全挂了也回退到缓存；连缓存都没有才报失败。
//!      缓存文件同样要过验签 —— 验不过就当场删掉、当作没有缓存（见 `read_cache_file`）。
//!
//! 为什么读快照而不是接口、为什么必须验签：见 `mods/ratings.rs` 的文件头。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::config;
use crate::net;
use crate::runtime::RuntimePaths;

/// 单个镜像的超时
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// 多镜像轮询的总预算（与索引一致）
pub const TOTAL_BUDGET: Duration = Duration::from_secs(12);

pub(crate) fn now_ms() -> u128 {
    crate::mods::pkg::epoch_ms()
}

/// 验签：`Ok(())` 才算这个镜像可用
pub type Verifier<'a> = &'a dyn Fn(&Value) -> Result<(), String>;

/// 设置里那串地址覆盖。只认 http/https；给了但一条都不合法，就当没给、回落到内置地址。
///
/// 评价源与补给线源各读各的键（`modRatingUrls` / `sponsorUrls`）：
/// 用户可能只想换其中一个，绑在一起会逼着两个一起改。
pub fn urls_from_settings(runtime: &RuntimePaths, key: &str, defaults: &[&str]) -> Vec<String> {
    let settings = config::read_settings(&runtime.settings_file());
    if let Some(items) = settings.get(key).and_then(Value::as_array) {
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
    defaults.iter().map(|item| item.to_string()).collect()
}

/// 读缓存。**缓存也要验签**：验不过就当场删掉、当作没有缓存 —— 与网络那条路共用同一个验签函数。
///
/// 为什么省不得（2026-10-02 报障）：缓存是本地磁盘上一份普通 JSON，用别的钥匙签出来的快照
/// （本地演练源 / 自建源）一旦写进来就会一直躺着。等某个模组的实时分片取不到时（那个模组当时
/// 一条评价都没有，服务端回 503），回退分支把它当「旧数据」端出去 —— 界面上于是出现三条演练
/// 残留的假评论，编号是短得离谱的 `rv-3`，点回复被服务端回一句「reviewId 不合法」。
/// 验签是这一层唯一的真伪判据，**缓存不能例外**。
fn read_cache_file(path: &Path, verify: Verifier<'_>) -> Option<(Value, u128)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let fetched_at = parsed.get("fetchedAt").and_then(Value::as_u64).unwrap_or(0) as u128;
    let payload = parsed.get("payload").cloned()?;
    if verify(&payload).is_err() {
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some((payload, fetched_at))
}

fn write_cache_file(path: &Path, payload: &Value) -> u128 {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fetched_at = now_ms();
    let document = json!({ "fetchedAt": fetched_at as u64, "payload": payload });
    if let Ok(text) = serde_json::to_string(&document) {
        let _ = std::fs::write(path, format!("{text}\n"));
    }
    fetched_at
}

fn fetch_one(url: &str, verify: Verifier<'_>) -> Result<Value, String> {
    let separator = if url.contains('?') { '&' } else { '?' };
    let target = format!("{url}{separator}t={}", now_ms());
    let response = net::get(&target, "application/json", FETCH_TIMEOUT)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("HTTP {}", response.status));
    }
    let Some(payload) = response.json() else {
        return Err("不是合法的 JSON 对象".to_string());
    };
    if !payload.is_object() {
        return Err("不是合法的 JSON 对象".to_string());
    }
    verify(&payload)?;
    Ok(payload)
}

/// 多镜像轮询 + 缓存兜底。`kind` 只用来拼错误文案（评价 / 评论 / 补给线名单）。
pub fn fetch_with_cache(
    urls: Vec<String>,
    cache: PathBuf,
    ttl_ms: u128,
    force: bool,
    kind: &str,
    verify: Verifier<'_>,
) -> Value {
    let cached = read_cache_file(&cache, verify);
    if !force {
        if let Some((payload, fetched_at)) = cached.as_ref() {
            if now_ms().saturating_sub(*fetched_at) < ttl_ms {
                return json!({
                    "ok": true,
                    "payload": payload,
                    "source": "cache",
                    "fetchedAt": fetched_at,
                    "cached": true,
                });
            }
        }
    }

    let started = Instant::now();
    let mut failures: Vec<String> = Vec::new();
    for url in urls {
        if started.elapsed() >= TOTAL_BUDGET {
            failures.push(format!(
                "{url} → 跳过（超出总预算 {}s）",
                TOTAL_BUDGET.as_secs()
            ));
            continue;
        }
        match fetch_one(&url, verify) {
            Ok(payload) => {
                let fetched_at = write_cache_file(&cache, &payload);
                return json!({
                    "ok": true,
                    "payload": payload,
                    "source": url,
                    "fetchedAt": fetched_at,
                    "cached": false,
                });
            }
            Err(reason) => failures.push(format!("{url} → {reason}")),
        }
    }

    let detail = failures.join("；");
    if let Some((payload, fetched_at)) = cached {
        return json!({
            "ok": true,
            "payload": payload,
            "source": "cache",
            "fetchedAt": fetched_at,
            "cached": true,
            "reason": format!("{kind}源不可用，已回退到本地缓存（{detail}）"),
        });
    }
    json!({ "ok": false, "reason": detail })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_cache(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-snapshot-cache-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能创建测试目录");
        dir.join("shard.json")
    }

    fn write_cache(path: &Path, payload: Value) {
        let document = json!({ "fetchedAt": now_ms() as u64, "payload": payload });
        fs::write(path, serde_json::to_string(&document).unwrap()).unwrap();
    }

    #[test]
    fn cache_signed_by_a_foreign_key_is_dropped_instead_of_served() {
        let path = temp_cache("foreign-key");
        // 演练源 / 自建源那份快照：形状完全合法，就是签名不是我们的（2026-10-02 报障）
        write_cache(
            &path,
            json!({ "schemaVersion": 1, "modId": "evejs-a", "reviews": [{ "id": "rv-3" }] }),
        );
        let reject = |_: &Value| Err("签名对不上".to_string());
        // 地址列表留空 = 网络那一步必然全挂，正好只考「回退到缓存」这一条路
        let out = fetch_with_cache(vec![], path.clone(), 60_000, false, "评论", &reject);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false), "{out}");
        assert!(!path.exists(), "验不过的缓存要删掉，别留着下次再端出去");
    }

    #[test]
    fn verified_cache_is_served_within_ttl() {
        let path = temp_cache("verified");
        write_cache(
            &path,
            json!({ "schemaVersion": 1, "modId": "evejs-a", "reviews": [] }),
        );
        let accept = |_: &Value| Ok(());
        let out = fetch_with_cache(vec![], path.clone(), 60_000, false, "评论", &accept);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true), "{out}");
        assert_eq!(out.get("cached").and_then(Value::as_bool), Some(true));
        assert_eq!(out.get("source").and_then(Value::as_str), Some("cache"));
        assert!(path.exists(), "验得过的缓存不该被删");
    }

    #[test]
    fn stale_verified_cache_is_the_last_resort_when_no_source_answers() {
        let path = temp_cache("stale");
        write_cache(
            &path,
            json!({ "schemaVersion": 1, "modId": "evejs-a", "reviews": [] }),
        );
        let accept = |_: &Value| Ok(());
        let out = fetch_with_cache(vec![], path.clone(), 0, false, "评论", &accept);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true), "{out}");
        assert!(
            out.get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("回退"),
            "回退到缓存时要说清来路：{out}"
        );
    }
}
