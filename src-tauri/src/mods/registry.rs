//! 模组市场：拉索引 → 验签 → 缓存 → 比对更新 → 下载安装。对齐现役版 `src/main/modRegistry.ts`。
//!
//! 免服务器模型：
//!   - 索引是**静态 JSON**，托管在 GitHub Pages（+ jsDelivr 镜像），本地还有缓存兜底；
//!   - ZIP 由**作者自己的仓库**托管（GitHub / Gitee Releases），启动器按 `downloadUrls`
//!     的 priority 逐个回退；
//!   - 索引本身由维护者私钥签名，客户端**先验签再信任**里面的 sha256 与下载地址。
//!
//! 「我创建的」(`list_my_mods`) 也在这个模块：它要合并「本地扫描 / 索引缓存 / 提交台账」
//! 三个来源，其中索引那一路必须走**只读缓存**（见 `read_index_cache` 的注释）。
use crate::author;
use crate::config;
use crate::mods::{claim, mods_root, pkg, scan, sign};
use crate::net;
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 默认索引地址（GitHub Pages 主站 + jsDelivr 镜像）。
///
/// ⚠️ 两条地址的路径形状**不一样**：Pages 是从仓库的 `docs/` 目录发布的，所以 Pages
/// 地址不带 `docs/`；jsDelivr 直接读仓库文件，路径必须带 `docs/`。少这段前缀就是 404
/// —— 2026-09-28 实测那条镜像一直 404（备用源等于不存在，Pages 不通时只能吃旧缓存，
/// 表现出来就是「模组市场不同步」）。
pub const DEFAULT_INDEX_URLS: [&str; 2] = [
    "https://diguo520.github.io/EVEjs-mods/mod-index.json",
    "https://cdn.jsdelivr.net/gh/diguo520/EVEjs-mods@main/docs/mod-index.json",
];

const CACHE_FILE: &str = "mod-index.json";
/// 自动路径的缓存有效期：2 分钟。
///
/// 原先是 30 分钟：审核台在后台下架/上架之后市场最长半小时不动，而界面上那个「刷新」
/// 当时又不传 force，用户点了也只是再读一遍这份缓存（2026-09-28 报障的根因）。
/// 缩短到 2 分钟让自动路径也跟得上；要「立刻同步」就走市场页签与刷新按钮的 force。
const TTL_MS: u128 = 2 * 60 * 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// 多镜像轮询的总预算（单镜像 8s 超时 ×N 不能无限拖下去）
const TOTAL_BUDGET: Duration = Duration::from_secs(12);
/// 单个镜像下载 ZIP 的超时
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// 下载安装时写进模组目录的「来源」标记文件（不影响清单校验与签名）
use super::MOD_SOURCE_FILE;

fn now_ms() -> u128 {
    crate::mods::pkg::epoch_ms()
}

pub fn cache_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.cache.join(CACHE_FILE)
}

/// 索引地址：优先设置里的 `modIndexUrls`（只认 http/https），否则用默认两条。
/// 对齐现役版 `indexUrls()`。
pub fn index_urls(runtime: &RuntimePaths) -> Vec<String> {
    let settings = config::read_settings(&runtime.settings_file());
    if let Some(items) = settings.get("modIndexUrls").and_then(Value::as_array) {
        let urls: Vec<String> = items
            .iter()
            .filter_map(Value::as_str)
            .filter(|url| is_http_url(url))
            .map(str::to_string)
            .collect();
        if !urls.is_empty() {
            return urls;
        }
    }
    DEFAULT_INDEX_URLS
        .iter()
        .map(|url| url.to_string())
        .collect()
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_secure_url(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("https://")
}

/* ------------------------------ 缓存与验签 ------------------------------ */

fn read_cache(runtime: &RuntimePaths) -> Option<(Value, u128)> {
    let raw = std::fs::read_to_string(cache_path(runtime)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let index = parsed.get("index")?.clone();
    if !index.is_object() {
        return None;
    }
    let fetched_at = parsed.get("fetchedAt").and_then(Value::as_u64).unwrap_or(0) as u128;
    Some((index, fetched_at))
}

fn write_cache(runtime: &RuntimePaths, index: &Value) -> u128 {
    let fetched_at = now_ms();
    if let Some(dir) = cache_path(runtime).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let payload = json!({ "fetchedAt": fetched_at, "index": index });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(cache_path(runtime), format!("{text}\n"));
    }
    fetched_at
}

/// 验签通过后，把索引里登记的作者公钥注入信任表（模组的签名校验就能认他们）
fn trust_authors_from_index(index: &Value) {
    let Some(entries) = index.get("mods").and_then(Value::as_array) else {
        return;
    };
    for entry in entries {
        let Some(author) = entry.get("author") else {
            continue;
        };
        let key_id = author
            .get("keyId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let public_key = author
            .get("publicKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !key_id.is_empty() && !public_key.is_empty() {
            sign::trust_public_key(key_id, public_key);
        }
    }
}

/// 只读本地缓存的索引（**绝不联网**）。
///
/// 「我创建的」这类要立刻出结果的调用必须用它 —— 否则索引地址不可达时会白等 8~12 秒，
/// 用户会以为点了没反应。真正的联网刷新交给「模组市场」页签的 `fetch_mod_index`。
pub fn read_index_cache(runtime: &RuntimePaths) -> Option<Value> {
    let (index, _) = read_cache(runtime)?;
    // 缓存被改过就当没有（签名对不上）
    if sign::verify_index_signature(&index).is_err() {
        return None;
    }
    trust_authors_from_index(&index);
    Some(index)
}

/// 拉一个镜像：加时间戳防缓存 → 验签 → 注入作者公钥
fn fetch_one(url: &str) -> Result<Value, String> {
    let separator = if url.contains('?') { '&' } else { '?' };
    let target = format!("{url}{separator}t={}", now_ms());
    let response = net::get(&target, "application/json", FETCH_TIMEOUT)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("HTTP {}", response.status));
    }
    let Some(index) = response.json() else {
        return Err("不是合法的 JSON 对象".to_string());
    };
    if !index.is_object() {
        return Err("不是合法的 JSON 对象".to_string());
    }
    if let Err(reason) = sign::verify_index_signature(&index) {
        return Err(format!("索引签名校验失败：{reason}"));
    }
    trust_authors_from_index(&index);
    Ok(index)
}

