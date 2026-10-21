//! 势力推演（`evejs-faction-sim` 模组自带的 Web 面板）代理。
//!
//! 模组会在 `127.0.0.1:26410` 起一个面板服务，把 NPC 势力推演的世界状态开放成一组
//! JSON 接口 + 一条 SSE 事件流。启动器**不嵌它**，而是用启动器自己的界面把这套数据重画
//! 一遍；这个模块就是那层数据管道。
//!
//! 三条设计约束：
//!   1. **令牌不进渲染层**。面板每个请求都要 `Authorization: Bearer <panelToken>`，
//!      而 `/api/action` 能改世界状态（GM 权限）。令牌由模组生成后存在它自己的推演库里
//!      （`setting.panelToken`），这里通过随包 Node 侧车 `faction-cli.js` 只读取出来，
//!      只在本模块内使用 —— 渲染层拿到的永远是没有令牌的响应体。
//!   2. **不动 CSP**。渲染层 CSP 是 `connect-src 'self' ipc:`，够不到 26410；由本模块
//!      在 Rust 侧代发请求，渲染层只跟自己人说话（`launcher_invoke`）。
//!   3. **不碰服务端文件**。只读模组写在 `_local/` 下的状态，不改 `server/`、`mods/`
//!      下的任何东西（这也意味着面板必须由模组自己起来，我们只做客户端）。
//!
//! 面板的接口形状（只读 GET + 一条写 POST）见模组 `lib/sim/web/server.js` 的抬头注释：
//!   GET  /api/<name>            → JSON（部分路由吃 page/size/q/sort/tier/filter 查询参数）
//!   POST /api/action {action, params} → {ok, action, result}
//!   GET  /api/events/stream     → text/event-stream，每帧 `data: {...}`

use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::net;
use crate::sidecar;

/// 面板默认端口，与模组侧 `EVEJS_FACTIONSIM_PANEL_PORT` 的默认值同源。
pub const DEFAULT_PANEL_PORT: u16 = 26410;

/// 势力推演模组的清单 id（与渲染层 `nav-config.ts` 的 `FACTION_MOD_ID` 同值）。
///
/// 探针要把「没装」与「装了但面板没给用」分开，只能回到盘上看清单里的 `id` ——
/// 目录名是作者可以随便改的。
pub const FACTION_MOD_ID: &str = "evejs-faction-sim";

const CLI: &str = "faction-cli.js";
/// 玩家主权（游戏侧）的只读侧车：见 `sovereignty` 通道的说明
const SOVEREIGNTY_CLI: &str = "sovereignty-cli.js";
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const GET_TIMEOUT: Duration = Duration::from_secs(20);
const POST_TIMEOUT: Duration = Duration::from_secs(30);
/// 断线后的重连间隔。面板每 15 s 发一次心跳，所以正常情况不会走到这里。
const RECONNECT_DELAY: Duration = Duration::from_millis(3000);
/// 事件通道：一帧事件一条
const EVENT_CHANNEL: &str = "faction:event";
/// 连接状态通道：连上 / 掉线各一条（与订阅通道 `faction:stream` 分开命名，避免混淆）
const STREAM_CHANNEL: &str = "faction:streamState";
/// SSE 订阅的默认回补条数（打开页面时先看到的最近事件）。
const STREAM_BACKLOG: u32 = 200;

/// 回补条数上限：模组 `lib/sim/web/stream.js` 的 `maxBacklog` 是 500，取大了它自己也会截。
const STREAM_BACKLOG_MAX: u32 = 500;

/// 事件分组过滤的允许值（模组 `lib/sim/web/overview.js` 的 EVENT_GROUPS 去掉 all）。
const STREAM_GROUPS: [&str; 8] = [
    "fleet",
    "combat",
    "intel",
    "territory",
    "economy",
    "logistics",
    "system",
    "other",
];

/// 端口：允许 `EVEJS_FACTIONSIM_PANEL_PORT` 覆盖（模组侧同一个变量，改了要跟着改）。
pub fn panel_port() -> u16 {
    std::env::var("EVEJS_FACTIONSIM_PANEL_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PANEL_PORT)
}

fn panel_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// 从模组的推演库里读面板令牌。返回 `(token, 数据库路径)`。
async fn token_of(repo_root: &Path) -> Result<(String, String), String> {
    let args = vec![
        "token".to_string(),
        repo_root.to_string_lossy().into_owned(),
    ];
    let value = sidecar::run_json(repo_root, CLI, &args, CLI_TIMEOUT).await?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("读不到势力推演面板令牌");
        return Err(reason.to_string());
    }
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("势力推演面板令牌为空".to_string());
    }
    let database = value
        .get("database")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((token, database))
}

