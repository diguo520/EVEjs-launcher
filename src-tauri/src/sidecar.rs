//! Node 侧车调用：把仓库自带的 CLI 脚本当外部工具执行（`account-cli.js` / `database-cli.js` / `init` 系列）。
//!
//! 迁移决策（见 `docs/框架迁移方案.md` §4）：这两个脚本**继续用 Node 跑**，不重写进 Rust。
//! 理由：它们与服务端共用同一套账号哈希算法与 SQLite 表结构，重写等于制造第二套真相；
//! 而且账号 CRUD / 数据库管理都是低频操作，Node 冷启动开销可接受。
//! 若将来成为瓶颈，按执行计划 S2.5 做常驻侧车，本模块接口不变。
//!
//! B5 加固（S3）：
//!   1. Node 解释器**不再裸名** `node` —— 走 [`node_executable`] 解析成绝对路径
//!      （`EVEJS_NODE` → 随包 node → PATH 扫描），避免 PATH 劫持与 CreateProcess 隐式搜索；
//!   2. 密码**不再进 argv** —— 候选脚本里若有一份支持 `--password-stdin`（约定见
//!      `vendor/cli/account-cli.js`），就用 stdin 传密码；只有当所有候选都是老脚本时才退回
//!      argv（老脚本契约无法绕开），并在 [`CliOutcome::password_via_stdin`] 里如实标注。
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[cfg(windows)]
use crate::win32::CREATE_NO_WINDOW;

/// CLI 输出上限，对齐现役版 execFile 的 maxBuffer（8 MB）
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// B5：密码走 stdin 的 CLI 约定（由 vendor/cli 脚本实现）
const PASSWORD_STDIN_FLAG: &str = "--password-stdin";

/// B5：密码在 argv 里的**占位符**。调用方把它放在密码该出现的那个位置上，
/// [`run_with_password`] 再决定把它换成 `--password-stdin`（支持 stdin 时）还是真密码（老脚本）。
/// 这样无论走哪条路，参数**位置**都与老契约一致，不会因为换传输方式而错位。
pub const PASSWORD_SLOT: &str = "__EVEJS_PASSWORD__";

#[cfg(windows)]
const NODE_EXE_NAMES: [&str; 1] = ["node.exe"];
#[cfg(not(windows))]
const NODE_EXE_NAMES: [&str; 1] = ["node"];

#[derive(Debug, Clone)]
pub struct CliOutcome {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    /// B5：本次调用密码是否走了 stdin（false = 退回 argv，说明用的是老脚本）
    pub password_via_stdin: bool,
}

/// 脚本查找顺序（每条都有存在理由，不要随意调换）：
///   1. `EVEJS_CLI_DIR`               —— 测试/部署覆盖
///   2. `<repoRoot>/scripts/<name>`   —— 服务端仓库自带，优先，便于服务端自行升级脚本
///   3. `<exeDir>/_launcher/cli/<n>`  —— 便携版随包（build.ps1 从 vendor/cli 拷贝）
///   4. `<exeDir>/resources/<name>`   —— 打包版 extraResources 布局
///   5. `<exeDir>/<name>`             —— 用户手动摊平放置
///   6. 开发态 vendor 目录            —— `cargo run` 时无需先拷贝
fn script_candidates(repo_root: &Path, name: &str) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("EVEJS_CLI_DIR") {
        if !dir.is_empty() {
            candidates.push(PathBuf::from(dir).join(name));
        }
    }
    candidates.push(repo_root.join("scripts").join(name));
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("_launcher").join("cli").join(name));
        candidates.push(exe_dir.join("resources").join(name));
        candidates.push(exe_dir.join(name));
    }
    // 开发态：编译期把源码目录写进二进制
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("cli")
            .join(name),
    );
    candidates
}

/// 第一个存在的候选（无密码命令走这里）
pub fn script_path(repo_root: &Path, name: &str) -> Option<PathBuf> {
    script_candidates(repo_root, name)
        .into_iter()
        .find(|path| path.is_file())
}

/// B5：候选里第一个「支持 `--password-stdin`」的脚本。命中即可保证密码完全不进 argv。
pub fn password_stdin_script(repo_root: &Path, name: &str) -> Option<PathBuf> {
    script_candidates(repo_root, name)
        .into_iter()
        .find(|path| path.is_file() && script_supports_password_stdin(path))
}

fn script_supports_password_stdin(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.contains(PASSWORD_STDIN_FLAG))
        .unwrap_or(false)
}

