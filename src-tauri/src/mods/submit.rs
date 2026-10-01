//! 提交模组：签名 → 打包 → sha256 → 索引分片草稿 →（可选）GitHub 开 PR。
//! 对齐现役版 `src/main/modSubmit.ts`。
//!
//! 关键约定：
//!   - 索引仓库是**分片**结构：一个模组一个 `mods/<id>.json`，作者只动自己那一个，
//!     避免多人同时改同一个 `mod-index.json` 造成 PR 互相冲突；
//!   - **每次发布都提一条 PR**：首次＝`sources.json` 收录登记 + `mods/<id>.json` 版本记录，
//!     之后每次发新版都更新同一个 `mods/<id>.json`（同一条 `release/<id>` 分支上的 PR）；
//!     索引构建器把**已合并**的版本记录当作该来源的权威版本 —— 合并后新版本才进市场；
//!   - `mod-index.json` 由 CI 合并 + 签名，作者不直接改；
//!   - ZIP 由作者自己托管（GitHub / Gitee Releases），索引里只登记 URL + sha256。
use crate::author;
use crate::github;
use crate::mods::{claim, mods_root, pkg, plan, sanitize_folder_name, scaffold, scan};
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const SUBMISSIONS_FILE: &str = "my-submissions.json";

/// 同一模组两次提交之间的最短间隔（维护者要求：防止连着重复提交）。
pub const SUBMIT_COOLDOWN_MS: u64 = 30 * 60 * 1000;

/// 两次发布之间的最短间隔：60 秒。
///
/// 与 `SUBMIT_COOLDOWN_MS`（同一模组 30 分钟）不是一个维度：那条管的是反复提交同一个模组，
/// 这条管的是**连着发布**（换个模组也一样等）—— 一次发布要打包、推仓库、建 Release、传 ZIP、
/// 开审核 PR，紧接着再发一次会撞上 GitHub 限流，两条 PR 还会抢同一次索引重建。
/// 计时起点同样是上一次**成功**提交（register_source 写的 `submittedAt`），所以失败重试不受影响。
/// 前端 `ui/src/lib/mod-logic.ts` 的 `PUBLISH_INTERVAL_MS` 与它一致（改一边记得改另一边）。
pub const PUBLISH_INTERVAL_MS: u64 = 60 * 1000;

/// 「审核中」那条 PR 的状态复查间隔（维护者要求：也按 30 分钟节流，别频繁打 GitHub）。
pub const REVIEW_RECHECK_MS: u64 = 30 * 60 * 1000;

/// 一次 list_my_mods / my_submissions 最多复查几条 PR（网络慢时别把页面拖住）。
const REVIEW_RECHECK_MAX: usize = 3;

/* ------------------------------ 台账读写 ------------------------------ */

fn submissions_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.user_data.join(SUBMISSIONS_FILE)
}

/// 索引仓库：设置里的 `modIndexRepo`（必须是 `owner/repo` 形状），否则用默认仓库
pub fn index_repo(runtime: &RuntimePaths) -> String {
    let settings = crate::config::read_settings(&runtime.settings_file());
    if let Some(value) = settings.get("modIndexRepo").and_then(Value::as_str) {
        let trimmed = value.trim();
        if is_repo_slug(trimmed) {
            return trimmed.to_string();
        }
    }
    github::DEFAULT_INDEX_REPO.to_string()
}

fn is_repo_slug(value: &str) -> bool {
    let mut parts = value.splitn(2, '/');
    let (Some(owner), Some(repo)) = (parts.next(), parts.next()) else {
        return false;
    };
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return false;
    }
    owner
        .chars()
        .chain(repo.chars())
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn read_submission_file(runtime: &RuntimePaths) -> Value {
    let fallback = json!({ "schemaVersion": 1, "items": [] });
    let Ok(raw) = std::fs::read_to_string(submissions_path(runtime)) else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return fallback;
    };
    if parsed.get("items").and_then(Value::as_array).is_none() {
        return fallback;
    }
    json!({
        "schemaVersion": 1,
        "items": parsed.get("items").cloned().unwrap_or_else(|| json!([])),
    })
}

fn write_submission_file(runtime: &RuntimePaths, file: &Value) -> Result<(), String> {
    let path = submissions_path(runtime);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|err| err.to_string())?;
    std::fs::write(path, format!("{text}\n")).map_err(|err| err.to_string())
}