/// 拉索引：TTL 内直接用缓存；超过 TTL（或 `force`）才联网。
/// 全部镜像失败时回退到最后一份缓存（并标注 `cached`）。
pub fn fetch_mod_index(runtime: &RuntimePaths, force: bool) -> Value {
    let cached = read_cache(runtime);
    if !force {
        if let Some((index, fetched_at)) = cached.as_ref() {
            if now_ms().saturating_sub(*fetched_at) < TTL_MS {
                trust_authors_from_index(index);
                return json!({
                    "ok": true,
                    "index": index,
                    "source": "cache",
                    "fetchedAt": fetched_at,
                    "cached": true,
                });
            }
        }
    }

    let started = Instant::now();
    let mut failures: Vec<String> = Vec::new();
    for url in index_urls(runtime) {
        // 现役版用 AbortController 卡 12s 总预算；阻塞式实现按「已耗时」等价处理
        if started.elapsed() >= TOTAL_BUDGET {
            failures.push(format!(
                "{url} → 跳过（超出总预算 {}s）",
                TOTAL_BUDGET.as_secs()
            ));
            continue;
        }
        match fetch_one(&url) {
            Ok(index) => {
                let fetched_at = write_cache(runtime, &index);
                return json!({
                    "ok": true,
                    "index": index,
                    "source": url,
                    "fetchedAt": fetched_at,
                    "cached": false,
                });
            }
            Err(reason) => failures.push(format!("{url} → {reason}")),
        }
    }

    let detail = failures.join("；");
    if let Some((index, fetched_at)) = cached {
        trust_authors_from_index(&index);
        return json!({
            "ok": true,
            "index": index,
            "source": "cache",
            "fetchedAt": fetched_at,
            "cached": true,
            "reason": format!("网络不可用，已回退到本地缓存（{detail}）"),
        });
    }
    let reason = if detail.is_empty() {
        "没有配置索引地址".to_string()
    } else {
        detail
    };
    json!({ "ok": false, "reason": reason })
}

/* ------------------------------ 版本比较 ------------------------------ */

/// 极简 semver 比较：数字段逐个比，预发布视为小于正式版（对齐 `compareVersion`）
pub fn compare_version(a: &str, b: &str) -> i32 {
    fn parse(value: &str) -> (Vec<i64>, String) {
        let trimmed = value.trim();
        let without_v = trimmed
            .strip_prefix('v')
            .or_else(|| trimmed.strip_prefix('V'))
            .unwrap_or(trimmed);
        let mut parts = without_v.splitn(2, '-');
        let core = parts.next().unwrap_or_default();
        let pre = parts.next().unwrap_or_default().to_string();
        let nums = core
            .split('.')
            .map(|item| {
                // 对齐 JS `Number.parseInt(x, 10) || 0`：非数字（含 "12abc"）取前缀数字
                let digits: String = item.chars().take_while(|ch| ch.is_ascii_digit()).collect();
                digits.parse::<i64>().unwrap_or(0)
            })
            .collect();
        (nums, pre)
    }
    let (left_nums, left_pre) = parse(a);
    let (right_nums, right_pre) = parse(b);
    let width = left_nums.len().max(right_nums.len());
    for index in 0..width {
        let left = left_nums.get(index).copied().unwrap_or(0);
        let right = right_nums.get(index).copied().unwrap_or(0);
        if left != right {
            return if left < right { -1 } else { 1 };
        }
    }
    if left_pre == right_pre {
        return 0;
    }
    if left_pre.is_empty() {
        return 1;
    }
    if right_pre.is_empty() {
        return -1;
    }
    if left_pre < right_pre {
        -1
    } else {
        1
    }
}

/// 当前 EveJS 版本是否满足条目的 `evejsVersions` 声明（支持 `0.12.x` 这种通配）
pub fn satisfies_evejs(entry: &Value, evejs_version: &str) -> bool {
    let list = entry.get("evejsVersions").and_then(Value::as_array);
    let list = match list {
        Some(list) if !list.is_empty() => list,
        _ => return true,
    };
    let current = evejs_version.trim();
    if current.is_empty() {
        return true;
    }
    let current_lower = current.to_ascii_lowercase();
    list.iter().any(|want| {
        let want = want.as_str().unwrap_or_default().trim();
        if want.is_empty() {
            return false;
        }
        if want.to_ascii_lowercase() == current_lower {
            return true;
        }
        if let Some(prefix) = want.strip_suffix(".x") {
            return current_lower.starts_with(&prefix.to_ascii_lowercase());
        }
        // 同 major.minor 的补丁向上兼容：声明 0.12.8、本机 0.12.9 → 放行。
        // 索引里的模组普遍只声明发布时的那个补丁号，卡死会让 0.12.9 的服务端看到空市场。
        matches!(
            (version_triple(want), version_triple(current)),
            (Some((want_major, want_minor, want_patch)), Some((major, minor, patch)))
                if want_major == major && want_minor == minor && patch >= want_patch
        )
    })
}

/// `[v]major[.minor[.patch]]` → (major, minor, patch)；带预发布标记或解析不了时返回 None。
///
/// 只服务于「补丁向上兼容」这一条：解析不出来就退回严格相等，不做猜测。
fn version_triple(value: &str) -> Option<(u64, u64, u64)> {
    let trimmed = value.trim();
    let without_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if without_v.is_empty() || without_v.contains('-') {
        return None;
    }
    let mut numbers = [0u64; 3];
    let mut seen = 0usize;
    let mut parts = without_v.split('.');
    for slot in numbers.iter_mut() {
        let Some(text) = parts.next() else { break };
        let digits: String = text.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        *slot = digits.parse().ok()?;
        seen += 1;
    }
    if seen == 0 || parts.next().is_some() {
        return None;
    }
    Some((numbers[0], numbers[1], numbers[2]))
}

