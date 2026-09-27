//! 仓库根目录探测：逐条对齐现役版 src/main/envDetector.ts 的 resolveRepoRoot 四级策略。
//! 现役版第 4 步的注释值得保留：绝不允许探测失败时把日志/设置写到任意的当前目录
//! （历史上曾导致日志落在 AppData 下）。
use crate::runtime::RuntimePaths;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::win32::CREATE_NO_WINDOW;

/// 给一个目录打分：越像 EveJS 项目根分越高，0 = 不像。逐条对齐现役版 `src/main/ipc.ts::repoRootScore`：
/// 新版服务端用 `server/index.js`（npm start），旧版用 `server/autostart.js`，**两种都认**。
/// 只认旧标记会让 0.12.8 及以后的安装既探测不到、也存不下根目录（S2 因此放弃了真仓库 e2e）。
/// 分级用于在多个候选目录里挑最像的那个，避免选中同名的旧目录。
pub fn repo_root_score(path: &Path) -> u8 {
    let server = path.join("server");
    let has_start_script = path.join("StartServer.bat").is_file();
    let has_server_index = server.join("index.js").is_file();
    let has_legacy_autostart = server.join("autostart.js").is_file();
    let has_server_package = server.join("package.json").is_file();

    if has_start_script && has_server_index {
        4
    } else if has_start_script && has_legacy_autostart {
        3
    } else if has_server_index && has_server_package {
        2
    } else if has_legacy_autostart {
        1
    } else {
        0
    }
}

pub fn is_repo_root(path: &Path) -> bool {
    repo_root_score(path) > 0
}

fn env_dir(key: &str) -> Option<PathBuf> {
    match std::env::var_os(key) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

fn looks_like_temp(path: &Path) -> bool {
    let text = path.to_string_lossy().to_lowercase();
    if text.contains("\\temp\\") || text.contains("\\tmp\\") {
        return true;
    }
    match env_dir("TEMP") {
        Some(temp) => text.starts_with(&temp.to_string_lossy().to_lowercase()),
        None => false,
    }
}

/// launcher.config.json 所在位置：便携版放 exe 旁，开发态放当前目录。
///
/// 2026-09-27 修：原来只认 PORTABLE_EXECUTABLE_DIR / cwd。从快捷方式启动、或工作目录被改成
/// 别处时，exe 旁的 launcher.config.json 会被漏读（根目录随之回落成 cwd，模组与数据库全指错）。
/// 现在优先「哪个目录真的有配置文件就用哪个」，都没有时用 exe 目录（便携版语义），最后才 cwd。
pub fn launcher_config_base() -> PathBuf {
    if let Some(dir) = env_dir("PORTABLE_EXECUTABLE_DIR") {
        return dir;
    }
    if let Some(dir) = exe_dir() {
        if dir.join("launcher.config.json").is_file() {
            return dir;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("launcher.config.json").is_file() {
        return cwd;
    }
    if let Some(dir) = exe_dir() {
        if !looks_like_temp(&dir) {
            return dir;
        }
    }
    cwd
}

pub fn read_launcher_config_repo_root(base: &Path) -> Option<PathBuf> {
    let file = base.join("launcher.config.json");
    let raw = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    let repo_root = value.get("repoRoot")?.as_str()?;
    if repo_root.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(repo_root))
}

pub fn write_launcher_config_repo_root(base: &Path, repo_root: &Path) -> std::io::Result<()> {
    let file = base.join("launcher.config.json");
    let payload = serde_json::json!({ "repoRoot": repo_root.to_string_lossy() });
    std::fs::write(file, serde_json::to_string_pretty(&payload)?)
}

pub fn resolve_repo_root(_runtime: &RuntimePaths) -> PathBuf {
    let portable_dir = env_dir("PORTABLE_EXECUTABLE_DIR");
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1) 便携版目录及其 3 级父目录
    if let Some(dir) = portable_dir.as_ref() {
        candidates.push(dir.clone());
        let mut up = dir.clone();
        for _ in 0..3 {
            match up.parent() {
                Some(parent) => {
                    up = parent.to_path_buf();
                    candidates.push(up.clone());
                }
                None => break,
            }
        }
    }

    // 2) launcher.config.json（便携版读 exe 旁，dev 读当前目录）
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(dir) = portable_dir.as_ref() {
        bases.push(dir.clone());
    }
    bases.push(cwd.clone());
    for base in bases {
        if let Some(found) = read_launcher_config_repo_root(&base) {
            candidates.push(found);
        }
    }

    // 3) cwd 及 5 级父目录
    candidates.push(cwd.clone());
    let mut cur = cwd.clone();
    for _ in 0..5 {
        match cur.parent() {
            Some(parent) => {
                cur = parent.to_path_buf();
                candidates.push(cur.clone());
            }
            None => break,
        }
    }

    for candidate in candidates {
        if is_repo_root(&candidate) {
            return candidate;
        }
    }

    // 4) 兜底：便携版目录 > exe 目录（排除 temp）> cwd
    if let Some(dir) = portable_dir {
        return dir;
    }
    if let Some(dir) = exe_dir() {
        if !looks_like_temp(&dir) {
            return dir;
        }
    }
    cwd
}

/// config:setRepoRoot 的目录校正：允许用户选到上层目录或 server/ 子目录
pub fn resolve_existing_repo_root(requested: &str) -> Option<PathBuf> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if is_repo_root(&path) {
        return Some(path);
    }
    if path.join("server").join("index.js").is_file() {
        return Some(path);
    }
    if path
        .file_name()
        .map(|name| name.eq_ignore_ascii_case("server"))
        .unwrap_or(false)
    {
        if let Some(parent) = path.parent() {
            if is_repo_root(parent) {
                return Some(parent.to_path_buf());
            }
        }
    }
    if let Some(parent) = path.parent() {
        if is_repo_root(parent) {
            return Some(parent.to_path_buf());
        }
    }
    None
}

