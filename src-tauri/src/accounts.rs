//! 账号与角色直登：对齐现役版 `src/main/accountManager.ts`。
//!
//! 与现役版一致的两个关键点：
//!   1. 账号 CRUD **不重写**，照旧调仓库自带的 `account-cli.js`（同一套哈希算法与库表结构）；
//!   2. 密码存 `launcher-settings.json` 的 `accountCredentials`（DPAPI 密文 base64），
//!      由 `crate::secrets` 负责，格式与现役版 `safeStorage` 兼容。
use crate::process::{self, ClientLogin};
use crate::secrets;
use crate::sidecar::{self, CliOutcome};
use crate::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ACCOUNT_CLI: &str = "account-cli.js";
/// 现役版 execFile 的 timeout: 60000
const ACCOUNT_CLI_TIMEOUT: Duration = Duration::from_secs(60);
/// 肖像候选尺寸优先级（现役版 PORTRAIT_SIZES，128 优先）
const PORTRAIT_SIZES: [u32; 6] = [128, 64, 256, 512, 32, 1024];
const PORTRAIT_EXTS: [&str; 2] = ["jpg", "png"];
/// 军团 / 联盟徽标候选尺寸：服务端图片目录里存的是 `<id>_<size>.png`，从大到小扫
const LOGO_SIZES: [u32; 6] = [1024, 512, 256, 128, 64, 32];
const LOGO_EXTS: [&str; 2] = ["png", "jpg"];

struct Ctx {
    root: PathBuf,
    settings_file: PathBuf,
    runtime: crate::runtime::RuntimePaths,
}

fn ctx(app: &AppHandle) -> Result<Ctx, String> {
    app.try_state::<AppState>()
        .map(|state| Ctx {
            root: state.repo_root(),
            settings_file: state.runtime.settings_file(),
            runtime: state.runtime.clone(),
        })
        .ok_or_else(|| "应用状态不可用".to_string())
}

fn root_text(ctx: &Ctx) -> String {
    ctx.root.to_string_lossy().to_string()
}