/// 本地已装模组 vs 索引：挑出「索引版本更高」的（跳过已下架条目）
pub fn find_updates(local_mods: &[scan::ModRecord], index: &Value) -> Vec<Value> {
    let empty: Vec<Value> = Vec::new();
    let entries = index
        .get("mods")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut out = Vec::new();
    for local in local_mods {
        let Some(entry) = entries
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(local.id.as_str()))
        else {
            continue;
        };
        let version = entry
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if version.is_empty() {
            continue;
        }
        if entry
            .get("delisted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if compare_version(version, &local.version) > 0 {
            out.push(json!({
                "id": local.id,
                "displayName": if local.display_name.is_empty() { local.id.clone() } else { local.display_name.clone() },
                "localVersion": local.version,
                "remoteVersion": version,
                "entry": entry,
            }));
        }
    }
    out
}
/* ------------------------------ 下载与安装 ------------------------------ */

/// 下载条目 ZIP：按 priority 试每个镜像 → 校验 sha256 → 返回本地路径。
/// 进度回调收到的是**数组载荷**要用的那个对象（`mod:downloadProgress`）。
pub fn download_entry(
    entry: &Value,
    runtime: &RuntimePaths,
    mut on_progress: impl FnMut(Value),
) -> Value {
    let mut urls: Vec<&Value> = entry
        .get("downloadUrls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| is_secure_url(&url_of(item)))
                .collect()
        })
        .unwrap_or_default();
    if urls.is_empty() {
        return json!({ "ok": false, "reason": "这个条目没有可用的下载地址（作者未提供）" });
    }
    // priority 缺省按 99 参与排序（对齐 `Number(a.priority) || 99`）
    urls.sort_by_key(|item| item.get("priority").and_then(Value::as_i64).unwrap_or(99));

    let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
    let version = entry.get("version").and_then(Value::as_str).unwrap_or("0");
    let dest_dir = runtime.temp.join("market");
    let _ = std::fs::create_dir_all(&dest_dir);
    let dest = dest_dir.join(format!("{id}-{version}.zip"));

    let want = entry
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();

    let mut failures: Vec<String> = Vec::new();
    for item in urls {
        let url = url_of(item);
        let mirror = item
            .get("mirror")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let total_holder = std::cell::Cell::new(None::<u64>);
        let id_owned = id.to_string();
        let mirror_owned = mirror.clone();
        let outcome = net::download(&url, &dest, DOWNLOAD_TIMEOUT, |downloaded, total| {
            total_holder.set(total);
            let percent = total
                .filter(|value| *value > 0)
                .map(|value| (downloaded as f64 / value as f64 * 100.0).round() as u64);
            let mut payload = Map::new();
            payload.insert("id".into(), json!(id_owned));
            payload.insert("downloaded".into(), json!(downloaded));
            payload.insert(
                "total".into(),
                total.map(|value| json!(value)).unwrap_or(Value::Null),
            );
            payload.insert(
                "percent".into(),
                percent.map(|value| json!(value)).unwrap_or(Value::Null),
            );
            payload.insert("mirror".into(), json!(mirror_owned));
            on_progress(Value::Object(payload));
        });
        match outcome {
            Ok(download) => {
                if download.bytes == 0 {
                    failures.push(format!("{mirror} → 空文件"));
                    continue;
                }
                if !want.is_empty() {
                    match pkg::sha256_file(&dest) {
                        Ok((got, _)) if got == want => {}
                        Ok((got, _)) => {
                            // 只展示前 12 位，和现役版提示保持一致
                            failures.push(format!(
                                "{mirror} → sha256 不匹配（期望 {}… 实际 {}…）",
                                &want[..want.len().min(12)],
                                &got[..got.len().min(12)]
                            ));
                            continue;
                        }
                        Err(reason) => {
                            failures.push(format!("{mirror} → {reason}"));
                            continue;
                        }
                    }
                }
                return json!({
                    "ok": true,
                    "zipPath": dest.to_string_lossy(),
                    "mirror": mirror,
                });
            }
            Err(reason) => failures.push(format!("{mirror} → {reason}")),
        }
    }

    // 全部镜像都 404 = 作者删除/改名了仓库或 Release 资源（索引里还留着旧地址）
    let all404 = !failures.is_empty() && failures.iter().all(|item| item.contains("HTTP 404"));
    if all404 {
        return json!({
            "ok": false,
            "reason": format!(
                "下载地址已失效（HTTP 404）：作者可能删除了仓库或 Release 资源。请点「检查更新」刷新索引后重试；\
                 如果这个模组还在列表里，说明索引尚未更新（可联系维护者下架）。 详细信息：{}",
                failures.join("；")
            ),
        });
    }
    json!({ "ok": false, "reason": format!("所有镜像都失败了：{}", failures.join("；")) })
}

fn url_of(item: &Value) -> String {
    item.get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 记下「这个目录是从模组市场下载安装的」，供已安装详情里的「来源」字段使用。
/// 写在模组目录里的隐藏文件，不影响清单校验与签名。
fn record_market_source(repo_root: &Path, folder: &str, entry: &Value) {
    if folder.is_empty() {
        return;
    }
    // B1：folder 来自（远端）市场索引，拼路径前必须做组件级包含判定
    let Some(dir) = crate::mods::join_within(&mods_root(repo_root), folder) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let payload = json!({
        "source": "market",
        "repo": entry.get("repo").and_then(Value::as_str).unwrap_or_default(),
        "version": entry.get("version").and_then(Value::as_str).unwrap_or_default(),
        "id": entry.get("id").and_then(Value::as_str).unwrap_or_default(),
        "at": pkg::iso_from_ms(pkg::epoch_ms() as u64),
    });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(dir.join(MOD_SOURCE_FILE), format!("{text}\n"));
    }
}

