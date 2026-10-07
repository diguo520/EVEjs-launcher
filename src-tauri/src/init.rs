//! 环境初始化：对齐现役版 `src/main/initManager.ts`。
//!
//! 五个任务键：deps（主服务器依赖）/ db（本地数据库）/ market（市场服务二进制）/
//! client（客户端路径，直连任务）/ ca（客户端证书 CA，弹出 ClientSETUP 向导）。
//!
//! 设计要点：
//!   - **单任务串行**：正在跑时直接返回 `{ok:false, reason}`，不做排队（现役版同款）；
//!   - bat 任务写成临时 bat 再 `cmd.exe /d /c call <bat>`（**不能用 /s 加引号**，
//!     cmd 会把带引号的整串当命令名）；
//!   - 所有输出走 `terminal:data` 的 `system` 页签，进度走 `init:changed` 事件。
use crate::config;
use crate::env;
use crate::AppState;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::win32::CREATE_NO_WINDOW;

/// 初始化任务键（顺序即 UI 展示顺序）
pub const KEYS: [&str; 5] = ["deps", "db", "market", "client", "ca"];

/// 客户端路径探测候选（EVE 常见安装位置，含 exefile.exe 判定）
const CLIENT_PATH_CANDIDATES: [&str; 8] = [
    "F:\\EVE Online - 3396210\\tq",
    "D:\\EVE Online - 3396210\\tq",
    "E:\\EVE Online - 3396210\\tq",
    "C:\\EVE Online - 3396210\\tq",
    "C:\\Program Files (x86)\\EVE Online\\tq",
    "C:\\Games\\EVE Online - 3396210\\tq",
    "D:\\Games\\EVE Online - 3396210\\tq",
    "E:\\Games\\EVE Online - 3396210\\tq",
];

/// CA 任务启动前的中文向导提示（现役版 preNote 原文）
const CA_PRE_NOTE: &str = "已打开 EvEJS 客户端配置向导窗口：请按向导完成「选择客户端 → 安装证书 → 补丁 → start.ini」；向导关闭后本任务结束，如向导报错请在下方终端按任意键继续";

/// 快任务（直连任务）至少保持 600ms 完成态，避免进度条一闪而过
const DIRECT_TASK_HOLD_MS: u64 = 600;

pub fn label_of(key: &str) -> &'static str {
    match key {
        "deps" => "主服务器依赖",
        "db" => "本地数据库",
        "market" => "市场服务二进制",
        "client" => "客户端路径",
        "ca" => "客户端证书 CA",
        _ => "",
    }
}

struct Job {
    key: String,
    progress: Option<u32>,
}

/// 初始化状态机（放进 AppState，供 `init:run` / `init:state` 使用）
pub struct InitManager {
    current: Mutex<Option<Job>>,
}

impl Default for InitManager {
    fn default() -> Self {
        Self::new()
    }
}

impl InitManager {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// 现役版 InitState 形状：{busy, key, label, progress}
    pub fn state(&self) -> Value {
        let idle = || {
            json!({
                "busy": false,
                "key": Value::Null,
                "label": "",
                "progress": Value::Null
            })
        };
        let Ok(guard) = self.current.lock() else {
            return idle();
        };
        match guard.as_ref() {
            Some(job) => json!({
                "busy": true,
                "key": job.key,
                "label": label_of(&job.key),
                "progress": job.progress
            }),
            None => idle(),
        }
    }

    fn busy_label(&self) -> Option<String> {
        self.current
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|job| label_of(&job.key).to_string()))
    }

    fn begin(&self, key: &str, progress: Option<u32>) {
        if let Ok(mut guard) = self.current.lock() {
            *guard = Some(Job {
                key: key.to_string(),
                progress,
            });
        }
    }

    /// 只在仍是同一个任务时更新进度（避免旧任务的迟到事件覆盖新任务）
    fn set_progress(&self, key: &str, progress: u32) {
        if let Ok(mut guard) = self.current.lock() {
            if let Some(job) = guard.as_mut() {
                if job.key == key {
                    job.progress = Some(progress);
                }
            }
        }
    }

    fn finish(&self, key: &str) {
        if let Ok(mut guard) = self.current.lock() {
            if guard.as_ref().map(|job| job.key.as_str()) == Some(key) {
                *guard = None;
            }
        }
    }
}

fn emit_init(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let snapshot = state.init.state();
        let _ = app.emit("init:changed", json!([snapshot]));
    }
}

