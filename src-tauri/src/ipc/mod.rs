//! IPC 分发层：把契约里的 82 个请求通道收敛到**单一** Tauri command。
//!
//! 设计取舍：不注册 82 个 `#[tauri::command]`，只注册 `launcher_invoke`，
//! 由 `ipc::channels` 做二次白名单校验。理由有三：
//!   1. 渲染层 shim 只需生成一个调用点，契约变更不会漏改；
//!   2. 通道名来自生成产物，Rust 与 TS 不会各自漂移；
//!   3. 未实现通道可以统一回 `{ok:false, reason}`，不会出现「前端 await 永不返回」。
pub mod channels;
pub mod registry;
pub mod smoke;
pub mod window;

use crate::accounts;
use crate::author;
use crate::config;
use crate::db;
use crate::env;
use crate::gameconfig;
use crate::health;
use crate::init;
use crate::log;
use crate::market;
use crate::mods;
use crate::process;
use crate::sponsors;
use crate::updater;
use crate::AppState;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 渲染层唯一入口：`window.api.*` → `invoke("launcher_invoke", { channel, args })`
#[tauri::command]
pub async fn launcher_invoke(
    app: AppHandle,
    window: WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if !channels::is_request(&channel) {
        return Err(format!("拒绝未知通道: {channel}"));
    }
    // B3：只认主窗口。Tauri 没有 Electron 的 event.senderFrame，用窗口 label 做等价校验
    if !is_allowed_window_label(window.label()) {
        return Err(format!("拒绝来自未知窗口的调用: {}", window.label()));
    }
    dispatch(&app, &window, &channel, &args).await
}

