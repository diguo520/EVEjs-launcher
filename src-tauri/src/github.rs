//! GitHub 集成：令牌存取 + REST 调用 + 提交 PR / 发布到作者自己的仓库。
//!
//! 对齐现役版三个模块：
//!   - `githubToken.ts`  令牌持久化（Windows 上走 DPAPI，绑定当前用户；失败则只留内存）
//!   - `githubSubmit.ts` fork → 分支 → 提交分片 → 开 PR
//!   - `githubPublish.ts` 作者自己仓库 → `evejs-mod.json` → Release → 传 ZIP
//!
//! 所有出网都经 `net.rs`；令牌**只**用于提交模组，不参与任何下载与更新。
use crate::net;
use crate::runtime::RuntimePaths;
use crate::secrets;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// `githubSubmit.ts::TIMEOUT_MS`：API 调用 20s
const API_TIMEOUT: Duration = Duration::from_secs(20);
/// `githubPublish.ts::TIMEOUT_MS`：发布链路 30s（上传是它的 4 倍）
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(30);
/// GitHub **单个发布资产**的硬上限：2 GiB。超过它的包必须切片，各传一个资产。
/// 这不是我们拍的数 —— GitHub 文档明确写明 release asset 每条要小于 2 GiB。
pub const GITHUB_ASSET_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
/// 我们自己切片的大小：留 100 MB 余量，别正好顶在 2 GiB 上被 GitHub 拒。
pub const UPLOAD_PART_SIZE: u64 = 1_900_000_000;
/// 默认索引仓库（对齐 `modSubmit.ts::DEFAULT_INDEX_REPO`）
pub const DEFAULT_INDEX_REPO: &str = "diguo520/EVEjs-mods";
pub(crate) const TOKEN_FILE: &str = "github-token.bin";

/* ------------------------------ 令牌存取 ------------------------------ */

/// DPAPI 不可用时的内存兜底（对齐现役版 `memoryToken` / `memoryOnly`）
static MEMORY_TOKEN: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
static MEMORY_ONLY: AtomicBool = AtomicBool::new(false);

pub fn token_file(paths: &RuntimePaths) -> PathBuf {
    paths.user_data.join(TOKEN_FILE)
}

/// 读令牌：文件能解开就用文件，否则回退到内存（对齐现役版 `getToken`）。
///
/// 密文格式与 Electron `safeStorage` 互通（Chromium OSCrypt：`v10 | nonce | AES-256-GCM | tag`，
/// 见 `crate::oscrypt`），所以老启动器存下来的 `github-token.bin` 搬过来后**直接能读**，
/// 不需要用户重填令牌。
pub fn get_token(paths: &RuntimePaths) -> String {
    let file = token_file(paths);
    if file.is_file() {
        if let Ok(raw) = std::fs::read(&file) {
            return crate::oscrypt::decrypt(&raw)
                .and_then(|plain| String::from_utf8(plain).ok())
                .unwrap_or_default();
        }
        return String::new();
    }
    MEMORY_TOKEN
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

pub fn is_memory_only() -> bool {
    MEMORY_ONLY.load(Ordering::Relaxed)
}

/// 令牌状态：`encrypted` 表示已加密落盘（false = 只在内存里，退出即失效）
pub fn token_status(paths: &RuntimePaths) -> Value {
    let file = token_file(paths);
    let on_disk = file.is_file();
    json!({
        "hasToken": !get_token(paths).is_empty() || on_disk,
        "encrypted": on_disk,
        "path": file.to_string_lossy(),
    })
}

/// 保存令牌：优先 DPAPI 落盘；不可用时只留内存并说明原因（绝不静默失败）
pub fn save_token(paths: &RuntimePaths, token: &str) -> Value {
    let value = token.trim().to_string();
    if value.is_empty() {
        return json!({ "ok": false, "encrypted": false, "reason": "令牌不能为空" });
    }
    match crate::oscrypt::encrypt(value.as_bytes()) {
        Some(cipher) => {
            let file = token_file(paths);
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&file, cipher) {
                Ok(()) => {
                    if let Ok(mut guard) = MEMORY_TOKEN.lock() {
                        guard.clear();
                    }
                    MEMORY_ONLY.store(false, Ordering::Relaxed);
                    json!({ "ok": true, "encrypted": true })
                }
                Err(err) => {
                    keep_in_memory(value);
                    json!({
                        "ok": true,
                        "encrypted": false,
                        "reason": format!("加密失败（{err}），令牌只保存在内存里"),
                    })
                }
            }
        }
        None => {
            keep_in_memory(value);
            json!({
                "ok": true,
                "encrypted": false,
                "reason": "当前环境不支持加密存储（DPAPI 不可用），令牌只保存在内存里，退出启动器后需要重新填写",
            })
        }
    }
}

fn keep_in_memory(value: String) {
    if let Ok(mut guard) = MEMORY_TOKEN.lock() {
        *guard = value;
    }
    MEMORY_ONLY.store(true, Ordering::Relaxed);
}

pub fn clear_token(paths: &RuntimePaths) -> Value {
    if let Ok(mut guard) = MEMORY_TOKEN.lock() {
        guard.clear();
    }
    MEMORY_ONLY.store(false, Ordering::Relaxed);
    let file = token_file(paths);
    if file.is_file() {
        if let Err(err) = std::fs::remove_file(&file) {
            return json!({ "ok": false, "reason": err.to_string() });
        }
    }
    json!({ "ok": true })
}

/* ------------------------------ REST 调用 ------------------------------ */

/// 对齐现役版 `ApiResult<T>`
pub struct ApiReply {
    pub ok: bool,
    pub status: u16,
    pub data: Option<Value>,
    pub reason: String,
    /// `x-oauth-scopes`：classic / OAuth 令牌才有；fine-grained 与 GitHub App 为 None
    pub scopes: Option<String>,
}

impl ApiReply {
    fn failed(status: u16, reason: String) -> Self {
        Self {
            ok: false,
            status,
            data: None,
            reason,
            scopes: None,
        }
    }
}

/// 把 GitHub 的 403 / 404 翻成「到底缺哪一项令牌权限」（对齐 `githubPublish::permissionHint`）
pub fn permission_hint(status: u16) -> &'static str {
    match status {
        403 => "（令牌权限不足：索引仓库 EVEjs-mods 在维护者名下）请改用 classic 令牌并勾选 public_repo（或 repo）；如果你是索引仓库协作者，请把 fine-grained 令牌的 Repository access 勾上 EVEjs-mods，并开 Contents / Pull requests = Read and write",
        404 => "（仓库或文件不存在，或者令牌没有覆盖它；索引仓库属于维护者时 fine-grained 令牌覆盖不到，投稿请改用 classic 令牌勾 public_repo 或 repo）",
        _ => "",
    }
}