pub fn submission_items(runtime: &RuntimePaths) -> Vec<Value> {
    read_submission_file(runtime)
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub fn list_submissions(runtime: &RuntimePaths) -> Value {
    json!({ "ok": true, "items": submission_items(runtime) })
}

/// 台账条目是不是**本机当前署名**投的。
///
/// 台账按机器存、不按身份存：重装系统 / 换过身份之后，里面还留着旧身份的投稿。
/// 「移除记录」只该删自己投的那些，判据与 registry::list_my_mods 的归属判定保持同一套：
/// 清单草稿里写的作者 id / keyId、条目自带的签名 keyId，以及认领过的旧模组（见 mods/claim.rs）。
pub fn submission_is_mine(
    runtime: &RuntimePaths,
    item: &Value,
    author_id: &str,
    key_id: &str,
) -> bool {
    let draft_author = item.get("indexDraft").and_then(|draft| draft.get("author"));
    let draft_id = draft_author
        .and_then(|author| author.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let draft_key = draft_author
        .and_then(|author| author.get("keyId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let direct_key = item
        .get("signatureKeyId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
    (!draft_id.is_empty() && draft_id == author_id)
        || (!draft_key.is_empty() && draft_key == key_id)
        || (!direct_key.is_empty() && direct_key == key_id)
        || claim::is_claimed(runtime, id)
}

/// 「移除记录」：把投稿台账里某个模组的**全部版本条目**从本机删掉。
///
/// 只动 `my-submissions.json` 一个文件：GitHub 仓库 / Release / 审核 PR / 市场索引一概不碰 ——
/// 那些已经是公开产物，删台账只是让本机「我创建的」不再挂着这条已经无效的记录。删掉之后
/// 作者在本地重建同名模组（id 不变）刷新一下，就能重新走「首次提交」上架；仓库与 Release
/// 都是幂等复用的，不会重复建（见 github::ensure_own_repo / ensure_release）。不可撤销。
pub fn forget_submission(runtime: &RuntimePaths, id: &str) -> Value {
    let identity = match author::read_identity() {
        Ok(identity) => identity,
        Err(_) => {
            return json!({
                "ok": false,
                "removed": 0,
                "reason": "读不到本机作者身份，没法确认这条记录是你投的",
            })
        }
    };
    forget_submission_as(runtime, id, &identity.id, &identity.key_id)
}

/// `forget_submission` 的本体：身份由调用方给（单测就不必依赖机器上真有一份身份）。
fn forget_submission_as(runtime: &RuntimePaths, id: &str, author_id: &str, key_id: &str) -> Value {
    let id = id.trim();
    if id.is_empty() {
        return json!({ "ok": false, "removed": 0, "reason": "缺少模组标识" });
    }
    let mut file = read_submission_file(runtime);
    let mut removed = 0usize;
    if let Some(items) = file.get_mut("items").and_then(Value::as_array_mut) {
        let before = items.len();
        // 删该 id 的**全部**版本条目：只删最新一条的话，列表里会剩下更早那一条
        items.retain(|item| {
            let same = item.get("id").and_then(Value::as_str) == Some(id);
            !(same && submission_is_mine(runtime, item, author_id, key_id))
        });
        removed = before - items.len();
    }
    if removed == 0 {
        // 没有可删的（本来就是空台账 / 这条是别的身份投的）：不当错误，也不白写一次盘
        return json!({ "ok": true, "removed": 0 });
    }
    match write_submission_file(runtime, &file) {
        Ok(()) => json!({ "ok": true, "removed": removed }),
        Err(err) => json!({ "ok": false, "removed": 0, "reason": err }),
    }
}

/// 这个模组还要等多久才能再次提交（毫秒）；0＝现在就能提交。
///
/// 只认**成功提交过**的时间戳（register_source 写完 PR 才写 `submittedAt`）：
/// 打包失败 / 推仓库失败 / 开 PR 失败都不算，失败重试不会被自己的冷却挡住。
pub fn submit_cooldown_remaining(runtime: &RuntimePaths, id: &str) -> u64 {
    let file = read_submission_file(runtime);
    let now = pkg::epoch_ms() as u64;
    let last = file
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .filter_map(|item| item.get("submittedAt").and_then(Value::as_u64))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    if last == 0 {
        return 0;
    }
    SUBMIT_COOLDOWN_MS.saturating_sub(now.saturating_sub(last))
}

/// 距可以再次发布还剩多少毫秒（0＝现在就能发）：取台账里**任何**模组最近一次成功提交的时间。
pub fn publish_interval_remaining(runtime: &RuntimePaths) -> u64 {
    let file = read_submission_file(runtime);
    let now = pkg::epoch_ms() as u64;
    let last = file
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("submittedAt").and_then(Value::as_u64))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    if last == 0 {
        return 0;
    }
    PUBLISH_INTERVAL_MS.saturating_sub(now.saturating_sub(last))
}

/// 「审核中」的 PR 状态复查：按模组节流（REVIEW_RECHECK_MS 一次），终态不再复查。
///
/// 只改台账文件，不改返回值 —— 调用方（my_submissions）照常读一遍就是最新状态。
pub fn refresh_review_states(runtime: &RuntimePaths) {
    let token = github::get_token(runtime);
    if token.is_empty() {
        return;
    }
    let upstream = index_repo(runtime);
    let mut file = read_submission_file(runtime);
    let now = pkg::epoch_ms() as u64;
    let mut looked_up = 0usize;
    let mut changed = false;
    if let Some(items) = file.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            if looked_up >= REVIEW_RECHECK_MAX {
                break;
            }
            let reference = text_field(item, "sourceReviewUrl");
            if reference.is_empty() {
                continue;
            }
            let state = text_field(item, "reviewPrState");
            if state == "merged" || state == "closed" {
                continue; // 终态：合并/关闭之后不会变回去
            }
            let last = item
                .get("reviewCheckedAt")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if last > 0 && now.saturating_sub(last) < REVIEW_RECHECK_MS {
                continue;
            }
            looked_up += 1;
            let pr = github::get_pull_request(&token, &upstream, &reference);
            let checked_at = pkg::epoch_ms() as u64;
            let Some(map) = item.as_object_mut() else {
                continue;
            };
            map.insert("reviewCheckedAt".into(), json!(checked_at));
            if pr.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                map.insert("reviewPrState".into(), json!(text_field(&pr, "state")));
                let number = text_field(&pr, "number");
                if !number.is_empty() {
                    map.insert("reviewPrNumber".into(), json!(number));
                }
                changed = true;
            }
        }
    }
    if changed {
        let _ = write_submission_file(runtime, &file);
    }
}

fn find_item_index(file: &Value, id: &str, version: &str) -> Option<usize> {
    file.get("items")
        .and_then(Value::as_array)?
        .iter()
        .position(|item| {
            item.get("id").and_then(Value::as_str) == Some(id)
                && item.get("version").and_then(Value::as_str) == Some(version)
        })
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 读缓存里的索引，把同一个模组的历史版本带过来（避免覆盖时丢掉 history）。
///
/// ⚠️ 这里**故意复刻现役版的空结果**：现役版 previousHistory() 读缓存文件的**顶层**
/// `mods`，而 writeCache() 写的是 `{ fetchedAt, index: { mods: [...] } }`，
/// 两者对不上，所以线上 `history` 恒为 `[]`。索引分片是要提 PR 给维护者仓库的共享产物，
/// 迁移期不改它的形状；正确写法（读 `index.mods`）作为待办记在实施记录里。
fn previous_history(runtime: &RuntimePaths, _id: &str) -> Vec<Value> {
    let _ = crate::mods::registry::cache_path(runtime);
    Vec::new()
}

/* --------------------------- README → 上架说明 --------------------------- */

/// 命中的 `## 功能要点` / `## 详细介绍` 这类小节标题
fn is_highlights_section(section: &str) -> bool {
    section.is_empty()
        || section.contains("功能要点")
        || contains_ignore_case(section, "highlights")
}

fn is_detail_section(section: &str) -> bool {
    section.contains("详细介绍")
        || section.contains("说明")
        || contains_ignore_case(section, "details")
        || contains_ignore_case(section, "description")
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// 从 `mods/<id>/README.md` 里抽出上架用的正文：
/// 创建模组时生成的 README 有「## 功能要点」与「## 详细介绍」两段 ——
/// 前者去重后进 highlights，后者按空行拆成段落进 readme；没有标题的手写 README 则整篇当正文。
/// `mods:list` 也调它：作者改完 README 要能在详情里立刻看到，不必等索引刷新。
pub(crate) fn readme_for_listing(repo_root: &Path, folder: &str) -> (Vec<String>, Vec<String>) {
    let safe = sanitize_folder_name(folder);
    let safe = if safe.is_empty() {
        folder.to_string()
    } else {
        safe
    };
    if safe.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let result = plan::read_mod_readme(repo_root, &safe);
    if !result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }
    let text = text_field(&result, "text");
    if text.trim().is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut highlights: Vec<String> = Vec::new();
    let mut detail: Vec<String> = Vec::new();
    let mut free: Vec<String> = Vec::new();
    let mut section = String::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if let Some(heading) = heading_of(line) {
            section = heading;
            continue;
        }
        if line.starts_with("# ") {
            continue;
        }
        if let Some(bullet) = bullet_of(line) {
            if is_highlights_section(&section) {
                highlights.push(bullet);
                continue;
            }
        }
        if is_detail_section(&section) {
            detail.push(line.to_string());
        } else if section.is_empty() {
            free.push(line.to_string());
        }
    }

    let source = if detail.is_empty() { free } else { detail };
    let mut paragraphs: Vec<String> = Vec::new();
    for chunk in split_paragraphs(&source.join("\n")) {
        if !chunk.is_empty() {
            paragraphs.push(chunk);
        }
        if paragraphs.len() >= 60 {
            break;
        }
    }
    // 去重后最多 12 条（对齐 `Array.from(new Set(highlights)).slice(0, 12)`）
    let mut unique: Vec<String> = Vec::new();
    for item in highlights {
        if !unique.contains(&item) {
            unique.push(item);
        }
        if unique.len() >= 12 {
            break;
        }
    }
    (paragraphs, unique)
}

/// `^##\s*(.+?)\s*$`
fn heading_of(line: &str) -> Option<String> {
    let rest = line.strip_prefix("##")?;
    let title = rest.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// `^[-*]\s+(.+)$`
fn bullet_of(line: &str) -> Option<String> {
    let rest = line.strip_prefix('-').or_else(|| line.strip_prefix('*'))?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 按空行拆段并 trim（对齐 `split(/\n{2,}/).map(trim)`）
fn split_paragraphs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n").trim().to_string());
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        out.push(current.join("\n").trim().to_string());
    }
    out
}
/* --------------------------- ① 生成并打包 --------------------------- */

fn https_only(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("https://")
}

/// 组装 `evejs-mod.json` / 索引分片里的 downloadUrls：
/// 只认 https，priority 缺省按顺序补齐（对齐 `prepareSubmission` 的 map 口径）
fn normalize_download_urls(input: &Value, key: &str) -> Vec<Value> {
    let Some(items) = input.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let url = text_field(item, "url");
        if !https_only(&url) {
            continue;
        }
        let mirror = {
            let value = text_field(item, "mirror");
            if value.is_empty() {
                "custom".to_string()
            } else {
                value
            }
        };
        let priority = item
            .get("priority")
            .and_then(Value::as_i64)
            .filter(|value| *value != 0)
            .unwrap_or(index as i64 + 1);
        out.push(json!({ "mirror": mirror, "url": url, "priority": priority }));
    }
    out
}

