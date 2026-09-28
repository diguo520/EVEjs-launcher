//! 启动器自更新：清单检查 → 下载校验 → 交给 Go 更新器替换 exe。
//!
//! 直译现役版 `src/main/updater.ts`，逐条对齐：
//!   - 状态机与返回形状（`UpdateState` / `UpdateCheckResult`）一字不改，渲染层无需改；
//!   - 每次状态变化都广播 `update:changed`（载荷是数组，见 S2-D20）；
//!   - 清单地址优先级：`EVEJS_UPDATE_MANIFEST_URL` → 设置项 `updateManifestUrl` →
//!     `launcher.config.json.updateManifestUrl` → 内置默认（GitHub Releases）；
//!   - 下载边下边回报，先算 SHA256 再进 `ready`，校验失败删包；
//!   - 替换动作**不重写**：继续复用现役版的 Go 更新器（与外壳框架无关），
//!     `--target/--source/--pid/--from/--to/--restart` 参数逐位一致。
//!
//! 与现役版的差异见 `docs/S2-更新器-实施记录.md`。
use crate::config;
use crate::net;
use crate::runtime::RuntimePaths;
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 与现役版 updater.ts 保持一致，避免迁移期双轨指向不同清单
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/diguo520/EVEjs-launcher/releases/latest/download/update-manifest.json";

/// 清单很小，超时按 API 口径给 30s
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 更新包可能几十 MB：现役版没有下载超时（只能手动取消），这里给一个宽松上限兜底
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// 下载分块大小（与 `net::download` 一致）
const CHUNK: usize = 64 * 1024;

/// 内置维护者公钥（base64 raw Ed25519，32 字节）。
///
/// **空串 = 尚未配置 → 一律拒绝更新**（fail closed，A1）。配置步骤见
/// `docs/S3-查重与审核-实施记录.md`：`node scripts/gen-update-key.mjs` 生成密钥对，
/// 私钥存 CI Secret（发布时签 `update-manifest.json`），公钥粘到这两个常量上。
///
/// 测试与本地演练用 `EVEJS_UPDATE_KEY_ID` / `EVEJS_UPDATE_PUBKEY` 覆盖，不必重编译。
pub const UPDATE_KEY_ID: &str = "";
pub const UPDATE_PUBKEY: &str = "";

/// 允许 `file://` / 本地路径清单的开关（只有 smoke 与本地演练该打开它）
const ALLOW_LOCAL_ENV: &str = "EVEJS_UPDATE_ALLOW_LOCAL";

use crate::win32::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

/// 更新器进程句柄名（随包放在 exe 同级，见 `updater_helper_path`）
/// 自更新器文件名：单文件版 (`seed.rs`) 释放侧车时也用同一个名字，单一来源由查重门禁守住
pub(crate) const UPDATER_NAME: &str = "evejs-updater.exe";

#[derive(Clone)]
struct UpdateStore {
    state: String,
    latest_version: Option<String>,
    channel: Option<String>,
    size: Option<u64>,
    downloaded: Option<u64>,
    percent: Option<f64>,
    speed: Option<f64>,
    message: Option<String>,
    manifest: Option<Value>,
    asset: Option<Value>,
    downloaded_path: Option<PathBuf>,
}

impl Default for UpdateStore {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            latest_version: None,
            channel: None,
            size: None,
            downloaded: None,
            percent: None,
            speed: None,
            message: None,
            manifest: None,
            asset: None,
            downloaded_path: None,
        }
    }
}

/// 进程级更新状态：渲染层首屏就调 `update:state`，所以必须是全局的
static STORE: LazyLock<Mutex<UpdateStore>> = LazyLock::new(|| Mutex::new(UpdateStore::default()));
/// 下载取消标志：`update:cancel` 与下载循环之间唯一的通信手段
static CANCEL: AtomicBool = AtomicBool::new(false);

