//! EvEJS 启动器 · Tauri 2 外壳（迁移自 Electron 版 src/main，模块名一一对应）。
//!
//! 关键约定：
//!   - 渲染层契约：window.api（89 个入口，见 docs/ipc-contract.md），由 initialization_script 注入；
//!   - 单一分发命令 launcher_invoke：按通道名二次白名单校验（ipc::channels 是生成产物）；
//!   - 事件方向统一发数组载荷，shim 负责展开成多参数回调，对齐 Electron 语义；
//!   - A4 渲染隔离：withGlobalTauri:false（渲染层走 __TAURI_INTERNALS__，与 @tauri-apps/api 同款传输层），
//!     命令白名单只有 launcher_invoke（自检命令仅 `--self-test` 注册），capabilities 只放行 core:event:default。
pub mod accounts;
pub mod author;
pub mod config;
pub mod db;
pub mod dialog;
pub mod env;
pub mod github;
pub mod health;
pub mod init;
pub mod ipc;
pub mod legacy;
pub mod log;
pub mod metrics;
pub mod mods;
pub mod net;
pub mod oscrypt;
pub mod process;
pub mod pty;
pub mod runtime;
pub mod secrets;
pub mod seed;
pub mod shell;
pub mod sidecar;
pub mod updater;
pub mod webview2;
pub mod win32;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 渲染层注入脚本：window.api shim（由 scripts/gen-contract.mjs 生成，随源码进仓）。
const API_SHIM: &str = include_str!("../../ui/src/api-shim.js");

/// 自检进程的渲染层标记：只在 `--self-test` 下注入，生产运行时这个全局根本不存在。
///
/// 自检是无值守的诊断进程（parity / L3 / smoke 都靠它跑）。界面里的后台动作会污染 dump：
/// `update:state` 的瞬时 checking 会被采进冻结基线，还会真去打 GitHub，让同一份二进制
/// 两次跑给出不同结果。渲染层见到这个标记就不做后台网络动作（见 ui/src/lib/update-watch.ts）。
const SELF_TEST_SHIM: &str = "window.__EVEJS_SELF_TEST__ = true;";

/// A4：自检模式开关（`--self-test`）。命令白名单据此收窄到「生产集合」。
fn is_self_test() -> bool {
    std::env::args().any(|arg| arg == "--self-test")
}

/// 渲染层选择（双入口，见 docs/S6-UI迁移-实施记录.md §10）：
///   `--ui=react`  → ui/dist/react/index.html（S6 的 Vite+React 应用）
///   `--ui=legacy` → ui/dist/eve-launcher.html（现役 HTML，G6 退役条件达成前必须保留）
/// 不给参数时用默认值。
///
/// 为什么放在 Rust 侧而不是「构建两份 frontendDist」：frontendDist 是静态配置，
/// 两个目录只能二选一；子目录方案让同一份 dist 同时装下两个渲染层，切换零构建成本。
const UI_REACT: &str = "react/index.html";
const UI_LEGACY: &str = "eve-launcher.html";

/// 默认渲染层。S6 cutover 后为 React；回退只需 `EvEJSLauncher.exe --ui=legacy`。
fn default_ui() -> &'static str {
    UI_REACT
}

/// 解析 `--ui=<react|legacy>`；非法值回落到默认值并弹一次提示（不静默吞掉拼错）。
///
/// 为什么是弹窗不是打印：B4 禁止生产代码里的 println!/eprintln!（终端输入不能有日志出口），
/// 启动期的诊断信息只能走系统弹窗 —— 与「缺 WebView2」指引同一来源（win32.rs）。
fn resolve_ui_page() -> &'static str {
    let raw = std::env::args().find_map(|arg| arg.strip_prefix("--ui=").map(str::to_string));
    match raw.as_deref() {
        Some("react") => UI_REACT,
        Some("legacy") => UI_LEGACY,
        Some(other) => {
            crate::win32::warn_dialog(
                "EvEJS 启动器 · 启动参数",
                &format!(
                    "未知的 --ui={other}，已回落到默认渲染层。\n\n可选值：react（S6 新界面，默认） / legacy（旧界面）"
                ),
            );
            default_ui()
        }
        None => default_ui(),
    }
}

pub struct AppState {
    pub runtime: runtime::RuntimePaths,
    pub repo_root: Mutex<PathBuf>,
    pub services: Arc<process::ServiceTable>,
    pub pty: Arc<pty::PtyManager>,
    pub metrics: Mutex<metrics::MetricsCollector>,
    pub init: init::InitManager,
}