/// 解析本次要发布的版本号，必要时**先把它写回模组清单**。
///
/// 详情页的「发布新版本」会在弹窗里预填递增后的版本号，而清单里还停在上一版，这一步负责把
/// 两者对齐。必须赶在重签与打包之前落盘：ZIP 里的 `evejs-launcher.mod.json`、索引分片、台账
/// 与 Release tag 只能共用一个版本号。只改一边的话，装回去的包版本比市场旧，别人的启动器会
/// 永远提示更新；而完全不管它，后面按新版本号回查台账就会失败，报成一句看不懂的
/// 「找不到待提交记录」（2026-09-30 报障：弹窗里填 1.0.8、清单里还是 1.0.7）。
fn resolve_submit_version(
    manifest: &Map<String, Value>,
    manifest_path: &Path,
    record_version: &str,
    requested: &str,
) -> Result<String, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Ok(if record_version.is_empty() {
            "0.0.0".to_string()
        } else {
            record_version.to_string()
        });
    }
    if !scaffold::is_semver_like(requested) {
        // 复用「创建模组」那条已翻好的固定文案：界面按整段文本节点查多语言目录，
        // 带上用户输入的值（如「版本号格式不对：v1」）就永远查不中，只能一直显示中文
        return Err("版本号格式必须像 1.0.0".to_string());
    }
    if requested != record_version {
        let mut next = manifest.clone();
        next.insert("version".to_string(), json!(requested));
        // 清单内容变了 → 旧签名失效，先摘掉（紧接着的重签会补回来）
        next.remove("signature");
        let text = serde_json::to_string_pretty(&Value::Object(next)).unwrap_or_default() + "\n";
        std::fs::write(manifest_path, text)
            .map_err(|error| format!("版本号写入清单失败：{error}"))?;
    }
    Ok(requested.to_string())
}