/// 向启动器终端的 system 页签推一行（换行统一成 CRLF，对齐现役版 push）
fn push(app: &AppHandle, text: &str) {
    let normalized = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let _ = app.emit(
        "terminal:data",
        json!(["system", format!("{normalized}\r\n")]),
    );
}

fn push_colored(app: &AppHandle, color: &str, text: &str) {
    push(app, &format!("\x1b[{color}m{text}\x1b[0m"));
}

fn join_bat(lines: Vec<String>) -> String {
    lines.join("\r\n")
}

/// bat 任务定义：返回临时 bat 内容；None 表示缺少前置条件（如未装 MSVC）
fn build_bat(key: &str, root: &Path) -> Option<String> {
    match key {
        "deps" => Some(join_bat(vec![
            "@echo off".to_string(),
            "chcp 65001 >nul 2>&1".to_string(),
            format!("cd /d \"{}\"", root.join("server").to_string_lossy()),
            "call npm ci --no-audit --no-fund".to_string(),
            "exit /b %errorlevel%".to_string(),
        ])),
        // 数据库初始化 = 强制重建：CreateDatabase.bat 默认只检查 manifest.json 是否存在，
        // 若 sqlite 缺失但 manifest 在（拷贝遗漏/构建中断）会被误跳过；/force 保证真正补全。
        // 现役版把这段说明放在 bat 里，这里移到 Rust 注释：bat 保持纯 ASCII 更稳。
        "db" => Some(join_bat(vec![
            "@echo off".to_string(),
            "chcp 65001 >nul 2>&1".to_string(),
            format!(
                "call \"{}\" /force",
                root.join("tools")
                    .join("DatabaseCreator")
                    .join("CreateDatabase.bat")
                    .to_string_lossy()
            ),
            "exit /b %errorlevel%".to_string(),
        ])),
        "market" => {
            let vcvars = env::find_vs_install_path()?
                .join("VC")
                .join("Auxiliary")
                .join("Build")
                .join("vcvars64.bat");
            if !vcvars.is_file() {
                return None;
            }
            Some(join_bat(vec![
                "@echo off".to_string(),
                "chcp 65001 >nul 2>&1".to_string(),
                format!("call \"{}\" >nul 2>&1", vcvars.to_string_lossy()),
                "if errorlevel 1 (echo MSVC env init failed & exit /b 1)".to_string(),
                format!(
                    "cd /d \"{}\"",
                    root.join("externalservices")
                        .join("market-server")
                        .to_string_lossy()
                ),
                "call cargo build --release".to_string(),
                "exit /b %errorlevel%".to_string(),
            ]))
        }
        "ca" => {
            let setup = root
                .join("tools")
                .join("ClientSETUP")
                .join("StartClientSetup.bat");
            if !setup.is_file() {
                return None;
            }
            Some(join_bat(vec![
                "@echo off".to_string(),
                "chcp 65001 >nul 2>&1".to_string(),
                format!("call \"{}\"", setup.to_string_lossy()),
                "exit /b %errorlevel%".to_string(),
            ]))
        }
        _ => None,
    }
}

fn client_path_looks_valid(path: &Path) -> bool {
    path.exists()
        && (path.join("exefile.exe").is_file() || path.join("bin64").join("exefile.exe").is_file())
}

/// 自动探测 EVE 客户端安装路径（已配置且有效 → 直接沿用）
fn detect_client_path(root: &Path) -> Option<String> {
    let configured = config::read_client_config(root).client_path;
    let configured = configured.trim();
    if !configured.is_empty() && client_path_looks_valid(Path::new(configured)) {
        return Some(configured.to_string());
    }
    CLIENT_PATH_CANDIDATES
        .iter()
        .find(|candidate| client_path_looks_valid(Path::new(candidate)))
        .map(|candidate| (*candidate).to_string())
}

