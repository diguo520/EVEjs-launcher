//! 客户端证书信任：**没装过就装、装过就覆盖，且不因前置缺失而失败**（2026-11-01）。
//!
//! 报障原文是脚本自己那句 `Certificate tooling gate: node-forge is missing ...`：脚本是在**仓库根**
//! 做 `require('node-forge')` 的，而启动器原来的「主服务器依赖」任务只执行 `cd server && npm ci`
//! —— 根 `node_modules` 永远是空的，于是「重新打客户端证书」根本走不到证书那一步。
//!
//! 这个模块把整条链补上：
//!
//!   1. **状态**：服务端 CA 文件在不在 + 客户端两个 `cacert.pem` 里有没有**当前那把** CA
//!      （逐字节比 base64；不靠文件名、也不搜 "EvEJS" 字样 —— PEM 正文里不一定出现它）；
//!   2. **自愈**：脚本的前置（Node 与根 `node-forge`）缺了，就在安装根补一次 `npm ci`，补完再探；
//!   3. **执行**：跑服务端自带的 `Install-EvEJSCerts.ps1`（它本身幂等：清掉 bundle 里旧的 EveJS 段
//!      再追加当前 CA、把 CA 装进 `CurrentUser\Root`、必要时重铸叶子），
//!      并把每道门的原文翻成可操作的中文提示（对照 `docs/证书重装-处置手册.md`）。
//!
//! 因此「装过 → 覆盖」与「没装过 → 装上」是同一条路径：脚本自己按当前 CA/叶子重写两份 bundle，
//! 启动器只需要保证它跑得起来、并且如实把结果报出来。
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};

/// 服务端随包的证书脚本（相对安装根，与 `InstallCerts.bat` 指向同一个文件）
const SCRIPT_REL: [&str; 4] = ["tools", "ClientSETUP", "scripts", "Install-EvEJSCerts.ps1"];
/// 客户端信任包（相对客户端 `tq`）：脚本处理的就是这两份，缺任何一份都算没装全
const BUNDLE_REL: [&[&str]; 2] = [
    &["bin64", "cacert.pem"],
    &["bin64", "packages", "certifi", "cacert.pem"],
];
/// 脚本生成的服务端 CA（`EVEJS_CA_PEM` 没配或指向不存在的文件时用它兜底）
const SERVER_CA_REL: [&str; 3] = ["_local", "certs", "xmpp-ca-cert.pem"];

/// node-forge 探针超时（node 冷启动为主）。名字带 FORGE_ 前缀：查重门禁要求文件级 const 全局唯一，
/// 而 `env.rs` 里已经有一个通用 `PROBE_TIMEOUT`。
const FORGE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// `npm ci` 超时：根依赖是纯 JS，但要留网络与解包时间
const NPM_TIMEOUT: Duration = Duration::from_secs(600);