/// 取 EveJS 服务端版本（现役版 `ipc.ts::readEvejsVersion`）：
/// 依次尝试 `config/version.json` → 根 `package.json` → `server/package.json`，
/// 每个文件取 `evejsVersion ?? version`，第一个非空字符串即返回。
///
/// 用在三处：`app:info` 的 `evejsVersion`、模组脚手架写清单、模组市场的兼容性判定。
pub fn read_evejs_version(repo_root: &Path) -> String {
    let candidates = [
        repo_root.join("config").join("version.json"),
        repo_root.join("package.json"),
        repo_root.join("server").join("package.json"),
    ];
    for file in candidates {
        let Ok(raw) = std::fs::read_to_string(file) else {
            continue;
        };
        let Ok(value) =
            serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
        else {
            continue;
        };
        // `??` 语义：evejsVersion 存在就只看它（类型不对也不回退到 version）
        let picked = match value.get("evejsVersion") {
            Some(node) => node.as_str().map(str::to_string),
            None => value
                .get("version")
                .and_then(|node| node.as_str())
                .map(str::to_string),
        };
        if let Some(text) = picked {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// 定位 Visual Studio 安装路径（对齐现役版 envDetector.findVsInstallPath）：
/// 先问 vswhere（要求 VC++ x86/x64 工具集），失败再枚举 Microsoft Visual Studio\<版本>\VC\Tools\MSVC。
pub fn find_vs_install_path() -> Option<PathBuf> {
    let pf86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());

    for base in [&pf86, &pf] {
        let vswhere = Path::new(base)
            .join("Microsoft Visual Studio")
            .join("Installer")
            .join("vswhere.exe");
        if !vswhere.is_file() {
            continue;
        }
        let mut command = Command::new(&vswhere);
        command
            .args([
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = command.output() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
                return Some(PathBuf::from(line));
            }
        }
    }

    for base in [&pf86, &pf] {
        let vs_root = Path::new(base).join("Microsoft Visual Studio");
        let Ok(entries) = std::fs::read_dir(&vs_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let msvc = entry.path().join("VC").join("Tools").join("MSVC");
            let has_toolset = std::fs::read_dir(&msvc)
                .map(|mut dir| dir.next().is_some())
                .unwrap_or(false);
            if has_toolset {
                return Some(entry.path());
            }
        }
    }
    None
}

/// 环境自检：字段与检查项**逐条对齐**现役版 `src/main/envDetector.ts::detectEnv`：
///   node / rust / vsBuildTools / serverDeps / localDb / market / clientPath / caCert
/// （key 必须与现役一致 —— `ui/web/launcher-bridge.js` 的 envKeyMap 与
///  `["node","serverDeps","localDb"]` 关键项白名单都按这些 key 分支。）
///
/// `env:check` 的 8 个检查项顺序（**单一来源**）。
///
/// 逐条对齐现役版 `src/main/envDetector.ts` 的声明顺序；渲染层
/// `ui/web/launcher-bridge.js` 的 `critical` 白名单与 `envKeyMap` 都以此为基准 ——
/// S5 交叉对拍抓到过一次真实的 key 漂移（检查项写成了 repoRoot/marketBinary/clientConfig/ca），
/// 导致「一键启动」的关键环境拦截与「立即修复」映射静默失效，这里用常量 + 单测钉死。
pub const ENV_CHECK_KEYS: [&str; 8] = [
    "node",
    "rust",
    "vsBuildTools",
    "serverDeps",
    "localDb",
    "market",
    "clientPath",
    "caCert",
];

/// 与现役版的**唯一有意差异**：现役版用 execSync 串行阻塞（最坏 30s，卡住首帧），
/// 这里改成 tokio 异步 + 单项 10s 超时，探测口径不变、不阻塞 UI。
pub async fn detect_env(repo_root: &Path) -> serde_json::Value {
    let node_version = probe_node_version().await;
    // 客户端配置只读一次（现役版也是 readClientConfig 调一次、派生两项检查）
    let (client_path_check, ca_cert_check) = client_config_checks(repo_root);

    let checks = vec![
        node_check(&node_version),
        rust_check().await,
        vs_build_tools_check().await,
        server_deps_check(repo_root),
        local_db_check(repo_root),
        market_check(repo_root),
        client_path_check,
        ca_cert_check,
    ];

    // 演示/验证模式（EVEJS_INIT_DEMO=1）：强制模拟「首次启动未初始化」界面（仅用于 UI 验证）
    let checks = if std::env::var("EVEJS_INIT_DEMO").ok().as_deref() == Some("1") {
        checks
            .into_iter()
            .map(|mut item| {
                let key = item
                    .get("key")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                if matches!(key, "localDb" | "market" | "clientPath" | "caCert") {
                    item["ok"] = serde_json::json!(false);
                    item["warn"] = serde_json::json!(true);
                }
                item
            })
            .collect::<Vec<_>>()
    } else {
        checks
    };

    debug_assert_eq!(
        checks
            .iter()
            .filter_map(|item| item["key"].as_str())
            .collect::<Vec<_>>(),
        ENV_CHECK_KEYS.to_vec(),
        "env:check 的顺序必须与 ENV_CHECK_KEYS 一致（渲染层白名单按它取值）"
    );

    let pass_count = checks
        .iter()
        .filter(|item| item["ok"] == serde_json::json!(true))
        .count();
    let total_count = checks.len();
    let node_ok = checks
        .first()
        .map(|item| item["ok"] == serde_json::json!(true))
        .unwrap_or(false);

    serde_json::json!({
        "repoRoot": repo_root.to_string_lossy(),
        "node": { "version": node_version, "ok": node_ok },
        "checks": checks,
        "passCount": pass_count,
        "totalCount": total_count,
        "sys": system_resource_summary()
    })
}

/// 组装一条检查项。缺省的 `warn`/`hint`/`installUrl` **不出现**在 JSON 里，
/// 而不是写成 null：现役版是 JS，undefined 序列化时会消失，写成 null 会让
/// 渲染层（以及 parity 比对）看到不同的键集合。
fn check_item(
    key: &str,
    label: &str,
    ok: bool,
    warn: Option<bool>,
    message: String,
    hint: Option<&str>,
    install_url: Option<&str>,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("key".to_string(), serde_json::json!(key));
    map.insert("label".to_string(), serde_json::json!(label));
    map.insert("ok".to_string(), serde_json::json!(ok));
    if let Some(value) = warn {
        map.insert("warn".to_string(), serde_json::json!(value));
    }
    map.insert("message".to_string(), serde_json::json!(message));
    if let Some(value) = hint {
        map.insert("hint".to_string(), serde_json::json!(value));
    }
    if let Some(value) = install_url {
        map.insert("installUrl".to_string(), serde_json::json!(value));
    }
    serde_json::Value::Object(map)
}

/// 单项探测的超时（与现役版 execSync 的 timeout: 10000 一致）
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 跑一个 `--version` 类命令并剥掉前缀（现役版用 execSync，这里异步 + 超时 + 无窗口）
async fn probe_version(program: &str, args: &[&str], prefix: &str) -> String {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            match text.strip_prefix(prefix) {
                Some(rest) => rest.trim().to_string(),
                None => text,
            }
        }
        _ => String::new(),
    }
}

