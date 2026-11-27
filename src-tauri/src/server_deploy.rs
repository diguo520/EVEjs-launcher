//! 全新服务端部署：下载发布包 → 安全解压 → 调用服务端自带的完整安装向导。
//!
//! 这里不重新实现服务端的安装步骤。发布包里已经有 `tools/Setup/Setup-EvEJS.ps1`，
//! 它负责 Node.js 检查、依赖安装、证书、游戏数据库、独立市场、客户端补丁与防火墙；
//! 启动器只负责选择空目录、下载/解压、把选项翻译成脚本参数，并把脚本的事件流转成
//! 启动器界面上的阶段与结果。这样部署流程与 `SetupEveJSGui` 完全一致，也不会改动
//! 任何服务端源码。
use crate::env;
use crate::runtime::RuntimePaths;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use zip::ZipArchive;

#[cfg(windows)]
use crate::win32::CREATE_NO_WINDOW;

const DEPLOY_PROGRESS_EVENT: &str = "server:deployProgress";
const DEPLOY_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_ZIP_ENTRIES: usize = 20_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MARKER_FILE: &str = ".evejs-deploy.json";

static DEPLOY_BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static CANCEL_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeployOptions {
    /// `server` = 只安装服务端；`play` = 同时准备客户端（补丁、证书、防火墙）。
    purpose: String,
    client_path: String,
    install_firewall: bool,
    /// `none` / `v1` / `v2` / `v3` / `v4`
    market_seed: String,
    /// 只跑 Setup-EvEJS.ps1 的 `-Preflight`，不执行安装阶段。
    check_only: bool,
}

impl DeployOptions {
    fn parse(value: &Value) -> Result<Self, String> {
        let options: Self = serde_json::from_value(value.clone())
            .map_err(|err| format!("部署选项不完整：{err}"))?;
        options.validate()?;
        Ok(options)
    }

    fn validate(&self) -> Result<(), String> {
        if !matches!(self.purpose.as_str(), "server" | "play") {
            return Err("部署用途无效".to_string());
        }
        if self.purpose == "play" && self.client_path.trim().is_empty() {
            return Err("选择客户端用途时必须指定客户端目录".to_string());
        }
        if !matches!(
            self.market_seed.as_str(),
            "none" | "v1" | "v2" | "v3" | "v4"
        ) {
            return Err("市场种子选项无效".to_string());
        }
        Ok(())
    }

    /// `Setup-EvEJS.ps1` 的 native 阶段数，用来估算进度。
    fn total_phases(&self) -> usize {
        let mut total = 6; // node / root-deps / server-deps / save-upgrade / gamedb / certs
        if self.market_seed != "none" {
            total += 1;
        }
        if self.purpose == "play" {
            total += 3; // client / client-offline / firewall
        }
        total
    }
}

