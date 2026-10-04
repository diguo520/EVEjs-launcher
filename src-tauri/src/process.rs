//! 服务启停状态机：对齐现役版 src/main/processManager.ts 的关键语义
//!   - 状态取值 idle / starting / running / stopping / error（渲染层直接映射卡片颜色）
//!   - 主服务器经 PTY 执行 `cmd.exe /c npm start`，cwd = server/
//!   - 市场服务直接 spawn release 二进制，缺失时给出可操作提示
//!   - 停止统一走 `taskkill /PID <pid> /T /F`（等价现役版 killOwned）
use crate::env;
use crate::health;
use crate::pty::PtySpec;
#[cfg(windows)]
use crate::win32::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const MAIN_SERVER: &str = "mainServer";
pub const MARKET_SERVER: &str = "marketServer";
pub const CLIENT: &str = "client";

/// PTY 会话 id（与现役版一致：市场服务用 "market"）
fn session_id(service_id: &str) -> &'static str {
    match service_id {
        MAIN_SERVER => "mainServer",
        MARKET_SERVER => "market",
        _ => "client",
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceInfo {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 进程第一次被记录下来的时刻（毫秒时间戳）：运行时长由它算出来。
    /// 「端口已被外部占用、pid 为空」的那种运行中拿不到起点，回 null，界面画 "—"。
    /// 不 skip：让每张卡片的 JSON 形状恒定（省得结构比对时忽有忽无）
    #[serde(rename = "startedAt")]
    pub started_at: Option<u64>,
}

pub struct ServiceTable {
    inner: Mutex<BTreeMap<String, ServiceInfo>>,
}

impl Default for ServiceTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceTable {
    pub fn new() -> Self {
        let mut table = BTreeMap::new();
        for (id, name) in [
            (MAIN_SERVER, "主服务器"),
            (MARKET_SERVER, "市场服务"),
            (CLIENT, "游戏客户端"),
        ] {
            table.insert(
                id.to_string(),
                ServiceInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    state: "idle".to_string(),
                    pid: None,
                    message: None,
                    started_at: None,
                },
            );
        }
        Self {
            inner: Mutex::new(table),
        }
    }

    pub fn snapshot(&self) -> Vec<ServiceInfo> {
        match self.inner.lock() {
            Ok(guard) => guard.values().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn state_of(&self, id: &str) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).map(|info| info.state.clone()))
            .unwrap_or_else(|| "idle".to_string())
    }

    /// 记录中的 PID（客户端是 DETACHED_PROCESS 直连启动，没有 PTY，只能从这里取）
    pub fn pid_of(&self, id: &str) -> Option<u32> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).and_then(|info| info.pid))
    }

    pub fn message_of(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).and_then(|info| info.message.clone()))
    }

    /// 进程退出后清掉 PID，但保留 state/message（update 会一并覆盖 message，不能拿来复用）
    pub fn clear_pid(&self, id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(info) = guard.get_mut(id) {
                info.pid = None;
            }
        }
    }

    fn update(&self, id: &str, state: &str, pid: Option<u32>, message: Option<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(info) = guard.get_mut(id) {
                info.state = state.to_string();
                info.message = message;
                match pid {
                    Some(value) => {
                        // 记下「第一次拿到 pid」的那一刻：运行时长从这里起算。
                        // 同一个 pid 反复上报（starting → running）不能把起点往后推。
                        if info.pid != Some(value) {
                            info.started_at = Some(now_ms());
                        }
                        info.pid = Some(value);
                    }
                    None => {
                        if state == "idle" || state == "error" || state == "stopping" {
                            info.pid = None;
                            info.started_at = None;
                        }
                    }
                }
            }
        }
    }
}

/// 服务表 + 逐进程读数（CPU / 内存）。
///
/// `services:list` 与 `services:changed` 共用这一份：两个入口形状必须一致，
/// 否则收到事件的那一帧会把卡片上的读数抖成 "—"。
pub fn list_with_stats(state: &AppState) -> Vec<Value> {
    let snapshot = state.services.snapshot();
    let pids: Vec<u32> = snapshot.iter().filter_map(|info| info.pid).collect();
    let stats = match state.metrics.lock() {
        Ok(mut guard) => guard.process_stats(&pids),
        Err(_) => HashMap::new(),
    };

    snapshot
        .into_iter()
        .map(|info| {
            let mut value = serde_json::to_value(&info).unwrap_or(Value::Null);
            let stat = info.pid.and_then(|pid| stats.get(&pid));
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "cpuPercent".to_string(),
                    stat.and_then(|stat| stat.cpu_percent)
                        .map_or(Value::Null, |cpu| json!(cpu)),
                );
                object.insert(
                    "memMB".to_string(),
                    stat.map_or(Value::Null, |stat| json!(stat.mem_mb)),
                );
            }
            value
        })
        .collect()
}

fn emit_services(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let list = list_with_stats(&state);
        let _ = app.emit("services:changed", json!([list]));
    }
}

fn set_state(app: &AppHandle, id: &str, state: &str, pid: Option<u32>, message: Option<String>) {
    if let Some(app_state) = app.try_state::<AppState>() {
        app_state.services.update(id, state, pid, message);
    }
    emit_services(app);
}

fn taskkill_tree(pid: u32) {
    // 输出丢弃而不是继承：taskkill 的提示是 CP936 的（L5 顺带发现），继承到父进程控制台
    // 会以 UTF-8 解读成乱码；而这段文字对用户没有任何价值（成功与否由状态机与 PID 探针判定）。
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags_no_window()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 只用于隐藏 taskkill 的控制台窗口（不改变进程创建语义）
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use crate::win32::CREATE_NO_WINDOW;
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

pub fn stop_tree(app: &AppHandle, service_id: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let tab = session_id(service_id);
    let mut pids: Vec<u32> = Vec::new();
    if let Some(pid) = state.pty.pid(tab) {
        pids.push(pid);
    }
    if let Some(pid) = state.services.pid_of(service_id) {
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    for pid in pids {
        taskkill_tree(pid);
    }
    state.pty.remove(tab);
}

/* ------------------------------ 启动 ------------------------------ */

pub async fn start_service(app: &AppHandle, service_id: &str) -> Result<Value, String> {
    match service_id {
        MAIN_SERVER => start_main_server(app).await,
        MARKET_SERVER => start_market_server(app).await,
        CLIENT => start_client(app, None).await,
        other => Err(format!("未知服务: {other}")),
    }
}

/* ------------------------------ 启动预算 ------------------------------ */

/// 主服务器启动的基价（现役版 Electron 给的就是 60s）
const MAIN_START_BASE_MS: u64 = 60_000;
/// 每个模组 loader 追加的预算：NODE_OPTIONS 里每个 `--require` 都是一次真实读盘 + 编译 + 执行
const MAIN_START_PER_LOADER_MS: u64 = 3_000;
/// 启动预算的硬上限：模组再多也不能无限等
const MAIN_START_MAX_MS: u64 = 180_000;
/// 启动进度的回写间隔（状态文案里的秒数靠它走字）
const START_PROGRESS_STEP_MS: u64 = 5_000;

/// 主服务器启动预算：60s 基价 + 每个模组 loader 3s，封顶 180s。
///
/// 为什么按 loader 数放大：20 个模组的 NODE_OPTIONS 就是 20 条 `--require`，
/// node 启动时要逐个读盘、编译、执行；写死 30s（现役版是 60s）在慢盘上会把
/// 「还在加载」误判成「启动超时」，然后把已经起来的服务杀掉。
fn main_start_budget_ms(loader_count: usize) -> u64 {
    MAIN_START_BASE_MS
        .saturating_add(MAIN_START_PER_LOADER_MS.saturating_mul(loader_count as u64))
        .min(MAIN_START_MAX_MS)
}

/// 启动中的状态文案，如 `启动中 45s / 120s · 正在加载 20 个模组…`。
///
/// 超预算之后换成「已超出预算 · 仍在等待端口」：进程还活着，只是慢，
/// 文案不能带失败口吻（此刻界面仍然是「启动中」）。
fn start_progress_message(
    elapsed_ms: u64,
    budget_ms: u64,
    loader_count: usize,
    over_budget: bool,
) -> String {
    let seconds = elapsed_ms / 1000;
    let budget = budget_ms / 1000;
    let loading = if loader_count > 0 {
        format!("正在加载 {loader_count} 个模组")
    } else {
        "正在启动服务端".to_string()
    };
    if over_budget {
        format!("启动中 {seconds}s · {loading} · 已超出 {budget}s 预算，仍在等待端口…")
    } else {
        format!("启动中 {seconds}s / {budget}s · {loading}…")
    }
}

/// 这次启动是否还归我们管：用户点了停止、或别的路径已经判过失败时，别再覆盖状态
fn is_starting(app: &AppHandle, service_id: &str) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.services.state_of(service_id) == "starting")
        .unwrap_or(false)
}