/// 一次 GitHub REST 调用。`with_path_and_hint` 对齐两个现役模块的差异：
/// `githubSubmit::call` 只给「GitHub <status>：<message>」，
/// `githubPublish::call` 还会附上「[方法 路径]」与权限提示（上传失败时排错全靠它）。
pub fn call(
    token: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
    with_path_and_hint: bool,
) -> ApiReply {
    let response = match net::github_api(token, method, path, body, timeout) {
        Ok(response) => response,
        Err(reason) => return ApiReply::failed(0, reason),
    };
    let status = response.status;
    let data = response.json();
    let scopes = response.oauth_scopes.clone();
    if !(200..300).contains(&status) {
        let message = data
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let text = response.text();
                let head: String = text.chars().take(200).collect();
                if head.is_empty() {
                    format!("HTTP {status}")
                } else {
                    head
                }
            });
        let mut reason = format!("GitHub {status}：{message}");
        if with_path_and_hint {
            reason.push_str(&format!(" [{method} {path}]"));
            // 限流也是 403，别把「API rate limit exceeded」说成令牌权限问题
            if !message.to_ascii_lowercase().contains("rate limit") {
                reason.push_str(permission_hint(status));
            }
        }
        return ApiReply::failed(status, reason);
    }
    ApiReply {
        ok: true,
        status,
        data,
        reason: String::new(),
        scopes,
    }
}

/// 便捷包装：提交链路（带路径尾注与权限提示 —— 投稿会连做「建 fork / 写文件 / 开 PR」
/// 三件在别人仓库上的事，403 光秃秃一句 `Resource not accessible` 作者根本无从下手）
fn call_submit(token: &str, method: &str, path: &str, body: Option<&Value>) -> ApiReply {
    call(token, method, path, body, API_TIMEOUT, true)
}

/// 便捷包装：发布链路（带路径尾注与权限提示）
fn call_publish(token: &str, method: &str, path: &str, body: Option<&Value>) -> ApiReply {
    call(token, method, path, body, PUBLISH_TIMEOUT, true)
}

fn object_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `GET /user` 的原始回包：登录名在 `data`，classic 令牌的 scope 在 `x-oauth-scopes` 头。
///
/// 刻意**不带**路径尾注与权限提示：这个端点跟仓库权限无关，坏令牌的 401/403
/// 不该被误报成「缺 Contents」。
fn user_reply(token: &str) -> ApiReply {
    call(token, "GET", "/user", None, API_TIMEOUT, false)
}

/// `GET /user`：校验令牌并拿到登录名（`validateToken` / `whoami` 是同一件事）
pub fn validate_token(token: &str) -> Value {
    let reply = user_reply(token);
    let login = reply
        .data
        .as_ref()
        .map(|value| object_field(value, "login"))
        .unwrap_or_default();
    if !reply.ok || login.is_empty() {
        return json!({ "ok": false, "reason": if reply.reason.is_empty() { "令牌无效".to_string() } else { reply.reason } });
    }
    json!({ "ok": true, "login": login })
}

/// 判定这枚令牌能不能往索引仓库（在维护者名下）开 PR。
///
/// 依据是 `x-oauth-scopes`：classic 令牌会返回逗号分隔的 scope，勾了 `public_repo`
/// 或 `repo` 就能读写公共仓库、建 fork、开 PR；fine-grained 令牌没有这个头，而且它的
/// Repository access 只能覆盖「自己有权限的仓库」—— 索引仓库在别人名下，普通作者勾不到，
/// 投稿必然 403 `Resource not accessible by personal access token`。
fn submit_capability(token: &str, scopes: Option<&str>) -> (&'static str, Vec<String>, bool) {
    let items: Vec<String> = scopes
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if token.starts_with("github_pat_") {
        return ("fine-grained", items, false);
    }
    if scopes.is_none() {
        // 既没有 `github_pat_` 前缀也没有 scope 头：GitHub App / OAuth 令牌，同样覆盖不到索引仓库
        return ("unknown", items, false);
    }
    let can_submit = items
        .iter()
        .any(|item| item == "public_repo" || item == "repo");
    ("classic", items, can_submit)
}

/// `checkToken(token?)`：给了就用给的，没给就用本机存的。
///
/// 返回里除了登录名，还带上「这枚令牌能不能投稿」的判定（`tokenKind` / `scopes` /
/// `canSubmit`）—— 界面在保存 / 校验时就能提前警告，而不是等作者提交到一半才吃 403。
pub fn check_token(paths: &RuntimePaths, token: Option<&str>) -> Value {
    let value = match token {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => get_token(paths),
    };
    if value.is_empty() {
        return json!({ "ok": false, "reason": "还没填 GitHub 令牌" });
    }
    let reply = user_reply(&value);
    let login = reply
        .data
        .as_ref()
        .map(|value| object_field(value, "login"))
        .unwrap_or_default();
    if !reply.ok || login.is_empty() {
        return json!({ "ok": false, "reason": if reply.reason.is_empty() { "令牌无效".to_string() } else { reply.reason } });
    }
    // 顺手把「这个令牌是谁」记下来：认领候选列表这类只读路径要按登录名排序，
    // 不能每次都再打一遍 GitHub（离线时还会白等一次 20s 超时）。
    remember_login(paths, &value, &login);
    let (token_kind, scopes, can_submit) = submit_capability(&value, reply.scopes.as_deref());
    json!({
        "ok": true,
        "login": login,
        "tokenKind": token_kind,
        "scopes": scopes,
        "canSubmit": can_submit,
    })
}

/* --------------------------- 登录名缓存 --------------------------- */

/// 登录名缓存：`GET /user` 是出网动作，而列表刷新是高频只读动作
const LOGIN_CACHE_FILE: &str = "gh-login.json";
/// 一条记录能活多久：换令牌 / 换账号都会让旧条目失效，一天足够
const LOGIN_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// 最多留几条（按令牌指纹索引），免得反复换令牌把文件养肥
const LOGIN_CACHE_MAX: usize = 8;

fn login_cache_path(paths: &RuntimePaths) -> PathBuf {
    paths.cache.join(LOGIN_CACHE_FILE)
}

/// 令牌指纹：缓存按它索引，文件里不落令牌明文
fn login_cache_key(token: &str) -> String {
    crate::mods::pkg::sha256_hex(token.as_bytes())
}

fn now_ms() -> u64 {
    crate::mods::pkg::epoch_ms() as u64
}

/// 读本机缓存（**绝不联网**）：过期的条目直接丢掉，别把一周前的登录名当现在的
fn read_login_cache(paths: &RuntimePaths) -> Vec<(String, String, u64)> {
    let Ok(raw) = std::fs::read_to_string(login_cache_path(paths)) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    let now = now_ms();
    parsed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let key = item.get("key").and_then(Value::as_str)?;
                    let login = item.get("login").and_then(Value::as_str)?;
                    let at_ms = item.get("atMs").and_then(Value::as_u64).unwrap_or(0);
                    Some((key.to_string(), login.to_string(), at_ms))
                })
                .filter(|(_, _, at_ms)| now.saturating_sub(*at_ms) < LOGIN_TTL_MS)
                .collect()
        })
        .unwrap_or_default()
}

/// 记住「这个令牌是哪个账号」：核验过令牌的地方都该调一次。
pub fn remember_login(paths: &RuntimePaths, token: &str, login: &str) {
    if token.is_empty() || login.is_empty() {
        return;
    }
    let key = login_cache_key(token);
    let mut items = read_login_cache(paths);
    items.retain(|(existing, _, _)| *existing != key);
    items.push((key, login.to_string(), now_ms()));
    if items.len() > LOGIN_CACHE_MAX {
        let drop = items.len() - LOGIN_CACHE_MAX;
        items.drain(0..drop);
    }
    let payload = json!({
        "schemaVersion": 1,
        "items": items
            .iter()
            .map(|(key, login, at_ms)| json!({ "key": key, "login": login, "atMs": at_ms }))
            .collect::<Vec<Value>>(),
    });
    let path = login_cache_path(paths);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(path, format!("{text}\n"));
    }
}