/// 生成待提交包：版本号对齐 → 重签 → 打包 → sha256 → 组装索引分片 → 写入 `my-submissions.json`。
/// 除最后一步外完全离线，不碰网络。
pub fn prepare_submission(repo_root: &Path, runtime: &RuntimePaths, input: &Value) -> Value {
    let folder = text_field(input, "folder").trim().to_string();
    if folder.is_empty() {
        return json!({ "ok": false, "reason": "没有选择模组" });
    }

    let Some(dir) = crate::mods::join_within(&mods_root(repo_root), &folder) else {
        return json!({ "ok": false, "reason": "目录名非法" });
    };
    let record = scan::read_mod_dir(&folder, &dir);
    if !record.valid {
        return json!({ "ok": false, "reason": format!("清单校验失败：{}", record.error) });
    }

    let identity = match author::read_identity() {
        Ok(identity) => identity,
        Err(reason) => {
            return json!({ "ok": false, "reason": format!("读不到本机作者身份：{reason}") })
        }
    };
    let author_id = identity.id.clone();

    // 清单里声明了别的作者时不能替他提交
    let manifest = scan::read_manifest(&record.manifest_path).unwrap_or_default();
    let declared_author_id = manifest
        .get("author")
        .and_then(Value::as_object)
        .and_then(|author| author.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // 认领过的模组放行（见 mods/claim.rs），与 sign_mod_folder 用同一套判据：
    // 两个入口必须一致，否则会出现「签得动但提交不了」这种半通不通的状态。
    let claimed = claim::is_claimed(runtime, &record.id);
    if !declared_author_id.is_empty() && declared_author_id != author_id && !claimed {
        return json!({
            "ok": false,
            "reason": format!(
                "这个模组的作者标识是 {declared_author_id}，不是本机作者，不能替别人提交。\
                 如果这个模组本来就是你做的（重装过系统 / 换过电脑），先在「找回旧模组」里认领它；\
                 当年导出过 .eve-key 的话，直接在「令牌配置」里导入就能用回原身份。"
            ),
        });
    }

    // 防重复提交：同一模组 30 分钟内只能提交一次（上次**成功**提交起算）
    let remaining = submit_cooldown_remaining(runtime, &record.id);
    if remaining > 0 {
        let minutes = remaining.div_ceil(60_000);
        return json!({
            "ok": false,
            "cooldown": true,
            "retryAfterMs": remaining,
            "reason": format!(
                "「{folder}」刚提交过：同一个模组两次提交至少间隔 30 分钟（还剩约 {minutes} 分钟再试）"
            ),
        });
    }

    // 连发拦截：两次发布之间至少间隔 60 秒（换个模组也一样等），见 PUBLISH_INTERVAL_MS
    let interval = publish_interval_remaining(runtime);
    if interval > 0 {
        let seconds = interval.div_ceil(1000);
        return json!({
            "ok": false,
            "cooldown": true,
            "retryAfterMs": interval,
            "reason": format!("刚刚发布过一次：两次发布之间至少间隔 60 秒（还剩约 {seconds} 秒再试）"),
        });
    }

    // 1) 版本号：以弹窗里填的为准（详情页「发布新版本」会预填递增后的号），必要时写回清单。
    let version = match resolve_submit_version(
        &manifest,
        &record.manifest_path,
        &record.version,
        &text_field(input, "version"),
    ) {
        Ok(version) => version,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    // 2) 重签（内容变了签名就失效；这里统一重签一次）
    let signed = plan::sign_mod_folder(repo_root, &folder, runtime);
    if !signed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({ "ok": false, "reason": format!("签名失败：{}", text_field(&signed, "reason")) });
    }

    // 3) 打包（.NET ZipFile，避免 Compress-Archive 的分隔符坑）
    let zip_path = runtime
        .temp
        .join(format!("export-{}-{version}.zip", record.id));
    let packed = pkg::pack_mod_zip(&record.dir, &zip_path);
    let sha256 = text_field(&packed, "sha256");
    let size_bytes = packed.get("sizeBytes").and_then(Value::as_u64);
    if !packed.get("ok").and_then(Value::as_bool).unwrap_or(false)
        || sha256.is_empty()
        || size_bytes.is_none()
    {
        return json!({
            "ok": false,
            "reason": if text_field(&packed, "reason").is_empty() { "打包失败".to_string() } else { text_field(&packed, "reason") },
        });
    }
    let size_bytes = size_bytes.unwrap_or(0);
    let packed_zip = {
        let value = text_field(&packed, "zipPath");
        if value.is_empty() {
            zip_path.to_string_lossy().to_string()
        } else {
            value
        }
    };

    // 4) 组装索引分片
    let compat_versions: Vec<String> = manifest
        .get("compatibility")
        .and_then(Value::as_object)
        .and_then(|compat| compat.get("evejsVersions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let input_versions: Vec<String> = input
        .get("evejsVersions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let evejs_versions = if input_versions.is_empty() {
        compat_versions
    } else {
        input_versions
    };

    let download_urls = normalize_download_urls(input, "downloadUrls");
    let now = crate::mods::pkg::epoch_ms() as u64;
    let mut history = previous_history(runtime, &record.id);
    if !history.is_empty() {
        history.push(json!({
            "version": version,
            "changelog": text_field(input, "changelog"),
            "at": now,
        }));
    }

    let (listed_readme, listed_highlights) = readme_for_listing(repo_root, &folder);
    let changelog = text_field(input, "changelog");
    let description = {
        let value = text_field(input, "description");
        if value.is_empty() {
            record.description.clone()
        } else {
            value
        }
    };
    let category = {
        let value = text_field(input, "category");
        if value.is_empty() {
            "玩法".to_string()
        } else {
            value
        }
    };
    let input_readme = input.get("readme").cloned().unwrap_or_else(|| json!([]));
    let input_highlights = input
        .get("highlights")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let conflicts = input
        .get("conflicts")
        .cloned()
        .unwrap_or_else(|| json!(record.conflicts.clone()));

    let mut index_draft = Map::new();
    index_draft.insert("id".into(), json!(record.id));
    index_draft.insert("displayName".into(), json!(record.display_name));
    index_draft.insert("version".into(), json!(version));
    index_draft.insert(
        "author".into(),
        json!({ "id": author_id, "name": identity.name, "keyId": identity.key_id }),
    );
    index_draft.insert("description".into(), json!(description));
    index_draft.insert("category".into(), json!(category));
    index_draft.insert(
        "tags".into(),
        input.get("tags").cloned().unwrap_or_else(|| json!([])),
    );
    index_draft.insert(
        "readme".into(),
        if listed_readme.is_empty() {
            input_readme
        } else {
            json!(listed_readme)
        },
    );
    index_draft.insert(
        "highlights".into(),
        if listed_highlights.is_empty() {
            input_highlights
        } else {
            json!(listed_highlights)
        },
    );
    index_draft.insert("conflicts".into(), conflicts);
    index_draft.insert(
        "requiresRestart".into(),
        json!(input
            .get("requiresRestart")
            .and_then(Value::as_bool)
            .unwrap_or(true)),
    );
    index_draft.insert("evejsVersions".into(), json!(evejs_versions));
    index_draft.insert("sizeBytes".into(), json!(size_bytes));
    index_draft.insert("sha256".into(), json!(sha256));
    index_draft.insert("downloadUrls".into(), json!(download_urls));
    index_draft.insert("changelog".into(), json!(changelog));
    index_draft.insert("history".into(), json!(history));
    index_draft.insert("repo".into(), json!(text_field(input, "repo")));
    index_draft.insert("featured".into(), json!(false));
    index_draft.insert("delisted".into(), json!(false));
    index_draft.insert(
        "publishedAt".into(),
        json!(crate::mods::pkg::iso_from_ms(now)
            .chars()
            .take(10)
            .collect::<String>()),
    );

    let item = json!({
        "id": record.id,
        "version": version,
        "displayName": record.display_name,
        "changelog": changelog,
        "zipPath": packed_zip,
        "sha256": sha256,
        "sizeBytes": size_bytes,
        "downloadUrls": download_urls,
        "indexDraft": Value::Object(index_draft),
        "status": "draft",
        "prUrl": "",
        "branch": format!("submit/{}-{version}", record.id),
        "sourceRepo": "",
        "sourceReviewUrl": "",
        "createdAt": now,
    });

    let mut file = read_submission_file(runtime);
    if let Some(index) = find_item_index(&file, &record.id, &version) {
        // 保留上一次的进度字段（status / prUrl / branch / sourceRepo / sourceReviewUrl）
        let previous = file["items"][index].clone();
        let mut item = item;
        for key in ["prUrl", "status", "sourceRepo", "sourceReviewUrl"] {
            if let Some(value) = previous.get(key) {
                item[key] = value.clone();
            }
        }
        if let Some(branch) = previous.get("branch").and_then(Value::as_str) {
            if !branch.is_empty() {
                item["branch"] = json!(branch);
            }
        }
        file["items"][index] = item.clone();
        if let Err(reason) = write_submission_file(runtime, &file) {
            return json!({ "ok": false, "reason": format!("写入提交台账失败：{reason}") });
        }
        return json!({ "ok": true, "item": item });
    }
    if let Some(items) = file.get_mut("items").and_then(Value::as_array_mut) {
        items.push(item.clone());
    }
    if let Err(reason) = write_submission_file(runtime, &file) {
        return json!({ "ok": false, "reason": format!("写入提交台账失败：{reason}") });
    }
    json!({ "ok": true, "item": item })
}

/// 由索引分片 + 资产地址组装 `evejs-mod.json`（索引仓库 CI 抓取的就是它）
fn build_listing_json(draft: &Value, download_urls: &[Value]) -> String {
    let mut merged = draft.clone();
    if let Some(map) = merged.as_object_mut() {
        map.insert("downloadUrls".into(), json!(download_urls));
    }
    serde_json::to_string_pretty(&merged).unwrap_or_else(|_| "{}".to_string()) + "\n"
}
/* ------------------------ ② 发布到作者自己的仓库 ------------------------ */

/// 从「发布结果 + 索引分片」算出最终的 downloadUrls：
/// GitHub 资产地址打头（priority 1），Gitee 镜像次之，作者自带的其它镜像补在后面。
fn assemble_download_urls(asset_url: &str, gitee_url: &str, existing: &[Value]) -> Vec<Value> {
    let mut out = vec![json!({ "mirror": "github", "url": asset_url, "priority": 1 })];
    if https_only(gitee_url) {
        out.push(json!({ "mirror": "gitee", "url": gitee_url, "priority": 2 }));
    }
    for extra in existing {
        let url = text_field(extra, "url");
        if url.is_empty() || !https_only(&url) {
            continue;
        }
        if out
            .iter()
            .any(|item| item.get("url").and_then(Value::as_str) == Some(url.as_str()))
        {
            continue;
        }
        let mut entry = extra.clone();
        entry["priority"] = json!(out.len() as i64 + 1);
        out.push(entry);
    }
    out
}

/// 发布到**作者自己的仓库**：确保仓库 → 写 `evejs-mod.json` → 建 Release → 传 ZIP。
/// 只动作者自己的仓库，不碰索引仓库；版本更新完全不需要 PR。
#[allow(clippy::too_many_arguments)]
pub fn publish_own_repo(
    runtime: &RuntimePaths,
    id: &str,
    version: &str,
    repo_input: &str,
    gitee_url: &str,
    mut say: impl FnMut(&str, u32),
) -> Value {
    let file = read_submission_file(runtime);
    let Some(index) = find_item_index(&file, id, version) else {
        return json!({ "ok": false, "reason": "找不到待提交记录（请先执行「① 生成并打包」）" });
    };
    let item = file["items"][index].clone();

    let token = github::get_token(runtime);
    if token.is_empty() {
        return json!({ "ok": false, "reason": "还没填 GitHub 令牌" });
    }

    let me = github::validate_token(&token);
    let login = text_field(&me, "login");
    if login.is_empty() {
        return json!({
            "ok": false,
            "reason": if text_field(&me, "reason").is_empty() { "令牌无效".to_string() } else { text_field(&me, "reason") },
        });
    }

    // 解析 owner/repo，并提前算出确定性的资产地址（tag 与资产名都是确定的）
    let raw = repo_input
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_end_matches(".git")
        .to_string();
    let parts: Vec<&str> = raw.split('/').filter(|part| !part.is_empty()).collect();
    let owner = if parts.len() >= 2 {
        parts[0].to_string()
    } else {
        login.clone()
    };
    let repo_name = if parts.len() >= 2 {
        parts[1].to_string()
    } else if let Some(first) = parts.first() {
        first.to_string()
    } else {
        github::default_repo_name_for(id)
    };
    if repo_name.is_empty()
        || !repo_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
    {
        return json!({ "ok": false, "reason": "请填写你自己的仓库名（形如 my-evejs-mod，或 owner/my-evejs-mod）" });
    }

    let asset_name = github::asset_name_for(id, version);
    let repo_url = github::repo_url_for(&owner, &repo_name);
    let asset_url = format!("{repo_url}/releases/download/v{version}/{asset_name}");
    let existing_urls = item
        .get("downloadUrls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let download_urls = assemble_download_urls(&asset_url, gitee_url, &existing_urls);

    let draft = item.get("indexDraft").cloned().unwrap_or_else(|| json!({}));
    let mut draft_with_repo = draft.clone();
    if let Some(map) = draft_with_repo.as_object_mut() {
        map.insert("repo".into(), json!(repo_url));
    }
    let listing = build_listing_json(&draft_with_repo, &download_urls);

    let zip_path = PathBuf::from(text_field(&item, "zipPath"));
    let published = github::publish_to_own_repo(
        &token,
        repo_input,
        &zip_path,
        &asset_name,
        version,
        &text_field(&item, "changelog"),
        &text_field(&item, "displayName"),
        &listing,
        &github::default_repo_name_for(id),
        &mut say,
    );

    if !published
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "owner": published.get("owner").cloned().unwrap_or(json!(owner)),
            "repo": published.get("repo").cloned().unwrap_or(json!(repo_name)),
            "repoUrl": published.get("repoUrl").cloned().unwrap_or(json!(repo_url)),
            "releaseUrl": published.get("releaseUrl").cloned().unwrap_or(Value::Null),
            "reason": text_field(&published, "reason"),
        });
    }

    let published_owner = {
        let value = text_field(&published, "owner");
        if value.is_empty() {
            owner.clone()
        } else {
            value
        }
    };
    let published_repo = {
        let value = text_field(&published, "repo");
        if value.is_empty() {
            repo_name.clone()
        } else {
            value
        }
    };

    // 回填台账：来源仓库 + 最终下载地址 + 分片里的 repo
    let mut file = file;
    if let Some(index) = find_item_index(&file, id, version) {
        file["items"][index]["sourceRepo"] = json!(format!("{published_owner}/{published_repo}"));
        file["items"][index]["downloadUrls"] = json!(download_urls);
        let mut updated_draft = draft;
        if let Some(map) = updated_draft.as_object_mut() {
            map.insert("downloadUrls".into(), json!(download_urls));
            map.insert("repo".into(), json!(repo_url));
        }
        file["items"][index]["indexDraft"] = updated_draft;
        let _ = write_submission_file(runtime, &file);
    }

    json!({
        "ok": true,
        "owner": published_owner,
        "repo": published_repo,
        "repoUrl": if text_field(&published, "repoUrl").is_empty() { repo_url.clone() } else { text_field(&published, "repoUrl") },
        "releaseUrl": published.get("releaseUrl").cloned().unwrap_or(Value::Null),
        "assetUrl": if text_field(&published, "assetUrl").is_empty() { asset_url.clone() } else { text_field(&published, "assetUrl") },
        "repoCreated": published.get("repoCreated").cloned().unwrap_or(json!(false)),
    })
}

/* --------------------------- ③ 收录 / 版本审核 PR --------------------------- */

/// 版本记录在索引仓库里的路径：一个模组一个分片（沿用现役版的 `mods/<id>.json` 约定）。
pub fn version_record_path(id: &str) -> String {
    format!("mods/{id}.json")
}

/// 本次要提交的版本记录。
///
/// 只放「发布产物」相关的字段：其余元数据（简介 / readme / 标签 / 分类…）由索引 CI
/// 从作者仓库的 `evejs-mod.json` 现抓，不在这里重复一份（重复了就会有两份真相）。
fn version_record_json(id: &str, source_repo: &str, item: &Value) -> Value {
    let draft = item.get("indexDraft").cloned().unwrap_or(Value::Null);
    let pick = |key: &str| -> String {
        let from_draft = text_field(&draft, key);
        if from_draft.is_empty() {
            text_field(item, key)
        } else {
            from_draft
        }
    };
    json!({
        "schemaVersion": 1,
        "id": id,
        "source": source_repo,
        "displayName": pick("displayName"),
        "version": pick("version"),
        "sha256": pick("sha256"),
        "sizeBytes": draft
            .get("sizeBytes")
            .cloned()
            .unwrap_or_else(|| item.get("sizeBytes").cloned().unwrap_or(json!(0))),
        "downloadUrls": draft
            .get("downloadUrls")
            .cloned()
            .unwrap_or_else(|| item.get("downloadUrls").cloned().unwrap_or(json!([]))),
        "author": draft.get("author").cloned().unwrap_or_else(|| json!({})),
        "publishedAt": pick("publishedAt"),
        "submittedAt": pkg::iso_from_ms(pkg::epoch_ms() as u64),
    })
}

/// ③ 提交收录 / 版本审核 PR —— **每次发布都提**（2026-09-28 维护者要求：版本更新也要走 PR）。
///
/// 提交内容：
///   - 首次发布：`sources.json`（登记收录源）+ `mods/<id>.json`（本次版本记录）；
///   - 版本更新：只更新 `mods/<id>.json`。
///
/// 两者都走同一个分支 `release/<id>`，所以同一模组的后续版本会**刷新同一条 PR**，
/// 不会一版一条堆在索引仓库里（分支每次提交前会被重置回 fork 的 base，diff 只含自己的文件）。
///
/// 索引仓库的 `build-index.mjs` 把**已合并**的版本记录当作该来源的权威版本 ——
/// 也就是说合并之后新版本才进市场，这一步才真的叫「审核」。
pub fn register_source(runtime: &RuntimePaths, id: &str, version: &str) -> Value {
    let file = read_submission_file(runtime);
    let Some(item_index) = find_item_index(&file, id, version) else {
        return json!({ "ok": false, "reason": "找不到待提交记录" });
    };
    let item = file["items"][item_index].clone();
    let source_repo = text_field(&item, "sourceRepo");
    if source_repo.is_empty() {
        return json!({ "ok": false, "reason": "请先执行「② 发布到我的仓库」，拿到仓库地址后再提交审核" });
    }

    let token = github::get_token(runtime);
    if token.is_empty() {
        return json!({ "ok": false, "reason": "还没填 GitHub 令牌" });
    }
    let upstream = index_repo(runtime);

    // 必须先读到**当前**的 sources.json。读不到就中止 —— 绝不能拿空列表去覆盖，
    // 否则会一次把别人已收录的来源全删掉（现役版 0.1.19 实测：网络受限时 PR #1 就是这样）。
    let current = github::read_repo_file(&token, &upstream, "sources.json", "main");
    if !current.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "reason": format!(
                "读不到索引仓库当前的 sources.json，为避免覆盖别人的收录已中止：{}（令牌需要对 {upstream} 有 Contents = Read and write，或稍后重试）",
                text_field(&current, "reason")
            ),
        });
    }
    let current_text = text_field(&current, "text");
    if current_text.is_empty() {
        return json!({
            "ok": false,
            "reason": format!(
                "读不到索引仓库当前的 sources.json，为避免覆盖别人的收录已中止：（令牌需要对 {upstream} 有 Contents = Read and write，或稍后重试）"
            ),
        });
    }

    let sources: Vec<String> = match serde_json::from_str::<Value>(&current_text) {
        Ok(value) => match value.get("sources").and_then(Value::as_array) {
            Some(items) => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            None => {
                return json!({ "ok": false, "reason": "索引仓库的 sources.json 解析失败，已中止：sources 字段不是字符串数组" })
            }
        },
        Err(err) => {
            return json!({ "ok": false, "reason": format!("索引仓库的 sources.json 解析失败，已中止：{err}") })
        }
    };

    let first_time = !sources
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(&source_repo));

    let sources_text = if first_time {
        let mut next: Vec<String> = sources.clone();
        next.push(source_repo.clone());
        let payload = json!({ "schemaVersion": 1, "sources": next });
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()) + "\n"
    } else {
        String::new()
    };

    let record = version_record_json(id, &source_repo, &item);
    let record_path = version_record_path(id);
    let record_text =
        serde_json::to_string_pretty(&record).unwrap_or_else(|_| "{}".to_string()) + "\n";

    let mut files: Vec<github::SubmitFile<'_>> = Vec::new();
    if first_time {
        files.push(github::SubmitFile {
            path: "sources.json",
            content: sources_text.as_str(),
        });
    }
    files.push(github::SubmitFile {
        path: record_path.as_str(),
        content: record_text.as_str(),
    });

    let display_name = {
        let value = text_field(&record, "displayName");
        if value.is_empty() {
            id.to_string()
        } else {
            value
        }
    };
    let zip_name = Path::new(&text_field(&item, "zipPath"))
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let short_sha: String = text_field(&record, "sha256").chars().take(12).collect();
    let size_bytes = record.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0);
    let pr_body = [
        "### 模组版本审核 / mod release review".to_string(),
        String::new(),
        format!("- 模组 / mod：`{id}`（{display_name}）"),
        format!("- 版本 / version：`{}`", text_field(&record, "version")),
        format!("- 来源仓库 / source：`{source_repo}`"),
        format!(
            "- 分片 / shard：`{record_path}`{}",
            if first_time {
                "（本 PR 另含 `sources.json` 收录登记 / also registers the source）"
            } else {
                ""
            }
        ),
        format!("- 包 / package：`{zip_name}` · {size_bytes} B · sha256 `{short_sha}…`"),
        format!(
            "- 署名 / keyId：`{}`",
            text_field(&record["author"], "keyId")
        ),
        String::new(),
        "合并后索引 CI 会立刻重建 `mod-index.json`，市场里的版本更新到本条记录。".to_string(),
        "版本记录就是 `mods/<id>.json`，之后每一版都会更新同一个文件（同一条 PR 持续刷新）。".to_string(),
        String::new(),
        "After merge the index CI rebuilds `mod-index.json` and the marketplace moves to the version in this record.".to_string(),
    ]
    .join("\n");

    let branch = if first_time {
        // 首次复用「收录登记」那条分支名：老启动器已经开过的申请收录 PR 会被直接刷新成
        // 版本审核 PR（内容里多出 mods/<id>.json），不会再多一条重复的登记 PR。
        format!("register/{}", source_repo.replace('/', "-").to_lowercase())
    } else {
        format!("release/{id}")
    };
    let commit_message = if first_time {
        format!("Add mod source {source_repo} + release {id} v{version}")
    } else {
        format!("release: {id} v{version}")
    };
    let pr_title = if first_time {
        format!("Add mod source {source_repo}（{id} v{version}）")
    } else {
        format!("release: {id} v{version}")
    };
    let result = github::submit_files_via_pull_request(&github::SubmitFilesInput {
        token: &token,
        upstream: &upstream,
        files: &files,
        branch: &branch,
        base_branch: "main",
        commit_message: &commit_message,
        pr_title: &pr_title,
        pr_body: &pr_body,
    });

    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let result_branch = {
        let value = text_field(&result, "branch");
        if value.is_empty() {
            branch.clone()
        } else {
            value
        }
    };
    let pr_url = text_field(&result, "prUrl");
    if ok {
        let mut file = file;
        if let Some(index) = find_item_index(&file, id, version) {
            file["items"][index]["sourceReviewUrl"] = json!(pr_url.clone());
            // 「提交审核」这一步真的开出 PR 了：状态得跟上，否则 myMods 只会说
            // 「草稿」，「我创建的」页签既不显示审核中、也没有入口打开那条 PR。
            file["items"][index]["prUrl"] = json!(pr_url.clone());
            file["items"][index]["status"] = json!("submitted");
            // 成功开 PR 的时刻（epoch ms）：既是 30 分钟提交冷却的计时起点，也是
            // 「这条投稿比索引里那条已驳回 / 已下架结论更新」的凭据（见 registry.rs 的
            // ledger_supersedes_moderation）—— 少了它，重新发布永远翻不回「审核中」。
            file["items"][index]["submittedAt"] = json!(pkg::epoch_ms() as u64);
            // 新 PR 就是新的一轮审核：上一版复查出来的结论（往往是 merged）必须作废，
            // 否则「审核中」的条目会挂着「已合并 #13」这种上一版的状态。
            file["items"][index]["reviewPrState"] = json!("");
            file["items"][index]["reviewPrNumber"] = json!("");
            file["items"][index]["reviewCheckedAt"] = json!(0);
            let _ = write_submission_file(runtime, &file);
        }
    }
    json!({
        "ok": ok,
        "prUrl": pr_url,
        "branch": result_branch.clone(),
        "compareUrl": github::pull_request_compare_url(&upstream, &result_branch, &text_field(&result, "login")),
        "reason": text_field(&result, "reason"),
        "firstTime": first_time,
        "files": if first_time {
            json!(["sources.json", record_path])
        } else {
            json!([record_path])
        },
    })
}