pub fn script_path(root: &Path) -> PathBuf {
    SCRIPT_REL
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// 客户端信任包路径（`client_path` 应指向 `...\tq`）
pub fn bundle_paths(client_path: &str) -> Vec<PathBuf> {
    let base = Path::new(client_path);
    BUNDLE_REL
        .iter()
        .map(|parts| {
            parts
                .iter()
                .fold(base.to_path_buf(), |path, part| path.join(part))
        })
        .collect()
}

/// 去掉所有空白，便于整段比对 base64
fn compact(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// PEM 里第一张证书的 base64（去空白）。给的是 CA 文件时就是那把 CA。
pub fn first_certificate_base64(text: &str) -> Option<String> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = text.find(BEGIN)? + BEGIN.len();
    let rest = &text[start..];
    let end = rest.find(END)?;
    let body = compact(&rest[..end]);
    (!body.is_empty()).then_some(body)
}

/// bundle 里有没有当前这把 CA —— 逐字节比 base64，不看文件名
pub fn bundle_contains_ca(bundle_text: &str, ca_text: &str) -> bool {
    match first_certificate_base64(ca_text) {
        Some(ca) => compact(bundle_text).contains(&ca),
        None => false,
    }
}

/// 把脚本的门翻译成可操作的中文提示；不是已知的门就返回 None（原文照旧透出）
pub fn gate_hint(text: &str) -> Option<&'static str> {
    let has = |needle: &str| text.contains(needle);
    if has("node-forge is missing") {
        return Some("证书工具依赖缺失（安装根没有 node-forge）：启动器会自动补一次 npm ci；若仍失败，请检查网络或用镜像 npm ci --registry=https://registry.npmmirror.com");
    }
    if has("Node.js was not found") {
        return Some("找不到 Node.js：装 LTS 版（https://nodejs.org）后重试");
    }
    if has("retired or unconstrained EveJS CA") {
        return Some("信任库里留着退役/无约束的 EveJS CA：需要「轮换 CA」重装（会影响所有已装过证书的客户端）");
    }
    if has("regenerate the chat and both gateway leaves") {
        return Some("服务端叶子证书过期或缺少必需域名：需要「轮换 CA」重装");
    }
    if has("current EveJS CA is not in") {
        return Some("当前 CA 不在 Windows 信任库里：重装一次即可（可能会弹一次确认）");
    }
    if has("Client path was not found") {
        return Some("客户端路径没配好：在配置面板填 EVEJS_CLIENT_PATH，要指到 ...\tq");
    }
    if has("No client cacert.pem bundle was found") {
        return Some("客户端路径指错了：要指到 ...\tq（不是 EVE 安装根）");
    }
    if has("Failed to verify EvEJS CA inside") {
        return Some("写入客户端信任包后回读校验失败：多半是被占用或杀软拦截，用管理员重试一次");
    }
    None
}

/// 一个信任包的状态
#[derive(Clone, Debug)]
pub struct BundleState {
    pub path: PathBuf,
    pub present: bool,
    pub has_ca: bool,
}

/// 客户端证书信任的整体状态
#[derive(Clone, Debug)]
pub struct CertStatus {
    pub ca_path: Option<PathBuf>,
    pub ca_present: bool,
    pub script_present: bool,
    pub client_path: String,
    pub bundles: Vec<BundleState>,
}

impl CertStatus {
    /// 两个信任包都拿到、且都含当前 CA 才算装好（只有一个存在时按存在的那个判）
    pub fn installed(&self) -> bool {
        let present: Vec<&BundleState> = self.bundles.iter().filter(|item| item.present).collect();
        self.ca_present && !present.is_empty() && present.iter().all(|item| item.has_ca)
    }

    pub fn bundles_with_ca(&self) -> usize {
        self.bundles
            .iter()
            .filter(|item| item.present && item.has_ca)
            .count()
    }

    pub fn bundles_present(&self) -> usize {
        self.bundles.iter().filter(|item| item.present).count()
    }

    /// 给人看的一句话（环境自检那一行）
    pub fn summary(&self) -> String {
        if self.client_path.trim().is_empty() {
            return "未配置客户端路径".to_string();
        }
        if !Path::new(&self.client_path).is_dir() {
            return format!("客户端路径不存在: {}", self.client_path);
        }
        if self.bundles_present() == 0 {
            return "客户端目录里找不到信任包（cacert.pem）".to_string();
        }
        if self.installed() {
            return format!(
                "已装入客户端（{}/{} 个信任包）",
                self.bundles_with_ca(),
                self.bundles_present()
            );
        }
        format!(
            "客户端缺少 CA（{}/{} 个信任包已含）",
            self.bundles_with_ca(),
            self.bundles_present()
        )
    }

    pub fn to_json(&self) -> Value {
        json!({
            "installed": self.installed(),
            "caPath": self.ca_path.as_ref().map(|path| path.to_string_lossy().to_string()),
            "caPresent": self.ca_present,
            "clientPath": self.client_path,
            "scriptPresent": self.script_present,
            "bundles": self.bundles.iter().map(|item| json!({
                "path": item.path.to_string_lossy(),
                "present": item.present,
                "hasCa": item.has_ca,
            })).collect::<Vec<Value>>(),
        })
    }
}

/// 当前该拿哪份 CA：配置里的 `EVEJS_CA_PEM` 优先，缺失则用服务端脚本生成的那份
pub fn resolve_ca_path(root: &Path) -> Option<PathBuf> {
    let configured = crate::config::read_client_config(root).ca_pem;
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    let fallback = SERVER_CA_REL
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    fallback.is_file().then_some(fallback)
}