/// 本机缓存里这个令牌的登录名（**绝不联网**）：没有就回空串
pub fn cached_login(paths: &RuntimePaths, token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let key = login_cache_key(token);
    read_login_cache(paths)
        .into_iter()
        .find(|(existing, _, _)| *existing == key)
        .map(|(_, login, _)| login)
        .unwrap_or_default()
}

/* --------------------------- 提交 PR（fork 流程） --------------------------- */

/// 确保 fork 存在并可用（已存在则直接复用，409/422 属正常情况）
pub fn ensure_fork(token: &str, upstream: &str) -> Value {
    let fork = call_submit(
        token,
        "POST",
        &format!("/repos/{upstream}/forks"),
        Some(&json!({})),
    );
    if fork.ok {
        if let Some(data) = fork.data.as_ref() {
            let full_name = object_field(data, "full_name");
            if !full_name.is_empty() {
                return json!({ "ok": true, "repo": full_name });
            }
        }
    }
    let user = validate_token(token);
    let login = object_field(&user, "login");
    if login.is_empty() {
        let reason = if fork.reason.is_empty() {
            "拿不到 GitHub 登录名".to_string()
        } else {
            fork.reason
        };
        return json!({ "ok": false, "reason": reason });
    }
    let repo_name = upstream.split('/').nth(1).unwrap_or_default();
    let mine = call_submit(token, "GET", &format!("/repos/{login}/{repo_name}"), None);
    if mine.ok {
        if let Some(data) = mine.data.as_ref() {
            let full_name = object_field(data, "full_name");
            if !full_name.is_empty() {
                return json!({ "ok": true, "repo": full_name });
            }
        }
    }
    let reason = if !fork.reason.is_empty() {
        fork.reason
    } else if !mine.reason.is_empty() {
        mine.reason
    } else {
        "fork 不可用".to_string()
    };
    json!({ "ok": false, "reason": reason })
}

/// 读仓库里的一个文件（优先 Contents API，退回 raw CDN）。返回文本与 sha。
///
/// 用途：往 `sources.json` 追加一行前必须先拿到**当前**内容 —— 读不到就绝不能继续，
/// 否则会拿空列表去覆盖，把别人的收录全删掉（现役版 0.1.19 实测踩过）。
pub fn read_repo_file(token: &str, repo: &str, file_path: &str, base_branch: &str) -> Value {
    let path = format!(
        "/repos/{repo}/contents/{file_path}?ref={}",
        encode_uri(base_branch)
    );
    let via_api = call_submit(token, "GET", &path, None);
    if via_api.ok {
        if let Some(data) = via_api.data.as_ref() {
            if let Some(content) = data.get("content").and_then(Value::as_str) {
                if !content.is_empty() {
                    let cleaned: String = content.chars().filter(|ch| *ch != '\n').collect();
                    if let Some(bytes) = secrets::base64_decode(&cleaned) {
                        return json!({
                            "ok": true,
                            "text": String::from_utf8_lossy(&bytes),
                            "sha": object_field(data, "sha"),
                        });
                    }
                }
            }
        }
    }
    let url = format!("https://raw.githubusercontent.com/{repo}/{base_branch}/{file_path}");
    match net::get(&url, "*/*", API_TIMEOUT) {
        Ok(response) if (200..300).contains(&response.status) => {
            json!({ "ok": true, "text": response.text(), "sha": "" })
        }
        Ok(response) => json!({
            "ok": false,
            "reason": non_empty_or(&via_api.reason, &format!("raw HTTP {}", response.status)),
        }),
        Err(err) => json!({ "ok": false, "reason": non_empty_or(&via_api.reason, &err) }),
    }
}

fn non_empty_or(primary: &str, fallback: &str) -> String {
    if primary.is_empty() {
        fallback.to_string()
    } else {
        primary.to_string()
    }
}

/// 极简百分号编码：只转义会破坏 URL 结构的字符（对齐 JS `encodeURIComponent` 的常用子集）
fn encode_uri(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 提交链路的一次性输入（对齐 `SubmitFileInput`）
pub struct SubmitFileInput<'a> {
    pub token: &'a str,
    pub upstream: &'a str,
    pub file_path: &'a str,
    pub content: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub commit_message: &'a str,
    pub pr_title: &'a str,
    pub pr_body: &'a str,
}

/// 一个要提交到索引仓库的文件（路径 + 文本内容）
pub struct SubmitFile<'a> {
    pub path: &'a str,
    pub content: &'a str,
}

/// 一次 PR 要带的全部文件。首次发布＝`sources.json` + `mods/<id>.json`；
/// 版本更新＝只有 `mods/<id>.json`。同一个分支、同一条 PR。
pub struct SubmitFilesInput<'a> {
    pub token: &'a str,
    pub upstream: &'a str,
    pub files: &'a [SubmitFile<'a>],
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub commit_message: &'a str,
    pub pr_title: &'a str,
    pub pr_body: &'a str,
}