/// 启动一项环境初始化（单任务串行；正在运行时拒绝新任务）
pub fn run_init(app: &AppHandle, key: &str) -> Value {
    let Some(state) = app.try_state::<AppState>() else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };

    if let Some(label) = state.init.busy_label() {
        let reason = format!("正在执行「{label}」初始化，请等待完成");
        push_colored(app, "31", &format!("[初始化] {reason}"));
        return json!({ "ok": false, "reason": reason });
    }
    if !KEYS.contains(&key) {
        let reason = format!("未知初始化项: {key}");
        push_colored(app, "31", &format!("[初始化] {reason}"));
        return json!({ "ok": false, "reason": reason });
    }

    let root = state.repo_root();
    let label = label_of(key);
    if key == "db" {
        if let Some(issue) = env::better_sqlite_issue(&root) {
            let reason = format!("数据库运行环境未就绪：{issue}");
            push_colored(app, "31", &format!("[初始化] {reason}"));
            push_colored(
                app,
                "33",
                "[初始化] 先执行「主服务器依赖」修复重新 npm ci；若仍失败，请改用 Node.js 22。",
            );
            return json!({ "ok": false, "reason": reason });
        }
    }
    push(
        app,
        &format!("\r\n\x1b[33m════ [初始化] {label} 开始 ════\x1b[0m"),
    );
    if key == "ca" {
        push_colored(app, "36", &format!("[初始化] {CA_PRE_NOTE}"));
    }

    if key == "client" {
        state.init.begin(key, Some(0));
        emit_init(app);
        let app_task = app.clone();
        tauri::async_runtime::spawn(async move {
            run_client_task(&app_task).await;
        });
        return json!({ "ok": true });
    }

    let Some(bat) = build_bat(key, &root) else {
        let reason = "缺少初始化前置条件（如 MSVC 构建工具），请先安装".to_string();
        push_colored(app, "31", &format!("[初始化] {reason}"));
        return json!({ "ok": false, "reason": reason });
    };

    let init_dir = state.runtime.temp.join("launcher-init");
    let _ = std::fs::create_dir_all(&init_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let bat_file = init_dir.join(format!("init-{key}-{stamp}.bat"));
    if let Err(err) = std::fs::write(&bat_file, bat) {
        let reason = format!("写入临时 bat 失败：{err}");
        push_colored(app, "31", &format!("[初始化] {reason}"));
        return json!({ "ok": false, "reason": reason });
    }
    // 先占位再 spawn：两次 init:run 并发进来时，第二个会在 busy_label 处被挡掉
    if let Some(state) = app.try_state::<AppState>() {
        state.init.begin(key, Some(5));
    }
    emit_init(app);

    // 注意：不能用 /s 并手动包引号（cmd 会把带引号字符串当命令名）。
    // cmd /d /c call <path> 对含空格路径的引号处理最稳。
    let mut command = Command::new("cmd.exe");
    command
        .args(["/d", "/c", "call"])
        .arg(&bat_file)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            push_colored(app, "31", &format!("[初始化] 启动失败：{err}"));
            if let Some(state) = app.try_state::<AppState>() {
                state.init.finish(key);
            }
            emit_init(app);
            return json!({ "ok": false, "reason": err.to_string() });
        }
    };

    let key_owned = key.to_string();
    let mut handles = Vec::new();
    if let Some(stream) = child.stdout.take() {
        handles.push(spawn_pump(app, &key_owned, stream));
    }
    if let Some(stream) = child.stderr.take() {
        handles.push(spawn_pump(app, &key_owned, stream));
    }

    let app_wait = app.clone();
    let bat_cleanup = bat_file.clone();
    let root_wait = root.clone();
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        for handle in handles {
            let _ = handle.join();
        }
        let db_issue = if code == 0 && key_owned == "db" {
            env::local_db_artifact_issue(&root_wait)
        } else {
            None
        };
        if code == 0 && db_issue.is_none() {
            push_colored(&app_wait, "32", &format!("════ [初始化] {label} 完成 ✓"));
        } else {
            let detail = db_issue
                .map(|issue| format!("：{issue}"))
                .unwrap_or_default();
            push_colored(
                &app_wait,
                "31",
                &format!(
                    "════ [初始化] {label} 结束（exit {code}）—— 未完成{detail}，请查看上方日志"
                ),
            );
        }
        let _ = std::fs::remove_file(&bat_cleanup);
        if let Some(state) = app_wait.try_state::<AppState>() {
            state.init.finish(&key_owned);
        }
        emit_init(&app_wait);
    });

    json!({ "ok": true })
}

/// 逐块读子进程输出 → 推送到 system 页签，并把输出事件数换算成进度（+2/次，上限 90）
fn spawn_pump<R: Read + Send + 'static>(
    app: &AppHandle,
    key: &str,
    stream: R,
) -> std::thread::JoinHandle<()> {
    let app_line = app.clone();
    let key_line = key.to_string();
    std::thread::spawn(move || {
        let mut reader = stream;
        let mut buffer = [0u8; 8192];
        let mut events: u32 = 0;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    push(&app_line, &String::from_utf8_lossy(&buffer[..count]));
                    events += 1;
                    if let Some(state) = app_line.try_state::<AppState>() {
                        state.init.set_progress(&key_line, (5 + events * 2).min(90));
                    }
                    emit_init(&app_line);
                }
            }
        }
    })
}