fn store() -> MutexGuard<'static, UpdateStore> {
    STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn version_of(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 非空的目录型环境变量（对齐 JS 里 `process.env.X` 的空串为假）
fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 打包态判定：release 构建即视为已打包（对齐现役版 `app.isPackaged`）
fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

/// 现役版 `targetPath()`：最终要被替换掉的那个 exe
fn target_path() -> PathBuf {
    if let Some(path) = env_dir("EVEJS_UPDATE_TARGET_PATH") {
        return path;
    }
    if let Some(path) = env_dir("PORTABLE_EXECUTABLE_FILE") {
        return path;
    }
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."))
}

/// 现役版 `configBaseDir()`：便携版读 exe 旁，dev 读当前目录
fn config_base_dir() -> PathBuf {
    if let Some(dir) = env_dir("PORTABLE_EXECUTABLE_DIR") {
        return dir;
    }
    if !is_packaged() {
        return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    exe_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 现役版里的 `value.trim() || undefined`：空白串等于没配（三个候选源共用）
fn trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 解析出「用哪个 keyId / 公钥」验签（env 覆盖优先，便于本地演练与单测）
fn update_signer_from(env_key_id: Option<&str>, env_pubkey: Option<&str>) -> (String, String) {
    let key_id = env_key_id
        .and_then(trimmed)
        .unwrap_or_else(|| UPDATE_KEY_ID.to_string());
    let pubkey = env_pubkey
        .and_then(trimmed)
        .unwrap_or_else(|| UPDATE_PUBKEY.to_string());
    (key_id, pubkey)
}

fn update_signer() -> (String, String) {
    let env_key_id = std::env::var("EVEJS_UPDATE_KEY_ID").ok();
    let env_pubkey = std::env::var("EVEJS_UPDATE_PUBKEY").ok();
    update_signer_from(env_key_id.as_deref(), env_pubkey.as_deref())
}

/// A1：清单必须由内置维护者公钥签名，否则一律拒绝（fail closed）
fn verify_update_manifest(payload: &Value) -> Result<(), String> {
    let (key_id, pubkey) = update_signer();
    crate::mods::sign::verify_signature_with_key(payload, &key_id, &pubkey)
}

/// 是否允许本地清单（`file://` / 绝对路径）。默认关闭：本地文件是可被改写的输入，
/// 只在 smoke 与本地演练时用 `EVEJS_UPDATE_ALLOW_LOCAL=1` 打开。
fn local_manifest_allowed() -> bool {
    matches!(
        std::env::var(ALLOW_LOCAL_ENV).unwrap_or_default().as_str(),
        "1" | "true" | "yes"
    )
}

/// 现役版 `resolveManifestUrl()` 的纯函数部分（env 单独读，便于单测不碰进程环境）
///
/// `allow_config_file`：A1 要求**打包版忽略 `launcher.config.json`**（它躺在 exe 旁边，
/// 是最容易被第三方改写的输入）；dev 构建仍读它，方便本地调试。
fn manifest_url_from(
    from_env: Option<&str>,
    settings: &Map<String, Value>,
    config_base: &Path,
    allow_config_file: bool,
) -> String {
    if let Some(value) = from_env.and_then(trimmed) {
        return value;
    }
    if let Some(value) = settings
        .get("updateManifestUrl")
        .and_then(Value::as_str)
        .and_then(trimmed)
    {
        return value;
    }
    if allow_config_file {
        let file = config_base.join("launcher.config.json");
        if let Ok(raw) = std::fs::read_to_string(file) {
            if let Ok(value) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
                if let Some(value) = value
                    .get("updateManifestUrl")
                    .and_then(Value::as_str)
                    .and_then(trimmed)
                {
                    return value;
                }
            }
        }
    }
    DEFAULT_MANIFEST_URL.to_string()
}

fn resolve_manifest_url(runtime: &RuntimePaths) -> String {
    let from_env = std::env::var("EVEJS_UPDATE_MANIFEST_URL").ok();
    let settings = config::read_settings(&runtime.settings_file());
    manifest_url_from(
        from_env.as_deref(),
        &settings,
        &config_base_dir(),
        // 打包版忽略 exe 旁的 launcher.config.json（A1）
        !is_packaged(),
    )
}

/// 现役版 `parseJson`：先剥 BOM（Windows 记事本存过的清单带 BOM，JSON.parse 会炸）
fn parse_manifest(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|err| format!("更新清单解析失败：{err}"))
}

/// `file://` 转本地路径：只认盘符形式（`file:///C:/x.json`）与 %20，
/// 够覆盖「用环境变量指一个本地清单」的开发场景
fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let decoded = rest.replace("%20", " ");
    let bytes = decoded.as_bytes();
    let normalized = if bytes.len() > 2 && bytes[0] == b'/' && bytes[2] == b':' {
        &decoded[1..]
    } else {
        &decoded[..]
    };
    Some(PathBuf::from(normalized))
}

/// 读清单：默认**只认 HTTPS**；`allow_local` 打开时才允许 `file://` 与绝对路径
/// （A1：本地文件是能被第三方改写的输入，只有 smoke / 本地演练该用它）
fn read_manifest(url: &str, allow_local: bool) -> Result<Value, String> {
    let local = if allow_local {
        file_url_path(url)
            .filter(|path| path.is_file())
            .or_else(|| {
                let path = Path::new(url);
                if path.is_absolute() && path.is_file() {
                    Some(path.to_path_buf())
                } else {
                    None
                }
            })
    } else {
        None
    };
    if let Some(path) = local {
        let raw =
            std::fs::read_to_string(&path).map_err(|err| format!("读取更新清单失败：{err}"))?;
        return parse_manifest(&raw);
    }
    if !url.starts_with("https://") {
        return Err(format!(
            "更新清单地址必须是 https 或 file://，当前：{url}（本地清单需设置 {ALLOW_LOCAL_ENV}=1）"
        ));
    }
    let response = net::get(url, "application/json", MANIFEST_TIMEOUT)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("更新服务器返回 HTTP {}", response.status));
    }
    parse_manifest(&response.text())
}