/// `node -v` → 去掉前缀 v（现役版 `.replace(/^v/, "")`；失败时是「未知」）
async fn probe_node_version() -> String {
    let mut command = tokio::process::Command::new("node");
    command
        .arg("-v")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_start_matches('v')
            .to_string(),
        _ => "未知".to_string(),
    }
}

fn node_check(version: &str) -> serde_json::Value {
    let ok = version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .map(|major| major >= 24)
        .unwrap_or(false);
    check_item(
        "node",
        "Node.js 运行时",
        ok,
        None,
        if ok {
            format!("Node v{version}（满足 ≥24）")
        } else {
            format!("未检测到可用 Node（当前: {version}）")
        },
        if ok {
            None
        } else {
            Some("请手动安装 Node.js 24+（LTS 版本即可）")
        },
        if ok { None } else { Some("https://nodejs.org") },
    )
}

async fn rust_check() -> serde_json::Value {
    let rustc_version = probe_version("rustc", &["--version"], "rustc").await;
    let cargo_version = probe_version("cargo", &["--version"], "cargo").await;
    let ok = !rustc_version.is_empty() && !cargo_version.is_empty();
    let partial = rustc_version.is_empty() != cargo_version.is_empty();
    check_item(
        "rust",
        "Rust / Cargo 工具链",
        ok,
        Some(partial),
        if ok {
            format!("rustc {rustc_version} · cargo {cargo_version}")
        } else if partial {
            format!(
                "工具链不完整（仅检测到 {}）",
                if rustc_version.is_empty() {
                    "cargo"
                } else {
                    "rustc"
                }
            )
        } else {
            "未检测到 Rust 工具链（rustc / cargo）".to_string()
        },
        if ok {
            None
        } else {
            Some("请手动安装 Rust（官方 rustup 方式）")
        },
        if ok {
            None
        } else {
            Some("https://www.rust-lang.org/tools/install")
        },
    )
}