async fn dispatch(
    app: &AppHandle,
    window: &WebviewWindow,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let root = state.repo_root();

    match channel {
        /* ------------------------------ 窗口控制 ------------------------------ */
        "window:minimize" => {
            window.minimize().map_err(text)?;
            Ok(Value::Null)
        }
        "window:toggleMaximize" => {
            let result = if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            };
            result.map_err(text)?;
            Ok(Value::Null)
        }
        "window:close" => {
            // 现役版 close 时同步落盘窗口几何，这里保持一致
            window::save_bounds(window);
            window.close().map_err(text)?;
            Ok(Value::Null)
        }

        /* --------------------------- 应用信息 / 外链 --------------------------- */
        "app:info" => Ok(json!({
            "name": "EvEJS 启动器",
            "version": app.package_info().version.to_string(),
            "evejsVersion": env::read_evejs_version(&root),
            "repoRoot": root.to_string_lossy(),
            // 现役版返回 process.platform（Windows 为 "win32"），渲染层按它分支，保持一致
            "platform": "win32",
            "phase": "3-4",
            // 老启动器数据接管台账：老用户升级过来时，身份 key / GitHub 令牌 / 账号凭据
            // 已经在启动阶段搬好，这里把结果报给设置页，用户不需要重新配置任何东西
            "legacy": crate::legacy::last_state(&state.runtime)
        })),
        "shell:openExternal" => Ok(json!(open_external(app, &arg_str(args, 0)))),

        /* ------------------------- 环境自检 / 健康检查 ------------------------- */
        "env:check" => Ok(env::detect_env(&root).await),
        "health:check" => Ok(json!(health::check_all().await)),
        "health:ping" => {
            let configured = config::read_server_config(&root).ports.game;
            let port = if configured > 0 {
                configured
            } else {
                config::DEFAULT_GAME_PORT
            };
            let ms = health::tcp_latency(port).await;
            Ok(json!({ "ok": ms.is_some(), "port": port, "ms": ms }))
        }
        "metrics:get" => Ok(state
            .metrics
            .lock()
            .map(|mut collector| collector.collect(&root))
            .unwrap_or_else(|_| json!({}))),
        "log:read" => Ok(log::read_server_log(&root)),

        /* ------------------------------- 配置 ------------------------------- */
        "config:get" => Ok(config::config_bundle(&root)),
        "config:setRepoRoot" => Ok(set_repo_root(&state, &arg_str(args, 0))),
        "config:setClient" => Ok(set_client(&root, args.first())),
        "config:repairClientDisplay" => Ok(repair_client_display(&root).await),

        /* -------------------------- 游戏世界参数 --------------------------- */
        // 规则不在这里：条目定义 / 范围校验 / 原子写全部复用服务端的配置管理器，
        // 本层只负责把侧车的 JSON 原样转给渲染层。
        "gameConfig:read" => Ok(gameconfig::read(&root).await),
        "gameConfig:save" => {
            let patch = args
                .first()
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            Ok(gameconfig::save(&root, &patch).await)
        }

        /* ------------------------------ 设置项 ------------------------------ */
        "settings:get" => Ok(Value::Object(config::read_settings(
            &state.runtime.settings_file(),
        ))),
        "settings:set" => {
            let patch = args
                .first()
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            Ok(Value::Object(config::write_settings(
                &state.runtime.settings_file(),
                &patch,
            )))
        }

        /* ------------------------------ 服务控制 ------------------------------ */
        // 带逐进程读数（CPU / 内存 / startedAt），与 services:changed 同形：
        // 见 process::list_with_stats
        "services:list" => Ok(json!(process::list_with_stats(state.inner()))),
        "service:start" => Ok(action_result(
            process::start_service(app, &arg_str(args, 0)).await,
        )),
        "service:stop" => Ok(action_result(
            process::stop_service(app, &arg_str(args, 0)).await,
        )),
        "service:restart" => Ok(action_result(
            process::restart_service(app, &arg_str(args, 0)).await,
        )),
        "engage:start" => Ok(process::engage_start(app).await),
        "engage:stop" => Ok(process::engage_stop(app).await),

        /* ------------------------------ 终端 ------------------------------ */
        "terminal:input" => {
            // 现役版会话不存在时只记日志不报错，这里同样静默（避免提示框被输入打断）。
            // B4：输入一律经 TerminalInput 包装，明文不会进任何日志/错误信息
            let tab = arg_str(args, 0);
            let payload = arg_str(args, 1);
            let _ = state
                .pty
                .write(&tab, crate::pty::TerminalInput::new(&payload));
            Ok(Value::Null)
        }
        "terminal:resize" => {
            let _ = state.pty.resize(
                &arg_str(args, 0),
                arg_u16(args, 1, 120),
                arg_u16(args, 2, 30),
            );
            Ok(Value::Null)
        }

        /* --------------------------- 更新器 / 初始化 --------------------------- */
        "update:state" => Ok(updater::current_state(app)),
        // 检查 / 下载 / 替换都要出网或动磁盘，丢 spawn_blocking；取消只是置标志 + 广播
        "update:check" => {
            let runtime = state.runtime.clone();
            let app = app.clone();
            Ok(blocking(move || updater::check_for_updates(&app, &runtime)).await?)
        }
        "update:download" => {
            let runtime = state.runtime.clone();
            let app = app.clone();
            Ok(blocking(move || updater::download_update(&app, &runtime)).await?)
        }
        "update:apply" => {
            let runtime = state.runtime.clone();
            let app = app.clone();
            Ok(blocking(move || updater::apply_update(&app, &runtime)).await?)
        }
        "update:cancel" => {
            updater::cancel_download(app);
            Ok(Value::Null)
        }
        "init:state" => Ok(state.init.state()),
        "init:run" => Ok(init::run_init(app, &arg_str(args, 0))),

        /* ------------------------------ 账号管理 ------------------------------ */
        "accounts:list" => Ok(accounts::list(app).await),
        "accounts:create" => Ok(accounts::create(
            app,
            &accounts::text_arg(args, 0),
            &accounts::text_arg(args, 1),
            accounts::bool_arg(args, 2),
        )
        .await),
        "accounts:delete" => Ok(accounts::delete(
            app,
            &accounts::text_arg(args, 0),
            accounts::bool_arg(args, 1),
        )
        .await),
        "accounts:deleteCharacter" => Ok(accounts::delete_character(
            app,
            &accounts::text_arg(args, 0),
            accounts::bool_arg(args, 1),
        )
        .await),
        "accounts:logotypes" => Ok(accounts::logotypes(app, &accounts::array_arg(args, 0))),
        "accounts:checkRunning" => Ok(accounts::check_running(app).await),
        "accounts:verify" => Ok(accounts::verify(
            app,
            &accounts::text_arg(args, 0),
            &accounts::text_arg(args, 1),
        )
        .await),
        "accounts:setPassword" => Ok(accounts::set_password(
            app,
            &accounts::text_arg(args, 0),
            &accounts::text_arg(args, 1),
            &accounts::text_arg(args, 2),
        )
        .await),
        "accounts:launch" => Ok(accounts::launch_stored(
            app,
            &accounts::text_arg(args, 0),
            accounts::optional_arg(args, 1),
        )
        .await),
        "login:start" => Ok(accounts::login_start(
            app,
            &accounts::text_arg(args, 0),
            &accounts::text_arg(args, 1),
            accounts::bool_arg(args, 2),
            accounts::optional_arg(args, 3),
        )
        .await),

        /* ------------------------------ 作者身份 ------------------------------ */
        "author:get" => Ok(author::get_state(&state.runtime)),
        "author:setName" => Ok(author::set_name(&state.runtime, &arg_str(args, 0))),
        // 导出 / 导入要弹 Win32 原生对话框（主线程），所以是 async
        "author:exportKey" => Ok(author::export_key(app, &state.runtime).await),
        "author:importKey" => Ok(author::import_key(app, &state.runtime).await),
        "author:openKeyFolder" => Ok(author::open_key_folder(app, &state.runtime)),

        /* ----------------------------- 数据库管理 ----------------------------- */
        "database:overview" => Ok(db::overview(&root).await),
        "database:table" => Ok(db::table(
            &root,
            &arg_str(args, 0),
            arg_u32(args, 1, 100),
            arg_u32(args, 2, 0),
        )
        .await),
        "database:backup" => Ok(db::backup(&root).await),
        "database:backups" => Ok(db::backups(&root).await),
        "database:restore" => {
            Ok(db::restore(&root, &arg_str(args, 0), &active_names(&state)).await)
        }
        "database:save" => {
            let values = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(db::save_row(&root, &arg_str(args, 0), &values, &active_names(&state)).await)
        }
        "database:insert" => {
            let values = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(db::insert_row(&root, &arg_str(args, 0), &values, &active_names(&state)).await)
        }
        "database:delete" => {
            let values = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(db::delete_row(&root, &arg_str(args, 0), &values, &active_names(&state)).await)
        }

        /* ------------------------------ 物品市场 ------------------------------ */
        // 直读服务端市场库（只读 + WAL）：市场服务跑着时能读，没跑也能读；见 market.rs 模块注释
        "market:overview" => Ok(market::overview(&root).await),
        "market:catalog" => Ok(market::catalog(&root).await),
        // 0 = 没选物品，market::book 会直接回「typeId 必须是正整数」
        "market:book" => Ok(market::book(&root, arg_u32(args, 0, 0)).await),
        "market:trades" => {
            let limit = args
                .first()
                .and_then(Value::as_u64)
                .map(|value| value as u32);
            Ok(market::trades(&root, limit).await)
        }

        /* ------------------------------ 模组管理 ------------------------------ */
        "mods:list" => {
            let scan_result = mods::scan::scan_mods(&root, &state.runtime);
            let mut value = scan_result.to_json();
            if let Some(map) = value.as_object_mut() {
                map.insert("repoRoot".to_string(), json!(root.to_string_lossy()));
                map.insert(
                    "repoRootLooksValid".to_string(),
                    json!(env::is_repo_root(&root)),
                );
            }
            Ok(value)
        }
        "mods:plan" => Ok(mods::plan::plan_loaders(&root, &state.runtime)),
        "mods:readme" => Ok(mods::plan::read_mod_readme(&root, &arg_str(args, 0))),
        "mods:setEnabled" => Ok(mods::plan::set_mod_enabled(
            &root,
            &arg_str(args, 0),
            arg_bool(args, 1),
            &state.runtime,
        )),
        "mods:setOrder" => {
            let folders: Vec<String> = args
                .first()
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Ok(mods::plan::set_mod_order(&state.runtime, &folders))
        }
        "mods:uninstall" => Ok(mods::plan::uninstall_mod(&root, &arg_str(args, 0))),
        "mods:createFolder" => Ok(mods::plan::create_mods_folder(&root)),
        // 编辑信息（本工程扩展通道，现役版只有渲染层的编辑弹窗、主进程没有落盘入口）
        // patch 是 { displayName?, description?, category?, tags?, conflicts?,
        //            requiresRestart?, readme?, highlights? } 的子集
        "mods:updateMeta" => Ok(mods::scaffold::update_mod_meta(
            &root,
            &state.runtime,
            &arg_str(args, 0),
            &args.get(1).cloned().unwrap_or(Value::Null),
        )),
        "mods:sign" => Ok(mods::plan::sign_mod_folder(
            &root,
            &arg_str(args, 0),
            &state.runtime,
        )),
        // 打开目录 / 定位模组：同步（只是调资源管理器）
        "mods:openFolder" => Ok(mods::desktop::open_mods_folder(app, &root)),
        "mods:openModFolder" => Ok(mods::desktop::open_mod_folder(&root, &arg_str(args, 0))),
        // 选 ZIP / 另存为要弹 Win32 原生对话框（主线程），所以是 async
        "mods:importZip" => Ok(mods::desktop::import_zip(app, &root, &state.runtime).await),
        "mods:saveText" => {
            Ok(mods::desktop::save_text(app, &arg_str(args, 0), &arg_str(args, 1)).await)
        }

        /* --------------------------- 模组脚手架 --------------------------- */
        "mods:templates" => Ok(mods::scaffold::templates_json()),
        "mods:create" => Ok(mods::scaffold::create_mod(
            &root,
            args.first().unwrap_or(&Value::Null),
            &env::read_evejs_version(&root),
            &state.runtime,
        )),
        "mods:authoringDoc" => Ok(mods::scaffold::ensure_mod_authoring_doc(
            &state.runtime,
            None,
        )),
        "mods:authoringDocText" => Ok(mods::scaffold::read_mod_authoring_doc_text(
            &state.runtime,
            Some(&arg_str(args, 0)),
        )),
        "mods:openAuthoringDoc" => Ok(mods::scaffold::open_authoring_doc(app, &state.runtime)),
        /* --------------------------- 模组市场 --------------------------- */
        // 出网 / 打包 / 拉起进程都要阻塞，统一丢进 spawn_blocking，别占住 tokio 工作线程
        "mods:marketList" => {
            let force = args.first().and_then(Value::as_bool).unwrap_or(false);
            let repo = root.clone();
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::registry::market_list(&repo, &runtime, force)).await?)
        }
        "mods:reviews" => {
            let mod_id = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let force = args.get(1).and_then(Value::as_bool).unwrap_or(false);
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::ratings::reviews_for(&runtime, &mod_id, force)).await?)
        }
        "mods:reviewSubmit" | "mods:reviewRetract" | "mods:replySubmit" | "mods:replyRetract"
        | "mods:reportReview" => {
            // 五个写动作共用一条入口：同一个签名身份、同一套「签的就是发的」约定，
            // 拆成五个几乎一样的 arm 只会让以后改约定时漏改其中一个。
            let input = args.first().cloned().unwrap_or(Value::Null);
            // 闭包要 'static，`channel` 是借来的 &str，先拷成自己的
            let action = channel.to_string();
            let runtime = state.runtime.clone();
            Ok(blocking(move || match action.as_str() {
                "mods:reviewSubmit" => mods::review::submit_review(&runtime, &input),
                "mods:reviewRetract" => mods::review::retract_review(&runtime, &input),
                "mods:replySubmit" => mods::review::submit_reply(&runtime, &input),
                "mods:replyRetract" => mods::review::retract_reply(&runtime, &input),
                _ => mods::review::report_review(&runtime, &input),
            })
            .await?)
        }
        "mods:marketInstall" => {
            let entry = args.first().cloned().unwrap_or(Value::Null);
            let repo = root.clone();
            let runtime = state.runtime.clone();
            let app = app.clone();
            Ok(blocking(move || {
                mods::registry::market_install(&repo, &runtime, &entry, move |progress| {
                    // 载荷是数组：渲染层 onModDownloadProgress 按 args[0] 取
                    let _ = app.emit("mod:downloadProgress", json!([progress]));
                })
            })
            .await?)
        }
        "mods:myMods" => {
            let repo = root.clone();
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::registry::list_my_mods(&repo, &runtime)).await?)
        }

        /* --------------------------- 模组提交 --------------------------- */
        "mods:submitPrepare" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            let repo = root.clone();
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::submit::prepare_submission(&repo, &runtime, &input)).await?)
        }
        "mods:submitGithub" => {
            let id = arg_str(args, 0);
            let version = arg_str(args, 1);
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::submit::submit_to_github(&runtime, &id, &version)).await?)
        }
        "mods:publishOwnRepo" => {
            let id = arg_str(args, 0);
            let version = arg_str(args, 1);
            let repo_input = arg_str(args, 2);
            let gitee = arg_str(args, 3);
            let runtime = state.runtime.clone();
            let app = app.clone();
            Ok(blocking(move || {
                mods::submit::publish_own_repo(
                    &runtime,
                    &id,
                    &version,
                    &repo_input,
                    &gitee,
                    move |stage, percent| {
                        let _ = app.emit(
                            "mod:publishProgress",
                            json!([{ "stage": stage, "percent": percent }]),
                        );
                    },
                )
            })
            .await?)
        }
        "mods:registerSource" => {
            let id = arg_str(args, 0);
            let version = arg_str(args, 1);
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::submit::register_source(&runtime, &id, &version)).await?)
        }
        "mods:mySubmissions" => Ok(mods::submit::my_submissions(&state.runtime)),
        "mods:revealSubmissionZip" => Ok(mods::submit::reveal_submission_zip(&arg_str(args, 0))),
        // 移除记录（本工程扩展通道）：只删本机台账里自己投的那些条目（全部版本），
        // GitHub 仓库 / Release / 审核 PR / 市场索引一概不碰，不可撤销
        "mods:forgetSubmission" => Ok(mods::submit::forget_submission(
            &state.runtime,
            &arg_str(args, 0),
        )),

        /* --------------------------- 赞助人补给线 --------------------------- */
        // 名单与模组评分同一个源、同一套读法（多镜像 + 缓存 + 验签，见 crate::snapshot）。
        // 出网要阻塞；force=true 绕开 10 分钟的 TTL 缓存重拉。
        "sponsors:snapshot" => {
            let force = args.first().and_then(Value::as_bool).unwrap_or(false);
            let runtime = state.runtime.clone();
            Ok(blocking(move || sponsors::fetch_sponsors(&runtime, force)).await?)
        }

        /* --------------------------- GitHub 令牌 --------------------------- */
        // 明文令牌只在这一次调用里出现，落盘一律 DPAPI 加密（见 secrets.rs）
        "mods:githubTokenStatus" => Ok(mods::submit::token_state(&state.runtime)),
        "mods:githubTokenSave" => Ok(mods::submit::set_token(&state.runtime, &arg_str(args, 0))),
        "mods:githubTokenClear" => Ok(mods::submit::remove_token(&state.runtime)),
        "mods:githubTokenCheck" => {
            let token = args
                .first()
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::submit::check_token(&runtime, token.as_deref())).await?)
        }

        /* ------------------------ 旧模组归属认领 ------------------------ */
        // 重装系统 / 换电脑之后私钥没了，作者要接着更新自己几年前的模组：先列候选，
        // 再逐个核验「这个模组的仓库是不是你的」（走 GitHub），见 mods/claim.rs
        "mods:claimCandidates" => {
            let opts = mods::claim::ClaimOptions::parse(args);
            let repo = root.clone();
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::claim::claim_candidates(&repo, &runtime, &opts)).await?)
        }
        "mods:claimMod" => {
            let folder = arg_str(args, 0);
            let repo = root.clone();
            let runtime = state.runtime.clone();
            Ok(blocking(move || mods::claim::claim_mod(&repo, &runtime, &folder)).await?)
        }

        // 兜底：契约里若出现未登记的通道（例如将来新增），统一回 {ok:false, reason}，
        // 保证 G1「82/82 有回包」——渲染层 await 不会挂死
        other => Ok(registry::not_implemented(other)),
    }
}