fn emit(
    app: &AppHandle,
    kind: &str,
    phase: &str,
    percent: u8,
    message: &str,
    record: Option<Value>,
) {
    let _ = app.emit(
        DEPLOY_PROGRESS_EVENT,
        json!([{
            "kind": kind,
            "phase": phase,
            "percent": percent,
            "message": message,
            "record": record,
        }]),
    );
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn safe_version(version: &str) -> bool {
    !version.is_empty()
        && !version.contains("..")
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

/// R2 清单里偶尔会把 `261126.2` 写成 `261126.`；文件名才是下载与目录命名的可靠来源。
fn effective_version(file: &str, version: &str) -> String {
    let from_file = file
        .strip_prefix("EveJS-")
        .and_then(|name| name.strip_suffix(".zip"));
    if let Some(from_file) = from_file {
        if version.trim().is_empty() || version.ends_with('.') {
            return from_file.to_string();
        }
    }
    version.trim().to_string()
}

fn marker_path(target: &Path) -> PathBuf {
    target.join(MARKER_FILE)
}

fn marker_matches(target: &Path, version: &str) -> bool {
    let Ok(raw) = fs::read_to_string(marker_path(target)) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    value.get("version").and_then(Value::as_str) == Some(version)
}

fn write_marker(target: &Path, file: &str, version: &str) -> Result<(), String> {
    let marker = json!({
        "version": version,
        "file": file,
        "createdAt": now_millis(),
    });
    fs::write(marker_path(target), marker.to_string())
        .map_err(|err| format!("写入部署标记失败：{err}"))
}

fn remove_marker(target: &Path) {
    let _ = fs::remove_file(marker_path(target));
}

/// 目标目录的状态：全新部署、继续上次未完成的部署，或已解压但尚未安装的服务端包。
enum TargetState {
    Empty,
    Resume,
    Extracted,
}

/// 目录里是否已经躺着一份手动解压的完整服务端包（还没跑过安装向导）。
fn has_extracted_package(target: &Path) -> bool {
    target.join("server/index.js").is_file()
        && target.join("config/version.json").is_file()
        && target.join("tools/Setup/Setup-EvEJS.ps1").is_file()
}

/// 目标目录必须是绝对路径、空目录、本启动器上一次未完成的部署目录，
/// 或一份已解压但尚未安装的完整服务端包。
fn validate_target(target: &Path, version: &str) -> Result<TargetState, String> {
    if !target.is_absolute() || target.parent().is_none() {
        return Err("请选择绝对路径下的空目录".to_string());
    }
    match fs::metadata(target) {
        Ok(meta) if !meta.is_dir() => Err("部署目标不是文件夹".to_string()),
        Ok(_) => {
            let mut entries =
                fs::read_dir(target).map_err(|err| format!("读取部署目录失败：{err}"))?;
            if entries.next().is_none() {
                return Ok(TargetState::Empty);
            }
            if marker_matches(target, version) {
                return Ok(TargetState::Resume);
            }
            if has_extracted_package(target) {
                return Ok(TargetState::Extracted);
            }
            Err(
                "部署目录非空；请选择空目录、已解压的服务端目录，或继续上一次未完成的部署"
                    .to_string(),
            )
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(TargetState::Empty),
        Err(err) => Err(format!("读取部署目录失败：{err}")),
    }
}

fn extract_zip(zip_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|err| format!("打开服务端包失败：{err}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|err| format!("服务端包不是有效 ZIP：{err}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("服务端包条目过多，已拒绝解压".to_string());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("读取服务端包条目失败：{err}"))?;
        total = total.saturating_add(entry.size());
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err("服务端包解压后体积超过安全上限".to_string());
        }
        let Some(relative) = entry.enclosed_name() else {
            return Err("服务端包含越界路径，已拒绝解压".to_string());
        };
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|err| format!("创建目录失败：{err}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
        }
        let mut output_file =
            File::create(&output).map_err(|err| format!("写入解压文件失败：{err}"))?;
        io::copy(&mut entry, &mut output_file).map_err(|err| format!("解压文件失败：{err}"))?;
    }
    Ok(())
}

fn validate_package(root: &Path) -> Result<(), String> {
    if !root.join("server/index.js").is_file()
        || !root.join("config/version.json").is_file()
        || !root.join("tools/Setup/Setup-EvEJS.ps1").is_file()
    {
        return Err(
            "服务端包结构不完整：缺少 server/index.js、config/version.json 或 tools/Setup/Setup-EvEJS.ps1"
                .to_string(),
        );
    }
    Ok(())
}

fn create_log(runtime: &RuntimePaths, version: &str) -> Result<PathBuf, String> {
    let dir = runtime.temp.join("server-deploy");
    fs::create_dir_all(&dir).map_err(|err| format!("创建部署日志目录失败：{err}"))?;
    let path = dir.join(format!("deploy-{version}-{}.log", now_millis()));
    File::create(&path).map_err(|err| format!("创建部署日志失败：{err}"))?;
    Ok(path)
}

fn setup_arguments(
    root: &Path,
    options: &DeployOptions,
    cancel_file: &Path,
) -> Vec<std::ffi::OsString> {
    let script = root.join("tools").join("Setup").join("Setup-EvEJS.ps1");
    let mut args: Vec<std::ffi::OsString> = vec![
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-NonInteractive".into(),
        "-File".into(),
        script.into_os_string(),
        "-Mode".into(),
        "native".into(),
        "-NonInteractive".into(),
        "-EventStream".into(),
        "-CancelFile".into(),
        cancel_file.as_os_str().to_os_string(),
    ];
    if options.check_only {
        args.push("-Preflight".into());
    }
    if options.purpose == "server" {
        args.push("-SkipClient".into());
    } else {
        args.push("-ClientPath".into());
        args.push(options.client_path.trim().into());
        if options.install_firewall {
            args.push("-InstallFirewall".into());
        }
    }
    if options.market_seed == "none" {
        args.push("-SkipMarket".into());
    } else {
        args.push("-MarketSeed".into());
        args.push(options.market_seed.clone().into());
    }
    args
}

fn parse_event(line: &str) -> Option<Value> {
    line.strip_prefix("@evejs-setup ")
        .and_then(|payload| serde_json::from_str::<Value>(payload.trim()).ok())
}

fn record_label(record: &Value) -> &str {
    record.get("label").and_then(Value::as_str).unwrap_or("")
}

fn record_title(record: &Value) -> &str {
    record.get("title").and_then(Value::as_str).unwrap_or("")
}

fn record_detail(record: &Value) -> &str {
    record.get("detail").and_then(Value::as_str).unwrap_or("")
}

async fn run_setup(
    app: &AppHandle,
    root: &Path,
    options: &DeployOptions,
    log_path: &Path,
    cancel_file: &Path,
) -> Result<(i32, String), String> {
    let args = setup_arguments(root, options, cancel_file);
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动服务端安装向导失败：{err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取安装向导输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取安装向导错误输出".to_string())?;

    let log_for_stderr = log_path.to_path_buf();
    let stderr_task = tokio::spawn(async move {
        let mut lines = AsyncBufReader::new(stderr).lines();
        let mut last = String::new();
        let Ok(mut log) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_for_stderr)
        else {
            return last;
        };
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                last = line.clone();
                let _ = writeln!(log, "[stderr] {line}");
            }
        }
        last
    });

    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| format!("打开部署日志失败：{err}"))?;
    let mut reader = AsyncBufReader::new(stdout).lines();
    let mut install_started = false;
    let mut completed = 0usize;
    let mut last_error = String::new();
    let mut last_output = String::new();
    let total = options.total_phases().max(1);

    loop {
        let next = tokio::time::timeout(Duration::from_secs(120), reader.next_line()).await;
        let line = match next {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                let _ = child.kill().await;
                return Err(format!("读取安装向导输出失败：{err}"));
            }
            Err(_) => {
                // 超过两分钟没有任何输出：安装器仍在运行时不强行判失败，继续等待。
                if CANCEL_REQUESTED.load(Ordering::SeqCst) {
                    let _ = child.kill().await;
                    return Ok((2, "用户已停止部署".to_string()));
                }
                continue;
            }
        };
        let _ = writeln!(log, "{line}");
        let _ = log.flush();
        if !line.trim().is_empty() {
            last_output = line.clone();
        }

        let Some(record) = parse_event(&line) else {
            if !line.trim().is_empty() {
                emit(app, "log", "setup", 0, &line, None);
            }
            continue;
        };
        let kind = record.get("kind").and_then(Value::as_str).unwrap_or("");
        let title = record_title(&record).to_string();
        let detail = record_detail(&record).to_string();
        let label = record_label(&record).to_string();

        if kind == "phase" {
            install_started = true;
            let message = if detail.is_empty() {
                title.clone()
            } else {
                format!("{title} · {detail}")
            };
            emit(app, "phase", "setup", 60, &message, Some(record));
            continue;
        }
        if kind != "result" {
            continue;
        }

        if install_started && matches!(label.as_str(), "[done]" | "[skip]" | "[FAIL]") {
            completed = completed.saturating_add(1);
        }
        if label == "[FAIL]" {
            last_error = if detail.is_empty() {
                title.clone()
            } else {
                format!("{title}：{detail}")
            };
        }
        let percent = if install_started {
            (60 + completed.saturating_mul(37) / total).min(97) as u8
        } else {
            56
        };
        let message = if detail.is_empty() {
            title.clone()
        } else {
            format!("{title}：{detail}")
        };
        emit(app, "result", "setup", percent, &message, Some(record));
    }

    let status = match tokio::time::timeout(DEPLOY_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => return Err(format!("等待安装向导失败：{err}")),
        Err(_) => {
            let _ = child.kill().await;
            return Err("服务端安装超时（60 分钟）".to_string());
        }
    };
    let stderr_last = stderr_task.await.unwrap_or_default();
    if !status.success() && last_error.is_empty() {
        last_error = if !stderr_last.trim().is_empty() {
            stderr_last
        } else {
            last_output
        };
    }
    Ok((status.code().unwrap_or(1), last_error))
}