async fn vs_build_tools_check() -> serde_json::Value {
    // vswhere + 目录兜底是同步 IO（可能几秒），挪到阻塞线程池，别占住 IPC 的异步线程
    let found = tokio::task::spawn_blocking(find_vs_install_path)
        .await
        .ok()
        .flatten();
    let text = found.map(|path| path.to_string_lossy().to_string());
    check_item(
        "vsBuildTools",
        "VS C++ 构建工具",
        text.is_some(),
        None,
        match text.as_ref() {
            Some(path) => format!("已安装：{path}"),
            None => "未检测到 VS Build Tools（vswhere 未找到 / VC\\Tools\\MSVC 缺失）".to_string(),
        },
        if text.is_some() {
            None
        } else {
            Some("安装时勾选「使用 C++ 的桌面开发」工作负载")
        },
        if text.is_some() {
            None
        } else {
            Some("https://visualstudio.microsoft.com/zh-hans/downloads/#build-tools-for-visual-studio-2022")
        },
    )
}

fn server_deps_check(repo_root: &Path) -> serde_json::Value {
    let ok = repo_root
        .join("server")
        .join("node_modules")
        .join("express")
        .join("package.json")
        .exists();
    check_item(
        "serverDeps",
        "主服务器依赖",
        ok,
        None,
        if ok {
            "server/node_modules 已就绪".to_string()
        } else {
            "缺少 server/node_modules（express 未安装）".to_string()
        },
        if ok {
            None
        } else {
            Some("在 server 目录执行 npm ci 安装依赖")
        },
        None,
    )
}