/// 用 GitHub API 提 PR；失败时返回 `compareUrl` 供降级方案使用
pub fn submit_to_github(runtime: &RuntimePaths, id: &str, version: &str) -> Value {
    let file = read_submission_file(runtime);
    let Some(_) = find_item_index(&file, id, version) else {
        return json!({ "ok": false, "reason": "找不到待提交记录（请先执行「生成并打包」）" });
    };
    let index = find_item_index(&file, id, version).unwrap_or(0);
    let item = file["items"][index].clone();

    let token = github::get_token(runtime);
    if token.is_empty() {
        return json!({ "ok": false, "reason": "还没填 GitHub 令牌" });
    }
    let upstream = index_repo(runtime);
    let display_name = text_field(&item, "displayName");
    let changelog = text_field(&item, "changelog");
    let zip_name = Path::new(&text_field(&item, "zipPath"))
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let content = {
        let draft = item.get("indexDraft").cloned().unwrap_or_else(|| json!({}));
        serde_json::to_string_pretty(&draft).unwrap_or_else(|_| "{}".to_string()) + "\n"
    };
    let pr_body = [
        format!("### {display_name} `{version}`"),
        String::new(),
        if changelog.is_empty() {
            String::new()
        } else {
            format!("**更新说明**\n\n{changelog}")
        },
        String::new(),
        "| 字段 | 值 |".to_string(),
        "|---|---|".to_string(),
        format!("| id | `{id}` |"),
        format!("| version | `{version}` |"),
        format!("| sha256 | `{}` |", text_field(&item, "sha256")),
        format!(
            "| size | {} bytes |",
            item.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0)
        ),
        format!("| zip | `{zip_name}` |"),
        String::new(),
        "> 由 EvEJS 启动器提交；ZIP 由作者自行托管，索引里登记 URL 与 sha256。".to_string(),
    ]
    .join("\n");

    let result = github::submit_file_via_pull_request(&github::SubmitFileInput {
        token: &token,
        upstream: &upstream,
        file_path: &format!("mods/{id}.json"),
        content: &content,
        branch: &text_field(&item, "branch"),
        base_branch: "main",
        commit_message: &format!("Add {display_name} {version}"),
        pr_title: &format!("Add {display_name} {version}"),
        pr_body: &pr_body,
    });

    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let result_branch = {
        let value = text_field(&result, "branch");
        if value.is_empty() {
            text_field(&item, "branch")
        } else {
            value
        }
    };
    let mut file = file;
    if let Some(index) = find_item_index(&file, id, version) {
        if ok {
            file["items"][index]["status"] = json!("submitted");
            file["items"][index]["prUrl"] = json!(text_field(&result, "prUrl"));
            // 同上：记下开 PR 的时刻，重投才能盖掉索引侧的驳回结论、冷却才有起点
            file["items"][index]["submittedAt"] = json!(pkg::epoch_ms() as u64);
            file["items"][index]["reviewPrState"] = json!("");
            file["items"][index]["reviewPrNumber"] = json!("");
            file["items"][index]["reviewCheckedAt"] = json!(0);
        }
        file["items"][index]["branch"] = json!(result_branch);
        let _ = write_submission_file(runtime, &file);
    }
    json!({
        "ok": ok,
        "prUrl": result.get("prUrl").cloned().unwrap_or(json!("")),
        "branch": result_branch.clone(),
        "forkRepo": result.get("forkRepo").cloned().unwrap_or(json!("")),
        "login": result.get("login").cloned().unwrap_or(json!("")),
        "compareUrl": github::pull_request_compare_url(&upstream, &result_branch, &text_field(&result, "login")),
        "status": if ok { "submitted" } else { "draft" },
        "reason": text_field(&result, "reason"),
    })
}