/// 允许代理的只读路径。
///
/// 只放行面板自己的 `/api/` 命名空间，并挡掉三类东西：
///   - `/api/session`：它专门用来把令牌交给调用方，绝不能过这条通道；
///   - 任何带 `..` / `?` / `#` / 反斜杠 / 空白的路径（穿目录、注入查询串）；
///   - 非 `/api/` 开头的路径（页面与脚本不该从这里过，渲染层没有理由读它们）。
///
/// 主机与端口由本模块定死成 `127.0.0.1:<panel_port>`，渲染层**不能**指定地址，
/// 所以这里不需要再做「禁止外网」的判断。
fn is_allowed_path(path: &str) -> bool {
    if path == "/api/session" || !path.starts_with("/api/") {
        return false;
    }
    !path.contains("..")
        && !path.contains('?')
        && !path.contains('#')
        && !path.contains("//")
        && !path.contains('\\')
        && !path.chars().any(char::is_whitespace)
}

/// `{ page: "2", size: 50 }` → `?page=2&size=50`（只认标量与短字符串，值一律编码）
fn query_string(query: Option<&Value>) -> String {
    let Some(Value::Object(map)) = query else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (key, value) in map {
        if key.is_empty()
            || key.len() > 32
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let raw = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        if raw.len() > 128 {
            continue;
        }
        parts.push(format!("{key}={}", encode(&raw)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// 最小百分号编码：只保留 URL 里的安全字符，其余按 UTF-8 逐字节转义。
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~' | ',' | ':' | '|') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 一次请求（阻塞）→ 解析后的 JSON。
///
/// 面板对 4xx/5xx 回的是 `{error: "..."}`（写操作是 `{ok:false, error}`），
/// 这里把它翻成 `Err`，让上层统一按「失败 + 原因」回给界面。
///
/// 失败里带上状态码（见 [`PanelFailure`]）：探针要分得清「端口没人监听」与
/// 「端口在监听但请求被 401/403 拒掉」，而原来状态码在这一层就被丢掉了。
fn http_json_blocking(
    method: &str,
    url: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<Value, PanelFailure> {
    // 没有令牌就**不发** `Authorization` 头：空令牌发成 `Bearer ` 会让面板把
    // 「探针没带凭据」记成「带了坏凭据」，两种情形在它那边的日志不一样。
    let authorization = if token.is_empty() {
        None
    } else {
        Some(format!("Bearer {token}"))
    };
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if let Some(value) = authorization.as_deref() {
        headers.push(("Authorization", value));
    }
    headers.push(("Accept", "application/json"));
    let payload = match body {
        Some(value) => Some(
            serde_json::to_vec(value)
                .map_err(|err| PanelFailure::unreachable(format!("请求体序列化失败：{err}")))?,
        ),
        None => None,
    };
    let body_ref = payload
        .as_ref()
        .map(|bytes| (bytes.as_slice(), "application/json"));
    let timeout = if method == "GET" {
        GET_TIMEOUT
    } else {
        POST_TIMEOUT
    };
    let response =
        net::send(method, url, &headers, body_ref, timeout).map_err(PanelFailure::unreachable)?;
    let status = response.status;
    let parsed = response.json().unwrap_or(Value::Null);
    if status >= 400 {
        let reason = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("面板返回 HTTP {status}"));
        return Err(PanelFailure::http(status, reason));
    }
    Ok(parsed)
}

async fn http_json(
    method: &'static str,
    url: String,
    token: String,
    body: Option<Value>,
) -> Result<Value, PanelFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        http_json_blocking(method, &url, &token, body.as_ref())
    })
    .await
    .map_err(|err| PanelFailure::unreachable(format!("代理请求失败：{err}")))?
}

/// `faction:status`：面板在不在、连不连得上，以及顶栏要的那几个读数。
///
/// 四种情况分得清清楚楚（界面据此给出不同的空态，而不是笼统一句「失败」）：
///   - `state="missing"`：连令牌都读不到、盘上也没有这个模组 —— 没装 / 没跑过；
///   - `state="unauthorized"`：**装了但面板没给用** —— 端口在监听却把请求全拒掉
///     （401/403），或者模组装在 `mods/` 里却连端口都没开（模组侧对「未授权」的推荐
///     做法就是不 listen）。两种形态都指向「没拿到官方启动器的许可」；
///   - `state="down"`：读得到令牌（模组装过、跑过）但面板连不上 —— 服务端没起；
///   - `state="ready"`：一切正常，`status` 是 `/api/status` 的原样回包。
///
/// 为什么要「没有令牌也照探一次」：`unauthorized` 那种情形下 sqlite 里往往根本还没有
/// `panelToken`（模组没走到生成令牌那一步），只按「读不到令牌」判就会把它错报成
/// 「没装模组」—— 这一条差别就是用户能不能自己看懂发生了什么。
///
/// 兼容口径：`ok` / `available` 的含义**不变**（`ok` = 读得到令牌），老界面照旧工作；
/// 新增的 `state` / `panelReachable` / `httpStatus` 只是把判断依据透给渲染层。
pub async fn status(repo_root: &Path) -> Value {
    let port = panel_port();
    let url = panel_base(port);
    let (token, database, token_reason) = match token_of(repo_root).await {
        Ok((token, database)) => (token, database, String::new()),
        Err(reason) => (String::new(), String::new(), reason),
    };
    let has_token = !token.is_empty();
    // 装没装看盘上的清单，不看目录名（作者可以改目录名）
    let installed = mod_installed(repo_root);
    match http_json("GET", format!("{url}/api/status"), token, None).await {
        Ok(value) => json!({
            "ok": true,
            "available": true,
            "state": "ready",
            "panelReachable": true,
            "url": url,
            "port": port,
            "database": database,
            "status": value
        }),
        Err(failure) => {
            let state = probe_state(&failure, has_token, installed);
            json!({
                "ok": has_token,
                "available": false,
                "state": state,
                "panelReachable": failure.reachable(),
                "httpStatus": failure.status,
                "url": url,
                "port": port,
                "database": database,
                "reason": probe_reason(&failure, state, &token_reason)
            })
        }
    }
}

/// 一次面板请求的失败：带上「有没有拿到 HTTP 响应」与状态码。
///
/// 探针靠它把「端口没人监听」与「端口在监听但请求被拒」分开（见 [`status`] 的 `state`）；
/// 其余通道（`faction:api` / `faction:action`）只取 `reason`，行为与以前一致。
struct PanelFailure {
    /// 拿到了 HTTP 响应时的状态码；`None` = 传输层就没成（端口没监听 / 超时）
    status: Option<u16>,
    reason: String,
}

impl PanelFailure {
    /// 传输层失败：端口没监听、连不上、超时
    fn unreachable(reason: impl Into<String>) -> Self {
        Self {
            status: None,
            reason: reason.into(),
        }
    }

    /// 拿到了 HTTP 响应，但状态码 ≥ 400：把状态码一起记下来
    fn http(status: u16, reason: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            reason: reason.into(),
        }
    }

    /// 面板给过任何 HTTP 响应（哪怕是 4xx / 5xx）—— 端口有人在监听
    fn reachable(&self) -> bool {
        self.status.is_some()
    }

    /// 401 / 403：请求本身没被授权（不是「没有这个接口」，也不是「服务挂了」）
    fn unauthorized(&self) -> bool {
        matches!(self.status, Some(401 | 403))
    }
}