/// fork → 分支 → 提交文件 → 开 PR。失败时把「手动开 PR 的比较页」一并带回去。
pub fn submit_files_via_pull_request(input: &SubmitFilesInput) -> Value {
    let base = if input.base_branch.is_empty() {
        "main"
    } else {
        input.base_branch
    };
    let user = validate_token(input.token);
    let login = object_field(&user, "login");
    if login.is_empty() {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&user, "reason"), "令牌无效") });
    }

    let fork = ensure_fork(input.token, input.upstream);
    let fork_repo = object_field(&fork, "repo");
    if fork_repo.is_empty() {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&fork, "reason"), "fork 失败") });
    }
    let fork_name = fork_repo.split('/').nth(1).unwrap_or_default().to_string();

    // 先同步 fork 的 base 分支：索引仓库的 CI 每 6 小时就往 main 提交一次
    // （docs/mod-index.json），fork 不跟上就建分支，PR 的 diff 里会连带把
    // 别人已合并的改动「回退」一遍。同步失败不致命（分叉时就同步不了），照常往下走。
    let _ = call_submit(
        input.token,
        "POST",
        &format!("/repos/{login}/{fork_name}/merge-upstream"),
        Some(&json!({ "branch": base })),
    );

    let head_ref = call_submit(
        input.token,
        "GET",
        &format!("/repos/{login}/{fork_name}/git/ref/heads/{base}"),
        None,
    );
    let base_sha = head_ref
        .data
        .as_ref()
        .and_then(|value| value.get("object"))
        .map(|value| object_field(value, "sha"))
        .unwrap_or_default();
    if !head_ref.ok || base_sha.is_empty() {
        let reason = non_empty_or(
            &head_ref.reason,
            &format!("拿不到 fork 的 {base} 分支（fork 可能还在生成，稍后重试）"),
        );
        return json!({ "ok": false, "reason": reason });
    }

    // 分支已存在（上次提交过同名分支）时直接复用：422 是正常情况
    let create_ref = call_submit(
        input.token,
        "POST",
        &format!("/repos/{login}/{fork_name}/git/refs"),
        Some(&json!({ "ref": format!("refs/heads/{}", input.branch), "sha": base_sha })),
    );
    if !create_ref.ok && create_ref.status != 422 {
        return json!({ "ok": false, "reason": non_empty_or(&create_ref.reason, "建分支失败") });
    }
    if create_ref.status == 422 {
        // 分支已存在（同一模组上一版还开着 PR）：把它拉回 fork 的 base，
        // 否则旧分支上的旧文件会被算进本次 diff —— 等于顺手回退别人的合并。
        let reset = call_submit(
            input.token,
            "PATCH",
            &format!("/repos/{login}/{fork_name}/git/refs/heads/{}", input.branch),
            Some(&json!({ "sha": base_sha, "force": true })),
        );
        if !reset.ok {
            return json!({ "ok": false, "reason": non_empty_or(&reset.reason, "重置提交分支失败") });
        }
    }

    // 一个 PR 可能要带多个文件（首次发布：sources.json + 版本分片）：
    // 逐个 PUT 到同一个分支，最后只开一条 PR。
    for file in input.files {
        // 文件已存在（更新已有分片）时需要带上它的 blob sha
        let existing = call_submit(
            input.token,
            "GET",
            &format!(
                "/repos/{login}/{fork_name}/contents/{}?ref={}",
                file.path,
                encode_uri(input.branch)
            ),
            None,
        );
        let existing_sha = existing
            .data
            .as_ref()
            .map(|value| object_field(value, "sha"))
            .unwrap_or_default();

        let mut put_body = json!({
            "message": input.commit_message,
            "content": secrets::base64_encode(file.content.as_bytes()),
            "branch": input.branch,
        });
        if !existing_sha.is_empty() {
            put_body["sha"] = json!(existing_sha);
        }
        let put = call_submit(
            input.token,
            "PUT",
            &format!("/repos/{login}/{fork_name}/contents/{}", file.path),
            Some(&put_body),
        );
        if !put.ok {
            return json!({
                "ok": false,
                "reason": non_empty_or(&put.reason, "提交文件失败"),
                "failedFile": file.path,
            });
        }
    }

    let pr = call_submit(
        input.token,
        "POST",
        &format!("/repos/{}/pulls", input.upstream),
        Some(&json!({
            "title": input.pr_title,
            "head": format!("{login}:{}", input.branch),
            "base": base,
            "body": input.pr_body,
        })),
    );
    if pr.status == 422 {
        // 这个分支已经有 PR 了（重复点「申请收录」）：文件已经更新，把已有 PR 找回来算成功
        let head = encode_uri(&format!("{login}:{}", input.branch));
        let existing_pr = call_submit(
            input.token,
            "GET",
            &format!("/repos/{}/pulls?state=all&head={head}", input.upstream),
            None,
        );
        let url = existing_pr
            .data
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .map(|value| object_field(value, "html_url"))
            .unwrap_or_default();
        if !url.is_empty() {
            return json!({ "ok": true, "prUrl": url, "branch": input.branch, "login": login, "forkRepo": fork_repo });
        }
    }
    if !pr.ok {
        // 分支已推到 fork，但开 PR 失败（多半缺 Pull requests 写权限）：附带手动开 PR 的比较页
        return json!({
            "ok": false,
            "login": login,
            "forkRepo": fork_repo,
            "branch": input.branch,
            "compareUrl": compare_url(input.upstream, base, input.branch, &login),
            "reason": non_empty_or(&pr.reason, "开 PR 失败（分支已推送，可手动开 PR）"),
        });
    }
    json!({
        "ok": true,
        "prUrl": pr.data.as_ref().map(|value| object_field(value, "html_url")).unwrap_or_default(),
        "branch": input.branch,
        "login": login,
        "forkRepo": fork_repo,
    })
}

/// 单文件版本（保持原调用点不变）
pub fn submit_file_via_pull_request(input: &SubmitFileInput) -> Value {
    submit_files_via_pull_request(&SubmitFilesInput {
        token: input.token,
        upstream: input.upstream,
        files: &[SubmitFile {
            path: input.file_path,
            content: input.content,
        }],
        branch: input.branch,
        base_branch: input.base_branch,
        commit_message: input.commit_message,
        pr_title: input.pr_title,
        pr_body: input.pr_body,
    })
}

/// 从 `https://github.com/owner/repo/pull/8` 或 `8` 里取出 PR 编号；不是数字就返回空串。
pub fn pull_number_from(reference: &str) -> String {
    let tail = reference
        .trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    if !tail.is_empty() && tail.chars().all(|ch| ch.is_ascii_digit()) {
        tail.to_string()
    } else {
        String::new()
    }
}

/// 读一条 PR 的当前状态。
///
/// 用途：提交完「审核」之后**校验 PR 真的开出来了**（不能只信 PUT 成功的回包），
/// 以及复查那条 PR 后来是被合并还是被关掉了。失败只报原因，绝不当成提交失败。
pub fn get_pull_request(token: &str, upstream: &str, reference: &str) -> Value {
    let number = pull_number_from(reference);
    if number.is_empty() {
        return json!({ "ok": false, "reason": "没有 PR 编号" });
    }
    let result = call_submit(
        token,
        "GET",
        &format!("/repos/{upstream}/pulls/{number}"),
        None,
    );
    if !result.ok {
        return json!({ "ok": false, "number": number, "reason": non_empty_or(&result.reason, "读不到 PR 状态") });
    }
    let data = result.data.unwrap_or(Value::Null);
    let merged = data.get("merged").and_then(Value::as_bool).unwrap_or(false);
    let state = if merged {
        "merged".to_string()
    } else {
        object_field(&data, "state")
    };
    json!({
        "ok": true,
        "number": number,
        "state": state,
        "merged": merged,
        "title": object_field(&data, "title"),
        "htmlUrl": object_field(&data, "html_url"),
    })
}

fn compare_url(upstream: &str, base: &str, branch: &str, login: &str) -> String {
    format!(
        "https://github.com/{upstream}/compare/{base}...{}?expand=1",
        encode_uri(&format!("{login}:{branch}"))
    )
}

/// 降级路径：给出可直接打开的 PR 比较页地址（对齐 `pullRequestCompareUrl`）
pub fn pull_request_compare_url(upstream: &str, branch: &str, login: &str) -> String {
    if login.is_empty() {
        format!("https://github.com/{upstream}/compare/main...main?expand=1")
    } else {
        format!("https://github.com/{upstream}/compare/main...{login}:{branch}?expand=1")
    }
}
/* ----------------------- 发布到作者自己的仓库 ----------------------- */