/// 这次启动的结局是否还该由我们写。
///
/// 与 [`is_starting`] 的区别：`error` 也算「归我们」—— 进程退出时 `on_pty_exit`
/// （pty 退出线程）几乎总会抢先写下「异常退出（exit N）」，我们要用它更完整的
/// 退出码 + 日志末尾覆盖它；只有用户点停止（stopping / idle）才不该再插嘴。
fn start_outcome_owned(app: &AppHandle, service_id: &str) -> bool {
    match app.try_state::<AppState>() {
        Some(state) => matches!(
            state.services.state_of(service_id).as_str(),
            "starting" | "error"
        ),
        None => false,
    }
}

/// 「进程已退出」的出错前缀：带上 PTY 侧记到的退出码（拿不到就只报 PID）
fn exited_head(app: &AppHandle, service_id: &str, name: &str, pid: u32) -> String {
    let code = app
        .try_state::<AppState>()
        .and_then(|state| state.pty.last_exit_code(session_id(service_id)));
    match code {
        Some(code) => format!("{name}进程已退出（exit {code}）"),
        None => format!("{name}进程已退出（PID {pid}）"),
    }
}

/// 主服务器的失败原因：退出码 + 服务端日志末几行（node 的报错通常只留在这一份日志里）
fn main_server_exit_reason(app: &AppHandle, pid: u32, root: &Path) -> String {
    let head = exited_head(app, MAIN_SERVER, "主服务器", pid);
    let tail = server_log_tail(root, 3);
    if tail.is_empty() {
        head
    } else {
        format!("{head}，日志末尾：{}", tail.join(" | "))
    }
}

/// 服务端日志的末几行（复用 log:read 的候选路径解析；读不到就返回空，不编内容）
fn server_log_tail(root: &Path, count: usize) -> Vec<String> {
    let value = crate::log::read_server_log(root);
    let lines: Vec<String> = value
        .get("lines")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(shorten_line)
                .collect()
        })
        .unwrap_or_default();
    let start = lines.len().saturating_sub(count);
    lines[start..].to_vec()
}

/// 单行日志压到能塞进错误文案的长度（toast 装不下整段堆栈）
fn shorten_line(line: &str) -> String {
    const MAX_CHARS: usize = 160;
    if line.chars().count() <= MAX_CHARS {
        line.to_string()
    } else {
        line.chars().take(MAX_CHARS).collect::<String>() + "…"
    }
}

/// 等主服务器端口就绪，每 [`START_PROGRESS_STEP_MS`] 回写一次进度。
///
/// 预算用尽但进程还活着 → 转成无限等（`over_budget`）：**到点不杀**。
/// 慢不是坏，服务真起来了就该让它跑完；只有进程退出才立刻失败。
async fn await_main_server_ready(
    app: &AppHandle,
    pid: u32,
    budget_ms: u64,
    loader_count: usize,
) -> health::PortWait {
    let started = std::time::Instant::now();
    let mut over_budget = false;
    loop {
        let elapsed = started.elapsed().as_millis() as u64;
        if is_starting(app, MAIN_SERVER) {
            set_state(
                app,
                MAIN_SERVER,
                "starting",
                Some(pid),
                Some(start_progress_message(
                    elapsed,
                    budget_ms,
                    loader_count,
                    over_budget,
                )),
            );
        }
        let slice = if over_budget {
            START_PROGRESS_STEP_MS
        } else {
            budget_ms
                .saturating_sub(elapsed)
                .clamp(1, START_PROGRESS_STEP_MS)
        };
        let outcome = health::wait_port_until(crate::config::DEFAULT_GAME_PORT, slice, 500, || {
            crate::win32::alive(pid)
        })
        .await;
        match outcome {
            health::PortWait::Ready | health::PortWait::Exited => return outcome,
            health::PortWait::Timeout if !over_budget && elapsed + slice >= budget_ms => {
                over_budget = true;
            }
            health::PortWait::Timeout => {}
        }
    }
}

/// 预算用完还在等（进程活着）时的兜底：留一个后台任务继续探端口。
///
/// 仪表盘本来就 2s 轮询 health:check，但那只决定卡片颜色；这里负责把状态从
/// starting 推到 running / error —— 进程真起来了就收尾，真死了才把原因写清楚。
fn spawn_main_server_watch(
    app: &AppHandle,
    pid: u32,
    root: PathBuf,
    budget_ms: u64,
    loader_count: usize,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            if !is_starting(&app, MAIN_SERVER) {
                return;
            }
            let elapsed = budget_ms + started.elapsed().as_millis() as u64;
            set_state(
                &app,
                MAIN_SERVER,
                "starting",
                Some(pid),
                Some(start_progress_message(
                    elapsed,
                    budget_ms,
                    loader_count,
                    true,
                )),
            );
            match health::wait_port_until(
                crate::config::DEFAULT_GAME_PORT,
                START_PROGRESS_STEP_MS,
                500,
                || crate::win32::alive(pid),
            )
            .await
            {
                health::PortWait::Ready => {
                    if is_starting(&app, MAIN_SERVER) {
                        set_state(
                            &app,
                            MAIN_SERVER,
                            "running",
                            Some(pid),
                            Some(format!("运行中（PID {pid}）")),
                        );
                    }
                    return;
                }
                health::PortWait::Exited => {
                    if start_outcome_owned(&app, MAIN_SERVER) {
                        let reason = main_server_exit_reason(&app, pid, &root);
                        set_state(&app, MAIN_SERVER, "error", None, Some(reason));
                    }
                    return;
                }
                health::PortWait::Timeout => {}
            }
        }
    });
}