fn market_db(root: &Path) -> PathBuf {
    root.join("externalservices")
        .join("market-server")
        .join("data")
        .join("generated")
        .join("market.sqlite")
}

fn verify_deployed(root: &Path, options: &DeployOptions) -> Result<(), String> {
    validate_package(root)?;
    if let Some(issue) = env::local_db_artifact_issue(root) {
        return Err(format!("游戏数据库没有生成完整：{issue}"));
    }
    let moon = root
        .join("_local")
        .join("gameStore")
        .join("moon-compositions.json");
    if !moon.is_file() {
        return Err("月球产物数据库没有生成：_local/gameStore/moon-compositions.json".to_string());
    }
    if options.market_seed != "none" && !market_db(root).is_file() {
        return Err(
            "独立市场数据库没有生成：externalservices/market-server/data/generated/market.sqlite"
                .to_string(),
        );
    }
    Ok(())
}

pub fn cancel() -> Value {
    if !DEPLOY_BUSY.load(Ordering::SeqCst) {
        return json!({ "ok": false, "reason": "没有正在进行的部署" });
    }
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    if let Ok(guard) = CANCEL_FILE.lock() {
        if let Some(path) = guard.as_ref() {
            let _ = fs::write(path, b"");
        }
    }
    json!({ "ok": true })
}