/// 现役版 `parseVersion`：去 `v` 前缀、按 `.` 切、每段取前导数字（取不到算 0）
fn parse_version(value: &str) -> Vec<i64> {
    let raw = if value.is_empty() { "0.0.0" } else { value };
    let stripped = raw
        .strip_prefix('v')
        .or_else(|| raw.strip_prefix('V'))
        .unwrap_or(raw);
    stripped
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().unwrap_or(0)
        })
        .collect()
}

/// 现役版 `compareVersion`：逐段比数字，短的一侧补 0
fn compare_version(left: &str, right: &str) -> i64 {
    let a = parse_version(left);
    let b = parse_version(right);
    let length = a.len().max(b.len());
    for index in 0..length {
        let delta = a.get(index).copied().unwrap_or(0) - b.get(index).copied().unwrap_or(0);
        if delta != 0 {
            return delta;
        }
    }
    0
}

/// `${process.platform}-${process.arch}`；Windows 上是 `win32-x64` / `win32-arm64`
fn platform_keys() -> Vec<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    vec![format!("win32-{arch}"), "win32-x64".to_string()]
}

/// 现役版 `platformAsset`：先按本机 key 找，找不到再退 `win32-x64`
fn platform_asset(manifest: &Value) -> Option<Value> {
    let platforms = manifest.get("platforms")?;
    for key in platform_keys() {
        if let Some(asset) = platforms.get(&key) {
            if asset.is_object() {
                return Some(asset.clone());
            }
        }
    }
    None
}
/* ------------------------------ 状态读写与广播 ------------------------------ */

/// `UpdateState` 形状；可选字段缺省即不下发（对齐 JS 里 `undefined` 被 JSON 丢掉的行为）
fn snapshot(app: &AppHandle) -> Value {
    let store = store();
    let mut map = Map::new();
    map.insert("state".to_string(), json!(store.state));
    map.insert("currentVersion".to_string(), json!(version_of(app)));
    if let Some(value) = &store.latest_version {
        map.insert("latestVersion".to_string(), json!(value));
    }
    if let Some(value) = &store.channel {
        map.insert("channel".to_string(), json!(value));
    }
    if let Some(value) = store.size {
        map.insert("size".to_string(), json!(value));
    }
    if let Some(value) = store.downloaded {
        map.insert("downloaded".to_string(), json!(value));
    }
    if let Some(value) = store.percent {
        map.insert("percent".to_string(), json!(value));
    }
    if let Some(value) = store.speed {
        map.insert("speed".to_string(), json!(value));
    }
    if let Some(value) = &store.message {
        map.insert("message".to_string(), json!(value));
    }
    Value::Object(map)
}

/// 改状态 + 广播：现役版是 `state = {...state, ...patch}` 再 `update:changed`
fn patch(app: &AppHandle, mutate: impl FnOnce(&mut UpdateStore)) {
    {
        let mut store = store();
        mutate(&mut store);
    }
    // 载荷是数组：渲染层 shim 的 on() 按位置展开成回调参数（见 S2-D20）
    let _ = app.emit("update:changed", json!([snapshot(app)]));
}

/// 现役版 `currentUpdateState()`：渲染层首屏取的初始形状
pub fn current_state(app: &AppHandle) -> Value {
    snapshot(app)
}

/// 现役版 `cancelUpdateDownload()`：置标志 + 立刻回 idle（下载循环下一块就收手）
pub fn cancel_download(app: &AppHandle) {
    CANCEL.store(true, Ordering::SeqCst);
    patch(app, |store| {
        store.state = "idle".to_string();
        store.message = Some("已取消下载".to_string());
    });
}

/* -------------------------------- 检查更新 -------------------------------- */