async fn start_main_server(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let root = state.repo_root();
    let server_dir = root.join("server");

    // 端口取 config 里的单一声明（现役版这几处都是字面量 26000）
    let port = crate::config::DEFAULT_GAME_PORT;
    if health::tcp_alive(port).await {
        set_state(
            app,
            MAIN_SERVER,
            "running",
            None,
            Some(format!("端口 {port} 已监听（外部已启动）")),
        );
        return Ok(json!({ "ok": true, "reason": "already-running" }));
    }
    if !server_dir.join("autostart.js").exists() && !server_dir.join("package.json").exists() {
        let message = format!("服务端目录不完整：{}", server_dir.to_string_lossy());
        set_state(app, MAIN_SERVER, "error", None, Some(message.clone()));
        return Err(message);
    }

    let db_root = root.join("_local").join("gameStore");
    let mut env_vars = vec![
        (
            "EVEJS_LOCAL_DATABASE_ROOT".to_string(),
            db_root.to_string_lossy().to_string(),
        ),
        (
            "EVEJS_GAMESTORE_DATA_DIR".to_string(),
            db_root.join("data").to_string_lossy().to_string(),
        ),
        ("EVEJS_PROXY_LOCAL_INTERCEPT".to_string(), "1".to_string()),
    ];
    // 模组 loader：通过 NODE_OPTIONS=--require 注入，服务端文件零改动。
    // 注意 NODE_OPTIONS 的解析规则：反斜杠会被当转义符吃掉，且按空格分词，
    // 所以路径必须转成正斜杠并加双引号（已实测验证；plan_loaders 保证斜杠方向）。
    // 注入个数同时决定启动预算：每个 loader 都要读盘 + 编译 + 执行。
    let loader = mods_loader_injection(&root, &state.runtime);
    if let Some(options) = &loader.node_options {
        env_vars.push(("NODE_OPTIONS".to_string(), options.clone()));
    }
    // 静态数据热重载 host：请求目录交给注入进去的 host.js（它自己从 boot.json 认本轮启动）
    if loader.hotreload {
        env_vars.push((
            "EVEJS_HOTRELOAD_DIR".to_string(),
            crate::hotreload::env_dir(&state.runtime),
        ));
    }
    // 方案 D：清单与报告都走文件；`EVEJS_MODS_ROOT` 让总线把相对 target 解析到仓库根
    if let Some(plan_file) = &loader.plan_file {
        let _ = std::fs::create_dir_all(&state.runtime.logs);
        env_vars.push((
            "EVEJS_MODS_PLAN".to_string(),
            plan_file.to_string_lossy().to_string(),
        ));
        env_vars.push((
            "EVEJS_MODS_ROOT".to_string(),
            root.to_string_lossy().to_string(),
        ));
        env_vars.push((
            "EVEJS_MODS_REPORT".to_string(),
            state
                .runtime
                .logs
                .join(MOD_REPORT_FILE)
                .to_string_lossy()
                .to_string(),
        ));
    }

    set_state(
        app,
        MAIN_SERVER,
        "starting",
        None,
        Some("启动 npm start（server/）…".to_string()),
    );
    let pid = state.pty.spawn(
        app,
        session_id(MAIN_SERVER),
        PtySpec::new("cmd.exe", &server_dir)
            .args(vec!["/c".to_string(), "npm start".to_string()])
            .env(env_vars),
    )?;

    let budget_ms = main_start_budget_ms(loader.count);
    let outcome = await_main_server_ready(app, pid, budget_ms, loader.count).await;
    match outcome {
        health::PortWait::Ready if is_starting(app, MAIN_SERVER) => {
            set_state(
                app,
                MAIN_SERVER,
                "running",
                Some(pid),
                Some(format!("运行中（PID {pid}）")),
            );
            Ok(json!({ "ok": true, "reason": "ok", "pid": pid }))
        }
        health::PortWait::Exited if start_outcome_owned(app, MAIN_SERVER) => {
            let reason = main_server_exit_reason(app, pid, &root);
            set_state(app, MAIN_SERVER, "error", None, Some(reason.clone()));
            Err(reason)
        }
        health::PortWait::Timeout => {
            // 慢 ≠ 坏：预算用尽但进程还活着，不杀也不报错，交后台继续等端口
            set_state(
                app,
                MAIN_SERVER,
                "starting",
                Some(pid),
                Some(start_progress_message(
                    budget_ms,
                    budget_ms,
                    loader.count,
                    true,
                )),
            );
            spawn_main_server_watch(app, pid, root.clone(), budget_ms, loader.count);
            Ok(json!({ "ok": true, "reason": "still-starting", "pid": pid }))
        }
        // Ready / Exited 但状态已被别的路径（用户点停止）改掉：不覆盖，也不算失败
        _ => Ok(json!({ "ok": true, "reason": "state-changed", "pid": pid })),
    }
}

