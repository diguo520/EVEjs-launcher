//! 提交模组：签名 → 打包 → sha256 → 索引分片草稿 →（可选）GitHub 开 PR。
//! 对齐现役版 `src/main/modSubmit.ts`。
//!
//! 关键约定：
//!   - 索引仓库是**分片**结构：一个模组一个 `mods/<id>.json`，作者只动自己那一个，
//!     避免多人同时改同一个 `mod-index.json` 造成 PR 互相冲突；
//!   - `mod-index.json` 由 CI 合并 + 签名，作者不直接改；
//!   - ZIP 由作者自己托管（GitHub / Gitee Releases），索引里只登记 URL + sha256。
use crate::author;
use crate::github;
use crate::mods::{mods_root, pkg, plan, sanitize_folder_name, scan};
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const SUBMISSIONS_FILE: &str = "my-submissions.json";

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
fn readme_for_listing(repo_root: &Path, folder: &str) -> (Vec<String>, Vec<String>) {
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

/// 生成待提交包：重签 → 打包 → sha256 → 组装索引分片 → 写入 `my-submissions.json`。
/// 前四步完全离线，不碰网络。
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
    if !declared_author_id.is_empty() && declared_author_id != author_id {
        return json!({
            "ok": false,
            "reason": format!("这个模组的作者标识是 {declared_author_id}，不是本机作者，不能替别人提交"),
        });
    }

    // 1) 重签（内容变了签名就失效；这里统一重签一次）
    let signed = plan::sign_mod_folder(repo_root, &folder, runtime);
    if !signed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({ "ok": false, "reason": format!("签名失败：{}", text_field(&signed, "reason")) });
    }

    // 2) 打包（.NET ZipFile，避免 Compress-Archive 的分隔符坑）
    let version = if record.version.is_empty() {
        "0.0.0".to_string()
    } else {
        record.version.clone()
    };
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

    // 3) 组装索引分片
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

/* --------------------------- ③ 收录源登记 / PR --------------------------- */

/// 一次性动作：把作者自己的仓库登记进索引仓库的 `sources.json`（之后版本更新都不用再提 PR）。
pub fn register_source(runtime: &RuntimePaths, id: &str, version: &str) -> Value {
    let file = read_submission_file(runtime);
    let Some(_) = find_item_index(&file, id, version) else {
        return json!({ "ok": false, "reason": "找不到待提交记录" });
    };
    let item = file["items"][find_item_index(&file, id, version).unwrap_or(0)].clone();
    let source_repo = text_field(&item, "sourceRepo");
    if source_repo.is_empty() {
        return json!({ "ok": false, "reason": "请先执行「② 发布到我的仓库」，拿到仓库地址后再申请收录" });
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

    let parsed: Result<Value, _> = serde_json::from_str(&current_text);
    let sources: Vec<String> = match parsed {
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

    let already = sources
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&source_repo));
    let mut next = sources.clone();
    if !already {
        next.push(source_repo.clone());
    }
    let branch = format!("register/{}", source_repo.replace('/', "-").to_lowercase());
    let content = {
        let payload = json!({ "schemaVersion": 1, "sources": next });
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()) + "\n"
    };
    let pr_body = [
        "### 收录社区模组源",
        "",
        &format!("- 仓库：`{source_repo}`"),
        "- 上架清单：`evejs-mod.json`（仓库根目录）",
        &format!(
            "- 首次登记：{}",
            if already { "否（已存在，本次为刷新）" } else { "是" }
        ),
        "",
        "> 登记后，仓库的 `evejs-mod.json` 会被 CI 定时聚合进 `mod-index.json`；之后发新版**不需要**再提 PR。",
    ]
    .join("\n");

    let result = github::submit_file_via_pull_request(&github::SubmitFileInput {
        token: &token,
        upstream: &upstream,
        file_path: "sources.json",
        content: &content,
        branch: &branch,
        base_branch: "main",
        commit_message: &if already {
            format!("chore: refresh {source_repo}")
        } else {
            format!("Add mod source {source_repo}")
        },
        pr_title: &format!(
            "{} mod source: {source_repo}",
            if already { "Refresh" } else { "Add" }
        ),
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
    if ok {
        let mut file = file;
        if let Some(index) = find_item_index(&file, id, version) {
            file["items"][index]["sourceReviewUrl"] = json!(text_field(&result, "prUrl"));
            // 这一步就是界面上那个「提交审核」：PR 开出来了，状态得跟上，
            // 否则 myMods 只会说「草稿」，「我创建的」页签既不显示审核中、
            // 也没有入口打开那条 PR（2026-09-28 报障）。
            file["items"][index]["status"] = json!("submitted");
            let _ = write_submission_file(runtime, &file);
        }
    }
    json!({
        "ok": ok,
        "prUrl": result.get("prUrl").cloned().unwrap_or(json!("")),
        "branch": result_branch.clone(),
        "compareUrl": github::pull_request_compare_url(&upstream, &result_branch, &text_field(&result, "login")),
        "reason": text_field(&result, "reason"),
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
}