/* ------------------------------ 辅助函数 ------------------------------ */

/// 把阻塞活儿挪到阻塞线程池：IPC 分发跑在 tokio 工作线程上，
/// 直接在里面做 HTTPS / 打包 / 拉起进程会把并发的其它请求一起拖住。
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| format!("后台任务失败：{err}"))
}

fn text(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn arg_str(args: &[Value], index: usize) -> String {
    args.get(index)
        .map(|value| match value {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn arg_u16(args: &[Value], index: usize, fallback: u16) -> u16 {
    match args.get(index).and_then(|value| value.as_u64()) {
        // 0 与缺失同义：PTY 不接受 0x0 尺寸，退回默认值
        None | Some(0) => fallback,
        Some(value) => value.min(u16::MAX as u64) as u16,
    }
}

fn arg_u32(args: &[Value], index: usize, fallback: u32) -> u32 {
    args.get(index)
        .and_then(|value| value.as_u64())
        .map(|value| value.min(u32::MAX as u64) as u32)
        .unwrap_or(fallback)
}
/// 布尔参数（现役版 `!!enabled` 的等价物：非 true 一律当 false）
fn arg_bool(args: &[Value], index: usize) -> bool {
    args.get(index).and_then(Value::as_bool).unwrap_or(false)
}

/// 数据库写保护用：不是 idle/error 就认为服务还在跑（对齐现役版 activeServices）
fn active_names(state: &AppState) -> Vec<String> {
    state
        .services
        .snapshot()
        .into_iter()
        .filter(|info| info.state != "idle" && info.state != "error")
        .map(|info| info.name)
        .collect()
}

/// 服务启停：现役版返回 ServiceActionResult（`{ok, reason}`），失败不抛异常
fn action_result(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => value,
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// 外链白名单（修 B2）：只放行 http/https。
///
/// 抽成纯函数是为了能直接测：`open_external` 要 `AppHandle`，单测里造不出来，
/// 只测一段复制粘贴的判定逻辑等于没测（S2 的 B2 用例就是这种「影子断言」，本次改掉）。
fn is_allowed_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 只接受主窗口发来的 IPC（B3）。将来 S6 若新增设置面板等窗口，在这里加白名单。
fn is_allowed_window_label(label: &str) -> bool {
    label == "main"
}

fn open_external(app: &AppHandle, url: &str) -> bool {
    let trimmed = url.trim();
    if !is_allowed_external_url(trimmed) {
        return false;
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(trimmed, None::<&str>).is_ok()
}

fn set_repo_root(state: &AppState, requested: &str) -> Value {
    let Some(next_root) = env::resolve_existing_repo_root(requested) else {
        let shown = if requested.trim().is_empty() {
            "空路径".to_string()
        } else {
            requested.trim().to_string()
        };
        return json!({
            "ok": false,
            "reason": format!("这个目录不像 EveJS 项目根目录（里面应该有 server/index.js）：{shown}")
        });
    };

    let base = env::launcher_config_base();
    let config_path = base.join("launcher.config.json");
    if let Err(err) = env::write_launcher_config_repo_root(&base, &next_root) {
        return json!({ "ok": false, "reason": err.to_string() });
    }
    // 现役版每次调用都重读配置；这里缓存了根目录，必须同步刷新
    state.set_repo_root(next_root.clone());

    json!({
        "ok": true,
        "path": config_path.to_string_lossy(),
        "repoRoot": next_root.to_string_lossy(),
        "corrected": !same_path(&next_root, requested)
    })
}

fn same_path(next_root: &Path, requested: &str) -> bool {
    let requested = requested.trim();
    if requested.is_empty() {
        return false;
    }
    let normalize = |path: &Path| {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    normalize(next_root) == normalize(Path::new(requested))
}

fn set_client(root: &Path, patch: Option<&Value>) -> Value {
    let patch: Map<String, Value> = patch
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    match config::write_client_config(root, &patch) {
        Ok(client) => json!({ "ok": true, "client": client }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// 配置中心「修复游戏窗口」：等价现役版 repairClientDisplay（调 ClientSETUP 的 PowerShell）
async fn repair_client_display(root: &Path) -> Value {
    let client = config::read_client_config(root);
    if client.client_path.is_empty() || !Path::new(&client.client_path).exists() {
        return json!({ "ok": false, "reason": "客户端路径无效，请先在配置中心设置" });
    }
    let script = root
        .join("tools")
        .join("ClientSETUP")
        .join("scripts")
        .join("PrepareClientSettings.ps1");
    if !script.is_file() {
        return json!({ "ok": false, "reason": "未找到 PrepareClientSettings.ps1" });
    }

    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Mode", "Display"])
        .env("EVEJS_CLIENT_PATH", &client.client_path)
        .env("EVEJS_CLIENT_SAFE_WINDOWED", "on")
        .env("EVEJS_CLIENT_SAFE_GRAPHICS", "off")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(120), command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => return json!({ "ok": false, "reason": first_line(&err.to_string()) }),
            Err(_) => return json!({ "ok": false, "reason": "显示设置重置超时" }),
        };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let reason = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return json!({ "ok": false, "reason": first_line(&reason) });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = first_line(&stdout);
    json!({
        "ok": true,
        "reason": if line.is_empty() { "已重置为窗口模式".to_string() } else { line }
    })
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_readers_are_forgiving() {
        let args = vec![json!("tab"), json!(12), json!(null)];
        assert_eq!(arg_str(&args, 0), "tab");
        assert_eq!(arg_str(&args, 9), "");
        assert_eq!(arg_u16(&args, 1, 30), 12);
        assert_eq!(arg_u16(&args, 5, 30), 30);
        // 0 会退化成默认值，避免 PTY 收到 0x0 尺寸
        assert_eq!(arg_u16(&[json!(0)], 0, 120), 120);
    }

    #[test]
    fn service_action_errors_become_action_result() {
        let value = action_result(Err("boom".to_string()));
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("boom"));
    }

    #[test]
    fn external_links_are_scheme_limited() {
        for url in ["http://127.0.0.1/", "https://tauri.app", "  https://a.b  "] {
            assert!(is_allowed_external_url(url), "{url} 应放行");
        }
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:",
            "vbscript:msgbox(1)",
            "data:text/html,<script>1</script>",
        ] {
            assert!(!is_allowed_external_url(url), "{url} 应拒绝");
        }
        // 大小写不敏感
        assert!(is_allowed_external_url("HTTPS://github.com/a"));
    }

    #[test]
    fn only_main_window_label_is_accepted() {
        assert!(is_allowed_window_label("main"));
        for label in ["", "self-test", "main2", "MAIN", "main "] {
            assert!(!is_allowed_window_label(label), "{label} 应拒绝");
        }
    }
}