/// PTY 会话退出 → 崩溃 / 退出处理（对齐现役版 `pty.onExit(...)` 注册的回调）。
///
/// 只在「本以为它在运行」时判崩溃：手动停止会先把状态置成 `stopping`，
/// 启动失败另有自己的错误路径，都不该被这里覆盖成「异常退出」。
pub fn on_pty_exit(app: &AppHandle, tab_id: &str, code: i64) {
    let (service_id, message) = match tab_id {
        "mainServer" => (MAIN_SERVER, format!("主服务器异常退出（exit {code}）")),
        "market" => (MARKET_SERVER, format!("市场服务异常退出（exit {code}）")),
        "client" => (CLIENT, format!("客户端已退出（exit {code}）")),
        _ => return,
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let current = state.services.state_of(service_id);
    if current == "running" || current == "starting" {
        // pid 传 None：update 会在 error 状态下清掉它（等价现役版 `r.ownedPid = undefined`）
        set_state(app, service_id, "error", None, Some(message));
    }
}
/// 模组 loader 的注入结果。
///
/// 为什么要连着个数一起给：启动预算按 loader 数放大（见 [`main_start_budget_ms`]），
/// 而 `plan_loaders` 已经算过一遍了，再读一次盘纯属浪费。
struct LoaderInjection {
    /// 要注入的 `NODE_OPTIONS`（没有模组时为 None）
    node_options: Option<String>,
    /// 实际注入的 loader 个数
    count: usize,
    /// 模组清单文件（`EVEJS_MODS_PLAN`）。
    /// 只有走方案 D 的总线注入时才有；退回「每个 loader 一条 --require」时是 None。
    plan_file: Option<PathBuf>,
    /// 这一轮有没有把静态数据热重载 host 注进去（决定要不要给 EVEJS_HOTRELOAD_DIR）
    hotreload: bool,
}

/// 启动器自带的注入总线（方案 D）：独占唯一的 `Module.prototype._compile` 钩子，
/// 模组改成向 `globalThis.__evejsMods` 声明「改哪个文件、加什么」，不再各自挂钩子。
/// 源文件在编译期嵌进二进制，随包分发，不落在模组目录里。
pub(crate) const MOD_HOST_JS: &str = include_str!("mods/mod_host.js");
/// 总线与清单落在 `_launcher/mods/` 下的文件名
const MOD_HOST_FILE: &str = "mod-host.js";
const MOD_PLAN_FILE: &str = "mod-plan.json";
/// 总线写出的加载报告（落在 `_launcher/logs/`）
pub const MOD_REPORT_FILE: &str = "mod-load-report.json";

/// 把「注入总线」与「模组清单」写进 `_launcher/mods/`，返回 `(host, 清单)`。
///
/// 清单走文件而不是 `NODE_OPTIONS`：那边的分词/转义规则连中文目录名都过不去
/// （模组目录叫「自动挖矿」时 `--require` 直接失效），70 个模组还会变成 70 条 `--require`。
fn write_mod_bus(
    root: &Path,
    runtime: &crate::runtime::RuntimePaths,
    paths: &[String],
) -> std::io::Result<(PathBuf, PathBuf)> {
    let dir = runtime.root.join("mods");
    std::fs::create_dir_all(&dir)?;
    let host = dir.join(MOD_HOST_FILE);
    std::fs::write(&host, MOD_HOST_JS)?;
    let plan = dir.join(MOD_PLAN_FILE);
    let payload = json!({
        "schemaVersion": 1,
        "api": 1,
        "root": root.to_string_lossy().replace('\\', "/"),
        "loaders": paths,
        "generatedAt": crate::mods::pkg::epoch_ms() as u64,
    });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
    std::fs::write(&plan, format!("{text}\n"))?;
    Ok((host, plan))
}

/// `--require "<路径>"`：NODE_OPTIONS 按空格分词、且把反斜杠当转义符吃掉，
/// 所以路径必须转成正斜杠并加双引号（已实测）。
fn require_arg(path: &Path) -> String {
    format!("--require \"{}\"", path.to_string_lossy().replace('\\', "/"))
}

/// 计算要注入主服务器的 `NODE_OPTIONS`，一共两条：
///   1. 模组注入总线（方案 D）：有模组时写 `_launcher/mods/mod-host.js`，清单交给 `EVEJS_MODS_PLAN`；
///      写盘失败退回「每个 loader 一条 `--require`」的老写法 —— 注入不能因为临时目录
///      写不进去就整个失效。
///   2. 静态数据热重载 host（[`crate::hotreload`]）：与模组无关，零模组时也要注入，
///      否则「改 JSON 不重启」这个功能在干净服务端上直接不可用。顺序必须在总线之后：
///      总线要独占 `Module.prototype._compile` 钩子。
///
/// 两条都装不上时 `node_options` 是 None（老行为：不设 NODE_OPTIONS）。
///
/// 现役版还会把「注入了几个 loader / 跳过了哪个模组」写进启动器日志，
/// Rust 侧暂时只做注入（没有启动器日志写入通道），跳过理由仍可从 `mods:plan` 读到。
fn mods_loader_injection(root: &Path, runtime: &crate::runtime::RuntimePaths) -> LoaderInjection {
    let plan = crate::mods::plan::plan_loaders(root, runtime);
    let paths: Vec<String> = plan
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let inherited = std::env::var("NODE_OPTIONS").unwrap_or_default();
    let join = |args: &str| {
        [inherited.as_str(), args]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut args: Vec<String> = Vec::new();
    let mut plan_file = None;
    if !paths.is_empty() {
        match write_mod_bus(root, runtime, &paths) {
            Ok((host, written_plan)) => {
                args.push(require_arg(&host));
                plan_file = Some(written_plan);
            }
            Err(_) => {
                for path in &paths {
                    args.push(format!("--require \"{path}\""));
                }
            }
        }
    }
    let hotreload_arg = crate::hotreload::prepare(runtime, root);
    let hotreload = hotreload_arg.is_some();
    if let Some(arg) = hotreload_arg {
        args.push(arg);
    }
    let node_options = if args.is_empty() {
        None
    } else {
        Some(join(&args.join(" ")))
    };
    LoaderInjection {
        node_options,
        count: paths.len(),
        plan_file,
        hotreload,
    }
}
async fn start_market_server(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let root = state.repo_root();

    let port = crate::config::DEFAULT_MARKET_PORT;
    if health::tcp_alive(port).await {
        set_state(
            app,
            MARKET_SERVER,
            "running",
            None,
            Some(format!("端口 {port} 已监听（外部已启动）")),
        );
        return Ok(json!({ "ok": true, "reason": "already-running" }));
    }

    let exe = env::market_binary(&root);
    if !exe.is_file() {
        let message = "release 二进制缺失，请先构建（cargo build --release）".to_string();
        set_state(app, MARKET_SERVER, "error", None, Some(message.clone()));
        return Err(message);
    }

    set_state(
        app,
        MARKET_SERVER,
        "starting",
        None,
        Some("启动 market-server.exe …".to_string()),
    );
    let market_dir = env::market_working_dir(&root);
    let pid = state.pty.spawn(
        app,
        session_id(MARKET_SERVER),
        PtySpec::new(&exe.to_string_lossy(), &market_dir),
    )?;
    set_state(
        app,
        MARKET_SERVER,
        "starting",
        Some(pid),
        Some(format!("已启动（PID {pid}），等待 {port} 端口…")),
    );

    // 市场服务是独立 exe，30s 够它监听（现役版也是 30s）；这里多的是「早死早报」：
    // 进程退出就立刻失败，不再空等满 30s 才说一句笼统的「启动超时」。
    let outcome = health::wait_port_until(port, 30_000, 500, || crate::win32::alive(pid)).await;
    if outcome == health::PortWait::Ready {
        set_state(
            app,
            MARKET_SERVER,
            "running",
            Some(pid),
            Some(format!("运行中（PID {pid}）")),
        );
        Ok(json!({ "ok": true, "reason": "ok", "pid": pid }))
    } else {
        // 先取退出码再收树：stop_tree 会顺手清掉 PTY 里记的那一份
        let message = if outcome == health::PortWait::Exited {
            exited_head(app, MARKET_SERVER, "市场服务", pid)
        } else {
            format!("启动超时：{port} 未在 30s 内监听")
        };
        stop_tree(app, MARKET_SERVER);
        set_state(app, MARKET_SERVER, "error", None, Some(message.clone()));
        Err(message)
    }
}

/// 停止服务：对齐现役版 stopService —— 先向 PTY 发 Ctrl+C 优雅退出，
/// 等 3s 仍存活则 `taskkill /T /F` 收尾；外部启动的进程不接管。
pub async fn stop_service(app: &AppHandle, service_id: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let id = match service_id {
        MAIN_SERVER | MARKET_SERVER | CLIENT => service_id,
        other => return Err(format!("未知服务: {other}")),
    };
    let name = match id {
        MAIN_SERVER => "主服务器",
        MARKET_SERVER => "市场服务",
        _ => "游戏客户端",
    };

    let current = state.services.state_of(id);
    if current == "idle" {
        return Ok(json!({ "ok": true, "reason": format!("{name} 未运行") }));
    }
    if current == "stopping" {
        return Ok(json!({ "ok": true, "reason": format!("{name} 正在停止") }));
    }

    // 外部启动的进程（没有 PID 记录）：只改状态，不越权杀
    let owned = state.pty.pid(session_id(id)).is_some() || state.services.pid_of(id).is_some();
    if !owned && (current == "running" || current == "starting") {
        set_state(
            app,
            id,
            "idle",
            None,
            Some("外部进程，未接管停止".to_string()),
        );
        return Ok(json!({ "ok": true, "reason": "external, not owned" }));
    }

    set_state(app, id, "stopping", None, Some("正在停止…".to_string()));
    if id != CLIENT {
        let _ = state
            .pty
            .write(session_id(id), crate::pty::TerminalInput::new("\u{3}"));
        tokio::time::sleep(std::time::Duration::from_millis(3_000)).await;
    }
    stop_tree(app, id);
    set_state(app, id, "idle", None, Some("已停止".to_string()));
    Ok(json!({ "ok": true, "reason": "已停止" }))
}

pub async fn restart_service(app: &AppHandle, service_id: &str) -> Result<Value, String> {
    stop_service(app, service_id).await?;
    start_service(app, service_id).await
}

/// 一键启动：主服务器失败即中止；市场服务受设置项 startMarket 控制（对齐现役版 engageStart）
pub async fn engage_start(app: &AppHandle) -> Value {
    let settings = read_setting_bool(app, "startMarket", true);
    let main = action_of(start_service(app, MAIN_SERVER).await);
    if main["ok"] != json!(true) {
        return main;
    }
    if settings {
        let _ = start_service(app, MARKET_SERVER).await;
    } else {
        set_state(
            app,
            MARKET_SERVER,
            "idle",
            None,
            Some("已跳过（启动选项关闭）".to_string()),
        );
    }
    set_state(
        app,
        CLIENT,
        "idle",
        None,
        Some("客户端由登录入口单独启动".to_string()),
    );
    json!({ "ok": true, "reason": "启动序列完成" })
}

pub async fn engage_stop(app: &AppHandle) -> Value {
    let results = tokio::join!(
        stop_service(app, MAIN_SERVER),
        stop_service(app, MARKET_SERVER),
        stop_service(app, CLIENT)
    );
    for result in [results.0, results.1, results.2] {
        if let Err(reason) = result {
            return json!({ "ok": false, "reason": reason });
        }
    }
    json!({ "ok": true, "reason": "已全部停止" })
}

/// 现役版失败时返回 ServiceActionResult 而不是抛异常
fn action_of(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => value,
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// 读取启动器设置里的布尔项（settings:set 写入 launcher-settings.json）
fn read_setting_bool(app: &AppHandle, key: &str, fallback: bool) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return fallback;
    };
    crate::config::read_settings(&state.runtime.settings_file())
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(fallback)
}

/* ------------------------------ 客户端直连启动 ------------------------------ */

/// 客户端自动登录参数（对齐现役版 `ClientLoginOpts`）
#[derive(Debug, Clone, Default)]
pub struct ClientLogin {
    pub user: String,
    pub password: String,
    /// 目标角色 ID（客户端 `/autoSelectCharacter:` 参数，直达该角色）
    pub character_id: Option<String>,
}

/// 客户端早期崩溃观察窗口（现役版同款 6000ms）
const CLIENT_WATCH_MS: u64 = 6_000;
/// 客户端输出日志目录名（现役版 launcherRuntimeRoot()/logs/client）
const CLIENT_LOG_SUBDIR: &str = "client";
fn is_switch_on(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// tq 同级的 ResFiles 资源缓存目录（等价 Play.bat 的 :ResolveClientResourceCache）
fn resolve_client_res_files(client_path: &str) -> Option<String> {
    let parent = Path::new(client_path).parent()?;
    let res_files = parent.join("ResFiles");
    res_files
        .exists()
        .then(|| res_files.to_string_lossy().to_string())
}

/// 复刻 Play.bat 的 :ApplyClientNetworkPolicy（代理 / Darkly 屏蔽 / Sentry 关闭 / 本地 CA）
fn apply_client_network_policy(env: &mut BTreeMap<String, String>, proxy_url: &str, ca_pem: &str) {
    let trimmed = proxy_url.trim();
    let proxy = if trimmed.is_empty() {
        "http://127.0.0.1:26002/".to_string()
    } else {
        trimmed.to_string()
    };
    const DARKLY: [&str; 12] = [
        "launchdarkly.com",
        ".launchdarkly.com",
        "clientstream.launchdarkly.com",
        "events.launchdarkly.com",
        "mobile.launchdarkly.com",
        "app.launchdarkly.com",
        "sdk.launchdarkly.com",
        "stream.launchdarkly.com",
        "launchdarkly.us",
        ".launchdarkly.us",
        "launchdarkly.eu",
        ".launchdarkly.eu",
    ];
    const BLOCKED_PREFIX: &str =
        "api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com,";

    let mut blocked = String::from(BLOCKED_PREFIX);
    blocked.push_str(&DARKLY.join(","));

    env.insert("EVEJS_PROXY_URL".to_string(), proxy.clone());
    env.insert("EVEJS_PROXY_LOCAL_INTERCEPT".to_string(), "1".to_string());
    env.insert(
        "EVEJS_PROXY_UNHANDLED_HOST_POLICY".to_string(),
        "block".to_string(),
    );
    env.insert("EVEJS_PROXY_BLOCKED_HOSTS".to_string(), blocked);
    for key in [
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ] {
        env.insert(key.to_string(), proxy.clone());
    }
    let no_proxy = "127.0.0.1,localhost,::1";
    env.insert("EVEJS_NO_PROXY".to_string(), no_proxy.to_string());
    env.insert("no_proxy".to_string(), no_proxy.to_string());
    env.insert("NO_PROXY".to_string(), no_proxy.to_string());
    env.insert("EVE_CLIENT_SENTRY_DSN".to_string(), String::new());
    env.insert("SSL_CERT_DIR".to_string(), String::new());
    env.insert("LD_OFFLINE".to_string(), "true".to_string());
    env.insert("LAUNCHDARKLY_OFFLINE".to_string(), "true".to_string());
    env.insert("LAUNCHDARKLY_SEND_EVENTS".to_string(), "false".to_string());
    env.insert("LD_SEND_EVENTS".to_string(), "false".to_string());
    if !ca_pem.trim().is_empty() && Path::new(ca_pem).is_file() {
        env.insert("SSL_CERT_FILE".to_string(), ca_pem.to_string());
        env.insert("REQUESTS_CA_BUNDLE".to_string(), ca_pem.to_string());
        env.insert("CURL_CA_BUNDLE".to_string(), ca_pem.to_string());
    }
}

/// 跑 ClientSETUP 的 PowerShell 脚本（隐藏窗口、120s 超时、失败只取首行）
async fn run_client_setup_script(
    script: &Path,
    args: Vec<String>,
    extra_env: Vec<(String, String)>,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match tokio::time::timeout(std::time::Duration::from_secs(120), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let text = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            Err(crate::sidecar::first_line(&text))
        }
        Ok(Err(err)) => Err(crate::sidecar::first_line(&err.to_string())),
        Err(_) => Err("脚本执行超时（120s）".to_string()),
    }
}

/// Play.bat 每次启动都会跑 Install-EvEJSCerts.ps1；直连客户端时自己补上（失败不阻塞）
async fn prepare_client_certificate_trust(root: &Path, client_path: &str) {
    let script = root
        .join("tools")
        .join("ClientSETUP")
        .join("scripts")
        .join("Install-EvEJSCerts.ps1");
    if !script.is_file() {
        return;
    }
    let _ = run_client_setup_script(
        &script,
        vec!["-ClientPath".to_string(), client_path.to_string()],
        Vec::new(),
    )
    .await;
}

/// 启动前按配置决定是否重置显示设置（开关默认 off，此时完全不启动 PowerShell）
async fn prepare_client_display_safety(root: &Path, client: &crate::config::ClientConfig) {
    let safe_windowed = if client.safe_windowed.is_empty() {
        "off".to_string()
    } else {
        client.safe_windowed.clone()
    };
    let safe_graphics = if client.safe_graphics.is_empty() {
        "off".to_string()
    } else {
        client.safe_graphics.clone()
    };
    let script = root
        .join("tools")
        .join("ClientSETUP")
        .join("scripts")
        .join("PrepareClientSettings.ps1");
    for (mode, switch) in [("Display", &safe_windowed), ("Graphics", &safe_graphics)] {
        if !is_switch_on(switch) {
            continue;
        }
        let _ = run_client_setup_script(
            &script,
            vec!["-Mode".to_string(), mode.to_string()],
            vec![
                ("EVEJS_CLIENT_PATH".to_string(), client.client_path.clone()),
                (
                    "EVEJS_CLIENT_SAFE_WINDOWED".to_string(),
                    safe_windowed.clone(),
                ),
                (
                    "EVEJS_CLIENT_SAFE_GRAPHICS".to_string(),
                    safe_graphics.clone(),
                ),
            ],
        )
        .await;
    }
}

/// 客户端 stdout/stderr 由 `/stdout=` `/stderr=` 落盘，再增量喂给终端页签
/// （现役版 startClientLogTail：350ms 轮询，按整行推送，单块上限 64 KB）
fn start_client_log_tail(app: &AppHandle, file: PathBuf, tab: &str, stop: Arc<AtomicBool>) {
    let app = app.clone();
    let tab = tab.to_string();
    std::thread::spawn(move || {
        let mut offset: u64 = 0;
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let stopping = stop.load(Ordering::Relaxed);
            pump_client_log(&app, &file, &tab, &mut offset, &mut pending);
            if stopping {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(350));
        }
    });
}