/// Node 解释器的**绝对路径**。
///
/// 解析顺序：`EVEJS_NODE` → 随包 `_launcher/node/node.exe` / exe 同级 → PATH 扫描。
/// 全都找不到就报错（fail closed）：宁可让用户看到「请安装 Node」，
/// 也不退回裸名 `node`，否则等于把 PATH 劫持面留着。
pub fn node_executable() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("EVEJS_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("EVEJS_NODE 指向的文件不存在：{}", path.display()));
    }
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        for candidate in [
            exe_dir
                .join("_launcher")
                .join("node")
                .join(NODE_EXE_NAMES[0]),
            exe_dir.join(NODE_EXE_NAMES[0]),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if let Some(found) = find_in_path(&NODE_EXE_NAMES) {
        return Ok(found);
    }
    Err(format!(
        "未找到 Node.js：请安装 Node，或设置 EVEJS_NODE=<{} 的绝对路径>",
        NODE_EXE_NAMES[0]
    ))
}

/// 在 PATH 里按顺序找（等价 `where node`，但不依赖外部进程），命中即返回绝对路径
fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_name(script: &Path) -> String {
    script
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| script.display().to_string())
}

/// 执行 `node <script> <args...>`，cwd 固定为仓库根（与现役版 execFile 一致）。
/// `stdin` 为 `Some` 时把内容写进子进程标准输入并关闭（密码走这条路）。
pub async fn run_script(
    script: &Path,
    repo_root: &Path,
    args: &[String],
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<CliOutcome, String> {
    let node = node_executable()?;
    let name = command_name(script);
    let mut command = Command::new(&node);
    command
        .arg(script)
        .args(args)
        .current_dir(repo_root)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let payload = stdin.map(|text| text.to_string());
    let label = name.clone();
    let job = async move {
        let mut child = command
            .spawn()
            .map_err(|err| format!("启动 node 失败（{label}）: {err}"))?;
        if let Some(text) = payload {
            if let Some(mut sink) = child.stdin.take() {
                sink.write_all(text.as_bytes())
                    .await
                    .map_err(|err| format!("写入 {label} 标准输入失败: {err}"))?;
                let _ = sink.shutdown().await;
            }
        }
        child
            .wait_with_output()
            .await
            .map_err(|err| format!("等待 {label} 退出失败: {err}"))
    };

    let output = match tokio::time::timeout(timeout, job).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => return Err(err),
        Err(_) => return Err(format!("{name} 执行超时（{}s）", timeout.as_secs())),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stdout.len() > MAX_OUTPUT_BYTES {
        return Err(format!("{name} 输出过大（超过 8 MB），请缩小查询范围"));
    }
    Ok(CliOutcome {
        stdout,
        stderr,
        success: output.status.success(),
        password_via_stdin: false,
    })
}

fn missing_script(name: &str) -> String {
    format!("{name} 不存在（已查找仓库 scripts/ 与 exe 同级 _launcher/cli/）")
}

/// 无密码命令：按名字解析脚本后执行
pub async fn run(
    repo_root: &Path,
    name: &str,
    args: &[String],
    timeout: Duration,
) -> Result<CliOutcome, String> {
    let Some(script) = script_path(repo_root, name) else {
        return Err(missing_script(name));
    };
    run_script(&script, repo_root, args, None, timeout).await
}

/// B5：含密码命令。优先用支持 `--password-stdin` 的脚本（密码不进 argv），
/// 只有候选里全是老脚本时才退回 argv。
pub async fn run_with_password(
    repo_root: &Path,
    name: &str,
    mut args: Vec<String>,
    password: &str,
    timeout: Duration,
) -> Result<CliOutcome, String> {
    if let Some(script) = password_stdin_script(repo_root, name) {
        if fill_password_slot(&mut args, PASSWORD_STDIN_FLAG) == 0 {
            return Err("内部错误：调用方没有放 PASSWORD_SLOT 占位符".to_string());
        }
        // 末尾补一个换行：老式 `readFileSync(0)` 读取时先按行剥掉，避免 Windows 上把 \r 带进哈希
        let payload = format!("{password}\n");
        let mut outcome = run_script(&script, repo_root, &args, Some(&payload), timeout).await?;
        outcome.password_via_stdin = true;
        return Ok(outcome);
    }
    let Some(script) = script_path(repo_root, name) else {
        return Err(missing_script(name));
    };
    if fill_password_slot(&mut args, password) == 0 {
        return Err("内部错误：调用方没有放 PASSWORD_SLOT 占位符".to_string());
    }
    run_script(&script, repo_root, &args, None, timeout).await
}

/// 把占位符换成实际值，返回替换了几处（0 处说明调用方少放了密码位）
fn fill_password_slot(args: &mut [String], value: &str) -> usize {
    let mut hit = 0;
    for slot in args.iter_mut() {
        if slot == PASSWORD_SLOT {
            *slot = value.to_string();
            hit += 1;
        }
    }
    hit
}

/// 执行并把 stdout 解析成 JSON；失败语义与现役版 parseResult 对齐
pub async fn run_json(
    repo_root: &Path,
    name: &str,
    args: &[String],
    timeout: Duration,
) -> Result<Value, String> {
    let outcome = run(repo_root, name, args, timeout).await?;
    parse_json(name, outcome)
}

/// 含密码版本（B5）：与 [`run_json`] 同语义，只是密码走 stdin 优先的路径
pub async fn run_json_with_password(
    repo_root: &Path,
    name: &str,
    args: Vec<String>,
    password: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let outcome = run_with_password(repo_root, name, args, password, timeout).await?;
    parse_json(name, outcome)
}

fn parse_json(name: &str, outcome: CliOutcome) -> Result<Value, String> {
    if !outcome.success {
        let text = if outcome.stderr.trim().is_empty() {
            outcome.stdout.trim()
        } else {
            outcome.stderr.trim()
        };
        return Err(if text.is_empty() {
            format!("{name} 执行失败")
        } else {
            first_line(text)
        });
    }
    serde_json::from_str(outcome.stdout.trim()).map_err(|err| {
        format!(
            "返回数据解析失败: {err}（原始输出前 200 字符：{}）",
            truncate(outcome.stdout.trim(), 200)
        )
    })
}

/// 进度/日志类调用：只要退出码，stdout 原样返回（供终端推送）
pub async fn run_passthrough(
    repo_root: &Path,
    name: &str,
    args: &[String],
    timeout: Duration,
) -> Result<CliOutcome, String> {
    run(repo_root, name, args, timeout).await
}

pub fn first_line(text: &str) -> String {
    text.lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-sidecar-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        dir
    }

    #[test]
    fn first_line_skips_blank_lines() {
        assert_eq!(first_line("\r\n  \r\nboom\r\ntrace"), "boom");
        assert_eq!(first_line("   "), "");
    }

    #[test]
    fn script_path_prefers_env_override_dir() {
        let dir = temp_dir("env");
        let script = dir.join("fake-cli.js");
        std::fs::write(&script, "// stub").expect("应能写测试脚本");
        std::env::set_var("EVEJS_CLI_DIR", &dir);

        let found = script_path(Path::new("Z:\\not-exist"), "fake-cli.js");
        std::env::remove_var("EVEJS_CLI_DIR");

        assert_eq!(found.as_deref(), Some(script.as_path()));
    }

    #[test]
    fn missing_script_reports_clearly() {
        assert!(script_path(Path::new("Z:\\not-exist"), "nope-cli.js").is_none());
        assert!(password_stdin_script(Path::new("Z:\\not-exist"), "nope-cli.js").is_none());
    }

    #[test]
    fn password_stdin_script_skips_scripts_without_the_flag() {
        let root = temp_dir("pw-probe");
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).expect("应能建 scripts 目录");
        let script = scripts.join("pw-cli.js");
        std::fs::write(&script, "// 老脚本：没有 stdin 约定").unwrap();
        assert!(password_stdin_script(&root, "pw-cli.js").is_none());

        std::fs::write(
            &script,
            "// 新脚本\nconst USE = process.argv.includes(\"--password-stdin\");",
        )
        .unwrap();
        assert_eq!(
            password_stdin_script(&root, "pw-cli.js").as_deref(),
            Some(script.as_path())
        );
    }

    #[test]
    fn vendored_account_cli_supports_password_stdin() {
        let vendored = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("cli")
            .join("account-cli.js");
        assert!(
            script_supports_password_stdin(&vendored),
            "随包 account-cli.js 必须支持 --password-stdin（B5）"
        );
    }

    #[test]
    fn node_executable_is_absolute_when_found() {
        match node_executable() {
            Ok(path) => assert!(
                path.is_absolute(),
                "node 必须是绝对路径：{}",
                path.display()
            ),
            // 机器上确实没有 Node 时是 fail closed，不算失败（但错误信息必须可操作）
            Err(reason) => assert!(
                reason.contains("EVEJS_NODE"),
                "错误信息应给出补救办法：{reason}"
            ),
        }
    }

    #[test]
    fn find_in_path_returns_absolute_candidate() {
        let dir = temp_dir("path-scan");
        let target = dir.join(NODE_EXE_NAMES[0]);
        std::fs::write(&target, "// stub").unwrap();
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", &dir);
        let found = find_in_path(&NODE_EXE_NAMES);
        match previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        assert_eq!(found.as_deref(), Some(target.as_path()));
    }
}