fn local_db_check(repo_root: &Path) -> serde_json::Value {
    let store = repo_root.join("_local").join("gameStore");
    let ok = store.join("manifest.json").exists() && store.join("gamestore.sqlite").exists();
    check_item(
        "localDb",
        "本地数据库",
        ok,
        None,
        if ok {
            "_local/gameStore 已初始化".to_string()
        } else {
            "本地数据库缺失（manifest/sqlite 不存在）".to_string()
        },
        if ok {
            None
        } else {
            Some("运行 tools\\DatabaseCreator\\CreateDatabase.bat 初始化数据库")
        },
        None,
    )
}

fn market_check(repo_root: &Path) -> serde_json::Value {
    let ok = market_binary(repo_root).exists();
    check_item(
        "market",
        "市场服务二进制",
        ok,
        None,
        if ok {
            "release 二进制已构建".to_string()
        } else {
            "未找到 target/release/market-server.exe".to_string()
        },
        if ok {
            None
        } else {
            Some("按 StartMarketServer.bat 使用 VS Build Tools 构建一次（cargo build --release）")
        },
        None,
    )
}

/// 客户端路径 / CA 证书两项（现役版这两项靠 readClientConfig 一次读取）
fn client_config_checks(repo_root: &Path) -> (serde_json::Value, serde_json::Value) {
    let client = crate::config::read_client_config(repo_root);
    let client_path_ok = !client.client_path.is_empty() && Path::new(&client.client_path).exists();
    let ca_ok = !client.ca_pem.is_empty() && Path::new(&client.ca_pem).exists();

    let client_path = check_item(
        "clientPath",
        "客户端路径",
        client_path_ok,
        Some(!client_path_ok),
        if client.client_path.is_empty() {
            "未配置 EVEJS_CLIENT_PATH".to_string()
        } else if client_path_ok {
            format!("客户端: {}", client.client_path)
        } else {
            format!("路径不存在: {}", client.client_path)
        },
        if client_path_ok {
            None
        } else {
            Some("在 EvEJSConfig.bat / 配置面板中填写客户端安装路径")
        },
        None,
    );
    let ca_cert = check_item(
        "caCert",
        "客户端证书 CA",
        ca_ok,
        Some(!ca_ok),
        if ca_ok {
            "CA 证书就绪".to_string()
        } else {
            "CA 证书缺失".to_string()
        },
        if ca_ok {
            None
        } else {
            Some("运行 SetupEveJS.bat 或检查 EVEJS_CA_PEM 指向")
        },
        None,
    );
    (client_path, ca_cert)
}