fn pump_client_log(
    app: &AppHandle,
    file: &Path,
    tab: &str,
    offset: &mut u64,
    pending: &mut Vec<u8>,
) {
    let Ok(meta) = std::fs::metadata(file) else {
        return;
    };
    let size = meta.len();
    if size <= *offset {
        return;
    }
    let Ok(mut handle) = std::fs::File::open(file) else {
        return;
    };
    if handle.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut chunk = Vec::new();
    if handle.take(size - *offset).read_to_end(&mut chunk).is_err() {
        return;
    }
    *offset += chunk.len() as u64;
    pending.extend_from_slice(&chunk);
    match pending.iter().rposition(|byte| *byte == b'\n') {
        Some(index) => {
            let text = String::from_utf8_lossy(&pending[..=index]).to_string();
            pending.drain(..=index);
            let _ = app.emit("terminal:data", json!([tab, text]));
        }
        None if pending.len() >= 65_536 => {
            let text = String::from_utf8_lossy(pending).to_string();
            pending.clear();
            let _ = app.emit("terminal:data", json!([tab, text]));
        }
        None => {}
    }
}

/// 当前时间（毫秒时间戳）：服务运行时长的起点用
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// ISO8601 UTC 时间戳（毫秒精度，对齐现役版 `new Date().toISOString()`）
pub(crate) fn iso_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        now.subsec_millis()
    )
}