/// 盘上有没有装 [`FACTION_MOD_ID`] 这个模组（按清单里的 `id` 认，不看目录名）。
fn mod_installed(repo_root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(crate::mods::mods_root(repo_root)) else {
        return false;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest = dir.join(crate::mods::scan::MANIFEST_NAME);
        let Ok(fields) = crate::mods::scan::read_manifest(&manifest) else {
            continue;
        };
        if fields.get("id").and_then(Value::as_str) == Some(FACTION_MOD_ID) {
            return true;
        }
    }
    false
}

/// 探针的状态判定（纯函数，取值与含义见 [`status`] 的说明）。
fn probe_state(failure: &PanelFailure, has_token: bool, installed: bool) -> &'static str {
    if failure.unauthorized() {
        return "unauthorized";
    }
    if failure.reachable() {
        // 面板答了，但答的是别的错（500 / 404…）：不是授权问题，就是它不正常
        return "down";
    }
    if has_token {
        // 模组装过、跑过（令牌在），面板却连不上 —— 服务端没起
        return "down";
    }
    if installed {
        // 盘上装着模组，面板却没监听：模组侧「未授权就不 listen」就是这个形态
        return "unauthorized";
    }
    "missing"
}

/// 探针失败时的原因文案：让用户知道下一步该做什么。
fn probe_reason(failure: &PanelFailure, state: &str, token_reason: &str) -> String {
    match state {
        "unauthorized" if failure.reachable() => format!(
            "面板在监听，但拒绝了这次请求（{}）：该模组当前未获官方启动器许可。",
            failure.reason
        ),
        "unauthorized" => {
            "这个模组装在 mods 目录里，但面板没有启动：模组未获官方启动器许可时不会监听端口。"
                .to_string()
        }
        "down" => failure.reason.clone(),
        // missing：沿用原来那句「读不到令牌」的原因
        _ if !token_reason.is_empty() => token_reason.to_string(),
        _ => failure.reason.clone(),
    }
}