/// 把 IPC 参数（可能是 string / number / null）转成字符串，空值归 None
fn arg_text(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn arg_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => matches!(
            text.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

/// 现役版 `(stderr || stdout || fallback).trim()` 的等价物（只取首行，便于 UI 展示）
fn fail_reason(outcome: &CliOutcome, fallback: &str) -> String {
    let stderr = outcome.stderr.trim();
    let stdout = outcome.stdout.trim();
    let text = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        return fallback.to_string();
    };
    sidecar::first_line(text)
}

async fn run_cli(ctx: &Ctx, args: Vec<String>) -> Result<CliOutcome, String> {
    sidecar::run(&ctx.root, ACCOUNT_CLI, &args, ACCOUNT_CLI_TIMEOUT).await
}

/// B5：含密码的调用。密码位放 [`sidecar::PASSWORD_SLOT`]，由 sidecar 决定走 stdin 还是 argv
async fn run_cli_password(
    ctx: &Ctx,
    args: Vec<String>,
    password: &str,
) -> Result<CliOutcome, String> {
    sidecar::run_with_password(&ctx.root, ACCOUNT_CLI, args, password, ACCOUNT_CLI_TIMEOUT).await
}

/// B6：角色 ID 直接参与文件名校拼接（`<id>_<size>.<ext>`），必须是纯标识符。
/// 白名单与执行计划一致：`^[A-Za-z0-9_-]{1,32}$`。
fn is_safe_character_id(value: &str) -> bool {
    let value = value.trim();
    let count = value.chars().count();
    (1..=32).contains(&count)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// 解析角色游戏内肖像（与 EvEJS 服务端 portraitImageStore 一致）：
/// 运行时目录优先，其次 legacy 目录；尺寸 128 → 64 → 256 → 512 → 32 → 1024；
/// 都找不到时回退默认肖像 hi.jpg / hi.png；返回 base64 data URL。
pub fn resolve_portrait_data_url(root: &Path, character_id: &str) -> Option<String> {
    let character_id = character_id.trim();
    // B6：非法 ID 直接拒绝，绝不拿它去拼路径（`..\..\x`、`a/b`、超长都到这里为止）
    if !is_safe_character_id(character_id) {
        return None;
    }
    let runtime_dir = root
        .join("_local")
        .join("gameStore")
        .join("images")
        .join("Character");
    let legacy_dir = root
        .join("server")
        .join("src")
        .join("_secondary")
        .join("image")
        .join("generated")
        .join("Character");

    let mut candidates: Vec<PathBuf> = Vec::new();
    for size in PORTRAIT_SIZES {
        for ext in PORTRAIT_EXTS {
            candidates.push(runtime_dir.join(format!("{character_id}_{size}.{ext}")));
            candidates.push(legacy_dir.join(format!("{character_id}_{size}.{ext}")));
        }
    }
    let default_dir = root
        .join("server")
        .join("src")
        .join("_secondary")
        .join("image")
        .join("images");
    candidates.push(default_dir.join("hi.jpg"));
    candidates.push(default_dir.join("hi.png"));

    for file in candidates {
        if !file.is_file() {
            continue;
        }
        let extension = file
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mime = if extension == "png" {
            "image/png"
        } else {
            "image/jpeg"
        };
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        return Some(format!(
            "data:{mime};base64,{}",
            secrets::base64_encode(&bytes)
        ));
    }
    None
}

/// 军团 / 联盟**专属**徽标的 data URL；服务端图片目录里真有文件才给。
///
/// 与肖像的关键差别：这里**不回退**服务端那张兜底图 —— `evejscorp.png`（军团）与
/// `alliance-default.png`（联盟）是同一张画，只差底部一行小字，缩到 20px 完全看不出
/// 区别，直接画就会出现「军团图标和联盟图标一模一样」。拿不到专属徽标就返回 None，
/// 由渲染层画自己的短标识占位（军团 ticker / 联盟简称）。
///
/// 另一层好处：徽标不再依赖本地图片服务（26001）在跑，服务端关着也能画出来。
pub fn resolve_logotype_data_url(root: &Path, kind: &str, id: &str) -> Option<String> {
    let id = id.trim();
    // 与肖像同一条白名单：ID 直接参与拼文件名，必须是纯标识符
    if !is_safe_character_id(id) {
        return None;
    }
    let dirs: [PathBuf; 2] = match kind {
        "corporations" => [
            root.join("_local")
                .join("gameStore")
                .join("images")
                .join("Corporation"),
            root.join("server")
                .join("src")
                .join("_secondary")
                .join("image")
                .join("generated")
                .join("Corporation"),
        ],
        "alliances" => [
            root.join("_local")
                .join("gameStore")
                .join("images")
                .join("Alliance"),
            root.join("server")
                .join("src")
                .join("_secondary")
                .join("image")
                .join("generated")
                .join("Alliance"),
        ],
        _ => return None,
    };
    for size in LOGO_SIZES {
        for ext in LOGO_EXTS {
            for dir in &dirs {
                let file = dir.join(format!("{id}_{size}.{ext}"));
                if !file.is_file() {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&file) else {
                    continue;
                };
                let mime = if ext == "png" {
                    "image/png"
                } else {
                    "image/jpeg"
                };
                return Some(format!(
                    "data:{mime};base64,{}",
                    secrets::base64_encode(&bytes)
                ));
            }
        }
    }
    None
}

/// [`logotypes`] 的纯函数部分：逐条回 `{ kind, id, dataUrl }`（拿不到就是 null）
pub fn logotype_payload(root: &Path, requests: &[Value]) -> Vec<Value> {
    // 上限 200：正常只有「账号数 × 角色数 × 2」的量级，多的是调用方写错了
    requests
        .iter()
        .take(200)
        .map(|item| {
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
            let id = item
                .get("id")
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let data_url = resolve_logotype_data_url(root, kind, &id);
            json!({
                "kind": kind,
                "id": item.get("id").cloned().unwrap_or(Value::Null),
                "dataUrl": data_url,
            })
        })
        .collect()
}

/// 批量取军团 / 联盟徽标（渲染层一次问一批）
pub fn logotypes(app: &AppHandle, requests: &[Value]) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    json!({ "ok": true, "data": logotype_payload(&ctx.root, requests) })
}

/// 列出全部账号（含角色与游戏内头像）
pub async fn list(app: &AppHandle) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let outcome = match run_cli(&ctx, vec!["list".to_string(), root_text(&ctx)]).await {
        Ok(outcome) => outcome,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    if !outcome.success {
        return json!({ "ok": false, "reason": fail_reason(&outcome, "list 失败") });
    }

    let mut accounts: Vec<Value> = match serde_json::from_str(outcome.stdout.trim()) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "reason": format!("解析账号列表失败: {err}")
            })
        }
    };
    let online = crate::hotreload::online_character_ids(&ctx.runtime);
    decorate_accounts(
        &mut accounts,
        &ctx.settings_file,
        &ctx.root,
        online.as_deref(),
    );
    json!({ "ok": true, "data": accounts })
}