/// 文件名安全版 ISO 时间戳（把 `:` 和 `.` 换成 `-`）
fn iso_log_stamp() -> String {
    iso_timestamp().replace([':', '.'], "-")
}

/// 天数 → (年, 月, 日)（Howard Hinnant 的 civil_from_days，避免为一行时间戳引入 chrono）
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let doe = (shifted - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 客户端直连启动（对齐现役版 startClient）：/noconsole + /login: + /autoSelectCharacter: + /port:
pub async fn start_client(app: &AppHandle, login: Option<ClientLogin>) -> Result<Value, String> {
    let Some((root, logs_dir)) = app
        .try_state::<AppState>()
        .map(|state| (state.repo_root(), state.runtime.logs.clone()))
    else {
        return Err("应用状态不可用".to_string());
    };

    let client = crate::config::read_client_config(&root);
    if client.client_path.trim().is_empty() || !Path::new(&client.client_path).exists() {
        let message = "客户端路径无效，请先在配置面板设置".to_string();
        set_state(app, CLIENT, "error", None, Some(message));
        return Err("客户端路径无效".to_string());
    }

    let client_dir = Path::new(&client.client_path);
    let bin64 = client_dir.join("bin64").join("exefile.exe");
    let bin = client_dir.join("bin").join("exefile.exe");
    let exe = if !client.client_exe.trim().is_empty() && Path::new(&client.client_exe).is_file() {
        PathBuf::from(client.client_exe.trim())
    } else if bin64.is_file() {
        bin64
    } else {
        bin
    };
    if !exe.is_file() {
        let shown = exe.to_string_lossy().to_string();
        set_state(
            app,
            CLIENT,
            "error",
            None,
            Some(format!("客户端程序不存在：{shown}")),
        );
        return Err(format!("exefile 不存在：{shown}"));
    }

    /* ---- 自动登录参数（V1 同款三件套） ---- */
    let login = login.unwrap_or_default();
    let account = login.user.trim().to_string();
    let password = login.password;
    let character_id = login.character_id.unwrap_or_default().trim().to_string();
    let mut args: Vec<String> = vec!["/noconsole".to_string()];
    if password.contains(':') {
        set_state(
            app,
            CLIENT,
            "error",
            None,
            Some("自动登录失败：密码不能包含冒号（客户端 /login: 参数限制）".to_string()),
        );
        return Err("密码不能包含冒号".to_string());
    }
    if !account.is_empty() && !password.is_empty() {
        args.push(format!("/login:{account}:{password}"));
    }
    let character_ok = !character_id.is_empty()
        && character_id.chars().all(|ch| ch.is_ascii_digit())
        && character_id.parse::<u64>().unwrap_or(0) > 0;
    if character_ok {
        args.push(format!(
            "/autoSelectCharacter:{}",
            character_id.parse::<u64>().unwrap_or(0)
        ));
    }

    /* ---- 游戏端口 ---- */
    let configured_port = crate::config::read_server_config(&root).ports.game;
    let game_port = if configured_port > 0 {
        configured_port
    } else {
        26000
    };
    args.push(format!("/port:{game_port}"));

    /* ---- 客户端输出落盘到 _launcher/logs/client（目录与文件名全部 ASCII） ---- */
    let client_log_dir = logs_dir.join(CLIENT_LOG_SUBDIR);
    let _ = std::fs::create_dir_all(&client_log_dir);
    let stamp = iso_log_stamp();
    let pid_hint = std::process::id();
    let stdout_log = client_log_dir.join(format!("client-{stamp}-{pid_hint}.out.log"));
    let stderr_log = client_log_dir.join(format!("client-{stamp}-{pid_hint}.err.log"));
    args.push(format!("/stdout={}", stdout_log.to_string_lossy()));
    args.push(format!("/stderr={}", stderr_log.to_string_lossy()));

    /* ---- 环境（等价 Play.bat 的 ApplyClientNetworkPolicy + ResFiles） ---- */
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    apply_client_network_policy(&mut env, &client.proxy_url, &client.ca_pem);
    if let Some(res_files) = resolve_client_res_files(&client.client_path) {
        env.insert("EO_REMOTEFILECACHEFOLDER".to_string(), res_files);
    }

    await_client_prepare(&root, &client).await;

    let mut command = tokio::process::Command::new(&exe);
    command
        .args(&args)
        .current_dir(client_dir)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // 客户端 creationFlags：不分配控制台 + 独立进程组。绝不能叠加 windowsHide ——
    // Windows 会把 SW_HIDE 应用到 GUI 子系统的 exefile.exe 首次显示窗口上（B8 历史故障点）。
    #[cfg(windows)]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let reason = err.to_string();
            set_state(
                app,
                CLIENT,
                "error",
                None,
                Some(format!("客户端启动失败：{reason}")),
            );
            return Err(reason);
        }
    };
    let pid = child.id().unwrap_or(0);
    set_state(
        app,
        CLIENT,
        "starting",
        Some(pid),
        Some(format!("客户端启动中（PID {pid}）")),
    );

    let stop_flag = Arc::new(AtomicBool::new(false));
    start_client_log_tail(app, stdout_log, "client", stop_flag.clone());
    start_client_log_tail(app, stderr_log, "client", stop_flag.clone());

    let app_exit = app.clone();
    let stop_exit = stop_flag.clone();
    tauri::async_runtime::spawn(async move {
        let code = match child.wait().await {
            Ok(status) => status.code().map(i64::from).unwrap_or(-1),
            Err(_) => -1,
        };
        stop_exit.store(true, Ordering::Relaxed);
        let current = app_exit.state::<AppState>().services.state_of(CLIENT);
        if current == "running" || current == "starting" {
            set_state(
                &app_exit,
                CLIENT,
                "error",
                None,
                Some(format!("客户端已退出（exit {code}）")),
            );
        } else {
            app_exit.state::<AppState>().services.clear_pid(CLIENT);
            emit_services(&app_exit);
        }
    });

    /* 直连启动后短暂观察：早期崩溃（配置 / 证书 / 资源错误）立刻反馈给 UI */
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(CLIENT_WATCH_MS);
    while std::time::Instant::now() < deadline {
        let services = &app.state::<AppState>().services;
        if services.state_of(CLIENT) != "starting" {
            stop_flag.store(true, Ordering::Relaxed);
            let reason = services
                .message_of(CLIENT)
                .unwrap_or_else(|| "客户端已退出（exit ?）".to_string());
            return Err(reason);
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }

    set_state(
        app,
        CLIENT,
        "running",
        Some(pid),
        Some(format!("客户端已启动（PID {pid}）")),
    );
    Ok(json!({ "ok": true, "reason": "ok", "pid": pid }))
}