/// `faction:api`：代发一个只读 GET，原样回包。
pub async fn api(repo_root: &Path, path: &str, query: Option<&Value>) -> Value {
    let path = path.trim();
    if !is_allowed_path(path) {
        return json!({ "ok": false, "reason": format!("不允许的面板接口：{path}") });
    }
    let (token, _) = match token_of(repo_root).await {
        Ok(found) => found,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    let url = format!(
        "{}{}{}",
        panel_base(panel_port()),
        path,
        query_string(query)
    );
    match http_json("GET", url, token, None).await {
        Ok(value) => value,
        Err(failure) => json!({ "ok": false, "reason": failure.reason }),
    }
}

/// `faction:action`：代发一次 GM 写操作（`POST /api/action {action, params}`）。
///
/// 参数校验**不在启动器里重写**：面板自己会把每一个动作的参数查一遍（范围、枚举、
/// 数量上限），不合法就地 400。这里只挡「动作名不像动作名」这一类明显错误。
pub async fn action(repo_root: &Path, action: &str, params: Option<&Value>) -> Value {
    let action = action.trim();
    let valid = !action.is_empty()
        && action.len() <= 32
        && action.chars().all(|c| c.is_ascii_alphanumeric())
        && action.starts_with(|c: char| c.is_ascii_alphabetic());
    if !valid {
        return json!({ "ok": false, "reason": format!("不是合法的动作名：{action}") });
    }
    let (token, _) = match token_of(repo_root).await {
        Ok(found) => found,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    let body = json!({
        "action": action,
        "params": params.cloned().unwrap_or_else(|| json!({}))
    });
    let url = format!("{}/api/action", panel_base(panel_port()));
    match http_json("POST", url, token, Some(body)).await {
        Ok(value) => value,
        Err(failure) => json!({ "ok": false, "reason": failure.reason, "action": action }),
    }
}

/// `faction:sovereignty`：玩家主权（**游戏侧**，不是模组）。
///
/// 为什么这条通道读的是游戏库而不是面板：模组的 `/api/realm` 只描述它自己模拟出来的 NPC
/// 政体版图，**不知道玩家军团 / 联盟的主权**。游戏库 `_local/gameStore/gamestore.sqlite` 的
/// `sovereignty` 表才是权威（`systems␟<星系>` → allianceID / corporationID / 主权结构），
/// 星图要「统计到玩家领地」就得读它。走随包侧车 `sovereignty-cli.js`（只读 + WAL），
/// 与数据库页读游戏库是同一条链路，只 SELECT、不写盘。
pub async fn sovereignty(repo_root: &Path) -> Value {
    let args = vec![
        "claims".to_string(),
        repo_root.to_string_lossy().into_owned(),
    ];
    match sidecar::run_json(repo_root, SOVEREIGNTY_CLI, &args, CLI_TIMEOUT).await {
        Ok(value) => value,
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/* ------------------------------------------------------------------ *
 * 事件流：把面板的 SSE 转成 Tauri 事件推给渲染层
 * ------------------------------------------------------------------ */

/// 当前订阅的停止标志。面板最多只允许 8 条 SSE 连接，所以启动器**始终只开一条**：
/// 每次订阅先把上一条停掉（`stop_stream`），再起新的。
fn stream_slot() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    static SLOT: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn stop_stream() -> bool {
    let mut guard = stream_slot().lock().unwrap_or_else(|err| err.into_inner());
    match guard.take() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

fn emit(app: &AppHandle, channel: &str, payload: Value) {
    // 事件方向统一发数组载荷（shim 负责展开），与既有通道一致
    let _ = app.emit(channel, payload);
}

/// 取消订阅；返回之前是否真的订阅着。
pub fn unsubscribe() -> bool {
    stop_stream()
}

/// 订阅事件流：停掉旧的，起一条新线程。`query` 由 [`stream_query`] 拼好。
pub fn subscribe(app: AppHandle, repo_root: PathBuf, token: String, query: String) {
    stop_stream();
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = stream_slot().lock().unwrap_or_else(|err| err.into_inner());
        *guard = Some(flag.clone());
    }
    std::thread::spawn(move || stream_loop(app, repo_root, token, query, flag));
}

/// 拼订阅用的查询串：`?backlog=N`，可选 `&group=a,b`。
///
/// 为什么要有 `group`：不过滤时战斗事件（`loss` / `killReward`）在流里很稀疏 —— 实测 200 条
/// 回补里一条都捞不到，于是 KM（交战详情）永远开天窗。按组过滤之后，回补的 500 条**全是**战斗事件。
/// 分组名在 Rust 侧再挡一道白名单，不接受渲染层塞任意字符串进 URL。
fn stream_query(backlog: Option<u32>, group: Option<&str>) -> String {
    let count = backlog
        .unwrap_or(STREAM_BACKLOG)
        .clamp(1, STREAM_BACKLOG_MAX);
    let mut query = format!("?backlog={count}");
    let mut groups: Vec<&str> = Vec::new();
    for raw in group.unwrap_or("").split(',') {
        let name = raw.trim();
        if let Some(known) = STREAM_GROUPS.iter().find(|item| **item == name) {
            if !groups.contains(known) {
                groups.push(known);
            }
        }
    }
    if !groups.is_empty() {
        query.push_str("&group=");
        query.push_str(&groups.join(","));
    }
    query
}

/// 读一次事件流，直到对端关闭或出错。返回 `Err` 时调用方等一会儿再重连。
fn read_stream_once(
    app: &AppHandle,
    url: &str,
    token: &str,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let agent = stream_agent();
    let authorization = format!("Bearer {token}");
    let mut response = agent
        .get(url)
        .header("Authorization", &authorization)
        .header("Accept", "text/event-stream")
        .call()
        .map_err(|err| err.to_string())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("面板事件流返回 HTTP {status}"));
    }
    let mut reader = std::io::BufReader::new(response.body_mut().as_reader());
    let mut line = String::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        line.clear();
        match reader.read_line(&mut line) {
            // 0 = 对端正常关闭；出错都当「这一轮结束」，交给外层重连
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(reason) => return Err(reason.to_string()),
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        // SSE 帧：`data: {...}`；其余（`id:` / `: 心跳` / 空行）忽略
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
            emit(app, EVENT_CHANNEL, json!([value]));
        }
    }
}

/// 事件流专用 agent：**不能有全局超时**（那会把长连接掐断），所以单独建一个。
/// 其余（UA、TLS 提供方、4xx 不当异常）与 `net` 模块保持一致。
fn stream_agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .user_agent(net::USER_AGENT)
        .timeout_global(None)
        .tls_config(tls)
        .http_status_as_error(false)
        .build()
        .into()
}