/// 现役版 `envDetector.ts` 的阈值判定（抽成纯函数，单测直接钉三档边界）：
/// 绿灯 >8 GB 且 >8 线程；黄灯恰为 8 GB / 8 线程（或一项恰好等于）；红灯任一小于 8。
fn sys_level(mem_gb: f64, cpu_threads: usize) -> &'static str {
    if mem_gb < 8.0 || cpu_threads < 8 {
        "fail"
    } else if mem_gb > 8.0 && cpu_threads > 8 {
        "ok"
    } else {
        "warn"
    }
}

/// 系统资源摘要：现役版阈值 8 GB / 8 线程（memRaw < 8 或线程 < 8 → fail）
fn system_resource_summary() -> serde_json::Value {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let mem_raw = ((system.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0) * 10.0).round() / 10.0;
    let cpu_threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(0);
    let level = sys_level(mem_raw, cpu_threads);
    serde_json::json!({
        "memRaw": mem_raw,
        "memGB": mem_raw.floor(),
        "level": level,
        "cpuThreads": cpu_threads,
        "message": format!("内存 {mem_raw} GB · CPU {cpu_threads} 线程（阈值 8 GB / 8 线程）")
    })
}

pub fn market_binary(repo_root: &Path) -> PathBuf {
    repo_root
        .join("externalservices")
        .join("market-server")
        .join("target")
        .join("release")
        .join("market-server.exe")
}