/// 确保作者自己的仓库存在；不存在就建一个公开仓库
pub fn ensure_own_repo(token: &str, owner: &str, repo_name: &str, description: &str) -> Value {
    let existing = call_publish(token, "GET", &format!("/repos/{owner}/{repo_name}"), None);
    if existing.ok {
        if let Some(data) = existing.data.as_ref() {
            if !object_field(data, "full_name").is_empty() {
                return json!({ "ok": true, "repo": data, "created": false });
            }
        }
    }
    if existing.status != 404 {
        return json!({ "ok": false, "reason": non_empty_or(&existing.reason, "查询仓库失败") });
    }

    let created = call_publish(
        token,
        "POST",
        "/user/repos",
        Some(&json!({
            "name": repo_name,
            "description": description.chars().take(300).collect::<String>(),
            "private": false,
            "auto_init": true,
        })),
    );
    if !created.ok {
        if created.status == 403 {
            // 手动建仓库只需要 Contents 权限，所以这里给两条明确的出路
            let mut reason = String::from(
                "创建仓库被拒绝（403）：当前令牌缺少 Administration: Read and write。两个解法 —— \
                 ① 到 GitHub 打开这个令牌，Repository permissions 里把 Administration 设为 Read and write（Repository access 选 All repositories）后重试；\
                 ② 先在 GitHub 手动建好仓库，再把 owner/repo 填进「我的仓库」——手动建仓库时只需要 Contents = Read and write。",
            );
            if !created.reason.is_empty() {
                reason.push_str(&format!(" 原始错误：{}", created.reason));
            }
            return json!({ "ok": false, "reason": reason });
        }
        return json!({ "ok": false, "reason": non_empty_or(&created.reason, "创建仓库失败") });
    }
    let repo = created.data.unwrap_or(Value::Null);
    if object_field(&repo, "full_name").is_empty() {
        return json!({ "ok": false, "reason": non_empty_or(&created.reason, "创建仓库失败") });
    }
    json!({ "ok": true, "repo": repo, "created": true })
}

/// 只读探一次仓库：存不存在、当前令牌对它有没有写权限。
///
/// 与 `ensure_own_repo` 的区别是**绝不建仓库** —— 认领旧模组要靠它核验归属，
/// 核验这种只读动作不该顺手在 GitHub 上留下一个新仓库。
pub fn repo_access(token: &str, owner: &str, repo_name: &str) -> Value {
    let reply = call_publish(token, "GET", &format!("/repos/{owner}/{repo_name}"), None);
    if reply.status == 404 {
        return json!({
            "ok": true,
            "exists": false,
            "push": false,
            "admin": false,
            "ownerLogin": "",
            "fullName": "",
        });
    }
    if !reply.ok {
        return json!({
            "ok": false,
            "exists": false,
            "push": false,
            "admin": false,
            "reason": non_empty_or(&reply.reason, "查询仓库失败"),
        });
    }
    let data = reply.data.unwrap_or(Value::Null);
    let permissions = data.get("permissions").cloned().unwrap_or(Value::Null);
    json!({
        "ok": true,
        "exists": !object_field(&data, "full_name").is_empty(),
        "push": permissions.get("push").and_then(Value::as_bool).unwrap_or(false),
        "admin": permissions.get("admin").and_then(Value::as_bool).unwrap_or(false),
        "ownerLogin": object_field(&data.get("owner").cloned().unwrap_or(Value::Null), "login"),
        "fullName": object_field(&data, "full_name"),
    })
}