/// 读盘算状态（纯读，不启动任何进程）
pub fn status(root: &Path, client_path: &str, ca_path: Option<&Path>) -> CertStatus {
    let ca_text = ca_path.and_then(|path| std::fs::read_to_string(path).ok());
    let bundles = bundle_paths(client_path)
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).ok();
            let has_ca = match (text.as_deref(), ca_text.as_deref()) {
                (Some(bundle), Some(ca)) => bundle_contains_ca(bundle, ca),
                _ => false,
            };
            BundleState {
                present: text.is_some(),
                path,
                has_ca,
            }
        })
        .collect();
    CertStatus {
        ca_path: ca_path.map(Path::to_path_buf),
        ca_present: ca_text.is_some(),
        script_present: script_path(root).is_file(),
        client_path: client_path.to_string(),
        bundles,
    }
}

/// 用配置里的客户端路径算状态（环境自检那条走这里）
pub fn status_from_config(root: &Path) -> CertStatus {
    let client = crate::config::read_client_config(root);
    let ca = resolve_ca_path(root);
    status(root, &client.client_path, ca.as_deref())
}

struct Capture {
    ok: bool,
    stdout: String,
    stderr: String,
}

async fn command_capture(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<Capture, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Ok(Capture {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Ok(Err(err)) => Err(crate::sidecar::first_line(&err.to_string())),
        Err(_) => Err(format!("命令超时（{}s）", timeout.as_secs())),
    }
}

/// 在安装根探 `node-forge`：与脚本自己的 `Test-NodeForgeAvailable` 同一个判定
async fn probe_forge(root: &Path) -> Result<(), String> {
    let args = vec!["-e".to_string(), "require('node-forge')".to_string()];
    match command_capture("node", &args, root, FORGE_PROBE_TIMEOUT).await {
        Ok(capture) if capture.ok => Ok(()),
        Ok(capture) => Err(crate::sidecar::first_line(
            if capture.stderr.trim().is_empty() {
                &capture.stdout
            } else {
                &capture.stderr
            },
        )),
        Err(reason) => Err(reason),
    }
}

/// 找 npm（Windows 上 `npm` 是 `.cmd`，两个都试）
fn find_npm() -> Option<String> {
    for candidate in ["npm.cmd", "npm"] {
        if let Ok(output) = std::process::Command::new("where.exe")
            .arg(candidate)
            .output()
        {
            if output.status.success() {
                let line = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !line.is_empty() {
                    return Some(line);
                }
            }
        }
    }
    None
}

/// 证书脚本的前置：Node + **仓库根**的 node-forge。缺了就在根补一次 `npm ci`。
///
/// 返回 `(ok, detail)`；`detail` 是给界面/log 看的一句话（补了什么、补完还缺什么）。
pub async fn ensure_forge(root: &Path) -> (bool, String) {
    if probe_forge(root).await.is_ok() {
        return (true, "证书工具依赖就绪".to_string());
    }
    let Some(npm) = find_npm() else {
        return (false, "找不到 npm：装 Node.js LTS 后重试".to_string());
    };
    let args = vec![
        "ci".to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
    ];
    let detail = match command_capture(&npm, &args, root, NPM_TIMEOUT).await {
        Ok(capture) if capture.ok => {
            if probe_forge(root).await.is_ok() {
                "已在安装根执行 npm ci，证书工具依赖已就绪".to_string()
            } else {
                "执行了 npm ci，但 node-forge 仍不可用（检查 package.json / 网络）".to_string()
            }
        }
        Ok(capture) => format!(
            "npm ci 失败：{}",
            crate::sidecar::first_line(&capture.stderr)
        ),
        Err(reason) => format!("npm ci 失败：{reason}"),
    };
    (probe_forge(root).await.is_ok(), detail)
}

/// 界面按钮 / 启动前准备走的入口：客户端路径取自 `EVEJS_CLIENT_PATH`
pub async fn ensure_from_config(root: &Path) -> Value {
    let client_path = crate::config::read_client_config(root).client_path;
    ensure(root, &client_path).await
}

/// 打（或重打）客户端证书：自愈前置 → 跑服务端脚本 → 复检状态。
///
/// **幂等**：装过与没装过走同一条路，脚本自己按当前 CA/叶子重写两份 bundle。
pub async fn ensure(root: &Path, client_path: &str) -> Value {
    let script = script_path(root);
    if !script.is_file() {
        return json!({
            "ok": false,
            "stage": "script",
            "reason": "服务端目录里没有 Install-EvEJSCerts.ps1",
            "hint": "先跑一次 SetupEveJS.bat，或确认这套安装的服务端文件是完整的",
        });
    }
    if client_path.trim().is_empty() {
        return json!({
            "ok": false,
            "stage": "client",
            "reason": "未配置客户端路径",
            "hint": "在配置面板填写 EVEJS_CLIENT_PATH（要指到 ...\tq）",
        });
    }
    if !Path::new(client_path).is_dir() {
        return json!({
            "ok": false,
            "stage": "client",
            "reason": format!("客户端路径不存在: {client_path}"),
            "hint": "检查客户端是否已安装，或路径是否指到了 ...\tq",
        });
    }

    let (tooling_ok, tooling_detail) = ensure_forge(root).await;
    if !tooling_ok {
        return json!({
            "ok": false,
            "stage": "tooling",
            "reason": tooling_detail,
            "hint": gate_hint("node-forge is missing"),
        });
    }

    let run = crate::process::run_client_setup_script(
        &script,
        vec!["-ClientPath".to_string(), client_path.to_string()],
        Vec::new(),
    )
    .await;

    let ca = resolve_ca_path(root);
    let after = status(root, client_path, ca.as_deref());
    let mut payload = json!({
        "ok": after.installed(),
        "stage": "verify",
        "detail": tooling_detail,
        "status": after.to_json(),
    });
    match run {
        Ok(output) => {
            payload["scriptOutput"] = json!(crate::sidecar::first_line(&output));
            if !after.installed() {
                payload["reason"] = json!(after.summary());
            }
        }
        Err(reason) => {
            payload["ok"] = json!(false);
            payload["reason"] = json!(reason.clone());
            if let Some(hint) = gate_hint(&reason) {
                payload["hint"] = json!(hint);
            }
            if !after.installed() {
                payload["statusSummary"] = json!(after.summary());
            }
        }
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    const CA_PEM: &str = "-----BEGIN CERTIFICATE-----\nQUJDREVGR0g=\n-----END CERTIFICATE-----";

    #[test]
    fn certificate_body_is_extracted_without_whitespace() {
        assert_eq!(
            first_certificate_base64(CA_PEM),
            Some("QUJDREVGR0g=".to_string())
        );
        assert_eq!(first_certificate_base64("no pem here"), None);
        assert_eq!(
            first_certificate_base64("-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----"),
            None
        );
    }

    #[test]
    fn bundle_match_ignores_line_endings_and_spacing() {
        let bundle = format!("bag\r\n{}\r\nmore\r\n", CA_PEM.replace("\n", "\r\n"));
        assert!(bundle_contains_ca(&bundle, CA_PEM));
        assert!(!bundle_contains_ca(
            "-----BEGIN CERTIFICATE-----\nT1RIRVI=\n-----END CERTIFICATE-----",
            CA_PEM
        ));
        // CA 文件本身读不出来时不能误判成"已装入"
        assert!(!bundle_contains_ca(&bundle, "garbage"));
    }

    #[test]
    fn bundle_paths_cover_both_client_trust_stores() {
        let paths = bundle_paths("F:\\EVE Online - 3396210\\tq");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("bin64\\cacert.pem"));
        assert!(paths[1].ends_with("certifi\\cacert.pem"));
    }

    #[test]
    fn each_gate_gets_an_actionable_hint() {
        assert!(gate_hint("Certificate tooling gate: node-forge is missing.").is_some());
        assert!(gate_hint("Node.js was not found on PATH.").is_some());
        assert!(
            gate_hint("CA trust gate: retired or unconstrained EveJS CA still trusted.").is_some()
        );
        assert!(gate_hint("Client path was not found.").is_some());
        assert!(gate_hint("Failed to verify EvEJS CA inside X after writing.").is_some());
        assert_eq!(gate_hint("something else entirely"), None);
    }
}