/// 直连任务：探测 EVE 客户端路径并写入 EvEJSConfig.bat
async fn run_client_task(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let root = state.repo_root();
    let found = detect_client_path(&root);

    match found {
        None => {
            push_colored(
                app,
                "36",
                "[初始化] 未在常见位置找到 EVE 客户端（exefile.exe），请在配置面板中手动填写路径",
            );
            state_finish(app, "client", Some(100));
            tokio::time::sleep(std::time::Duration::from_millis(DIRECT_TASK_HOLD_MS)).await;
            push_colored(
                app,
                "31",
                "════ [初始化] 客户端路径 结束 —— 未找到客户端安装",
            );
            state_finish(app, "client", None);
        }
        Some(found) => {
            let mut patch = serde_json::Map::new();
            patch.insert("clientPath".to_string(), json!(found));
            match config::write_client_config(&root, &patch) {
                Ok(_) => {
                    push_colored(app, "36", &format!("[初始化] 已写入客户端路径：{found}"));
                    state_finish(app, "client", Some(100));
                    tokio::time::sleep(std::time::Duration::from_millis(DIRECT_TASK_HOLD_MS)).await;
                    push_colored(app, "32", "════ [初始化] 客户端路径 完成 ✓");
                    state_finish(app, "client", None);
                }
                Err(err) => {
                    push_colored(app, "36", &format!("[初始化] 写入配置失败：{err}"));
                    state_finish(app, "client", Some(100));
                    tokio::time::sleep(std::time::Duration::from_millis(DIRECT_TASK_HOLD_MS)).await;
                    push_colored(
                        app,
                        "31",
                        &format!("════ [初始化] 客户端路径 结束 —— 写入配置失败：{err}"),
                    );
                    state_finish(app, "client", None);
                }
            }
        }
    }
}

/// progress=None 表示任务结束（清空 busy），Some(v) 表示更新进度
fn state_finish(app: &AppHandle, key: &str, progress: Option<u32>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match progress {
        Some(value) => state.init.set_progress(key, value),
        None => state.init.finish(key),
    }
    emit_init(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_cover_every_key() {
        for key in KEYS {
            assert!(!label_of(key).is_empty(), "{key} 缺少中文标签");
        }
        assert_eq!(label_of("nope"), "");
    }

    #[test]
    fn bat_tasks_are_ascii_with_cp65001() {
        let root = Path::new("E:\\repo");
        for key in ["deps", "db"] {
            let bat = build_bat(key, root).expect("deps/db 应始终可构建");
            assert!(bat.starts_with("@echo off\r\nchcp 65001"), "{key}: {bat}");
            assert!(bat.contains("exit /b %errorlevel%"), "{key}: {bat}");
            assert!(bat.is_ascii(), "{key} 的 bat 必须是纯 ASCII");
        }
    }

    #[test]
    fn market_task_requires_msvc_toolset() {
        // 未装 MSVC 的机器上 build_bat 返回 None（install 前置条件缺失）
        let root = Path::new("E:\\repo");
        match build_bat("market", root) {
            None => {}
            Some(bat) => {
                assert!(bat.contains("vcvars64.bat"), "{bat}");
                assert!(bat.contains("cargo build --release"), "{bat}");
            }
        }
    }

    #[test]
    fn state_shape_matches_electron() {
        let manager = InitManager::new();
        let idle = manager.state();
        assert_eq!(idle["busy"], json!(false));
        assert_eq!(idle["progress"], Value::Null);

        manager.begin("deps", Some(5));
        let busy = manager.state();
        assert_eq!(busy["busy"], json!(true));
        assert_eq!(busy["key"], json!("deps"));
        assert_eq!(busy["label"], json!("主服务器依赖"));
        assert_eq!(busy["progress"], json!(5));

        // 别的任务的迟到进度不能覆盖当前任务
        manager.set_progress("db", 60);
        assert_eq!(manager.state()["progress"], json!(5));
        manager.set_progress("deps", 11);
        assert_eq!(manager.state()["progress"], json!(11));

        manager.finish("db");
        assert_eq!(manager.state()["busy"], json!(true));
        manager.finish("deps");
        assert_eq!(manager.state()["busy"], json!(false));
    }
}