/// 写入/更新作者仓库里的**一个文件**（文本或二进制都走它）。
///
/// `evejs-mod.json` 与 `shots/*.png` 共用这条路径：先 GET 拿已有 blob 的 sha，
/// 有就带上 sha 覆盖、没有就新建 —— 这是 GitHub Contents API 的更新约定，
/// 少带 sha 会被 409 拒掉。
pub fn put_repo_file(
    token: &str,
    owner: &str,
    repo_name: &str,
    file_path: &str,
    bytes: &[u8],
    message: &str,
) -> Value {
    let existing = call_publish(
        token,
        "GET",
        &format!("/repos/{owner}/{repo_name}/contents/{file_path}"),
        None,
    );
    let existing_sha = if existing.ok {
        existing
            .data
            .as_ref()
            .map(|value| object_field(value, "sha"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut body = json!({
        "message": message,
        "content": secrets::base64_encode(bytes),
    });
    if !existing_sha.is_empty() {
        body["sha"] = json!(existing_sha);
    }
    let put = call_publish(
        token,
        "PUT",
        &format!("/repos/{owner}/{repo_name}/contents/{file_path}"),
        Some(&body),
    );
    if !put.ok {
        return json!({
            "ok": false,
            "reason": non_empty_or(&put.reason, &format!("写入 {file_path} 失败")),
        });
    }
    let sha = put
        .data
        .as_ref()
        .and_then(|value| value.get("content"))
        .map(|value| object_field(value, "sha"))
        .unwrap_or_default();
    json!({ "ok": true, "sha": sha })
}

/// 写入/更新仓库里的 `evejs-mod.json`（索引 CI 就是靠它聚合）
pub fn put_listing_manifest(token: &str, owner: &str, repo_name: &str, content: &str) -> Value {
    put_repo_file(
        token,
        owner,
        repo_name,
        "evejs-mod.json",
        content.as_bytes(),
        "chore: update evejs-mod.json",
    )
}

/// 读仓库里一个**文本**文件；不存在 / 读不到都返回 `None`（调用方按"没有旧内容"处理）。
pub fn get_repo_file_text(
    token: &str,
    owner: &str,
    repo_name: &str,
    file_path: &str,
) -> Option<String> {
    let got = call_publish(
        token,
        "GET",
        &format!("/repos/{owner}/{repo_name}/contents/{file_path}"),
        None,
    );
    if !got.ok {
        return None;
    }
    let encoded = got
        .data
        .as_ref()
        .map(|value| object_field(value, "content"))
        .unwrap_or_default();
    // GitHub 的 content 是带换行的 base64，先去掉空白再解
    let cleaned: String = encoded.chars().filter(|ch| !ch.is_whitespace()).collect();
    let bytes = secrets::base64_decode(&cleaned)?;
    String::from_utf8(bytes).ok()
}

/// 新清单里**没有** `shots` 时，把作者仓库里已有的那份留下来。
///
/// 为什么必须做这一步：`evejs-mod.json` 是**整份覆盖**写的，而 `shots` 只在本地
/// `mods/<id>/shots/` 真有图时才生成（见 `submit::shots_for_listing`）。少了这层合并，
/// 作者换一台没有 `shots/` 的机器发个新版本，就会把之前上好的截图字段悄悄抹掉 ——
/// 索引跟着丢、详情里的图凭空消失，而且没有任何报错。
///
/// 反向不动：新清单自己带了 `shots` 就以它为准（作者删掉本地图 = 想撤下截图，这时该删）。
/// 合并失败（网络不通 / 旧文件坏了）也照原样写，不因为读不到旧内容就卡住发布。
fn preserve_listing_shots(token: &str, owner: &str, repo_name: &str, next_json: &str) -> String {
    let previous = get_repo_file_text(token, owner, repo_name, "evejs-mod.json");
    merge_listing_shots(next_json, previous.as_deref()).unwrap_or_else(|| next_json.to_string())
}

/// `preserve_listing_shots` 的纯逻辑（单独抽出来才能单测）。
/// 返回 `None` 表示"不用改，照新清单原样写"。
fn merge_listing_shots(next_json: &str, previous_json: Option<&str>) -> Option<String> {
    let next = serde_json::from_str::<Value>(next_json).ok()?;
    let previous = serde_json::from_str::<Value>(previous_json?).ok()?;
    // shots 与 banner 是两条独立的媒体字段（前者详情灯箱的面板截图，后者精选位背景）。
    // 规则一致：新清单自己带了就以它为准，没带就把旧的那份留下来。
    // 旧清单的 shots 只有非空数组才值得保（空数组等于"作者没图"，不必留空壳）
    let shots = previous.get("shots").filter(|value| {
        value
            .as_array()
            .map(|list| !list.is_empty())
            .unwrap_or(false)
    });
    let mut merged = next;
    let mut changed = false;
    if merged.get("shots").is_none() {
        if let (Some(shots), Some(object)) = (shots, merged.as_object_mut()) {
            object.insert("shots".into(), shots.clone());
            changed = true;
        }
    }
    // 横幅（shots/Banner/ 里那张横图）：旧清单有、新清单没带，就保住它
    let banner = previous.get("banner").filter(|value| {
        value
            .as_str()
            .map(|text| !text.trim().is_empty())
            .unwrap_or(false)
    });
    if merged.get("banner").is_none() {
        if let (Some(banner), Some(object)) = (banner, merged.as_object_mut()) {
            object.insert("banner".into(), banner.clone());
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    serde_json::to_string_pretty(&merged)
        .ok()
        .map(|text| text + "\n")
}

/// 确保 tag 对应的 Release 存在（已存在则复用）
pub fn ensure_release(
    token: &str,
    owner: &str,
    repo_name: &str,
    tag: &str,
    changelog: &str,
) -> Value {
    let found = call_publish(
        token,
        "GET",
        &format!(
            "/repos/{owner}/{repo_name}/releases/tags/{}",
            encode_uri(tag)
        ),
        None,
    );
    if found.ok {
        if let Some(data) = found.data.as_ref() {
            if data.get("id").and_then(Value::as_i64).is_some() {
                return json!({ "ok": true, "release": data });
            }
        }
    }
    let created = call_publish(
        token,
        "POST",
        &format!("/repos/{owner}/{repo_name}/releases"),
        Some(&json!({
            "tag_name": tag,
            "name": tag,
            "body": changelog,
            "draft": false,
            "prerelease": false,
        })),
    );
    if !created.ok {
        return json!({ "ok": false, "reason": non_empty_or(&created.reason, "创建 Release 失败") });
    }
    let release = created.data.unwrap_or(Value::Null);
    if release.get("id").and_then(Value::as_i64).is_none() {
        return json!({ "ok": false, "reason": non_empty_or(&created.reason, "创建 Release 失败") });
    }
    json!({ "ok": true, "release": release })
}

/// 上传 ZIP 到 Release；同名资源已存在时先删掉再传（便于重发同一版本）。
///
/// 现役版这里有个坑：Chromium 的 `fetch` 不允许手设 `Content-Length`，
/// 所以它写了一段 node `https` 兜底。ureq 直接按 `&[u8]` body 自动算长度，不需要兜底。
pub fn upload_release_asset(
    token: &str,
    owner: &str,
    repo_name: &str,
    release_id: i64,
    zip_path: &std::path::Path,
    asset_name: &str,
) -> Value {
    // 流式上传：body 直接从磁盘按块读（net::send_file 用 ureq 的 File body，
    // 自动带 Content-Length、不分块）。几十 MB 到几 GB 都不再先进内存。
    let file = match std::fs::File::open(zip_path) {
        Ok(file) => file,
        Err(err) => return json!({ "ok": false, "reason": format!("读不到 ZIP：{err}") }),
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);

    let assets = call_publish(
        token,
        "GET",
        &format!("/repos/{owner}/{repo_name}/releases/{release_id}/assets"),
        None,
    );
    if let Some(items) = assets.data.as_ref().and_then(Value::as_array) {
        if let Some(same) = items
            .iter()
            .find(|item| object_field(item, "name") == asset_name)
        {
            if let Some(id) = same.get("id").and_then(Value::as_i64) {
                let deleted = call_publish(
                    token,
                    "DELETE",
                    &format!("/repos/{owner}/{repo_name}/releases/assets/{id}"),
                    None,
                );
                if !deleted.ok {
                    return json!({ "ok": false, "reason": format!("同名资源删除失败：{}", deleted.reason) });
                }
            }
        }
    }

    let url = format!(
        "https://uploads.github.com/repos/{owner}/{repo_name}/releases/{release_id}/assets?name={}",
        encode_uri(asset_name)
    );
    let authorization = format!("Bearer {token}");
    let response = net::send_file(
        "POST",
        &url,
        &[
            ("Authorization", authorization.as_str()),
            ("Accept", "application/vnd.github+json"),
        ],
        file,
        "application/zip",
        size,
    );
    let response = match response {
        Ok(response) => response,
        Err(reason) => return json!({ "ok": false, "reason": format!("上传资源失败：{reason}") }),
    };
    let data = response.json();
    if !(200..300).contains(&response.status) {
        let message = data
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| response.text().chars().take(200).collect());
        return json!({
            "ok": false,
            "reason": format!("上传资源失败：GitHub {}：{message}{}", response.status, permission_hint(response.status)),
        });
    }
    let browser_url = data
        .as_ref()
        .map(|value| object_field(value, "browser_download_url"))
        .unwrap_or_default();
    json!({ "ok": true, "url": browser_url })
}

/// 一次发布：确保仓库 → 写 `evejs-mod.json` → 传截图 → 建 Release → 上传 ZIP。
/// 全程只动作者自己的仓库，**不碰索引仓库**。
///
/// 上传发布产物：不超过 GitHub 的 2 GiB 就整包传；超过就切片，逐片传。
///
/// 返回 `{ok, url, parts:[{name,url,sizeBytes,sha256,mirror}], reason}`。
/// `parts` 非空时调用方必须把它们写进索引的 `downloadParts`，并且**不能**再把
/// 「整包资产」的地址塞进 `downloadUrls` —— 那个资产根本不存在（整包超过上限，没传上去）。
fn upload_release_payload(
    token: &str,
    owner: &str,
    repo_name: &str,
    release_id: i64,
    zip_path: &std::path::Path,
    asset_name: &str,
) -> Value {
    let size = std::fs::metadata(zip_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if size <= GITHUB_ASSET_LIMIT {
        let single =
            upload_release_asset(token, owner, repo_name, release_id, zip_path, asset_name);
        if !single.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return json!({
                "ok": false,
                "reason": single.get("reason").cloned().unwrap_or(json!("上传失败")),
            });
        }
        return json!({
            "ok": true,
            "url": single.get("url").cloned().unwrap_or(Value::Null),
            "parts": [],
        });
    }

    // 切片：每片一个独立资产；本地分片传完即删（要留的只有作者的源码目录）
    let mut input = match std::fs::File::open(zip_path) {
        Ok(file) => file,
        Err(err) => return json!({ "ok": false, "reason": format!("读不到 ZIP：{err}") }),
    };
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    let mut parts: Vec<Value> = Vec::new();
    let mut index = 0usize;
    loop {
        let name = format!("{asset_name}.part{:03}", index + 1);
        let part_path = zip_path.with_file_name(&name);
        let mut written: u64 = 0;
        {
            let mut out = match std::fs::File::create(&part_path) {
                Ok(file) => file,
                Err(err) => return json!({ "ok": false, "reason": format!("切片写不进：{err}") }),
            };
            while written < UPLOAD_PART_SIZE {
                let want = (UPLOAD_PART_SIZE - written).min(buffer.len() as u64) as usize;
                let read = match input.read(&mut buffer[..want]) {
                    Ok(read) => read,
                    Err(err) => {
                        return json!({ "ok": false, "reason": format!("切片读失败：{err}") })
                    }
                };
                if read == 0 {
                    break;
                }
                if let Err(err) = out.write_all(&buffer[..read]) {
                    return json!({ "ok": false, "reason": format!("切片写失败：{err}") });
                }
                written += read as u64;
            }
            let _ = out.sync_all();
        }
        if written == 0 {
            let _ = std::fs::remove_file(&part_path);
            break;
        }
        index += 1;
        let uploaded = upload_release_asset(token, owner, repo_name, release_id, &part_path, &name);
        if !uploaded.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            let reason = uploaded.get("reason").cloned().unwrap_or(json!("上传失败"));
            let _ = std::fs::remove_file(&part_path);
            return json!({ "ok": false, "reason": format!("第 {index} 片上传失败：{reason}") });
        }
        let sha = match crate::mods::pkg::sha256_file(&part_path) {
            Ok((sha, _)) => sha,
            Err(reason) => {
                let _ = std::fs::remove_file(&part_path);
                return json!({ "ok": false, "reason": format!("第 {index} 片校验失败：{reason}") });
            }
        };
        parts.push(json!({
            "name": name,
            "url": uploaded.get("url").cloned().unwrap_or(Value::Null),
            "sizeBytes": written,
            "sha256": sha,
            "mirror": "github",
        }));
        // 传完即删：本地不该留下 1.9 GB 的碎片
        let _ = std::fs::remove_file(&part_path);
    }
    if parts.is_empty() {
        return json!({ "ok": false, "reason": "切片后没有得到任何分片" });
    }
    json!({
        "ok": true,
        "url": parts[0].get("url").cloned().unwrap_or(Value::Null),
        "parts": parts,
    })
}

/// `extra_files` 是 `(仓库内相对路径, 字节)`：目前只有 `shots/*`。
/// 它们**传失败不拦发布** —— 图是装饰，不能因为一张图挂了就发不出模组。
#[allow(clippy::too_many_arguments)]
pub fn publish_to_own_repo(
    token: &str,
    repo_input: &str,
    zip_path: &std::path::Path,
    asset_name: &str,
    version: &str,
    changelog: &str,
    description: &str,
    listing_json: &str,
    extra_files: &[(String, Vec<u8>)],
    default_repo_name: &str,
    mut say: impl FnMut(&str, u32),
) -> Value {
    say("校验 GitHub 令牌", 5);
    let me = validate_token(token);
    let login = object_field(&me, "login");
    if login.is_empty() {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&me, "reason"), "令牌无效") });
    }

    let raw = repo_input
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_end_matches(".git");
    let parts: Vec<&str> = raw.split('/').filter(|part| !part.is_empty()).collect();
    let owner = if parts.len() >= 2 {
        parts[0]
    } else {
        login.as_str()
    };
    let repo_name = if parts.len() >= 2 {
        parts[1]
    } else if let Some(first) = parts.first() {
        first
    } else {
        default_repo_name
    };
    if repo_name.is_empty() || !is_repo_name(repo_name) {
        return json!({ "ok": false, "reason": "请填写你自己的仓库名（形如 my-evejs-mod，或 owner/my-evejs-mod）" });
    }

    say("准备仓库", 20);
    let repo = ensure_own_repo(token, owner, repo_name, description);
    if repo["repo"].is_null() {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&repo, "reason"), "仓库不可用") });
    }

    say("写入 evejs-mod.json", 40);
    // 新清单没带 shots 就把仓库里已有的那份留着（本地没有 shots/ 的机器上发版不该抹掉截图）
    let listing_text = preserve_listing_shots(token, owner, repo_name, listing_json);
    let listing = put_listing_manifest(token, owner, repo_name, &listing_text);
    if !listing["ok"].as_bool().unwrap_or(false) {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&listing, "reason"), "写入 evejs-mod.json 失败") });
    }

    if !extra_files.is_empty() {
        say("上传截图", 50);
        for (file_path, bytes) in extra_files {
            let uploaded = put_repo_file(
                token,
                owner,
                repo_name,
                file_path,
                bytes,
                &format!("chore: add {file_path}"),
            );
            if !uploaded["ok"].as_bool().unwrap_or(false) {
                say(&format!("{file_path} 上传失败，已跳过"), 52);
            }
        }
    }

    let tag = format!("v{version}");
    say("创建 Release", 60);
    let release = ensure_release(token, owner, repo_name, &tag, changelog);
    let release_id = release["release"]["id"].as_i64().unwrap_or(0);
    if release_id == 0 {
        return json!({ "ok": false, "reason": non_empty_or(&object_field(&release, "reason"), "创建 Release 失败") });
    }

    say("上传 ZIP（最慢的一步，请稍候）", 75);
    // 超过 GitHub 的 2 GiB 单资产上限就自动切片（`parts` 非空，由调用方写进索引）
    let asset = upload_release_payload(token, owner, repo_name, release_id, zip_path, asset_name);
    let repo_url = object_field(&repo["repo"], "html_url");
    let release_url = object_field(&release["release"], "html_url");
    if !asset["ok"].as_bool().unwrap_or(false) {
        return json!({
            "ok": false,
            "owner": owner,
            "repo": repo_name,
            "repoUrl": repo_url,
            "releaseUrl": release_url,
            "reason": non_empty_or(&object_field(&asset, "reason"), "上传 ZIP 失败"),
        });
    }

    say("完成", 100);
    json!({
        "ok": true,
        "owner": owner,
        "repo": repo_name,
        "repoUrl": repo_url,
        "releaseUrl": release_url,
        "assetUrl": object_field(&asset, "url"),
        "parts": asset.get("parts").cloned().unwrap_or_else(|| json!([])),
        "repoCreated": repo["created"].as_bool().unwrap_or(false),
    })
}