/// 给 CLI 返回的账号列表补后处理字段：
///   1. `hasStoredCredential`：该账号是否存过 DPAPI 加密的密码；
///   2. `roles[].avatar`：游戏内肖像 data URL（都没有时显式 null，渲染层据此回退默认图）；
///   3. `roles[].online` / `onlineKnown`：服务端 sessionRegistry 的真实在线角色状态。
///
/// 其余字段一律原样透传，不做裁剪。
pub fn decorate_accounts(
    accounts: &mut [Value],
    settings_file: &Path,
    root: &Path,
    online_ids: Option<&[String]>,
) {
    for account in accounts.iter_mut() {
        let account_key = account
            .get("accountKey")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if let Some(object) = account.as_object_mut() {
            object.insert(
                "hasStoredCredential".to_string(),
                json!(secrets::has(settings_file, &account_key)),
            );
        }
        let Some(roles) = account
            .get_mut("roles")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        for role in roles.iter_mut() {
            let character_id = role
                .get("characterId")
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let avatar = resolve_portrait_data_url(root, &character_id);
            if let Some(object) = role.as_object_mut() {
                object.insert(
                    "avatar".to_string(),
                    avatar.map(Value::String).unwrap_or(Value::Null),
                );
                object.insert("onlineKnown".to_string(), json!(online_ids.is_some()));
                let online = online_ids
                    .map(|ids| ids.iter().any(|id| id == &character_id))
                    .unwrap_or(false);
                object.insert("online".to_string(), json!(online));
            }
        }
    }
}

/// 新建账号：用户名 + 密码 + 是否授权 GM
pub async fn create(app: &AppHandle, user: &str, password: &str, is_gm: bool) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let mut args = vec![
        "create".to_string(),
        root_text(&ctx),
        user.to_string(),
        sidecar::PASSWORD_SLOT.to_string(),
    ];
    if is_gm {
        args.push("--gm".to_string());
    }
    match run_cli_password(&ctx, args, password).await {
        Err(reason) => json!({ "ok": false, "reason": reason }),
        Ok(outcome) if !outcome.success => {
            json!({ "ok": false, "reason": fail_reason(&outcome, "create 失败") })
        }
        Ok(outcome) => {
            secrets::remember(&ctx.settings_file, user, password);
            json!({ "ok": true, "output": outcome.stdout })
        }
    }
}