pub fn open_log() -> Value {
    let path = LOG_FILE.lock().ok().and_then(|guard| guard.clone());
    let Some(path) = path else {
        return json!({ "ok": false, "reason": "还没有部署日志" });
    };
    if !path.is_file() {
        return json!({ "ok": false, "reason": "部署日志文件不存在" });
    }
    match std::process::Command::new("notepad.exe").arg(&path).spawn() {
        Ok(_) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(err) => json!({ "ok": false, "reason": format!("打开日志失败：{err}") }),
    }
}

/// `server:deploy`：完整部署，或只运行安装向导的环境检查。
pub async fn deploy(
    app: &AppHandle,
    runtime: &RuntimePaths,
    target_dir: &str,
    file: &str,
    version: &str,
    options_value: &Value,
) -> Value {
    if DEPLOY_BUSY.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "reason": "已有服务端部署在进行" });
    }
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    *CANCEL_FILE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    let result = deploy_inner(app, runtime, target_dir, file, version, options_value).await;
    DEPLOY_BUSY.store(false, Ordering::SeqCst);
    *CANCEL_FILE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    result
}

async fn deploy_inner(
    app: &AppHandle,
    runtime: &RuntimePaths,
    target_dir: &str,
    file: &str,
    version: &str,
    options_value: &Value,
) -> Value {
    let options = match DeployOptions::parse(options_value) {
        Ok(options) => options,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    let version = effective_version(file, version);
    if !safe_version(&version) {
        return json!({ "ok": false, "reason": "服务端版本号非法" });
    }
    let target = PathBuf::from(target_dir.trim());
    let state = match validate_target(&target, &version) {
        Ok(state) => state,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    match state {
        TargetState::Empty => {
            let parent = match target.parent() {
                Some(parent) => parent,
                None => return json!({ "ok": false, "reason": "请选择有效的部署目录" }),
            };
            if let Err(err) = fs::create_dir_all(parent) {
                return json!({ "ok": false, "reason": format!("创建部署目录失败：{err}") });
            }
            let name = target
                .file_name()
                .unwrap_or_else(|| OsStr::new("EveJS"))
                .to_string_lossy();
            let staging = parent.join(format!(".{name}.deploy-{}", now_millis()));
            if let Err(err) = fs::create_dir_all(&staging) {
                return json!({ "ok": false, "reason": format!("创建临时部署目录失败：{err}") });
            }

            emit(
                app,
                "phase",
                "downloading",
                3,
                "正在下载服务端发布包…",
                None,
            );
            let downloaded = crate::server_update::download(app, runtime, file, &version).await;
            if downloaded.get("ok").and_then(Value::as_bool) != Some(true) {
                let _ = fs::remove_dir_all(&staging);
                return downloaded;
            }
            let Some(zip_path) = downloaded
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
            else {
                let _ = fs::remove_dir_all(&staging);
                return json!({ "ok": false, "reason": "下载完成但找不到服务端包路径" });
            };

            emit(
                app,
                "phase",
                "extracting",
                48,
                "正在解压服务端发布包…",
                None,
            );
            if let Err(reason) = extract_zip(&zip_path, &staging) {
                let _ = fs::remove_dir_all(&staging);
                return json!({ "ok": false, "reason": reason });
            }
            if let Err(reason) = validate_package(&staging) {
                let _ = fs::remove_dir_all(&staging);
                return json!({ "ok": false, "reason": reason });
            }

            emit(app, "phase", "preparing", 54, "正在准备部署目录…", None);
            if target.exists() {
                if let Err(err) = fs::remove_dir(&target) {
                    let _ = fs::remove_dir_all(&staging);
                    return json!({ "ok": false, "reason": format!("目标目录已不是空目录：{err}") });
                }
            }
            if let Err(err) = fs::rename(&staging, &target) {
                let _ = fs::remove_dir_all(&staging);
                return json!({ "ok": false, "reason": format!("部署目录改名失败：{err}") });
            }
            if let Err(reason) = write_marker(&target, file, &version) {
                return json!({ "ok": false, "reason": reason });
            }
            let _ = fs::remove_dir_all(runtime.temp.join("server-update").join(&version));
        }
        TargetState::Resume => {
            emit(
                app,
                "phase",
                "preparing",
                10,
                "检测到未完成的部署，继续安装…",
                None,
            );
        }
        TargetState::Extracted => {
            // 目录里是用户手动解压的完整服务端包：跳过下载与解压，直接进入安装。
            if let Err(reason) = validate_package(&target) {
                return json!({ "ok": false, "reason": reason });
            }
            if let Err(reason) = write_marker(&target, file, &version) {
                return json!({ "ok": false, "reason": reason });
            }
            emit(
                app,
                "phase",
                "preparing",
                10,
                "检测到已解压的服务端目录，直接开始安装…",
                None,
            );
        }
    }

    if CANCEL_REQUESTED.load(Ordering::SeqCst) {
        return json!({
            "ok": false,
            "canceled": true,
            "reason": "部署已停止，已完成步骤会保留",
            "root": target.to_string_lossy(),
        });
    }

    let log_path = match create_log(runtime, &version) {
        Ok(path) => path,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    if let Ok(mut guard) = LOG_FILE.lock() {
        *guard = Some(log_path.clone());
    }
    let cancel_file = log_path.with_extension("stop");
    if let Ok(mut guard) = CANCEL_FILE.lock() {
        *guard = Some(cancel_file.clone());
    }
    let _ = fs::remove_file(&cancel_file);
    emit(app, "phase", "checking", 56, "正在检查环境…", None);

    let result = run_setup(app, &target, &options, &log_path, &cancel_file).await;
    let _ = fs::remove_file(&cancel_file);
    match result {
        Ok((0, _)) if options.check_only => {
            emit(app, "done", "done", 100, "环境检查通过", None);
            json!({
                "ok": true,
                "checked": true,
                "deployed": false,
                "version": version,
                "root": target.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
            })
        }
        Ok((0, _)) => {
            if let Err(reason) = verify_deployed(&target, &options) {
                emit(app, "error", "error", 97, &reason, None);
                return json!({
                    "ok": false,
                    "reason": reason,
                    "root": target.to_string_lossy(),
                    "logPath": log_path.to_string_lossy(),
                });
            }
            remove_marker(&target);
            emit(app, "done", "done", 100, "部署完成", None);
            json!({
                "ok": true,
                "deployed": true,
                "version": version,
                "root": target.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
            })
        }
        Ok((2, _)) => {
            emit(
                app,
                "error",
                "canceled",
                0,
                "部署已停止，已完成步骤会保留",
                None,
            );
            json!({
                "ok": false,
                "canceled": true,
                "reason": "部署已停止，已完成步骤会保留",
                "root": target.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
            })
        }
        Ok((_, reason)) => {
            let reason = if reason.trim().is_empty() {
                "服务端安装没有完成，请查看部署日志".to_string()
            } else {
                reason
            };
            emit(app, "error", "error", 0, &reason, None);
            json!({
                "ok": false,
                "reason": reason,
                "root": target.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
            })
        }
        Err(reason) => {
            emit(app, "error", "error", 0, &reason, None);
            json!({
                "ok": false,
                "reason": reason,
                "root": target.to_string_lossy(),
                "logPath": log_path.to_string_lossy(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn options(purpose: &str, client_path: &str, market_seed: &str) -> DeployOptions {
        DeployOptions {
            purpose: purpose.to_string(),
            client_path: client_path.to_string(),
            install_firewall: false,
            market_seed: market_seed.to_string(),
            check_only: false,
        }
    }

    #[test]
    fn safe_version_rejects_path_traversal() {
        assert!(safe_version("261126.2"));
        assert!(!safe_version("../261126.2"));
        assert!(!safe_version("261126.2/.."));
        assert!(!safe_version(""));
    }

    #[test]
    fn effective_version_repairs_manifest_typo_from_file_name() {
        assert_eq!(
            effective_version("EveJS-261126.2.zip", "261126."),
            "261126.2"
        );
        assert_eq!(
            effective_version("EveJS-261126.2.zip", "261126.2"),
            "261126.2"
        );
        assert_eq!(effective_version("server.zip", "261126.2"), "261126.2");
    }

    #[test]
    fn options_validate_client_and_market() {
        assert!(options("play", "", "none").validate().is_err());
        assert!(options("play", "D:\\EVE", "none").validate().is_ok());
        assert!(options("server", "", "v4").validate().is_ok());
        assert!(options("server", "", "v9").validate().is_err());
    }

    #[test]
    fn target_validation_accepts_empty_and_incomplete_marker() {
        let root = crate::testdir::temp_dir("server-deploy", "target");
        let missing = root.join("new-server");
        assert!(matches!(
            validate_target(&missing, "261126.2").unwrap(),
            TargetState::Empty
        ));

        let existing = root.join("existing");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("file.txt"), "x").unwrap();
        assert!(validate_target(&existing, "261126.2").is_err());

        write_marker(&existing, "EveJS-261126.2.zip", "261126.2").unwrap();
        assert!(matches!(
            validate_target(&existing, "261126.2").unwrap(),
            TargetState::Resume
        ));
        assert!(validate_target(&existing, "261127.1").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_validation_accepts_manually_extracted_package() {
        let root = crate::testdir::temp_dir("server-deploy", "extracted");
        let extracted = root.join("extracted");
        fs::create_dir_all(extracted.join("server")).unwrap();
        fs::create_dir_all(extracted.join("config")).unwrap();
        fs::create_dir_all(extracted.join("tools/Setup")).unwrap();
        fs::write(extracted.join("server/index.js"), "// server").unwrap();
        fs::write(extracted.join("config/version.json"), "{}").unwrap();
        fs::write(extracted.join("tools/Setup/Setup-EvEJS.ps1"), "# setup").unwrap();

        assert!(matches!(
            validate_target(&extracted, "261126.2").unwrap(),
            TargetState::Extracted
        ));
        // 缺少关键文件时不算已解压包。
        fs::remove_file(extracted.join("tools/Setup/Setup-EvEJS.ps1")).unwrap();
        assert!(validate_target(&extracted, "261126.2").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn setup_arguments_follow_setup_wizard_options() {
        let root = Path::new("E:\\EveJS");
        let cancel = root.join("deploy.stop");
        let server = options("server", "", "none");
        let args = setup_arguments(root, &server, &cancel);
        let text = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("-Mode native"));
        assert!(text.contains("-SkipClient"));
        assert!(text.contains("-SkipMarket"));

        let play = DeployOptions {
            install_firewall: true,
            ..options("play", "D:\\EVE", "v4")
        };
        let args = setup_arguments(root, &play, &cancel);
        let text = args
            .iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("-ClientPath D:\\EVE"));
        assert!(text.contains("-InstallFirewall"));
        assert!(text.contains("-MarketSeed v4"));
    }

    #[test]
    fn setup_events_parse_from_stdout() {
        let record = parse_event(
            r#"@evejs-setup {"kind":"result","label":"[ok]","title":"Node.js runtime","detail":"v26.13.1"}"#,
        )
        .unwrap();
        assert_eq!(record_label(&record), "[ok]");
        assert_eq!(record_title(&record), "Node.js runtime");
        assert_eq!(record_detail(&record), "v26.13.1");
        assert!(parse_event("ordinary output").is_none());
    }

    #[test]
    fn extract_zip_keeps_nested_server_paths() {
        let root = crate::testdir::temp_dir("server-deploy", "zip");
        let zip_path = root.join("server.zip");
        let file = File::create(&zip_path).unwrap();
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("server/index.js", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"console.log('ok')").unwrap();
        writer.finish().unwrap();

        let output = root.join("output");
        fs::create_dir_all(&output).unwrap();
        extract_zip(&zip_path, &output).unwrap();
        assert!(output.join("server/index.js").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