/// 启动前的证书信任 + 显示安全检查（都失败不阻塞启动）
async fn await_client_prepare(root: &Path, client: &crate::config::ClientConfig) {
    prepare_client_certificate_trust(root, &client.client_path).await;
    prepare_client_display_safety(root, client).await;
}

pub fn repo_root_of(app: &AppHandle) -> std::path::PathBuf {
    app.state::<AppState>().repo_root()
}

pub fn is_any_running(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .services
        .snapshot()
        .iter()
        .any(|info| info.state == "running" || info.state == "starting")
}

pub fn server_dir_of(root: &Path) -> std::path::PathBuf {
    root.join("server")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L6 进程树：停服必须把整棵树（含孙进程）一起收走，不能留孤儿。
    ///
    /// 为什么必须真起两级进程：现役版 killOwned 与本模块的 `taskkill /PID <pid> /T /F`
    /// 都是「按 PID 树」收，只有真拉起 `node → node` 才证明得了 `/T` 生效
    /// （只杀根 PID 的话孙进程会活下来，端口也就一直占着）。
    ///
    /// 默认 `#[ignore]`：真起两个 node 进程。跑法：
    ///   cargo test --lib -- --ignored --nocapture l6_process_tree
    ///   pwsh -File scripts/check-process-residue.ps1   （外加系统级残留断言与产物）
    #[test]
    #[ignore = "L6 进程树验收：真起 node 父子进程，需显式 --ignored 运行"]
    fn l6_stop_kills_whole_process_tree() {
        use crate::pty::{PtyManager, PtySpec};
        use crate::win32;
        use std::time::{Duration, Instant};

        let dir = std::env::temp_dir().join(format!("evejs-l6-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        let pid_file = dir.join("child.pid");
        let _ = std::fs::remove_file(&pid_file);

        // 父进程：拉一个孙进程（每秒空转）→ 把孙进程 PID 写盘 → 自己也不退出
        let script = format!(
            "const fs=require('fs');const {{spawn}}=require('child_process');\
             const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});\
             fs.writeFileSync({path},String(child.pid));\
             setInterval(()=>{{}},1000);",
            path = serde_json::to_string(&pid_file.to_string_lossy().to_string()).unwrap_or_default()
        );

        let pty = PtyManager::new();
        let root = pty
            .spawn_streaming(
                "l6-tree",
                PtySpec::new("node", &dir).args(vec!["-e".to_string(), script]),
                |_tab, _text| {},
                |_tab, _code| {},
            )
            .expect("启动 L6 父进程失败");

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut child_pid = 0u32;
        while Instant::now() < deadline && child_pid == 0 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                child_pid = text.trim().parse::<u32>().unwrap_or(0);
            }
            if child_pid == 0 {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        assert!(child_pid > 0, "20 s 内没等到孙进程 PID");
        assert!(win32::alive(root), "父进程应当活着");
        assert!(win32::alive(child_pid), "孙进程应当活着");
        let tree = win32::descendants(root);
        assert!(
            tree.iter().any(|entry| entry.pid == child_pid),
            "孙进程不在进程树里（快照口径可疑）：{tree:?}"
        );

        taskkill_tree(root);

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut leftover: Vec<win32::ProcessEntry> = win32::descendants(root)
            .into_iter()
            .filter(|entry| win32::alive(entry.pid))
            .collect();
        while !leftover.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
            leftover = win32::descendants(root)
                .into_iter()
                .filter(|entry| win32::alive(entry.pid))
                .collect();
        }
        println!(
            "[L6] 根 PID {root} · 孙进程 {child_pid} · 停后残留 {} 个（{}）",
            leftover.len(),
            leftover
                .iter()
                .map(|entry| format!("{}:{}", entry.name, entry.pid))
                .collect::<Vec<_>>()
                .join(", ")
        );
        assert!(leftover.is_empty(), "停服后仍有残留：{leftover:?}");
        assert!(!win32::alive(root), "根进程仍活着");
        assert!(!win32::alive(child_pid), "孙进程仍活着（/T 没生效）");
        pty.remove("l6-tree");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn log_stamp_is_filename_safe_iso8601() {
        let stamp = iso_log_stamp();
        assert!(stamp.ends_with('Z'), "时间戳应以 Z 结尾: {stamp}");
        assert!(
            !stamp.contains(':') && !stamp.contains('.'),
            "时间戳不能含 : 或 .（文件名非法字符）: {stamp}"
        );
        assert_eq!(stamp.len(), "2026-09-25T13-04-05-678Z".len(), "{stamp}");
    }

    #[test]
    fn switch_parser_matches_bat_convention() {
        for on in ["on", "ON", " 1 ", "true", "Yes"] {
            assert!(is_switch_on(on), "{on} 应视为开启");
        }
        for off in ["", "off", "0", "no", "disabled"] {
            assert!(!is_switch_on(off), "{off} 应视为关闭");
        }
    }

    /// 模组 loader 注入：路径必须是正斜杠 + 双引号（NODE_OPTIONS 会把反斜杠当转义吃掉）
    #[test]
    fn loader_injection_uses_forward_slashes_and_quotes_and_counts_loaders() {
        let root = std::env::temp_dir().join(format!("evejs-loader-env-{}", iso_log_stamp()));
        let repo = root.join("repo");
        let mods = repo.join("mods");
        let runtime = crate::runtime::RuntimePaths::from_root(root.join("_launcher"), false);
        std::fs::create_dir_all(&runtime.root).unwrap();
        std::fs::create_dir_all(&runtime.temp).unwrap();
        std::fs::create_dir_all(&runtime.cache).unwrap();

        std::fs::create_dir_all(&mods).unwrap();
        let empty = mods_loader_injection(&repo, &runtime);
        assert_eq!(empty.node_options, None, "没有模组时不应注入");
        assert_eq!(empty.count, 0, "没有模组时 loader 数为 0");

        let dir = mods.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("loader.js"), "require('./x.js')\n").unwrap();
        std::fs::write(
            dir.join("evejs-launcher.mod.json"),
            serde_json::to_string_pretty(&json!({
                "schemaVersion": 3,
                "id": "demo",
                "displayName": "示例",
                "version": "1.0.0",
                "kind": "loader",
                "restart": "game_server",
                "activation": { "strategy": "loader_rename" }
            }))
            .unwrap(),
        )
        .unwrap();

        let single = mods_loader_injection(&repo, &runtime);
        assert_eq!(single.count, 1, "注入个数要跟着 paths 走：预算靠它放大");
        let options = single.node_options.expect("应注入一个 loader");
        // 方案 D：NODE_OPTIONS 里只有启动器自带的总线一条，模组清单走文件
        assert!(options.contains("--require \""), "{options}");
        assert!(options.contains("/mods/mod-host.js\""), "{options}");
        assert!(
            !options.contains('\\'),
            "NODE_OPTIONS 里不能出现反斜杠：{options}"
        );
        assert!(
            !options.contains("loader.js\""),
            "loader 不该再进 NODE_OPTIONS：{options}"
        );

        let plan_file = single.plan_file.expect("应写出模组清单");
        let plan: Value =
            serde_json::from_str(&std::fs::read_to_string(&plan_file).unwrap()).unwrap();
        assert_eq!(plan["api"], 1);
        let listed = plan["loaders"][0].as_str().unwrap();
        assert!(listed.ends_with("/mods/demo/loader.js"), "{listed}");
        assert!(!listed.contains('\\'), "清单里的路径也要是正斜杠：{listed}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 静态数据热重载 host：**零模组也必须注入**（否则「改 JSON 不重启」在干净服务端上直接不可用），
    /// 并且要紧跟在模组总线后面（总线独占 `_compile` 钩子）。
    #[test]
    fn hotreload_host_is_injected_even_without_mods() {
        let root = std::env::temp_dir().join(format!("evejs-hotreload-env-{}", iso_log_stamp()));
        let repo = root.join("repo");
        let store = repo.join("server").join("src").join("gameStore");
        let runtime = crate::runtime::RuntimePaths::from_root(root.join("_launcher"), false);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&runtime.root).unwrap();
        std::fs::write(
            store.join("index.js"),
            "const SQLITE_TABLES = new Set([\"a\"]);\n",
        )
        .unwrap();

        let injected = mods_loader_injection(&repo, &runtime);
        assert!(injected.hotreload, "有服务端就必须注入热重载 host");
        assert_eq!(injected.count, 0, "零模组时 loader 数仍是 0");
        let options = injected.node_options.expect("零模组也要有 NODE_OPTIONS");
        assert!(options.contains("/hotreload/host.js\""), "{options}");
        assert!(!options.contains("mod-host.js"), "没有模组就不该注入总线：{options}");
        assert!(!options.contains('\\'), "NODE_OPTIONS 里不能出现反斜杠：{options}");
        assert!(runtime.root.join("hotreload").join("host.js").is_file());
        assert!(runtime.root.join("hotreload").join("boot.json").is_file());

        // 目录不是服务端时不注入：别在多出来的启动器上乱挂 --require
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(!mods_loader_injection(&bare, &runtime).hotreload);
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn network_policy_blocks_darkly_and_sets_proxy() {
        let mut env: BTreeMap<String, String> = BTreeMap::new();
        apply_client_network_policy(&mut env, "", "");
        assert_eq!(env["EVEJS_PROXY_URL"], "http://127.0.0.1:26002/");
        assert_eq!(env["EVEJS_PROXY_UNHANDLED_HOST_POLICY"], "block");
        assert!(env["EVEJS_PROXY_BLOCKED_HOSTS"].contains("launchdarkly.com"));
        assert!(env["EVEJS_PROXY_BLOCKED_HOSTS"].contains("sentry.io"));
        assert_eq!(env["HTTP_PROXY"], env["http_proxy"]);
        assert_eq!(env["LD_OFFLINE"], "true");
        // 未配置 CA 时不得设置证书变量，避免把不存在的路径塞给客户端
        assert!(!env.contains_key("SSL_CERT_FILE"));
        assert_eq!(env["EVEJS_NO_PROXY"], "127.0.0.1,localhost,::1");
    }

    /// 启动预算：60s 基价 + 每 loader 3s，封顶 180s（20 个模组 = 120s）
    #[test]
    fn main_start_budget_grows_with_mods_and_is_capped() {
        assert_eq!(main_start_budget_ms(0), 60_000);
        assert_eq!(main_start_budget_ms(1), 63_000);
        assert_eq!(main_start_budget_ms(20), 120_000);
        assert_eq!(main_start_budget_ms(40), 180_000);
        assert_eq!(main_start_budget_ms(500), 180_000);
    }

    /// 启动进度文案：要带秒数、预算与模组个数；超预算的口吻是「还在等」，不是「失败」
    #[test]
    fn start_progress_message_reports_mods_and_overrun() {
        let text = start_progress_message(45_000, 120_000, 20, false);
        assert!(text.contains("45s"), "{text}");
        assert!(text.contains("120s"), "{text}");
        assert!(text.contains("20 个模组"), "{text}");

        let over = start_progress_message(130_000, 120_000, 20, true);
        assert!(over.contains("已超出 120s 预算"), "{over}");
        assert!(!over.contains("失败"), "还在等就不能写成失败：{over}");

        let plain = start_progress_message(3_000, 60_000, 0, false);
        assert!(plain.contains("正在启动服务端"), "{plain}");
        assert!(!plain.contains("模组"), "没模组就别提模组：{plain}");
    }

    /// 日志行压长：toast 放不下整段堆栈，但也不能把短行改了
    #[test]
    fn shorten_line_keeps_short_lines_and_cuts_long_ones() {
        assert_eq!(shorten_line("short"), "short");
        let long = "字".repeat(300);
        let cut = shorten_line(&long);
        assert_eq!(cut.chars().count(), 161);
        assert!(cut.ends_with('…'));
    }
}