/// 下载并安装/更新：已装则走 `update_mod`（保留启用状态与用户数据），否则走 `import_mod_zip`
pub fn install_entry(
    repo_root: &Path,
    runtime: &RuntimePaths,
    entry: &Value,
    on_progress: impl FnMut(Value),
) -> Value {
    let downloaded = download_entry(entry, runtime, on_progress);
    let zip_path = downloaded
        .get("zipPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !downloaded
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || zip_path.is_empty()
    {
        let reason = downloaded
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("下载失败");
        return json!({ "ok": false, "reason": reason });
    }

    let entry_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
    let entry_version = entry
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let local = scan::scan_mods(repo_root, runtime)
        .mods
        .into_iter()
        .find(|item| item.id == entry_id);

    if let Some(local) = local {
        let updated = pkg::update_mod(repo_root, &zip_path, runtime);
        let ok = updated.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let folder = {
            let value = updated
                .get("folder")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if value.is_empty() {
                entry_id
            } else {
                value
            }
        };
        if ok {
            record_market_source(repo_root, folder, entry);
        }
        return json!({
            "ok": ok,
            "mode": "update",
            "id": updated.get("id").and_then(Value::as_str).unwrap_or(entry_id),
            "folder": updated.get("folder").cloned().unwrap_or(Value::Null),
            "version": updated.get("newVersion").and_then(Value::as_str).unwrap_or(entry_version),
            "previousVersion": updated.get("previousVersion").and_then(Value::as_str).unwrap_or(&local.version),
            "reason": updated.get("reason").cloned().unwrap_or(Value::Null),
        });
    }

    let imported = pkg::import_mod_zip(repo_root, &zip_path, runtime);
    let ok = imported.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        let folder = {
            let value = imported
                .get("folder")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if value.is_empty() {
                entry_id
            } else {
                value
            }
        };
        record_market_source(repo_root, folder, entry);
    }
    json!({
        "ok": ok,
        "mode": "install",
        "id": entry_id,
        "folder": imported.get("folder").cloned().unwrap_or(Value::Null),
        "version": entry_version,
        "reason": imported.get("reason").cloned().unwrap_or(Value::Null),
    })
}

/* --------------------------- IPC 通道实现 --------------------------- */