/// 在资源管理器里选中待提交的 ZIP（不存在就给明确提示，而不是静默失败）
pub fn reveal_submission_zip(zip_path: &str) -> Value {
    let file = Path::new(zip_path);
    if zip_path.is_empty() || !file.is_file() {
        return json!({ "ok": false, "reason": "ZIP 不存在（可能已被清理，请重新生成）" });
    }
    match shell::reveal_in_explorer(file) {
        Ok(()) => json!({ "ok": true, "path": zip_path }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// 令牌状态 / 保存 / 清除 / 校验：现役版把它们放在 `modSubmit.ts` 里转发给 `githubToken.ts`
pub fn token_state(runtime: &RuntimePaths) -> Value {
    github::token_status(runtime)
}

pub fn set_token(runtime: &RuntimePaths, token: &str) -> Value {
    github::save_token(runtime, token)
}

pub fn remove_token(runtime: &RuntimePaths) -> Value {
    github::clear_token(runtime)
}

pub fn check_token(runtime: &RuntimePaths, token: Option<&str>) -> Value {
    github::check_token(runtime, token)
}

/// 组合 `mods:mySubmissions`：台账 + 索引仓库地址（渲染层要显示「往哪个仓库提 PR」）
pub fn my_submissions(runtime: &RuntimePaths) -> Value {
    // 顺手复查「审核中」那条 PR 开出来了没有 / 是不是已经合并 —— 按模组 30 分钟节流
    refresh_review_states(runtime);
    let mut payload = list_submissions(runtime);
    if let Some(map) = payload.as_object_mut() {
        map.insert("indexRepo".into(), json!(index_repo(runtime)));
    }
    payload
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_runtime(tag: &str) -> RuntimePaths {
        let root = std::env::temp_dir().join(format!(
            "evejs-submit-{tag}-{}-{}",
            std::process::id(),
            crate::mods::pkg::epoch_ms()
        ));
        let paths = RuntimePaths::from_root(root, true);
        for dir in [&paths.root, &paths.user_data, &paths.cache, &paths.temp] {
            let _ = std::fs::create_dir_all(dir);
        }
        paths
    }

    #[test]
    fn version_record_path_is_one_shard_per_mod() {
        assert_eq!(
            version_record_path("evejs-automining"),
            "mods/evejs-automining.json"
        );
    }

    #[test]
    fn version_record_prefers_the_draft_and_falls_back_to_the_item() {
        let item = json!({
            "id": "evejs-x",
            "version": "1.0.1",
            "sha256": "从条目里读",
            "sizeBytes": 1,
            "displayName": "X",
            "indexDraft": {
                "version": "1.0.1",
                "sha256": "bb",
                "sizeBytes": 4096,
                "publishedAt": "2026-09-28",
                "displayName": "X-draft",
                "author": { "id": "au-1", "keyId": "1382094598d9", "name": "作者" },
                "downloadUrls": [
                    { "mirror": "github", "url": "https://github.com/a/b/releases/download/v1.0.1/x.zip", "priority": 1 }
                ],
            }
        });
        let record = version_record_json("evejs-x", "diguo520/evejs-mod-x", &item);
        assert_eq!(record["id"], "evejs-x");
        assert_eq!(record["source"], "diguo520/evejs-mod-x");
        assert_eq!(record["version"], "1.0.1");
        // 分片草稿里的是权威值，不能被条目上的旧值盖掉
        assert_eq!(record["sha256"], "bb");
        assert_eq!(record["sizeBytes"], 4096);
        assert_eq!(record["displayName"], "X-draft");
        assert_eq!(record["author"]["keyId"], "1382094598d9");
        assert_eq!(record["downloadUrls"][0]["priority"], 1);
        assert!(record["submittedAt"].as_str().unwrap_or("").len() >= 10);

        // 老台账（没有 indexDraft）也得能出记录：退回条目自身字段
        let bare =
            json!({ "version": "0.9.0", "sha256": "cc", "sizeBytes": 7, "displayName": "裸" });
        let fallback = version_record_json("evejs-y", "a/b", &bare);
        assert_eq!(fallback["version"], "0.9.0");
        assert_eq!(fallback["sha256"], "cc");
        assert_eq!(fallback["sizeBytes"], 7);
        assert_eq!(fallback["displayName"], "裸");
    }

    #[test]
    fn pull_number_is_taken_from_a_pr_url_but_not_from_junk() {
        assert_eq!(
            github::pull_number_from("https://github.com/diguo520/EVEjs-mods/pull/8"),
            "8"
        );
        assert_eq!(github::pull_number_from("8/"), "8");
        assert_eq!(github::pull_number_from("https://github.com/a/b/pulls"), "");
        assert_eq!(github::pull_number_from(""), "");
    }

    #[test]
    fn submit_cooldown_counts_from_the_last_successful_submit_only() {
        let runtime = temp_runtime("cooldown");
        let now = pkg::epoch_ms() as u64;

        // 压根没提交过 → 不挡
        assert_eq!(submit_cooldown_remaining(&runtime, "evejs-x"), 0);

        // 只有 createdAt（打包/推仓库成功、PR 没开出来）→ 不算数，失败重试不该被挡
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "createdAt": now - 1000 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        assert_eq!(submit_cooldown_remaining(&runtime, "evejs-x"), 0);

        // 成功提交过（submittedAt）→ 30 分钟内挡着，且只剩不到 30 分钟
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "createdAt": now - 1000, "submittedAt": now - 60_000 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        let left = submit_cooldown_remaining(&runtime, "evejs-x");
        assert!(
            left > 0 && left <= SUBMIT_COOLDOWN_MS - 60_000,
            "left={left}"
        );

        // 另一个模组互不影响
        assert_eq!(submit_cooldown_remaining(&runtime, "evejs-y"), 0);

        // 超过 30 分钟 → 放行
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "submittedAt": now - SUBMIT_COOLDOWN_MS - 1 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        assert_eq!(submit_cooldown_remaining(&runtime, "evejs-x"), 0);
    }

    #[test]
    fn publish_interval_counts_from_the_latest_successful_submit_of_any_mod() {
        let runtime = temp_runtime("publish-interval");
        let now = pkg::epoch_ms() as u64;

        // 压根没提交过 → 不挡
        assert_eq!(publish_interval_remaining(&runtime), 0);

        // 只有 createdAt（打包/推仓库成功、PR 没开出来）→ 不算数，失败重试不该被挡
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "createdAt": now - 1000 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        assert_eq!(publish_interval_remaining(&runtime), 0);

        // 刚成功提交过 → 60 秒内挡着；换个模组也照样挡（这条是发布间隔，不是模组冷却）
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "submittedAt": now - 10_000 },
            { "id": "evejs-y", "version": "1.0.0", "submittedAt": now - 20_000 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        let left = publish_interval_remaining(&runtime);
        assert!(
            left > 0 && left <= PUBLISH_INTERVAL_MS - 10_000,
            "left={left}"
        );

        // 超过 60 秒 → 放行
        let file = json!({ "schemaVersion": 1, "items": [
            { "id": "evejs-x", "version": "1.0.0", "submittedAt": now - PUBLISH_INTERVAL_MS - 1 }
        ]});
        let _ = write_submission_file(&runtime, &file);
        assert_eq!(publish_interval_remaining(&runtime), 0);
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn index_repo_requires_owner_slash_repo_shape() {
        let runtime = temp_runtime("repo");
        assert_eq!(index_repo(&runtime), github::DEFAULT_INDEX_REPO);

        let settings = json!({ "modIndexRepo": "me/ my-mods" });
        let _ =
            crate::config::write_settings(&runtime.settings_file(), settings.as_object().unwrap());
        // 带空格的非法值必须被挡掉（否则会拼出坏 URL 去请求）
        assert_eq!(index_repo(&runtime), github::DEFAULT_INDEX_REPO);

        let ok = json!({ "modIndexRepo": "someone/EVEjs-mods-fork" });
        let _ = crate::config::write_settings(&runtime.settings_file(), ok.as_object().unwrap());
        assert_eq!(index_repo(&runtime), "someone/EVEjs-mods-fork");
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn submission_ledger_round_trips() {
        let runtime = temp_runtime("ledger");
        assert_eq!(
            list_submissions(&runtime)["items"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let file = json!({
            "schemaVersion": 1,
            "items": [
                { "id": "demo", "version": "1.0.0", "status": "draft" },
                { "id": "demo", "version": "1.1.0", "status": "submitted", "prUrl": "https://example.com/pull/1" },
            ]
        });
        write_submission_file(&runtime, &file).unwrap();
        let items = submission_items(&runtime);
        assert_eq!(items.len(), 2);
        assert_eq!(find_item_index(&file, "demo", "1.1.0"), Some(1));
        assert_eq!(find_item_index(&file, "demo", "2.0.0"), None);

        // 坏 JSON 当作空台账，不能让整个「我创建的」崩掉
        std::fs::write(submissions_path(&runtime), "{ not json").unwrap();
        assert_eq!(submission_items(&runtime).len(), 0);
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn submission_is_mine_matches_author_id_key_id_or_direct_key() {
        // 判据按可靠度：草稿里的作者 id、草稿里的 keyId、条目自带的签名 keyId
        let runtime = temp_runtime("mine");
        let by_id = json!({ "id": "a", "indexDraft": { "author": { "id": "au-1" } } });
        let by_draft_key = json!({ "id": "b", "indexDraft": { "author": { "keyId": "key-1" } } });
        let by_direct_key = json!({ "id": "c", "signatureKeyId": "key-1" });
        let stranger =
            json!({ "id": "d", "indexDraft": { "author": { "id": "au-9", "keyId": "key-9" } } });
        assert!(submission_is_mine(&runtime, &by_id, "au-1", "key-1"));
        assert!(submission_is_mine(&runtime, &by_draft_key, "au-1", "key-1"));
        assert!(submission_is_mine(
            &runtime,
            &by_direct_key,
            "au-1",
            "key-1"
        ));
        assert!(!submission_is_mine(&runtime, &stranger, "au-1", "key-1"));
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn forget_submission_drops_every_version_and_is_idempotent() {
        let runtime = temp_runtime("forget");
        let file = json!({
            "schemaVersion": 1,
            "items": [
                { "id": "demo", "version": "1.0.0", "indexDraft": { "author": { "id": "au-1", "keyId": "key-1" } } },
                { "id": "demo", "version": "1.1.0", "indexDraft": { "author": { "id": "au-1", "keyId": "key-1" } } },
                { "id": "other", "version": "1.0.0", "indexDraft": { "author": { "id": "au-1", "keyId": "key-1" } } },
            ]
        });
        write_submission_file(&runtime, &file).unwrap();

        // 该 id 的**全部**版本一起走：只删最新一条的话，列表里会剩下更早那一条
        let reply = forget_submission_as(&runtime, "demo", "au-1", "key-1");
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["removed"], 2);
        let left = submission_items(&runtime);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["id"], "other");

        // 再删一次：空手而归也算成功（界面刷新一下就行），不能报成错误
        let again = forget_submission_as(&runtime, "demo", "au-1", "key-1");
        assert_eq!(again["ok"], true);
        assert_eq!(again["removed"], 0);

        // 空 id 直接拒，不去猜要删哪个
        let blank = forget_submission_as(&runtime, "  ", "au-1", "key-1");
        assert_eq!(blank["ok"], false);
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn forget_submission_keeps_records_signed_by_another_identity() {
        // 台账按机器存：重装系统换过身份之后，旧身份投的那些不该被新身份删掉
        let runtime = temp_runtime("forget-other");
        let file = json!({
            "schemaVersion": 1,
            "items": [
                { "id": "demo", "version": "1.0.0", "indexDraft": { "author": { "id": "au-old", "keyId": "key-old" } } },
            ]
        });
        write_submission_file(&runtime, &file).unwrap();
        let reply = forget_submission_as(&runtime, "demo", "au-new", "key-new");
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["removed"], 0);
        assert_eq!(submission_items(&runtime).len(), 1);
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn previous_history_stays_empty_for_now() {
        // 现役版读错了缓存层级，线上 history 恒为 []；这里锁住行为，避免「顺手修好」导致
        // 提交给维护者仓库的索引分片形状变化（修法见实施记录待办）
        let runtime = temp_runtime("history");
        // 故意造出「顶层就有 mods」的缓存，这正是现役版误读的那个层级
        let file = json!({ "fetchedAt": 1, "mods": [{ "id": "demo", "history": [{ "version": "0.9.0" }] }] });
        std::fs::write(
            crate::mods::registry::cache_path(&runtime),
            serde_json::to_string(&file).unwrap(),
        )
        .unwrap();
        assert!(previous_history(&runtime, "demo").is_empty());
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn normalize_download_urls_filters_and_fills_priority() {
        let input = json!({
            "downloadUrls": [
                { "mirror": "github", "url": "https://example.com/a.zip" },
                { "mirror": "http", "url": "http://example.com/b.zip" },
                { "url": "https://example.com/c.zip", "priority": 7 },
            ]
        });
        let urls = normalize_download_urls(&input, "downloadUrls");
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0]["mirror"], "github");
        assert_eq!(urls[0]["priority"], 1);
        // mirror 缺省补 "custom"
        assert_eq!(urls[1]["mirror"], "custom");
        assert_eq!(urls[1]["priority"], 7);
    }

    #[test]
    fn readme_listing_splits_highlights_and_details() {
        let runtime = temp_runtime("readme");
        let repo = runtime.root.join("repo");
        let dir = repo.join("mods").join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("README.md"),
            [
                "# 演示模组",
                "",
                "## 功能要点",
                "",
                "- 第一条要点",
                "- 第一条要点",
                "* 第二条要点",
                "",
                "## 详细介绍",
                "",
                "第一段说明。",
                "",
                "第二段说明。",
                "",
                "## 其它",
                "",
                "这段既不是要点也不是介绍，应该被丢掉。",
            ]
            .join("\n"),
        )
        .unwrap();

        let (readme, highlights) = readme_for_listing(&repo, "demo");
        assert_eq!(
            highlights,
            vec!["第一条要点".to_string(), "第二条要点".to_string()]
        );
        assert_eq!(
            readme,
            vec!["第一段说明。".to_string(), "第二段说明。".to_string()]
        );

        // 没有 README 时给空结果，不报错
        let (empty_readme, empty_highlights) = readme_for_listing(&repo, "missing");
        assert!(empty_readme.is_empty());
        assert!(empty_highlights.is_empty());
        let _ = std::fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn listing_json_carries_asset_urls() {
        let draft = json!({ "id": "demo", "version": "1.0.0", "downloadUrls": [] });
        let urls =
            vec![json!({ "mirror": "github", "url": "https://example.com/a.zip", "priority": 1 })];
        let text = build_listing_json(&draft, &urls);
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["downloadUrls"][0]["url"],
            "https://example.com/a.zip"
        );
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn assemble_download_urls_dedupes_and_orders() {
        let gitee = "https://gitee.com/me/repo/releases/download/v1.0.0/demo.zip";
        let existing = vec![
            json!({ "mirror": "custom", "url": "https://example.com/a.zip", "priority": 1 }),
            // 与 gitee 同址的一条要被去重
            json!({ "mirror": "gitee", "url": gitee, "priority": 9 }),
            json!({ "mirror": "cdn", "url": "https://cdn.example.com/a.zip", "priority": 9 }),
        ];
        let urls = assemble_download_urls(
            "https://github.com/me/repo/releases/download/v1.0.0/demo-1.0.0.zip",
            gitee,
            &existing,
        );
        // github(资产地址) → gitee → custom → cdn，priority 按最终顺序重排
        assert_eq!(urls.len(), 4);
        assert_eq!(urls[0]["mirror"], "github");
        assert_eq!(urls[1]["mirror"], "gitee");
        assert_eq!(urls[2]["url"], "https://example.com/a.zip");
        assert_eq!(urls[2]["priority"], 3);
        assert_eq!(urls[3]["mirror"], "cdn");
        assert_eq!(urls[3]["priority"], 4);

        // 没给 gitee 时只剩 github + 自带镜像
        let urls = assemble_download_urls(
            "https://github.com/me/repo/releases/download/v1.0.0/a.zip",
            "",
            &[],
        );
        assert_eq!(urls.len(), 1);
    }

    #[test]
    fn reveal_submission_zip_reports_missing_file() {
        let result = reveal_submission_zip("E:\\definitely\\not\\here.zip");
        assert_eq!(result["ok"], false);
        assert!(result["reason"].as_str().unwrap().contains("ZIP 不存在"));
    }

    /// 2026-09-30 报障：弹窗里填 1.0.8、清单里还是 1.0.7，打包仍按 1.0.7 走，
    /// 后面按 1.0.8 回查台账必然落空 → 报「找不到待提交记录」。
    #[test]
    fn resolve_submit_version_writes_the_requested_version_back_to_the_manifest() {
        let runtime = temp_runtime("submit-version");
        let manifest_path = runtime.root.join("evejs-launcher.mod.json");
        let mut manifest = Map::new();
        manifest.insert("id".to_string(), json!("demo"));
        manifest.insert("version".to_string(), json!("1.0.7"));
        manifest.insert("signature".to_string(), json!({ "sig": "old" }));
        std::fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();

        // 填了 1.0.8：返回 1.0.8，并把清单改成 1.0.8（旧签名必须摘掉，重签会补回来）
        let version =
            resolve_submit_version(&manifest, &manifest_path, "1.0.7", " 1.0.8 ").unwrap();
        assert_eq!(version, "1.0.8");
        let written = scan::read_manifest(&manifest_path).unwrap();
        assert_eq!(
            written.get("version").and_then(Value::as_str),
            Some("1.0.8")
        );
        assert!(written.get("signature").is_none(), "清单变了旧签名必须摘掉");

        // 没填、或跟清单一致：原样返回，且一个字节都不动
        let before = std::fs::read_to_string(&manifest_path).unwrap();
        assert_eq!(
            resolve_submit_version(&written, &manifest_path, "1.0.8", "").unwrap(),
            "1.0.8"
        );
        assert_eq!(
            resolve_submit_version(&written, &manifest_path, "1.0.8", "1.0.8").unwrap(),
            "1.0.8"
        );
        assert_eq!(std::fs::read_to_string(&manifest_path).unwrap(), before);

        // 格式不合法：直接拒绝，不落盘；文案是固定键，界面才能按它查多语言目录
        assert_eq!(
            resolve_submit_version(&written, &manifest_path, "1.0.8", "v1").unwrap_err(),
            "版本号格式必须像 1.0.0"
        );
        assert_eq!(std::fs::read_to_string(&manifest_path).unwrap(), before);
    }
}