fn stream_loop(
    app: AppHandle,
    repo_root: PathBuf,
    mut token: String,
    query: String,
    stop: Arc<AtomicBool>,
) {
    let port = panel_port();
    let base = panel_base(port);
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let url = format!("{base}/api/events/stream{query}");
        match read_stream_once(&app, &url, &token, &stop) {
            Ok(()) => {
                if !stop.load(Ordering::SeqCst) {
                    emit(
                        &app,
                        STREAM_CHANNEL,
                        json!([{ "connected": false, "reason": "" }]),
                    );
                }
            }
            Err(reason) => {
                emit(
                    &app,
                    STREAM_CHANNEL,
                    json!([{ "connected": false, "reason": reason }]),
                );
            }
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        // 重连前再读一次令牌：模组重建过库（换机 / 清存档）时新令牌才接得上
        if let Ok((fresh, _)) = tauri::async_runtime::block_on(token_of(&repo_root)) {
            token = fresh;
        }
        // 分片睡眠，停止时能及时退出
        let slices = (RECONNECT_DELAY.as_millis() as u64 / 100).max(1);
        for _ in 0..slices {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// `faction:stream`：`start=true` 订阅（先读令牌），`start=false` 取消。
///
/// `opts` 可选：`{ backlog?: number, group?: string }`（见 [`stream_query`]）。
/// KM 页用它订阅 `group=combat, backlog=500` —— 只要战斗事件，且要足够长的回补，
/// 否则逐舰损失（`loss` / `killReward`）在混合流里根本挤不进窗口。
pub async fn stream(app: &AppHandle, repo_root: &Path, start: bool, opts: Option<&Value>) -> Value {
    if !start {
        let was_running = unsubscribe();
        return json!({ "ok": true, "streaming": false, "stopped": was_running });
    }
    let (token, _) = match token_of(repo_root).await {
        Ok(found) => found,
        Err(reason) => return json!({ "ok": false, "streaming": false, "reason": reason }),
    };
    let backlog = opts
        .and_then(|value| value.get("backlog"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let group = opts
        .and_then(|value| value.get("group"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let query = stream_query(backlog, group.as_deref());
    subscribe(app.clone(), repo_root.to_path_buf(), token, query.clone());
    json!({ "ok": true, "streaming": true, "query": query })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 代理白名单：`/api/session`（交令牌）与非 `/api/` 路径必须被挡掉
    #[test]
    fn proxy_path_whitelist_rejects_session_and_escapes() {
        assert!(is_allowed_path("/api/overview"));
        assert!(is_allowed_path("/api/realm/polities"));
        assert!(!is_allowed_path("/api/session"));
        assert!(!is_allowed_path("/api/../secret"));
        assert!(!is_allowed_path("/api/state?token=x"));
        assert!(!is_allowed_path("/index.html"));
        assert!(!is_allowed_path("//127.0.0.1:1/api/state"));
        assert!(!is_allowed_path("/api/a b"));
        assert!(!is_allowed_path("/api/a\\b"));
    }

    /// 查询串只认标量键值，且键名与长度都受限
    #[test]
    fn query_string_encodes_and_skips_objects() {
        let query = json!({ "page": 2, "q": "苍 穹", "sort": "power", "nested": { "a": 1 } });
        let encoded = query_string(Some(&query));
        assert!(encoded.starts_with('?'), "{encoded}");
        assert!(encoded.contains("page=2"), "{encoded}");
        assert!(encoded.contains("q=%E8%8B%8D%20%E7%A9%B9"), "{encoded}");
        assert!(!encoded.contains("nested"), "{encoded}");
        assert_eq!(query_string(None), "");
        assert_eq!(query_string(Some(&json!({}))), "");
    }

    /// 订阅查询串：回补条数夹在 [1, 500]，分组只认模组那 8 个，其余一律丢掉
    #[test]
    fn stream_query_clamps_backlog_and_filters_groups() {
        assert_eq!(
            stream_query(None, None),
            format!("?backlog={STREAM_BACKLOG}")
        );
        assert_eq!(
            stream_query(Some(500), Some("combat")),
            "?backlog=500&group=combat"
        );
        // 超出上限 / 0 都要夹住（模组 maxBacklog 是 500）
        assert_eq!(stream_query(Some(9999), None), "?backlog=500");
        assert_eq!(stream_query(Some(0), None), "?backlog=1");
        // 未知分组丢掉；重复分组去重；只留合法的
        assert_eq!(
            stream_query(Some(500), Some("combat,combat,evil,combat")),
            "?backlog=500&group=combat"
        );
        assert_eq!(stream_query(Some(300), Some("nope")), "?backlog=300");
        assert_eq!(
            stream_query(Some(300), Some("combat, economy")),
            "?backlog=300&group=combat,economy"
        );
    }

    /// 端口默认 26410，且能被环境变量覆盖成非法值时不认
    #[test]
    fn panel_port_defaults_and_rejects_junk() {
        std::env::remove_var("EVEJS_FACTIONSIM_PANEL_PORT");
        assert_eq!(panel_port(), DEFAULT_PANEL_PORT);
        std::env::set_var("EVEJS_FACTIONSIM_PANEL_PORT", "0");
        assert_eq!(panel_port(), DEFAULT_PANEL_PORT);
        std::env::set_var("EVEJS_FACTIONSIM_PANEL_PORT", "not-a-port");
        assert_eq!(panel_port(), DEFAULT_PANEL_PORT);
        std::env::set_var("EVEJS_FACTIONSIM_PANEL_PORT", "26500");
        assert_eq!(panel_port(), 26500);
        std::env::remove_var("EVEJS_FACTIONSIM_PANEL_PORT");
    }

    /// 探针三态：没装 / 装了但面板没给用 / 面板没起，三者必须分得开
    #[test]
    fn probe_state_separates_missing_unauthorized_and_down() {
        // 端口没人监听：没有 HTTP 响应
        let refused = PanelFailure::unreachable("connection refused");
        assert!(!refused.reachable() && !refused.unauthorized());
        // 没令牌 + 盘上没装 = 没装模组
        assert_eq!(probe_state(&refused, false, false), "missing");
        // 盘上装着、面板却没监听 = 未授权（模组侧「未授权就不 listen」）
        assert_eq!(probe_state(&refused, false, true), "unauthorized");
        // 读得到令牌（装过、跑过）却连不上 = 服务端没起
        assert_eq!(probe_state(&refused, true, true), "down");
        // 用户手删了模组目录但令牌还在：仍按「装过」处理，不谎报没装
        assert_eq!(probe_state(&refused, true, false), "down");
    }

    /// 端口在监听但请求被拒：与「读不读得到令牌」无关，一律是未授权
    #[test]
    fn probe_state_treats_401_403_as_unauthorized() {
        let denied = PanelFailure::http(401, "面板返回 HTTP 401");
        assert!(denied.reachable() && denied.unauthorized());
        assert_eq!(probe_state(&denied, false, true), "unauthorized");
        assert_eq!(probe_state(&denied, true, true), "unauthorized");
        assert!(PanelFailure::http(403, "面板返回 HTTP 403").unauthorized());
        // 401 / 403 以外的状态码不算「未授权」：404 是接口没了，500 是服务挂了
        let broken = PanelFailure::http(500, "面板返回 HTTP 500");
        assert!(broken.reachable() && !broken.unauthorized());
        assert_eq!(probe_state(&broken, true, true), "down");
    }

    /// 原因文案：未授权那条必须指向「许可」，不能只说「连不上」
    #[test]
    fn probe_reason_points_at_authorization() {
        let denied = PanelFailure::http(401, "面板返回 HTTP 401");
        assert!(probe_reason(&denied, "unauthorized", "").contains("许可"));
        let refused = PanelFailure::unreachable("connection refused");
        assert!(probe_reason(&refused, "unauthorized", "").contains("许可"));
        // down / missing 沿用原来的原因（老界面靠它显示失败详情）
        assert_eq!(probe_reason(&refused, "down", ""), "connection refused");
        assert_eq!(
            probe_reason(&refused, "missing", "读不到令牌"),
            "读不到令牌"
        );
    }

    /// 装没装看清单里的 `id`，不看目录名
    #[test]
    fn mod_installed_matches_manifest_id_not_folder_name() {
        let root = std::env::temp_dir().join(format!("evejs-faction-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("mods").join("renamed-folder");
        std::fs::create_dir_all(&dir).unwrap();
        // 没有 mods/ 目录、目录里没有清单，都算没装
        assert!(!mod_installed(&root.join("nowhere")));
        assert!(!mod_installed(&root));
        // 别的模组不算
        std::fs::write(
            dir.join(crate::mods::scan::MANIFEST_NAME),
            json!({
                "schemaVersion": 3,
                "id": "other-mod",
                "displayName": "x",
                "version": "1.0.0"
            })
            .to_string(),
        )
        .unwrap();
        assert!(!mod_installed(&root));
        // 目录名随便改，只要清单 id 是它就算装上了
        std::fs::write(
            dir.join(crate::mods::scan::MANIFEST_NAME),
            json!({
                "schemaVersion": 3,
                "id": FACTION_MOD_ID,
                "displayName": "x",
                "version": "1.0.0"
            })
            .to_string(),
        )
        .unwrap();
        assert!(mod_installed(&root));
        let _ = std::fs::remove_dir_all(&root);
    }
}