fn is_repo_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

/* ------------------------------ 命名辅助 ------------------------------ */

/// ZIP 资源名：`<id>-<version>.zip`（纯 ASCII，避免下载时的编码问题）
pub fn asset_name_for(id: &str, version: &str) -> String {
    let safe_id = squash(id, "mod", true);
    let safe_ver = squash(version, "0", false);
    format!("{safe_id}-{safe_ver}.zip")
}

/// 复刻现役版的 `replace(/[^A-Za-z0-9._-]+/g, "-")`：
/// 非法字符的**连续段**压成一个 `-`（不是每个字符一个），`trim` 打开时再去掉首尾的 `-`。
fn squash(value: &str, fallback: &str, trim: bool) -> String {
    let source = if value.is_empty() { fallback } else { value };
    let mut out = String::new();
    let mut in_run = false;
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            in_run = false;
            out.push(ch);
        } else if !in_run {
            in_run = true;
            out.push('-');
        }
    }
    if trim {
        out.trim_matches('-').to_string()
    } else {
        out
    }
}

pub fn repo_url_for(owner: &str, repo: &str) -> String {
    format!("https://github.com/{owner}/{repo}")
}

pub fn default_repo_name_for(id: &str) -> String {
    // 现役版先把整串转小写再压非法段，所以这里也先转小写（_ 与 . 在仓库名里也算非法）
    let lowered = if id.is_empty() {
        "mod".to_string()
    } else {
        id.to_ascii_lowercase()
    };
    let mut out = String::new();
    let mut in_run = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            in_run = false;
            out.push(ch);
        } else if !in_run {
            in_run = true;
            out.push('-');
        }
    }
    format!("evejs-mod-{}", out.trim_matches('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_name_is_ascii_safe() {
        assert_eq!(asset_name_for("my mod", "1.0.0"), "my-mod-1.0.0.zip");
        assert_eq!(asset_name_for("hello-world", "v2"), "hello-world-v2.zip");
        // id 里的点与下划线保留，其它非法字符压成连字符并去掉首尾
        assert_eq!(asset_name_for("a.b_c/d", "1.0"), "a.b_c-d-1.0.zip");
        assert_eq!(asset_name_for("", ""), "mod-0.zip");
    }

    #[test]
    fn default_repo_name_is_lowercase_slug() {
        assert_eq!(default_repo_name_for("MyMod"), "evejs-mod-mymod");
        assert_eq!(
            default_repo_name_for("Hello World!"),
            "evejs-mod-hello-world"
        );
        assert_eq!(default_repo_name_for(""), "evejs-mod-mod");
    }

    #[test]
    fn compare_url_encodes_branch() {
        assert_eq!(
            pull_request_compare_url("a/b", "submit/x-1.0.0", "me"),
            "https://github.com/a/b/compare/main...me:submit/x-1.0.0?expand=1"
        );
        // 没有登录名（还没校验令牌）时退化成主分支比较页
        assert_eq!(
            pull_request_compare_url("a/b", "submit/x", ""),
            "https://github.com/a/b/compare/main...main?expand=1"
        );
    }

    #[test]
    fn encode_uri_escapes_reserved_characters() {
        assert_eq!(encode_uri("main"), "main");
        assert_eq!(encode_uri("submit/x 1.0"), "submit%2Fx%201.0");
        assert_eq!(encode_uri("me:submit/x"), "me%3Asubmit%2Fx");
    }

    #[test]
    fn memory_token_round_trip() {
        let root = std::env::temp_dir().join(format!("evejs-github-test-{}", std::process::id()));
        let paths = RuntimePaths::from_root(root.clone(), true);
        let _ = std::fs::create_dir_all(&paths.user_data);
        assert_eq!(get_token(&paths), "");
        let saved = save_token(&paths, "  ghp_test  ");
        assert_eq!(saved["ok"], true);
        assert_eq!(saved["encrypted"], true, "Windows 上 DPAPI 一定可用");
        assert_eq!(get_token(&paths), "ghp_test");
        let status = token_status(&paths);
        assert_eq!(status["hasToken"], true);
        assert_eq!(status["encrypted"], true);
        assert_eq!(clear_token(&paths)["ok"], true);
        assert_eq!(get_token(&paths), "");
        assert_eq!(token_status(&paths)["hasToken"], false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn submit_capability_tells_classic_from_fine_grained() {
        // classic 且勾了 public_repo / repo：能碰别人名下的索引仓库
        assert_eq!(
            submit_capability("ghp_x", Some("public_repo, read:user")),
            (
                "classic",
                vec!["public_repo".to_string(), "read:user".to_string()],
                true
            )
        );
        assert_eq!(
            submit_capability("ghp_x", Some("repo")),
            ("classic", vec!["repo".to_string()], true)
        );
        // classic 但没勾那两项：能发布，投稿会被拒
        assert_eq!(
            submit_capability("ghp_x", Some("workflow")),
            ("classic", vec!["workflow".to_string()], false)
        );
        assert_eq!(
            submit_capability("ghp_x", Some("")),
            ("classic", Vec::new(), false)
        );
        // fine-grained：没有 scope 头，Repository access 覆盖不到索引仓库
        assert_eq!(
            submit_capability("github_pat_abc", None),
            ("fine-grained", Vec::new(), false)
        );
        // 其它 GitHub App / OAuth 令牌同样覆盖不到
        assert_eq!(
            submit_capability("gho_x", None),
            ("unknown", Vec::new(), false)
        );
    }

    /* ------------------- 清单合并：保住已有的 shots ------------------- */

    #[test]
    fn merge_listing_shots_keeps_previous_when_next_has_none() {
        let next = "{\n  \"id\": \"demo\",\n  \"version\": \"1.0.1\"\n}\n";
        let previous = "{\"id\":\"demo\",\"version\":\"1.0.0\",\"shots\":[\"shots/01.webp\"]}";
        let merged = merge_listing_shots(next, Some(previous)).expect("应该合并");
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["shots"][0], json!("shots/01.webp"));
        // 新清单自己的字段照旧
        assert_eq!(value["version"], json!("1.0.1"));
        assert!(merged.ends_with('\n'));
    }

    #[test]
    fn merge_listing_shots_defers_to_next_when_it_has_shots() {
        // 新清单带了 shots（作者删掉本地图就是这种：空数组）→ 以它为准，不合并
        let next = "{\"id\":\"demo\",\"shots\":[]}";
        let previous = "{\"id\":\"demo\",\"shots\":[\"shots/01.webp\"]}";
        assert!(merge_listing_shots(next, Some(previous)).is_none());

        let next2 = "{\"id\":\"demo\",\"shots\":[\"shots/99.webp\"]}";
        assert!(merge_listing_shots(next2, Some(previous)).is_none());
    }

    #[test]
    fn merge_listing_shots_keeps_previous_banner() {
        // 新清单没带 banner，旧的有 → 保住（作者换台机器发版不该把精选背景抹掉）
        let next = "{\"id\":\"demo\",\"version\":\"1.0.1\"}";
        let previous = "{\"id\":\"demo\",\"banner\":\"shots/Banner/banner.jpg\"}";
        let merged = merge_listing_shots(next, Some(previous)).expect("应该合并");
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["banner"], json!("shots/Banner/banner.jpg"));
    }

    #[test]
    fn merge_listing_shots_defers_to_next_banner() {
        // 新清单自己带了 banner → 以它为准（作者换图/撤图）
        let next = "{\"id\":\"demo\",\"banner\":\"shots/Banner/new.png\"}";
        let previous = "{\"id\":\"demo\",\"banner\":\"shots/Banner/old.jpg\"}";
        assert!(merge_listing_shots(next, Some(previous)).is_none());
    }

    #[test]
    fn merge_listing_shots_merges_shots_and_banner_together() {
        // 两个字段各自缺失时都要保住
        let next = "{\"id\":\"demo\"}";
        let previous =
            "{\"id\":\"demo\",\"shots\":[\"shots/a.webp\"],\"banner\":\"shots/Banner/b.jpg\"}";
        let merged = merge_listing_shots(next, Some(previous)).expect("应该合并");
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["shots"][0], json!("shots/a.webp"));
        assert_eq!(value["banner"], json!("shots/Banner/b.jpg"));
    }

    #[test]
    fn merge_listing_shots_is_noop_without_usable_previous() {
        let next = "{\"id\":\"demo\"}";
        // 读不到旧文件 / 旧文件坏了 / 旧的那份没有 shots / 旧的是空数组 → 都不用改
        assert!(merge_listing_shots(next, None).is_none());
        assert!(merge_listing_shots(next, Some("not json")).is_none());
        assert!(merge_listing_shots(next, Some("{\"id\":\"demo\"}")).is_none());
        assert!(merge_listing_shots(next, Some("{\"id\":\"demo\",\"shots\":[]}")).is_none());
        // 新清单本身就解析不了 → 也别动
        assert!(merge_listing_shots("not json", Some("{\"shots\":[\"a.webp\"]}")).is_none());
    }
}