/// 删除账号：target 为账号 key 或角色名；apply=false 仅预览
pub async fn delete(app: &AppHandle, target: &str, apply: bool) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let mut args = vec!["delete".to_string(), root_text(&ctx), target.to_string()];
    if apply {
        args.push("--apply".to_string());
    }
    match run_cli(&ctx, args).await {
        Err(reason) => json!({ "ok": false, "reason": reason }),
        Ok(outcome) if !outcome.success => {
            json!({ "ok": false, "reason": fail_reason(&outcome, "delete 失败") })
        }
        Ok(outcome) => {
            secrets::forget(&ctx.settings_file, target);
            json!({ "ok": true, "output": outcome.stdout })
        }
    }
}

/// 删除单个角色（**账号与账号下其他角色都保留**）。
///
/// 与 [`delete`] 的分工：`delete` 是现役版语义（target 可以是角色名，命中后
/// **连账号一起删**）；界面上的「删除角色」必须走这条只删角色的路径。
/// target 为角色名或角色 ID；apply=false 仅预览。
pub async fn delete_character(app: &AppHandle, target: &str, apply: bool) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let mut args = vec![
        "delete-character".to_string(),
        root_text(&ctx),
        target.to_string(),
    ];
    if apply {
        args.push("--apply".to_string());
    }
    match run_cli(&ctx, args).await {
        Err(reason) => json!({ "ok": false, "reason": reason }),
        Ok(outcome) if !outcome.success => {
            json!({ "ok": false, "reason": fail_reason(&outcome, "delete-character 失败") })
        }
        // 只删角色：账号还在，绝不能像 delete 那样把保存的密码一起忘掉
        Ok(outcome) => json!({ "ok": true, "output": outcome.stdout }),
    }
}

/// 检测服务是否在运行（决定删除按钮是否可点）
pub async fn check_running(app: &AppHandle) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "running": false, "ports": [] });
    };
    let args = vec!["check-running".to_string(), root_text(&ctx)];
    match run_cli(&ctx, args).await {
        Ok(outcome) if outcome.success => serde_json::from_str(outcome.stdout.trim())
            .unwrap_or_else(|_| json!({ "running": false, "ports": [] })),
        _ => json!({ "running": false, "ports": [] }),
    }
}

/// 验证账号密码（客户端同款哈希，只读数据库）
pub async fn verify(app: &AppHandle, user: &str, password: &str) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let args = vec![
        "verify".to_string(),
        root_text(&ctx),
        user.to_string(),
        sidecar::PASSWORD_SLOT.to_string(),
    ];
    let outcome = match run_cli_password(&ctx, args, password).await {
        Ok(outcome) => outcome,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    if !outcome.success {
        // 现役版只看 stdout；空则给「验证失败」
        let text = outcome.stdout.trim();
        return json!({
            "ok": false,
            "reason": if text.is_empty() { "验证失败".to_string() } else { sidecar::first_line(text) }
        });
    }
    match serde_json::from_str::<Value>(outcome.stdout.trim()) {
        Ok(value) => json!({
            "ok": value.get("ok").and_then(Value::as_bool).unwrap_or(false),
            "reason": value.get("reason").cloned().unwrap_or(Value::Null)
        }),
        Err(_) => json!({ "ok": false, "reason": "验证服务异常" }),
    }
}

/// 修改密码：先验证旧密码，再写入新密码哈希（热生效，无需重启服务器）
pub async fn set_password(
    app: &AppHandle,
    user: &str,
    old_password: &str,
    new_password: &str,
) -> Value {
    let verified = verify(app, user, old_password).await;
    if verified["ok"] != json!(true) {
        let reason = verified["reason"].as_str().unwrap_or("未知错误");
        return json!({ "ok": false, "reason": format!("旧密码验证失败：{reason}") });
    }
    if new_password.len() < 4 {
        return json!({ "ok": false, "reason": "新密码至少 4 位" });
    }
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let args = vec![
        "set-password".to_string(),
        root_text(&ctx),
        user.to_string(),
        sidecar::PASSWORD_SLOT.to_string(),
    ];
    match run_cli_password(&ctx, args, new_password).await {
        Err(reason) => json!({ "ok": false, "reason": reason }),
        Ok(outcome) if !outcome.success => {
            json!({ "ok": false, "reason": fail_reason(&outcome, "修改失败") })
        }
        Ok(outcome) => {
            secrets::remember(&ctx.settings_file, user, new_password);
            json!({ "ok": true, "output": outcome.stdout })
        }
    }
}