/// 现役版 `checkForUpdates()`；返回 `UpdateCheckResult`
pub fn check_for_updates(app: &AppHandle, runtime: &RuntimePaths) -> Value {
    let current = version_of(app);
    patch(app, |store| {
        store.state = "checking".to_string();
        store.message = Some("正在检查更新…".to_string());
    });

    let manifest_url = resolve_manifest_url(runtime);
    if manifest_url.is_empty() {
        return check_failure(app, &current, "未配置 updateManifestUrl");
    }
    let remote = match read_manifest(&manifest_url, local_manifest_allowed()) {
        Ok(value) => value,
        Err(reason) => return check_failure(app, &current, &reason),
    };
    // A1：验签先行 —— 签名不过，清单里的任何字段（版本号、URL、哈希）都不看
    if let Err(reason) = verify_update_manifest(&remote) {
        let reason = format!("更新清单校验失败：{reason}");
        return check_failure(app, &current, &reason);
    }
    let Some(asset) = platform_asset(&remote) else {
        return check_failure(app, &current, "更新清单中没有当前平台");
    };
    let minimum = remote
        .get("minimumVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !minimum.is_empty() && compare_version(&current, minimum) < 0 {
        let reason = format!("当前版本过低，最低要求 {minimum}");
        return check_failure(app, &current, &reason);
    }

    let latest = remote
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let available = compare_version(&latest, &current) > 0;
    let channel = remote
        .get("channel")
        .and_then(Value::as_str)
        .map(str::to_string);
    let size = asset.get("size").and_then(Value::as_u64);

    patch(app, |store| {
        store.state = if available {
            "available".to_string()
        } else {
            "idle".to_string()
        };
        store.latest_version = Some(latest.clone());
        store.channel = channel.clone();
        store.size = size;
        store.message = Some(
            if available {
                "发现新版本"
            } else {
                "已是最新版本"
            }
            .to_string(),
        );
        store.manifest = Some(remote.clone());
        store.asset = Some(asset.clone());
    });

    let mut result = Map::new();
    result.insert("ok".to_string(), json!(true));
    result.insert("available".to_string(), json!(available));
    result.insert("currentVersion".to_string(), json!(current));
    result.insert("latestVersion".to_string(), json!(latest));
    if let Some(value) = size {
        result.insert("size".to_string(), json!(value));
    }
    if let Some(value) = remote.get("publishedAt").and_then(Value::as_str) {
        result.insert("date".to_string(), json!(value));
    }
    if let Some(value) = &channel {
        result.insert("channel".to_string(), json!(value));
    }
    result.insert(
        "changelog".to_string(),
        remote
            .get("changelog")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    result.insert("manifestUrl".to_string(), json!(manifest_url));
    result.insert(
        "targetPath".to_string(),
        json!(target_path().to_string_lossy()),
    );
    Value::Object(result)
}

/// 检查失败的统一回包：状态进 `error`，形状与现役版 catch 分支一致
fn check_failure(app: &AppHandle, current: &str, reason: &str) -> Value {
    patch(app, |store| {
        store.state = "error".to_string();
        store.message = Some(reason.to_string());
    });
    json!({ "ok": false, "available": false, "currentVersion": current, "reason": reason })
}

/* -------------------------------- 下载更新 -------------------------------- */

/// 现役版 `downloadUpdate()`：没检查过就顺手检查一次
pub fn download_update(app: &AppHandle, runtime: &RuntimePaths) -> Value {
    let (manifest, asset) = {
        let store = store();
        (store.manifest.clone(), store.asset.clone())
    };
    let (manifest, asset) = match (manifest, asset) {
        (Some(manifest), Some(asset)) => (manifest, asset),
        _ => {
            let checked = check_for_updates(app, runtime);
            if checked.get("ok") != Some(&json!(true))
                || checked.get("available") != Some(&json!(true))
            {
                let reason = checked
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("没有可用更新")
                    .to_string();
                return json!({ "ok": false, "reason": reason });
            }
            let store = store();
            (
                store.manifest.clone().unwrap_or(Value::Null),
                store.asset.clone().unwrap_or(Value::Null),
            )
        }
    };

    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let directory = update_temp_dir(&version);
    if let Err(err) = std::fs::create_dir_all(&directory) {
        let reason = format!("创建更新目录失败：{err}");
        patch(app, |store| {
            store.state = "error".to_string();
            store.message = Some(reason.clone());
        });
        return json!({ "ok": false, "reason": reason });
    }

    let destination = directory.join(format!("launcher-{version}.exe"));
    let url = asset
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expected_size = asset.get("size").and_then(Value::as_u64);
    CANCEL.store(false, Ordering::SeqCst);
    let started = Instant::now();

    let digest = match download_to_file(app, &url, &destination, expected_size, started) {
        Ok(digest) => digest,
        Err(reason) => {
            let _ = std::fs::remove_file(&destination);
            let cancelled = CANCEL.load(Ordering::SeqCst);
            patch(app, |store| {
                store.state = if cancelled {
                    "idle".to_string()
                } else {
                    "error".to_string()
                };
                store.message = Some(reason.clone());
            });
            return json!({ "ok": false, "reason": reason });
        }
    };

    let expected = asset
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if !expected.is_empty() && digest.to_lowercase() != expected {
        let _ = std::fs::remove_file(&destination);
        let reason = "更新包 SHA256 校验失败".to_string();
        patch(app, |store| {
            store.state = "error".to_string();
            store.message = Some(reason.clone());
        });
        return json!({ "ok": false, "reason": reason });
    }

    let size = expected_size.unwrap_or_else(|| {
        std::fs::metadata(&destination)
            .map(|meta| meta.len())
            .unwrap_or(0)
    });
    patch(app, |store| {
        store.downloaded_path = Some(destination.clone());
        store.state = "ready".to_string();
        store.downloaded = Some(size);
        store.percent = Some(100.0);
        store.message = Some("更新已下载完成".to_string());
    });
    json!({ "ok": true, "path": destination.to_string_lossy() })
}

/// 现役版 `tempUpdateDir`：OS 临时目录（不是 `_launcher/temp`，两处就不同，照搬）
fn update_temp_dir(version: &str) -> PathBuf {
    std::env::temp_dir()
        .join("EveJS-Launcher-Updater")
        .join(version)
}

/// 现役版 `downloadToFile`：本地路径 / `file://` 直接搬，其余走 HTTPS；
/// 都支持取消与进度回调，返回落盘后的 SHA256（小写 hex）
fn download_to_file(
    app: &AppHandle,
    url: &str,
    destination: &Path,
    expected_size: Option<u64>,
    started: Instant,
) -> Result<String, String> {
    let local = file_url_path(url)
        .filter(|path| path.is_file())
        .or_else(|| {
            let path = Path::new(url);
            if path.is_absolute() && path.is_file() {
                Some(path.to_path_buf())
            } else {
                None
            }
        });
    match local {
        Some(source) => copy_local(app, &source, destination, expected_size, started)?,
        None => {
            net::download_cancellable(
                url,
                destination,
                UPDATE_DOWNLOAD_TIMEOUT,
                || CANCEL.load(Ordering::SeqCst),
                |downloaded, total| emit_progress(app, downloaded, total, started),
            )?;
        }
    }
    let (digest, _) = crate::mods::pkg::sha256_file(destination)?;
    Ok(digest)
}

/// 本地更新包分块搬运（现役版走 `fs.createReadStream`，同样按块回报进度）
fn copy_local(
    app: &AppHandle,
    source: &Path,
    destination: &Path,
    expected_size: Option<u64>,
    started: Instant,
) -> Result<(), String> {
    let mut input =
        std::fs::File::open(source).map_err(|err| format!("打不开本地更新包：{err}"))?;
    let mut output =
        std::fs::File::create(destination).map_err(|err| format!("写不进目标文件：{err}"))?;
    let mut buffer = vec![0u8; CHUNK];
    let mut downloaded: u64 = 0;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(net::CANCELLED.to_string());
        }
        let read = input
            .read(&mut buffer)
            .map_err(|err| format!("读取本地更新包失败：{err}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|err| format!("写盘失败：{err}"))?;
        downloaded += read as u64;
        emit_progress(app, downloaded, expected_size, started);
    }
    let _ = output.flush();
    Ok(())
}

/// 进度广播：percent 以「预期大小」为分母（取不到就按已下载量算 100%），speed 是平均速度
fn emit_progress(app: &AppHandle, downloaded: u64, expected_size: Option<u64>, started: Instant) {
    let elapsed = started.elapsed().as_secs_f64().max(0.1);
    let total = expected_size.unwrap_or(downloaded);
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let speed = downloaded as f64 / elapsed;
    patch(app, |store| {
        store.state = "downloading".to_string();
        store.downloaded = Some(downloaded);
        store.size = expected_size;
        store.percent = Some(percent);
        store.speed = Some(speed);
        store.message = Some("正在下载更新…".to_string());
    });
}
/* -------------------------------- 安装更新 -------------------------------- */

/// 现役版 `applyUpdate()`：把下载好的包交给 Go 更新器，然后自己退出。
///
/// 更新器是独立进程，与外壳框架无关，**Go 侧一行都不用改**；本函数只负责
/// 「参数与现役版逐位一致 + 用 DETACHED 让它活过本进程」。
pub fn apply_update(app: &AppHandle, runtime: &RuntimePaths) -> Value {
    let downloaded = store().downloaded_path.clone();
    let Some(downloaded) = downloaded.filter(|path| path.is_file()) else {
        return json!({ "ok": false, "reason": "尚未下载更新包" });
    };
    if !is_packaged() && env_dir("EVEJS_UPDATE_TARGET_PATH").is_none() {
        return json!({
            "ok": false,
            "reason": "开发模式不支持自动替换，请使用打包后的便携版测试更新"
        });
    }
    let active: Vec<String> = app
        .state::<crate::AppState>()
        .services
        .snapshot()
        .into_iter()
        .filter(|info| info.state != "idle" && info.state != "error")
        .map(|info| info.name)
        .collect();
    if !active.is_empty() {
        return json!({ "ok": false, "reason": "请先停止主服务器和市场服务" });
    }
    let Some(helper) = updater_helper_path() else {
        return json!({ "ok": false, "reason": "更新器不存在" });
    };

    let version = store()
        .manifest
        .as_ref()
        .and_then(|manifest| manifest.get("version"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let temp_root = runtime.temp.clone();
    let temp_dir = temp_root
        .join("EveJS-Launcher-Updater")
        .join(if version.is_empty() {
            "current".to_string()
        } else {
            version.clone()
        });
    if let Err(err) = std::fs::create_dir_all(&temp_dir) {
        return apply_failure(app, &format!("创建临时目录失败：{err}"));
    }
    // 先拷一份再用拷贝启动：更新器替换 exe 时不会把自己锁在半路
    let helper_copy = temp_dir.join(UPDATER_NAME);
    if let Err(err) = std::fs::copy(&helper, &helper_copy) {
        return apply_failure(app, &format!("复制更新器失败：{err}"));
    }

    let mut command = std::process::Command::new(&helper_copy);
    command
        .arg("--target")
        .arg(target_path())
        .arg("--source")
        .arg(&downloaded)
        .arg("--pid")
        .arg(std::process::id().to_string())
        // Tauri 便携版没有 Electron 的 portable 包装进程，父 PID 传 0（Go 侧 <=0 即跳过）
        .arg("--parent-pid")
        .arg("0")
        .arg("--from")
        .arg(version_of(app))
        .arg("--to")
        .arg(&version)
        .arg("--restart")
        .env("TMPDIR", &temp_root)
        .env("TMP", &temp_root)
        .env("TEMP", &temp_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    if let Err(err) = command.spawn() {
        return apply_failure(app, &format!("拉起更新器失败：{err}"));
    }

    patch(app, |store| {
        store.state = "applying".to_string();
        store.message = Some("正在安装更新…".to_string());
    });
    // 现役版 setTimeout(() => app.quit(), 500)：留一点时间把 applying 事件送出去
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        app.exit(0);
    });
    json!({ "ok": true })
}

fn apply_failure(app: &AppHandle, reason: &str) -> Value {
    patch(app, |store| {
        store.state = "error".to_string();
        store.message = Some(reason.to_string());
    });
    json!({ "ok": false, "reason": reason })
}

/// 更新器查找顺序（对齐 `sidecar::script_path` 的思路：覆盖 → 随包 → 开发态）：
///   1. `EVEJS_UPDATER_DIR`                      —— 测试/部署覆盖
///   2. `<exeDir>/evejs-updater.exe`             —— Electron 便携版布局（resourcesPath 就是 exe 目录）
///   3. `<exeDir>/_launcher/updater/…`           —— 新便携版布局（build.ps1 从 vendor/updater 拷贝）
///   4. `<exeDir>/resources/…`                   —— 打包版 extraResources 布局
///   5. `../vendor/updater/bin/…`                —— 开发态，`cargo run` 无需先拷贝
fn updater_helper_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = env_dir("EVEJS_UPDATER_DIR") {
        candidates.push(dir.join(UPDATER_NAME));
    }
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join(UPDATER_NAME));
        candidates.push(dir.join("_launcher").join("updater").join(UPDATER_NAME));
        candidates.push(dir.join("resources").join(UPDATER_NAME));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("updater")
            .join("bin")
            .join(UPDATER_NAME),
    );
    candidates.into_iter().find(|path| path.is_file())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "evejs-updater-{tag}-{}",
            crate::mods::pkg::epoch_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifest_url_matches_electron_build() {
        assert!(DEFAULT_MANIFEST_URL.ends_with("update-manifest.json"));
        assert!(DEFAULT_MANIFEST_URL.starts_with("https://"));
    }

    #[test]
    fn version_comparison_matches_electron() {
        assert_eq!(compare_version("1.2.3", "1.2.3"), 0);
        assert_eq!(compare_version("1.2.4", "1.2.3"), 1);
        assert_eq!(compare_version("1.2.3", "1.2.4"), -1);
        // 短的一侧补 0
        assert_eq!(compare_version("1.2", "1.2.0"), 0);
        // 逐段取前导数字：预发布标签等价于 0（与现役版一致，非 semver）
        assert_eq!(compare_version("1.0.0-beta", "1.0.0"), 0);
        assert_eq!(compare_version("V1.0.0", "1.0.0"), 0);
        assert_eq!(compare_version("abc", "0.0.0"), 0);
        assert_eq!(parse_version(""), vec![0, 0, 0]);
        assert_eq!(parse_version("v0.12.8"), vec![0, 12, 8]);
    }

    #[test]
    fn platform_asset_prefers_native_then_win32_x64() {
        let manifest = json!({
            "platforms": {
                "win32-arm64": { "url": "https://example.com/arm64.exe" },
                "win32-x64": { "url": "https://example.com/x64.exe" }
            }
        });
        let expected = if platform_keys()[0] == "win32-arm64" {
            "https://example.com/arm64.exe"
        } else {
            "https://example.com/x64.exe"
        };
        assert_eq!(platform_asset(&manifest).unwrap()["url"], json!(expected));
        // 本机 key 缺失时退 win32-x64
        let only_x64 = json!({ "platforms": { "win32-x64": { "url": "u" } } });
        assert_eq!(platform_asset(&only_x64).unwrap()["url"], json!("u"));
        assert!(platform_asset(&json!({ "platforms": {} })).is_none());
        assert!(platform_asset(&json!({})).is_none());
    }

    #[test]
    fn manifest_url_priority_follows_electron() {
        let base = temp_dir("urlcfg");
        let settings = |value: Option<&str>| {
            let mut map = Map::new();
            if let Some(text) = value {
                map.insert("updateManifestUrl".to_string(), json!(text));
            }
            map
        };
        // 1) 环境变量最优先，且首尾空白会被 trim
        assert_eq!(
            manifest_url_from(
                Some("  https://env/m.json  "),
                &settings(Some("https://settings/m.json")),
                &base,
                true
            ),
            "https://env/m.json"
        );
        // 2) 环境变量只有空白 → 当作没配，退设置项
        assert_eq!(
            manifest_url_from(
                Some("   "),
                &settings(Some("https://settings/m.json")),
                &base,
                true
            ),
            "https://settings/m.json"
        );
        // 3) 设置项也没有 → 读 launcher.config.json
        std::fs::write(
            base.join("launcher.config.json"),
            "{\"updateManifestUrl\":\"https://config/m.json\"}",
        )
        .unwrap();
        assert_eq!(
            manifest_url_from(None, &settings(None), &base, true),
            "https://config/m.json"
        );
        // 3b) 打包版（allow_config_file=false）忽略 exe 旁的配置，直接落到内置默认
        assert_eq!(
            manifest_url_from(None, &settings(None), &base, false),
            DEFAULT_MANIFEST_URL
        );
        // 4) 都没有 → 内置默认
        std::fs::write(base.join("launcher.config.json"), "{}").unwrap();
        assert_eq!(
            manifest_url_from(None, &settings(None), &base, true),
            DEFAULT_MANIFEST_URL
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_reader_accepts_local_files() {
        let base = temp_dir("manifest");
        let manifest = json!({
            "schemaVersion": 1,
            "channel": "stable",
            "version": "9.9.9",
            "minimumVersion": "0.1.0",
            "publishedAt": "2026-01-01",
            "changelog": [{ "type": "new", "text": "x" }],
            "platforms": {
                "win32-x64": {
                    "url": "https://example.com/a.exe",
                    "sha256": "AB",
                    "size": 12
                }
            }
        });
        let text = serde_json::to_string_pretty(&manifest).unwrap();
        let path = base.join("update-manifest.json");
        // 记事本存过的清单带 BOM，必须能读（现役版 parseJson 就是干这个的）
        std::fs::write(&path, format!("\u{feff}{text}")).unwrap();

        // 默认只认 https：本地路径必须显式开开关（A1）
        assert!(read_manifest(&path.to_string_lossy(), false)
            .unwrap_err()
            .contains("必须是 https"));
        let direct = read_manifest(&path.to_string_lossy(), true).unwrap();
        assert_eq!(direct["version"], json!("9.9.9"));
        assert_eq!(platform_asset(&direct).unwrap()["sha256"], json!("AB"));

        let url = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
        assert_eq!(
            read_manifest(&url, true).unwrap()["channel"],
            json!("stable")
        );

        // 非法 JSON：给明确文案，而不是 panic
        std::fs::write(&path, "<html>502</html>").unwrap();
        assert!(read_manifest(&path.to_string_lossy(), true)
            .unwrap_err()
            .contains("解析失败"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A1 夹具：维护者公钥验签 —— 未签名 / 篡改版本号 / 换 asset URL / 换签名 / keyId 张冠李戴
    /// 必须全部拒绝，正版签名必须通过
    #[test]
    fn update_manifest_must_be_signed_by_builtin_key() {
        let sign = crate::mods::sign::generate_signing_key().expect("生成测试密钥");
        let public_key = crate::mods::sign::public_key_base64(&sign);
        let key_id = crate::mods::sign::key_id_of(&sign);
        let verify = |payload: &Value| {
            crate::mods::sign::verify_signature_with_key(payload, &key_id, &public_key)
        };

        let base = json!({
            "schemaVersion": 2,
            "channel": "stable",
            "version": "0.2.1",
            "publishedAt": "2026-01-01",
            "platforms": {
                "win32-x64": { "url": "https://example.com/a.exe", "sha256": "AA", "size": 1 }
            }
        });
        // 没签名 → 拒；公钥没配 → 拒（fail closed）
        assert!(verify(&base).unwrap_err().contains("缺少 signature"));
        assert!(crate::mods::sign::verify_signature_with_key(&base, "", "")
            .unwrap_err()
            .contains("尚未配置维护者公钥"));

        let mut signed = base.clone();
        signed["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id,
            "sig": crate::mods::sign::sign_manifest(&base, &sign)
        });
        verify(&signed).unwrap();

        // 篡改版本号
        let mut tampered = signed.clone();
        tampered["version"] = json!("9.9.9");
        assert!(verify(&tampered).unwrap_err().contains("已被修改"));

        // 换 asset URL（诱导下载别的 exe）
        let mut swapped = signed.clone();
        swapped["platforms"]["win32-x64"]["url"] = json!("https://evil.example/a.exe");
        assert!(verify(&swapped).is_err());

        // 换签名：用别人的密钥签同一份清单
        let other = crate::mods::sign::generate_signing_key().expect("生成第二把测试密钥");
        let mut foreign = signed.clone();
        foreign["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id,
            "sig": crate::mods::sign::sign_manifest(&base, &other)
        });
        assert!(verify(&foreign).is_err());

        // keyId 张冠李戴（公钥与 keyId 不是一对）
        let mut wrong_key_id = signed.clone();
        wrong_key_id["signature"] = json!({
            "alg": "ed25519",
            "keyId": "deadbeefdead",
            "sig": crate::mods::sign::sign_manifest(&base, &sign)
        });
        assert!(verify(&wrong_key_id).unwrap_err().contains("不受信任"));
    }

    #[test]
    fn update_signer_prefers_env_over_builtin() {
        assert_eq!(
            update_signer_from(None, None),
            (UPDATE_KEY_ID.to_string(), UPDATE_PUBKEY.to_string())
        );
        // 只有空白 → 当作没配
        assert_eq!(
            update_signer_from(Some("  "), Some("  ")),
            update_signer_from(None, None)
        );
        // env 覆盖生效（本地演练不必重编译）
        assert_eq!(
            update_signer_from(Some(" k1 "), Some(" pk ")),
            ("k1".to_string(), "pk".to_string())
        );
        // 没配公钥时任何清单都过不了
        assert!(verify_update_manifest(&json!({ "schemaVersion": 2 })).is_err());
    }

    #[test]
    fn temp_dirs_and_file_urls_match_electron() {
        let dir = update_temp_dir("1.2.3");
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(dir.ends_with(Path::new("EveJS-Launcher-Updater").join("1.2.3")));
        assert_eq!(file_url_path("https://example.com/a.json"), None);
        assert_eq!(
            file_url_path("file:///C:/a%20b/m.json"),
            Some(PathBuf::from("C:/a b/m.json"))
        );
    }

    /// §5.2「交叉验证」：JS（scripts/gen-update-key.mjs）签出的清单，Rust 必须能验过。
    ///
    /// 这条用例真正锁住的是**规范化规则**：JS 侧 `canonicalManifestJson`（递归 key 升序、紧凑、去掉 signature）
    /// 必须与 Rust `canonical_manifest_json` 逐字节一致。规则一漂，这里立刻红。
    #[test]
    fn js_signed_manifest_verifies_in_rust() {
        // 固定向量：种子私钥 = sha256("evejs-s3-parity-fixture")，见 tests/parity/gen-manifest-fixtures.mjs
        const FIXTURE_KEY_ID: &str = "evejs-parity-fixture";
        const FIXTURE_PUBKEY: &str = "fDkGYSbWJoAYFSHj/TRjZm3NXx+7Rr4scyJLPN/5mdc=";
        // 三个 fixture 与 JS 侧（tests/parity/run.mjs）读的是**同一份文件**，规范化规则一漂就红
        let valid: Value = serde_json::from_str(include_str!(
            "../../tests/parity/fixtures/manifest/valid.json"
        ))
        .expect("valid.json 必须是合法 JSON");
        let tampered: Value = serde_json::from_str(include_str!(
            "../../tests/parity/fixtures/manifest/tampered.json"
        ))
        .expect("tampered.json 必须是合法 JSON");
        let bad: Value = serde_json::from_str(include_str!(
            "../../tests/parity/fixtures/manifest/bad-signature.json"
        ))
        .expect("bad-signature.json 必须是合法 JSON");

        crate::mods::sign::verify_signature_with_key(&valid, FIXTURE_KEY_ID, FIXTURE_PUBKEY)
            .expect("Rust 必须能验过 JS 签出的清单");
        assert!(
            crate::mods::sign::verify_signature_with_key(&tampered, FIXTURE_KEY_ID, FIXTURE_PUBKEY)
                .is_err(),
            "篡改版本号后必须拒绝"
        );
        assert!(
            crate::mods::sign::verify_signature_with_key(&bad, FIXTURE_KEY_ID, FIXTURE_PUBKEY)
                .is_err(),
            "签名被改动后必须拒绝"
        );
        // 换个 keyId 冒充 → 必须拒绝（内置公钥只认自己那把）
        assert!(crate::mods::sign::verify_signature_with_key(
            &valid,
            "someone-else",
            FIXTURE_PUBKEY
        )
        .is_err());

        // 规范化负载必须与 JS 侧一致（改动这里要同步改 gen-update-key.mjs / gen-manifest-fixtures.mjs）
        let canonical = crate::mods::sign::canonical_manifest_json(&valid);
        assert!(
            canonical.starts_with(r#"{"notes":{"zh-CN":"新版本"},"#),
            "{canonical}"
        );
    }

    #[test]
    fn helper_lookup_finds_vendored_updater() {
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("updater")
            .join("bin")
            .join(UPDATER_NAME);
        // 没预编译更新器时跳过（build.ps1 的第 6 步负责补上）
        if !expected.is_file() {
            return;
        }
        assert!(updater_helper_path().is_some());
    }
}