pub fn market_working_dir(repo_root: &Path) -> PathBuf {
    repo_root.join("externalservices").join("market-server")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init;

    /// 现役版 `src/main/envDetector.ts` 的检查项顺序（S5 跨实现对拍时的比对基准）
    const REFERENCE_ENV_CHECK_KEYS: [&str; 8] = [
        "node",
        "rust",
        "vsBuildTools",
        "serverDeps",
        "localDb",
        "market",
        "clientPath",
        "caCert",
    ];

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 渲染层桥接脚本（浏览器侧决定「哪些检查项能拦住一键启动」「哪个检查项对应哪个修复动作」）
    fn renderer_bridge() -> String {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("ui")
            .join("web")
            .join("launcher-bridge.js");
        std::fs::read_to_string(&file)
            .unwrap_or_else(|err| panic!("读不到渲染层桥接脚本 {}：{err}", file.display()))
    }

    fn slice_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let from = source
            .find(start)
            .unwrap_or_else(|| panic!("渲染层脚本里找不到锚点 {start:?}"))
            + start.len();
        let rest = &source[from..];
        let to = rest
            .find(end)
            .unwrap_or_else(|| panic!("锚点 {start:?} 之后找不到结束标记 {end:?}"));
        &rest[..to]
    }

    fn quoted_items(block: &str) -> Vec<String> {
        let mut items = Vec::new();
        let mut rest = block;
        while let Some(start) = rest.find('"') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('"') else { break };
            items.push(after[..end].to_string());
            rest = &after[end + 1..];
        }
        items
    }

    #[test]
    fn env_check_keys_keep_reference_order() {
        assert_eq!(ENV_CHECK_KEYS, REFERENCE_ENV_CHECK_KEYS);
    }

    /// S5 的教训：检查项的 key 一旦和渲染层对不上，「一键启动」的关键环境拦截和
    /// 「立即修复」的 initKey 映射会**静默**失效（不报错、只是永远不触发）。
    #[test]
    fn renderer_whitelists_reference_real_check_keys() {
        let source = renderer_bridge();

        let critical = quoted_items(slice_between(&source, "const critical = new Set([", "])"));
        assert!(
            !critical.is_empty(),
            "critical 白名单不能为空，否则一键启动不再拦截任何关键项"
        );
        for key in &critical {
            assert!(
                ENV_CHECK_KEYS.contains(&key.as_str()),
                "critical 白名单里的 {key:?} 不是 env:check 的检查项（可选项：{ENV_CHECK_KEYS:?}）"
            );
        }

        let block = slice_between(&source, "const envKeyMap = {", "};");
        let mut mapped = 0;
        for line in block.lines() {
            let line = line.trim().trim_end_matches(',');
            if line.is_empty() {
                continue;
            }
            let (key, value) = line
                .split_once(':')
                .unwrap_or_else(|| panic!("envKeyMap 每行都应是 `key: \"value\"`，实际：{line:?}"));
            let key = key.trim().trim_matches('"').to_string();
            let value = value.trim().trim_matches('"').to_string();
            assert!(
                ENV_CHECK_KEYS.contains(&key.as_str()),
                "envKeyMap 的键 {key:?} 不是 env:check 的检查项"
            );
            assert!(
                init::KEYS.contains(&value.as_str()),
                "envKeyMap 的 {key:?} → {value:?} 不是 init:run 的任务键（可选项：{:?}）",
                init::KEYS
            );
            mapped += 1;
        }
        assert!(
            mapped > 0,
            "envKeyMap 不能为空，否则「立即修复」按钮全部失效"
        );
    }

    /// 现役版是 JS，`undefined` 序列化时会整键消失；Rust 侧若写成 `null`，两边键集合就不同了。
    #[test]
    fn check_items_never_carry_null_values() {
        let root = temp_root("env-check-items");
        std::fs::create_dir_all(&root).unwrap();

        // 空仓库根：三项都未就绪，且必须给出非空 hint
        let pending = [
            server_deps_check(&root),
            local_db_check(&root),
            market_check(&root),
        ];
        for item in &pending {
            for (name, value) in item.as_object().unwrap() {
                assert!(
                    !value.is_null(),
                    "{} 的 {name} 被写成了 null（现役版是 undefined，键会直接消失）",
                    item["key"]
                );
            }
            for required in ["key", "label", "ok", "message"] {
                assert!(item.get(required).is_some(), "检查项缺 {required}：{item}");
            }
            assert_eq!(item["ok"], serde_json::json!(false), "{item}");
            assert!(
                item["hint"].as_str().is_some_and(|hint| !hint.is_empty()),
                "未就绪的检查项必须给出修复提示：{item}"
            );
        }
        assert_eq!(pending[0]["key"], "serverDeps");
        assert_eq!(pending[1]["key"], "localDb");
        assert_eq!(pending[2]["key"], "market");

        // 补齐依赖 / 数据库 / 市场二进制后：ok 变 true，hint 与 installUrl 整键消失
        std::fs::create_dir_all(root.join("server").join("node_modules").join("express")).unwrap();
        std::fs::write(
            root.join("server")
                .join("node_modules")
                .join("express")
                .join("package.json"),
            "{}",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("_local").join("gameStore")).unwrap();
        std::fs::write(
            root.join("_local").join("gameStore").join("manifest.json"),
            "{}",
        )
        .unwrap();
        std::fs::write(
            root.join("_local")
                .join("gameStore")
                .join("gamestore.sqlite"),
            "",
        )
        .unwrap();
        let market = market_binary(&root);
        std::fs::create_dir_all(market.parent().unwrap()).unwrap();
        std::fs::write(&market, "").unwrap();

        for item in [
            server_deps_check(&root),
            local_db_check(&root),
            market_check(&root),
        ] {
            assert_eq!(item["ok"], serde_json::json!(true), "{item}");
            assert!(
                item.get("hint").is_none(),
                "就绪的检查项不该带 hint：{item}"
            );
            assert!(
                item.get("installUrl").is_none(),
                "就绪的检查项不该带 installUrl：{item}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sys_level_uses_eight_gb_and_eight_threads_thresholds() {
        assert_eq!(sys_level(31.9, 12), "ok");
        assert_eq!(sys_level(8.1, 9), "ok");
        assert_eq!(sys_level(8.0, 12), "warn", "恰好 8 GB 是黄灯");
        assert_eq!(sys_level(32.0, 8), "warn", "恰好 8 线程是黄灯");
        assert_eq!(sys_level(7.9, 12), "fail");
        assert_eq!(sys_level(32.0, 4), "fail");
    }

    #[test]
    fn resolve_existing_repo_root_accepts_root_server_and_parent() {
        let root = temp_root("resolve-repo-root");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(
            root.join("server").join("autostart.js"),
            "module.exports = {};",
        )
        .unwrap();

        assert_eq!(
            resolve_existing_repo_root(&root.to_string_lossy()),
            Some(root.clone())
        );
        // 选到 server/ 子目录 → 纠正回仓库根
        assert_eq!(
            resolve_existing_repo_root(&root.join("server").to_string_lossy()),
            Some(root.clone())
        );
        // 选到仓库根下面任意一层 → 仍然是这个仓库根
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            resolve_existing_repo_root(&nested.to_string_lossy()),
            Some(root.clone())
        );
        assert_eq!(resolve_existing_repo_root("   "), None);
        assert_eq!(resolve_existing_repo_root("Z:\\definitely\\missing"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实 0.12.8 布局（`StartServer.bat` + `server/index.js`，没有 autostart.js）必须被认作仓库根。
    /// 回归来源：只认 `server/autostart.js` 时，用户选中的目录在下次启动会被静默忽略。
    #[test]
    fn is_repo_root_accepts_current_server_layout() {
        let root = temp_root("repo-root-current-layout");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("StartServer.bat"), "@echo off\r\n").unwrap();
        std::fs::write(root.join("server").join("index.js"), "// entry\n").unwrap();

        assert_eq!(repo_root_score(&root), 4);
        assert!(is_repo_root(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 打分顺序对齐现役版：新版完整布局 4 > 服务端部署 2 > 只剩旧标记 1 > 无关目录 0。
    #[test]
    fn repo_root_score_ranks_layouts_and_rejects_others() {
        let current = temp_root("repo-root-score-current");
        std::fs::create_dir_all(current.join("server")).unwrap();
        std::fs::write(current.join("StartServer.bat"), "@echo off\r\n").unwrap();
        std::fs::write(current.join("server").join("index.js"), "// entry\n").unwrap();

        let deploy = temp_root("repo-root-score-deploy");
        std::fs::create_dir_all(deploy.join("server")).unwrap();
        std::fs::write(deploy.join("server").join("index.js"), "// entry\n").unwrap();
        std::fs::write(deploy.join("server").join("package.json"), "{}\n").unwrap();

        let legacy = temp_root("repo-root-score-legacy");
        std::fs::create_dir_all(legacy.join("server")).unwrap();
        std::fs::write(
            legacy.join("server").join("autostart.js"),
            "module.exports = {};\n",
        )
        .unwrap();

        let unrelated = temp_root("repo-root-score-unrelated");
        std::fs::create_dir_all(&unrelated).unwrap();

        assert_eq!(repo_root_score(&current), 4);
        assert_eq!(repo_root_score(&deploy), 2);
        assert_eq!(repo_root_score(&legacy), 1);
        assert_eq!(repo_root_score(&unrelated), 0);
        assert!(!is_repo_root(&unrelated));

        for dir in [current, deploy, legacy, unrelated] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// 落盘配置必须能被下次启动读回来——「选了目录、重启后又失效」的直接回归。
    #[test]
    fn persisted_repo_root_is_recognised_on_next_start() {
        let base = temp_root("repo-root-config-base");
        std::fs::create_dir_all(&base).unwrap();
        let root = temp_root("repo-root-config-target");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("StartServer.bat"), "@echo off\r\n").unwrap();
        std::fs::write(root.join("server").join("index.js"), "// entry\n").unwrap();

        write_launcher_config_repo_root(&base, &root).unwrap();

        let read_back = read_launcher_config_repo_root(&base).expect("配置应能读回");
        assert_eq!(read_back, root);
        assert!(is_repo_root(&read_back), "读回的路径必须仍然被认作仓库根");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&root);
    }
}