/// 登录并直达所选角色：本地验证 → 启动客户端（/login: + /autoSelectCharacter:）
pub async fn login_start(
    app: &AppHandle,
    user: &str,
    password: &str,
    remember: bool,
    character_id: Option<String>,
) -> Value {
    let verified = verify(app, user, password).await;
    if verified["ok"] != json!(true) {
        let reason = verified["reason"]
            .as_str()
            .unwrap_or("账号或密码错误")
            .to_string();
        return json!({ "ok": false, "reason": reason });
    }
    if password.contains(':') {
        return json!({
            "ok": false,
            "reason": "密码不能包含冒号（客户端 /login: 参数限制）"
        });
    }
    if remember {
        if let Ok(ctx) = ctx(app) {
            secrets::remember(&ctx.settings_file, user, password);
        }
    }

    let direct = character_id.is_some();
    let login = ClientLogin {
        user: user.to_string(),
        password: password.to_string(),
        character_id,
    };
    match process::start_client(app, Some(login)).await {
        Ok(_) => json!({
            "ok": true,
            "output": if direct { "登录成功，客户端直达角色" } else { "登录成功，客户端自动登录中" }
        }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// 使用创建账号时保存的安全凭据启动客户端，不把密码暴露给渲染层
pub async fn launch_stored(app: &AppHandle, user: &str, character_id: Option<String>) -> Value {
    let Ok(ctx) = ctx(app) else {
        return json!({ "ok": false, "reason": "应用状态不可用" });
    };
    let Some(password) = secrets::stored(&ctx.settings_file, user) else {
        return json!({
            "ok": false,
            "reason": "未找到已保存的登录凭据，请手动输入一次密码"
        });
    };
    login_start(app, user, &password, false, character_id).await
}

/// 供 ipc 层调用的参数适配：`accounts:*` 的入参一律经这里转成字符串
pub fn text_arg(args: &[Value], index: usize) -> String {
    arg_text(args.get(index)).unwrap_or_default()
}

pub fn optional_arg(args: &[Value], index: usize) -> Option<String> {
    arg_text(args.get(index))
}

pub fn bool_arg(args: &[Value], index: usize) -> bool {
    arg_flag(args.get(index))
}

/// 数组入参（accounts:logotypes 的批量请求）；不是数组就当空批次，不报错
pub fn array_arg(args: &[Value], index: usize) -> Vec<Value> {
    args.get(index)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub(stdout: &str, stderr: &str, success: bool) -> CliOutcome {
        CliOutcome {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            success,
            password_via_stdin: false,
        }
    }

    #[test]
    fn fail_reason_prefers_stderr_then_stdout() {
        assert_eq!(fail_reason(&stub("out", "err", false), "兜底"), "err");
        assert_eq!(fail_reason(&stub("out", "  ", false), "兜底"), "out");
        assert_eq!(fail_reason(&stub(" ", " ", false), "兜底"), "兜底");
        assert_eq!(
            fail_reason(&stub("第一行\n第二行", "", false), "兜底"),
            "第一行"
        );
    }

    #[test]
    fn arg_readers_accept_numbers_and_reject_blanks() {
        let args = vec![json!("pilot"), json!(1234), json!(""), json!(null)];
        assert_eq!(optional_arg(&args, 0).as_deref(), Some("pilot"));
        assert_eq!(optional_arg(&args, 1).as_deref(), Some("1234"));
        assert_eq!(optional_arg(&args, 2), None);
        assert_eq!(optional_arg(&args, 3), None);
        assert_eq!(optional_arg(&args, 9), None);
        assert!(!bool_arg(&args, 0));
        assert!(bool_arg(&[json!(true)], 0));
    }

    #[test]
    fn list_postprocess_matches_electron_on_real_cli_payload() {
        // 夹具取自真实 `account-cli.js list` 输出（EveJS v0.12.8 实机数据，字段名与类型原样保留）
        let raw = r#"[{"accountKey":"test","accountId":1,"isGM":true,"banned":false,
            "roles":[{"characterId":"140000001","characterName":"Test Pilot","isk":1000000000,
            "skillPoints":384402,"shipName":"Capsule","shipTypeID":670,
            "location":{"stationID":60003760,"stationName":"Jita IV - Moon 4",
            "solarSystemID":30000142,"solarSystemName":"Jita","worldSpaceID":null,
            "label":"Jita IV - Moon 4"},"securityStatus":0}]}]"#;
        let mut accounts: Vec<Value> = serde_json::from_str(raw).expect("夹具应为合法 JSON");

        let dir = std::env::temp_dir().join("evejs-accounts-fixture");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        let settings = dir.join("launcher-settings.json");
        let _ = std::fs::remove_file(&settings);
        assert!(secrets::remember(&settings, "test", "hunter2"));

        let online = vec!["140000001".to_string()];
        decorate_accounts(
            &mut accounts,
            &settings,
            Path::new("Z:\\no-portraits"),
            Some(&online),
        );

        let account = &accounts[0];
        assert_eq!(account["hasStoredCredential"], json!(true));
        assert_eq!(account["isGM"], json!(true));
        assert_eq!(account["roles"][0]["characterId"], json!("140000001"));
        assert_eq!(account["roles"][0]["onlineKnown"], json!(true));
        assert_eq!(account["roles"][0]["online"], json!(true));
        // 没有肖像文件时必须显式 null（渲染层据此回退默认图）
        assert_eq!(account["roles"][0]["avatar"], Value::Null);
        // 原字段一个都不能丢
        assert_eq!(
            account["roles"][0]["location"]["solarSystemName"],
            json!("Jita")
        );
        assert_eq!(account["roles"][0]["skillPoints"], json!(384402));

        let _ = std::fs::remove_file(&settings);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logotype_never_falls_back_to_the_shared_default_image() {
        let root = std::env::temp_dir().join("evejs-logotype-test");
        let legacy = root
            .join("server")
            .join("src")
            .join("_secondary")
            .join("image")
            .join("generated")
            .join("Alliance");
        std::fs::create_dir_all(&legacy).expect("应能建联盟徽标目录");
        std::fs::write(legacy.join("99000000_64.png"), b"legacy").expect("应能写徽标");
        let legacy_url = resolve_logotype_data_url(&root, "alliances", "99000000")
            .expect("应能找到 legacy 联盟徽标");
        assert!(
            legacy_url.starts_with("data:image/png;base64,"),
            "{legacy_url}"
        );

        // 运行时目录优先（尺寸从大到小扫，1024 先命中）
        let runtime = root
            .join("_local")
            .join("gameStore")
            .join("images")
            .join("Alliance");
        std::fs::create_dir_all(&runtime).expect("应能建运行时徽标目录");
        std::fs::write(runtime.join("99000000_1024.png"), b"runtime").expect("应能写运行时徽标");
        let runtime_url = resolve_logotype_data_url(&root, "alliances", "99000000")
            .expect("应能找到运行时联盟徽标");
        assert_ne!(runtime_url, legacy_url, "运行时目录应优先于 legacy 目录");

        // 没有专属徽标：宁可不画，也不回退到与军团兜底图几乎一样的 alliance-default.png
        assert!(resolve_logotype_data_url(&root, "alliances", "99999999").is_none());
        assert!(resolve_logotype_data_url(&root, "corporations", "98000001").is_none());
        // kind 白名单之外、以及路径穿越 ID 一律拒绝
        assert!(resolve_logotype_data_url(&root, "factions", "1").is_none());
        assert!(resolve_logotype_data_url(&root, "alliances", "../../evil").is_none());
        assert!(resolve_logotype_data_url(&root, "alliances", " ").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn logotype_payload_echoes_requests_and_keeps_missing_as_null() {
        let root = std::env::temp_dir().join("evejs-logotype-payload");
        let corp_dir = root
            .join("_local")
            .join("gameStore")
            .join("images")
            .join("Corporation");
        std::fs::create_dir_all(&corp_dir).expect("应能建军团徽标目录");
        std::fs::write(corp_dir.join("98000001_64.jpg"), b"corp").expect("应能写徽标");

        let payload = logotype_payload(
            &root,
            &[
                json!({ "kind": "corporations", "id": 98000001 }),
                json!({ "kind": "alliances", "id": 99000001 }),
            ],
        );
        assert_eq!(payload.len(), 2);
        assert_eq!(payload[0]["kind"], json!("corporations"));
        assert_eq!(payload[0]["id"], json!(98000001));
        assert!(
            payload[0]["dataUrl"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/jpeg;base64,"),
            "{}",
            payload[0]
        );
        // 没有文件就是显式 null（渲染层据此画短标识占位，不是画空图）
        assert!(payload[1]["dataUrl"].is_null(), "{}", payload[1]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn portraits_follow_electron_priority() {
        let root = std::env::temp_dir().join("evejs-portrait-test");
        let runtime = root
            .join("_local")
            .join("gameStore")
            .join("images")
            .join("Character");
        std::fs::create_dir_all(&runtime).expect("应能建肖像目录");
        for name in ["42_64.jpg", "42_128.png"] {
            std::fs::write(runtime.join(name), b"fake").expect("应能写肖像");
        }
        let data_url = resolve_portrait_data_url(&root, "42").expect("应能找到 128 肖像");
        assert!(data_url.starts_with("data:image/png;base64,"), "{data_url}");

        std::fs::remove_file(runtime.join("42_128.png")).expect("应能删测试文件");
        let fallback = resolve_portrait_data_url(&root, "42").expect("应回退到 64 尺寸");
        assert!(
            fallback.starts_with("data:image/jpeg;base64,"),
            "{fallback}"
        );

        assert!(resolve_portrait_data_url(&root, "999").is_none());
        assert!(resolve_portrait_data_url(&root, "  ").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn character_id_whitelist_blocks_path_tricks() {
        // 合法：EvEJS 角色 ID 是数字串，允许 `_` / `-` 与字母
        // 首尾空白先 trim（与调用方一致），trim 之后合法就接受
        for good in ["140000001", "abc-1_2", "A1", " 42 ", &"x".repeat(32)] {
            assert!(is_safe_character_id(good), "{good} 应被接受");
        }
        // 非法：路径穿越、分隔符、盘符、空白、控制字符、超长、空
        for bad in [
            "",
            "   ",
            "..",
            "..\\..\\x",
            "../../x",
            "a/b",
            "a\\b",
            "C:\\evil",
            "42_128.jpg",
            "42*",
            "4 2",
            "\u{1}42",
            &"x".repeat(33),
        ] {
            assert!(!is_safe_character_id(bad), "{bad:?} 应被拒绝");
        }
    }

    #[test]
    fn portrait_lookup_refuses_traversal_ids() {
        // B6 端到端：即使用户在 mods 根同级放了 `evil_128.jpg`，非法 ID 也不该读到它
        let root = std::env::temp_dir().join("evejs-portrait-traversal");
        let character_dir = root
            .join("_local")
            .join("gameStore")
            .join("images")
            .join("Character");
        std::fs::create_dir_all(&character_dir).expect("应能建肖像目录");
        let sibling = root.join("_local").join("gameStore").join("images");
        std::fs::write(sibling.join("evil_128.jpg"), b"fake").expect("应能写同级文件");
        for bad in ["..\\..\\evil", "../evil", "..", "a/b"] {
            assert!(
                resolve_portrait_data_url(&root, bad).is_none(),
                "{bad} 不应解析出肖像"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