/// `mods:marketList`：索引 + 兼容性分组 + 可更新列表。
/// 兼容性用**本机 EveJS 版本**判定，被下架的条目从市场隐藏（但「我创建的」里仍可见原因）。
pub fn market_list(repo_root: &Path, runtime: &RuntimePaths, force: bool) -> Value {
    let market = fetch_mod_index(runtime, force);
    let evejs_version = crate::env::read_evejs_version(repo_root);
    let index = if market.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        market.get("index").cloned()
    } else {
        None
    };
    let entries = index
        .as_ref()
        .and_then(|value| value.get("mods"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut listed: Vec<Value> = Vec::new();
    let mut delisted: Vec<Value> = Vec::new();
    for entry in entries {
        if entry
            .get("delisted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            let display_name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(id);
            delisted.push(json!({
                "id": id,
                "displayName": display_name,
                "reason": entry.get("delistReason").cloned().unwrap_or(Value::Null),
                "by": entry.get("moderatedBy").and_then(Value::as_str).unwrap_or_default(),
                "at": entry.get("moderatedAt").and_then(Value::as_str).unwrap_or_default(),
            }));
            continue;
        }
        listed.push(entry);
    }

    let mut compatible: Vec<Value> = Vec::new();
    let mut blocked: Vec<Value> = Vec::new();
    for entry in listed {
        if satisfies_evejs(&entry, &evejs_version) {
            compatible.push(entry);
        } else {
            blocked.push(json!({
                "id": entry.get("id").and_then(Value::as_str).unwrap_or_default(),
                "evejsVersions": entry.get("evejsVersions").cloned().unwrap_or_else(|| json!([])),
            }));
        }
    }

    let updates = match index.as_ref() {
        Some(index) => json!(find_updates(
            &scan::scan_mods(repo_root, runtime).mods,
            index
        )),
        None => json!([]),
    };
    let moderation = index
        .as_ref()
        .and_then(|value| value.get("moderation"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut payload = match market.as_object().cloned() {
        Some(map) => map,
        None => Map::new(),
    };
    payload.insert("mods".into(), json!(compatible));
    payload.insert("blocked".into(), json!(blocked));
    payload.insert("delisted".into(), json!(delisted));
    payload.insert("moderation".into(), moderation);
    payload.insert("updates".into(), updates);
    payload.insert("evejsVersion".into(), json!(evejs_version));
    payload.insert("indexUrls".into(), json!(index_urls(runtime)));
    Value::Object(payload)
}

/// `mods:marketInstall`：被下架的条目直接拒绝，其余交给 `install_entry`
pub fn market_install(
    repo_root: &Path,
    runtime: &RuntimePaths,
    entry: &Value,
    on_progress: impl FnMut(Value),
) -> Value {
    if entry
        .get("delisted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({ "ok": false, "reason": "该模组已被维护者下架，不能安装或更新" });
    }
    install_entry(repo_root, runtime, entry, on_progress)
}
/* ------------------------------ 「我创建的」 ------------------------------ */

fn item_str(item: Option<&Value>, key: &str) -> String {
    item.and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 台账这一条算不算「已提交审核」。
///
/// 三种写法都认：新版发布流程登记收录源后写 `status = "submitted"`；老版提
/// `mods/<id>.json` PR 时写的是 `prUrl`；**还要认 `sourceReviewUrl`** —— 只认前两者时，
/// 用「本地签名 + 令牌」新流程发布过的台账（只有 PR 地址、status 还是 draft）会一直显示成
/// 「草稿」，界面上既看不到「审核中」，也找不到那条收录源 PR（2026-09-28 报障）。
fn ledger_submitted(submission: &Value) -> bool {
    item_str(Some(submission), "status") == "submitted"
        || !item_str(Some(submission), "prUrl").is_empty()
        || !item_str(Some(submission), "sourceReviewUrl").is_empty()
}

fn item_u64(item: Option<&Value>, key: &str) -> u64 {
    item.and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn item_bool(item: Option<&Value>, key: &str) -> bool {
    item.and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn item_value(item: Option<&Value>, key: &str) -> Value {
    item.and_then(|value| value.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

/// 状态排序权重（越小越靠前）
fn status_order(status: &str) -> u32 {
    match status {
        "rejected" => 0,
        "submitted" => 1,
        "update-pending" => 2,
        "listed" => 3,
        "delisted" => 4,
        "draft" => 5,
        "local" => 6,
        _ => 9,
    }
}

fn fork_name(repo: &str) -> String {
    repo.split('/').nth(1).unwrap_or_default().to_string()
}

/// 「我创建的」：合并三个来源 —— 本地扫到的（author.id / 签名 keyId 是本机）、索引缓存里的、
/// 本机提交台账。状态优先级：索引已下架 > 索引已上架 > 台账已提交 > 台账草稿 > 仅本地。
///
/// 索引那一路**只读本地缓存、绝不联网**：否则索引地址不可达时会白等 8~12 秒。
pub fn list_my_mods(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let identity = match author::read_identity() {
        Ok(identity) => identity,
        Err(_) => return json!({ "ok": false, "items": [], "reason": "读不到本机作者身份" }),
    };
    let author_id = identity.id;
    let key_id = identity.key_id;

    let scanned = scan::scan_mods(repo_root, runtime).mods;
    let mut items: HashMap<String, Value> = HashMap::new();

    // 1) 本地扫到的模组（后面还要用它判断哪些记录已经「没有本地文件」了）
    for record in &scanned {
        let mine = (!record.author_id.is_empty() && record.author_id == author_id)
            || (!record.signature_key_id.is_empty() && record.signature_key_id == key_id)
            // 认领过的旧模组也算「我创建的」：重装系统换了身份之后，他得能在提交弹窗里
            // 选到自己的模组才谈得上更新（见 mods/claim.rs）
            || claim::is_claimed(runtime, &record.id);
        if !mine {
            continue;
        }
        let id = record.id.clone();
        items.insert(
            id.clone(),
            json!({
                "id": id,
                "displayName": if record.display_name.is_empty() { id } else { record.display_name.clone() },
                "version": record.version,
                "category": record.category,
                "status": "local",
                "folder": record.folder,
                "localVersion": record.version,
                "listedVersion": "",
                "signed": record.signature_state == "valid",
                "sourceRepo": "",
                "prUrl": "",
                "sizeBytes": record.size_bytes,
                "updatedAt": 0,
            }),
        );
    }

    // 2) 索引缓存（只读，不联网）
    let cached = read_index_cache(runtime);
    let entries = cached
        .as_ref()
        .and_then(|value| value.get("mods"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for entry in &entries {
        let entry_author_id = entry
            .get("author")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if entry_author_id != author_id {
            continue;
        }
        let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        let prev = items.get(id);
        let local_version = item_str(prev, "version");
        let listed_version = entry
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let needs_update =
            !local_version.is_empty() && compare_version(&local_version, listed_version) > 0;
        let delisted = entry
            .get("delisted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = if needs_update {
            "update-pending"
        } else if delisted {
            "delisted"
        } else {
            "listed"
        };
        let display_name = {
            let value = entry
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if value.is_empty() {
                id.to_string()
            } else {
                value.to_string()
            }
        };
        let category = {
            let value = entry
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if value.is_empty() {
                item_str(prev, "category")
            } else {
                value.to_string()
            }
        };
        let updated_at = entry
            .get("publishedAt")
            .and_then(Value::as_str)
            .and_then(pkg::ms_from_iso_date)
            .unwrap_or_else(|| pkg::epoch_ms() as u64);
        items.insert(
            id.to_string(),
            json!({
                "id": id,
                "displayName": display_name,
                "version": if local_version.is_empty() { listed_version } else { &local_version },
                "category": category,
                "status": status,
                "moderationAction": if delisted { "delist" } else { "" },
                "moderationReason": entry.get("delistReason").cloned().filter(|value| !value.is_null()).unwrap_or(Value::Null),
                "moderatedBy": entry.get("moderatedBy").and_then(Value::as_str).unwrap_or_default(),
                "moderatedAt": entry.get("moderatedAt").and_then(Value::as_str).unwrap_or_default(),
                "folder": item_str(prev, "folder"),
                "localVersion": local_version,
                "listedVersion": listed_version,
                "signed": item_bool(prev, "signed"),
                "sourceRepo": item_str(prev, "sourceRepo"),
                "prUrl": item_str(prev, "prUrl"),
                "sizeBytes": entry.get("sizeBytes").and_then(Value::as_u64).unwrap_or_else(|| item_u64(prev, "sizeBytes")),
                "updatedAt": updated_at,
            }),
        );
    }

    // 2b) 被「拒绝收录」的模组不会出现在 mods[] 里，只登记在 moderation 表 —— 补一条给作者看原因
    let moderation = cached
        .as_ref()
        .and_then(|value| value.get("moderation"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let ledger = crate::mods::submit::submission_items(runtime);
    for (key, record) in &moderation {
        let action = record
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action != "reject" && action != "delist" {
            continue;
        }
        // 「这条拒绝记录是不是我的」按可靠度从高到低判定：
        //   1) 索引里的 authorId 就是本机作者；
        //   2) 该 id 已经在本地列表里（本地文件夹或投稿台账）；
        //   3) 同一个仓库名在本地台账里（作者删了 mods/<id> 后仍能认领）；
        //   4) 降级：记录没带 authorId 时，清单里的 source 仓库名与本地台账一致也认领
        let record_author_id = record
            .get("authorId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let record_source = record
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let record_id = record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let mut mine = (!record_author_id.is_empty() && record_author_id == author_id)
            || (!record_id.is_empty() && items.contains_key(&record_id));
        if !mine && !record_source.is_empty() {
            mine = items.values().any(|item| {
                let source = item_str(Some(item), "sourceRepo").to_ascii_lowercase();
                !source.is_empty() && source == record_source
            });
        }
        if !mine {
            if let Some(fork) = Some(fork_name(&record_source)).filter(|value| !value.is_empty()) {
                mine = ledger.iter().any(|entry| {
                    let entry_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
                    let entry_source = entry
                        .get("sourceRepo")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if !record_id.is_empty() && !entry_id.is_empty() && entry_id == record_id {
                        return true;
                    }
                    if !record_source.is_empty()
                        && !entry_source.is_empty()
                        && entry_source == record_source
                    {
                        return true;
                    }
                    let entry_fork = fork_name(&entry_source);
                    !entry_fork.is_empty() && entry_fork == fork
                });
            }
        }
        if !mine {
            continue;
        }

        let prev = items
            .get(&record_id)
            .or_else(|| {
                if record_source.is_empty() {
                    None
                } else {
                    items.values().find(|item| {
                        item_str(Some(item), "sourceRepo").to_ascii_lowercase() == record_source
                    })
                }
            })
            .cloned();
        let id = if item_str(prev.as_ref(), "id").is_empty() {
            if record_id.is_empty() {
                let source = record
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if source.is_empty() {
                    key.clone()
                } else {
                    source.to_string()
                }
            } else {
                record_id.clone()
            }
        } else {
            item_str(prev.as_ref(), "id")
        };
        if action == "delist" && item_str(prev.as_ref(), "status") == "delisted" {
            continue; // 上面已经标过
        }
        let display_name = {
            let value = record
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if value.is_empty() {
                let from_prev = item_str(prev.as_ref(), "displayName");
                if from_prev.is_empty() {
                    id.clone()
                } else {
                    from_prev
                }
            } else {
                value.to_string()
            }
        };
        let updated_at = {
            let previous = item_u64(prev.as_ref(), "updatedAt");
            if previous > 0 {
                previous
            } else {
                record
                    .get("at")
                    .and_then(Value::as_str)
                    .and_then(pkg::ms_from_iso_date)
                    .unwrap_or_else(|| pkg::epoch_ms() as u64)
            }
        };
        let moderation_source = {
            let value = item_str(prev.as_ref(), "sourceRepo");
            if value.is_empty() {
                record
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            } else {
                value
            }
        };
        items.insert(
            id.clone(),
            json!({
                "id": id,
                "displayName": display_name,
                "version": item_str(prev.as_ref(), "version"),
                "category": item_str(prev.as_ref(), "category"),
                "status": if action == "delist" { "delisted" } else { "rejected" },
                "folder": item_str(prev.as_ref(), "folder"),
                "localVersion": item_str(prev.as_ref(), "localVersion"),
                "listedVersion": "",
                "signed": item_bool(prev.as_ref(), "signed"),
                "sourceRepo": moderation_source,
                "prUrl": item_str(prev.as_ref(), "prUrl"),
                "sizeBytes": item_u64(prev.as_ref(), "sizeBytes"),
                "updatedAt": updated_at,
                "moderationAction": action,
                "moderationReason": record.get("reason").cloned().filter(|value| !value.is_null()).unwrap_or(Value::Null),
                "moderatedBy": record.get("by").and_then(Value::as_str).unwrap_or_default(),
                "moderatedAt": record.get("at").and_then(Value::as_str).unwrap_or_default(),
            }),
        );
    }

    // 3) 本机提交台账
    for submission in &ledger {
        let id = submission
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let prev = items.get(id).cloned();
        let submitted = ledger_submitted(submission);
        let prev_status = item_str(prev.as_ref(), "status");
        let status = if !prev_status.is_empty() && prev_status != "local" {
            prev_status.clone()
        } else if submitted {
            "submitted".to_string()
        } else {
            "draft".to_string()
        };
        let display_name = {
            let value = item_str(Some(submission), "displayName");
            if value.is_empty() {
                id.to_string()
            } else {
                value
            }
        };
        let version_value = {
            let local = item_str(prev.as_ref(), "localVersion");
            if local.is_empty() {
                item_str(Some(submission), "version")
            } else {
                local
            }
        };
        let submission_size = {
            let size = item_u64(Some(submission), "sizeBytes");
            if size > 0 {
                size
            } else {
                item_u64(prev.as_ref(), "sizeBytes")
            }
        };
        let source_repo = {
            let value = item_str(Some(submission), "sourceRepo");
            if value.is_empty() {
                item_str(prev.as_ref(), "sourceRepo")
            } else {
                value
            }
        };
        let pr_url = {
            let review = item_str(Some(submission), "sourceReviewUrl");
            if !review.is_empty() {
                review
            } else {
                let direct = item_str(Some(submission), "prUrl");
                if direct.is_empty() {
                    item_str(prev.as_ref(), "prUrl")
                } else {
                    direct
                }
            }
        };
        items.insert(
            id.to_string(),
            json!({
                "id": id,
                "displayName": display_name,
                "version": version_value,
                "category": item_str(prev.as_ref(), "category"),
                "status": status,
                "moderationAction": item_value(prev.as_ref(), "moderationAction"),
                "moderationReason": item_value(prev.as_ref(), "moderationReason"),
                "moderatedBy": item_str(prev.as_ref(), "moderatedBy"),
                "moderatedAt": item_str(prev.as_ref(), "moderatedAt"),
                "folder": item_str(prev.as_ref(), "folder"),
                "localVersion": item_str(prev.as_ref(), "localVersion"),
                "listedVersion": item_str(prev.as_ref(), "listedVersion"),
                "signed": item_bool(prev.as_ref(), "signed"),
                "sourceRepo": source_repo,
                "prUrl": pr_url,
                "sizeBytes": submission_size,
                "updatedAt": item_u64(Some(submission), "createdAt"),
                // 审核 PR 的校验结果（提交时读过一次，之后按 30 分钟节流复查）
                "reviewPrState": item_str(Some(submission), "reviewPrState"),
                "reviewPrNumber": item_str(Some(submission), "reviewPrNumber"),
                "reviewSubmittedAt": item_u64(Some(submission), "submittedAt"),
            }),
        );
    }

    let mut all: Vec<Value> = items.into_values().collect();
    all.sort_by(|left, right| {
        let left_status = left
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_status = right
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let rank = status_order(left_status).cmp(&status_order(right_status));
        if rank != std::cmp::Ordering::Equal {
            return rank;
        }
        let left_at = left.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        let right_at = right.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        match right_at.cmp(&left_at) {
            std::cmp::Ordering::Equal => shell::locale_compare(
                left.get("id").and_then(Value::as_str).unwrap_or_default(),
                right.get("id").and_then(Value::as_str).unwrap_or_default(),
            ),
            other => other,
        }
    });

    // 只显示「本地还有文件夹」或「索引里仍是可安装条目」的；其余只挂着审核记录 / 提交台账的记录
    // 会被隐藏 —— 否则作者把 mods/<id> 删掉后，被拒绝收录的条目会一直留在「我创建的」里。
    let local_folders: Vec<String> = scanned.iter().map(|item| item.folder.clone()).collect();
    let listed_ids: Vec<String> = entries
        .iter()
        .filter(|entry| !entry_bool(entry, "delisted"))
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let keep_moderated = |item: &Value| {
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        status == "rejected"
            || status == "delisted"
            || !item_str(Some(item), "moderationAction").is_empty()
    };
    let list: Vec<Value> = all
        .iter()
        .filter(|item| {
            let folder = item_str(Some(item), "folder");
            let id = item_str(Some(item), "id");
            (!folder.is_empty() && local_folders.contains(&folder))
                || listed_ids.contains(&id)
                || keep_moderated(item)
        })
        .cloned()
        .collect();

    json!({
        "ok": true,
        "items": list,
        "hidden": all.len() - list.len(),
    })
}

fn entry_bool(entry: &Value, key: &str) -> bool {
    entry.get(key).and_then(Value::as_bool).unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_runtime(tag: &str) -> RuntimePaths {
        let root = std::env::temp_dir().join(format!(
            "evejs-registry-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let paths = RuntimePaths::from_root(root, true);
        for dir in [&paths.root, &paths.user_data, &paths.cache, &paths.temp] {
            let _ = std::fs::create_dir_all(dir);
        }
        paths
    }

    #[test]
    fn compare_version_matches_node_semantics() {
        assert_eq!(compare_version("1.0.0", "1.0.0"), 0);
        assert_eq!(compare_version("v1.2.0", "1.1.9"), 1);
        assert_eq!(compare_version("1.0", "1.0.1"), -1);
        // 预发布小于正式版
        assert_eq!(compare_version("1.0.0-beta", "1.0.0"), -1);
        assert_eq!(compare_version("1.0.0", "1.0.0-beta"), 1);
        // 注意：这里**不是** semver 排序，而是纯字符串比大小，与现役版逐字一致
        assert_eq!(compare_version("1.0.0-beta.2", "1.0.0-beta.10"), 1);
        // 非数字段按 0 处理（对齐 Number.parseInt 的容错）
        assert_eq!(compare_version("1.x.0", "1.0.0"), 0);
        assert_eq!(compare_version("", "0.0.0"), 0);
    }

    /// 台账里的「已提交审核」三种写法都要认（status=submitted / prUrl / sourceReviewUrl）。
    /// 最后一条是新流程的台账：只有 PR 地址、status 还是 draft，漏了它就永远显示成草稿。
    #[test]
    fn ledger_submitted_accepts_all_three_shapes() {
        assert!(ledger_submitted(&json!({ "status": "submitted" })));
        assert!(ledger_submitted(
            &json!({ "prUrl": "https://example.com/pull/1" })
        ));
        assert!(ledger_submitted(&json!({
            "status": "draft",
            "sourceRepo": "a/b",
            "sourceReviewUrl": "https://example.com/pull/8"
        })));
        assert!(!ledger_submitted(
            &json!({ "status": "draft", "sourceReviewUrl": "" })
        ));
        assert!(!ledger_submitted(&json!({})));
    }

    #[test]
    fn satisfies_evejs_honours_wildcards() {
        let entry = json!({ "evejsVersions": ["0.12.x", "0.11.3"] });
        assert!(satisfies_evejs(&entry, "0.12.8"));
        assert!(satisfies_evejs(&entry, "0.11.3"));
        assert!(!satisfies_evejs(&entry, "0.13.0"));
        // 没声明 / 本机版本为空 → 一律放行
        assert!(satisfies_evejs(&json!({}), "0.12.8"));
        assert!(satisfies_evejs(&entry, ""));
    }

    #[test]
    fn satisfies_evejs_allows_patch_forward_compatibility() {
        // 索引里的模组普遍只声明发布时的补丁号（0.12.8），服务端升到 0.12.9 不该把市场清空
        let entry = json!({ "evejsVersions": ["0.12.8"] });
        assert!(satisfies_evejs(&entry, "0.12.9"));
        assert!(satisfies_evejs(&entry, "0.12.8"));
        // 本机比声明更旧不放行：旧服务端跑新模组不在「补丁兼容」的语义里
        assert!(!satisfies_evejs(&entry, "0.12.7"));
        // minor / major 仍然拦住 —— 那才是 0.12.x / 0.13.x 通配的用武之地
        assert!(!satisfies_evejs(&entry, "0.13.0"));
        assert!(!satisfies_evejs(&entry, "1.0.0"));
        // 带预发布标记的只能精确命中，不参与补丁兼容
        let rc = json!({ "evejsVersions": ["0.12.8-rc.1"] });
        assert!(satisfies_evejs(&rc, "0.12.8-rc.1"));
        assert!(!satisfies_evejs(&rc, "0.12.9"));
    }

    #[test]
    fn find_updates_skips_delisted_and_same_version() {
        let index = json!({
            "mods": [
                { "id": "old", "version": "2.0.0" },
                { "id": "same", "version": "1.0.0" },
                { "id": "gone", "version": "9.9.9", "delisted": true },
            ]
        });
        let local = vec![
            record("old", "1.0.0", "Old Mod"),
            record("same", "1.0.0", "Same Mod"),
            record("gone", "1.0.0", "Gone Mod"),
        ];
        let updates = find_updates(&local, &index);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["id"], "old");
        assert_eq!(updates[0]["displayName"], "Old Mod");
        assert_eq!(updates[0]["localVersion"], "1.0.0");
        assert_eq!(updates[0]["remoteVersion"], "2.0.0");
    }

    fn record(id: &str, version: &str, display_name: &str) -> scan::ModRecord {
        let mut record = scan::read_mod_dir(id, Path::new("E:\\__missing__"));
        record.id = id.to_string();
        record.version = version.to_string();
        record.display_name = display_name.to_string();
        record
    }

    #[test]
    fn cache_without_signature_is_ignored() {
        let runtime = temp_runtime("unsigned");
        write_cache(&runtime, &json!({ "schemaVersion": 1, "mods": [] }));
        // 索引必须由维护者签名，没签名就当没有（否则任何人都能伪造下载地址）
        assert!(read_index_cache(&runtime).is_none());
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn signed_cache_is_trusted_and_triggers_author_registration() {
        let runtime = temp_runtime("signed");
        let key = sign::generate_signing_key().expect("应能生成密钥");
        let key_id = sign::key_id_of(&key);
        let public_key = sign::public_key_base64(&key);
        sign::trust_public_key(&key_id, &public_key);

        let mut index = json!({
            "schemaVersion": 1,
            "mods": [
                { "id": "demo", "version": "1.1.0", "author": { "id": "au-x", "keyId": key_id, "publicKey": public_key } }
            ]
        });
        let signature = sign::sign_manifest(&index, &key);
        index["signature"] = json!({ "alg": "ed25519", "keyId": key_id, "sig": signature });
        write_cache(&runtime, &index);

        let cached = read_index_cache(&runtime).expect("签名缓存应通过校验");
        assert_eq!(cached["mods"][0]["id"], "demo");
        // 验签通过后作者公钥会被注入信任表（否则模组自己的签名校验认不出作者）
        assert!(sign::trusted_key_ids().contains(&key_id));

        // 改一个字节 → 缓存立刻失效
        let mut tampered = cached.clone();
        tampered["mods"][0]["version"] = json!("9.9.9");
        write_cache(&runtime, &tampered);
        assert!(read_index_cache(&runtime).is_none());
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    /// 镜像地址必须带 `docs/`：Pages 从仓库 docs/ 发布（地址不带），jsDelivr 直接读仓库
    /// 文件（必须带）。少这段前缀就是 404 —— 2026-09-28 实测那条备用镜像一直 404，
    /// 于是 Pages 不通时只能吃旧缓存，表现出来就是「模组市场不同步」。
    #[test]
    fn default_index_urls_point_at_the_jsdelivr_docs_path() {
        assert_eq!(
            DEFAULT_INDEX_URLS[0],
            "https://diguo520.github.io/EVEjs-mods/mod-index.json"
        );
        assert_eq!(
            DEFAULT_INDEX_URLS[1],
            "https://cdn.jsdelivr.net/gh/diguo520/EVEjs-mods@main/docs/mod-index.json"
        );
    }

    #[test]
    fn index_urls_fall_back_to_defaults_and_respect_settings() {
        let runtime = temp_runtime("urls");
        assert_eq!(index_urls(&runtime), DEFAULT_INDEX_URLS.to_vec());

        crate::config::write_settings(
            &runtime.settings_file(),
            json!({ "modIndexUrls": ["ftp://nope", "https://mirror.example/mod-index.json"] })
                .as_object()
                .unwrap(),
        );
        assert_eq!(
            index_urls(&runtime),
            vec!["https://mirror.example/mod-index.json".to_string()]
        );
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn download_entry_rejects_entries_without_usable_urls() {
        let runtime = temp_runtime("download");
        // 只有 http（非 https）→ 直接拒绝，不发请求
        let entry = json!({ "id": "demo", "version": "1.0.0", "downloadUrls": [{ "mirror": "x", "url": "http://example.com/a.zip" }] });
        let result = download_entry(&entry, &runtime, |_| {});
        assert_eq!(result["ok"], false);
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("没有可用的下载地址"));
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn market_list_splits_delisted_and_incompatible_entries() {
        let runtime = temp_runtime("market");
        let repo = runtime.root.join("repo");
        let _ = std::fs::create_dir_all(&repo);
        let _ = std::fs::write(
            repo.join("package.json"),
            r#"{"name":"evejs","version":"0.12.8"}"#,
        );

        let key = sign::generate_signing_key().expect("应能生成密钥");
        let key_id = sign::key_id_of(&key);
        let mut index = json!({
            "schemaVersion": 1,
            "mods": [
                { "id": "ok", "version": "1.0.0", "displayName": "可用" },
                { "id": "new", "version": "1.0.0", "evejsVersions": ["0.13.x"] },
                { "id": "hidden", "version": "1.0.0", "delisted": true, "delistReason": { "zh": "违规" }, "moderatedBy": "k", "moderatedAt": "2026-01-01" }
            ]
        });
        let signature = sign::sign_manifest(&index, &key);
        index["signature"] = json!({ "alg": "ed25519", "keyId": key_id, "sig": signature });
        write_cache(&runtime, &index);

        // force=false 且缓存新鲜 → 不联网，直接吃缓存
        let market = market_list(&repo, &runtime, false);
        assert_eq!(market["ok"], true);
        assert_eq!(market["cached"], true);
        assert_eq!(market["evejsVersion"], "0.12.8");
        let ids: Vec<String> = market["mods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["ok".to_string()]);
        assert_eq!(market["blocked"][0]["id"], "new");
        assert_eq!(market["blocked"][0]["evejsVersions"][0], "0.13.x");
        assert_eq!(market["delisted"][0]["id"], "hidden");
        assert_eq!(market["delisted"][0]["reason"]["zh"], "违规");
        assert_eq!(market["indexUrls"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&runtime.root);
    }
}