impl AppState {
    pub fn repo_root(&self) -> PathBuf {
        self.repo_root
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| self.runtime.root.clone())
    }

    pub fn set_repo_root(&self, next: PathBuf) {
        if let Ok(mut guard) = self.repo_root.lock() {
            *guard = next;
        }
    }
}

pub fn run() {
    // S4/G4：便携版没有安装器，缺 WebView2 时给中文指引（含离线办法）后退出，避免「双击没反应」
    if !webview2::ensure_installed() {
        return;
    }
    let runtime = runtime::RuntimePaths::ensure().expect("无法创建 _launcher 运行时目录");
    let repo_root = env::resolve_repo_root(&runtime);
    // 全局运行时路径：签名 / 作者身份等「拿不到 AppState」的路径要用（对齐现役版全局 launcherRuntimePaths）
    runtime::install_active(runtime.clone());
    // 老用户接手：本机还没有身份 / 令牌时，从老 Electron 启动器的数据目录搬一份过来。
    // 必须早于任何「读身份」的动作（模组扫描要用它验签），所以放在这里。
    legacy::adopt(&runtime, &repo_root);
    // 与 Electron safeStorage 互通的密文（令牌 / 账号密码）：装好 AES 密钥表。
    // 必须晚于 legacy::adopt —— 接管过来的密钥要优先于「现生成一把」被用上。
    oscrypt::init(&runtime);
    // 单文件 exe：把嵌在二进制里的侧车（Node CLI / 自更新器）释放到 exe 同级的 _launcher/。
    // 必须早于任何「调 CLI / 调更新器」的动作；内容一致时一个字节都不写。
    // 释放失败（只读目录、磁盘满）不拦启动：相关功能会自己报「找不到脚本 / 找不到更新器」，
    // 那两个错误信息里已经带了预期路径，用户看得懂；启动期弹窗反而更打扰。
    if let Some(dir) = seed::exe_dir() {
        let _ = seed::ensure_bundled_sidecars(&dir);
    }
    // 每次启动把内置的模组制作规范释放到 _launcher/mods/，方便模组作者查阅（对齐现役版 index.ts）
    mods::scaffold::ensure_all_mod_authoring_docs(&runtime);

    let state = AppState {
        runtime,
        repo_root: Mutex::new(repo_root),
        services: Arc::new(process::ServiceTable::new()),
        pty: Arc::new(pty::PtyManager::new()),
        metrics: Mutex::new(metrics::MetricsCollector::new()),
        init: init::InitManager::new(),
    };

    let self_test = is_self_test();

    let mut builder = tauri::Builder::default();
    // 单实例锁：自检（--self-test）**不参与**。
    // 自检是无人值守的诊断进程，parity（L2）、L3 端到端、smoke 都靠它跑；用户开着启动器时
    // 第二个实例会被锁挡掉（实测 0.5 秒退出、不落 dump），这些门禁就静默变成空跑。
    if !self_test {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 单实例：第二次启动时聚焦既有窗口（对齐现役版 requestSingleInstanceLock 行为）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let builder = builder.plugin(tauri_plugin_opener::init()).manage(state);

    // A4：命令白名单。生产运行只注册唯一分发命令（通道名还要过 ipc::channels 二次校验）；
    // `self_test_report` 会按环境变量写文件并退出进程，只在 `--self-test` 下注册。
    let builder = if self_test {
        builder.invoke_handler(tauri::generate_handler![
            ipc::launcher_invoke,
            ipc::smoke::self_test_report
        ])
    } else {
        builder.invoke_handler(tauri::generate_handler![ipc::launcher_invoke])
    };

    builder
        .setup(move |app| {
            let page = resolve_ui_page();
            let mut shell = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("EvEJS 启动器")
                .inner_size(1360.0, 860.0)
                .min_inner_size(1024.0, 640.0)
                .decorations(false)
                .background_color(tauri::window::Color(5, 8, 13, 255))
                .visible(false)
                .center()
                .initialization_script(API_SHIM);
            if self_test {
                shell = shell.initialization_script(SELF_TEST_SHIM);
            }
            let window = shell.build()?;

            // 恢复上次窗口几何（对齐现役版 savedWindow 逻辑），再 show
            ipc::window::restore(&window);

            // G1 运行时自检：仅 --self-test 时启用（见 scripts/smoke-ipc.ps1）
            if self_test {
                ipc::smoke::run(window.clone());
            }

            // 防白屏：等首帧就绪再显示（对齐现役版 ready-to-show 后再 show）
            let handle = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { .. } => {
                    ipc::window::save_bounds(&handle);
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    ipc::window::save_bounds_throttled(&handle);
                }
                _ => {}
            });
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
