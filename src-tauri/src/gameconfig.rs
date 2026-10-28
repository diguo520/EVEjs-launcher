//! 游戏世界参数（服务端 `config/*.json`）的读写通道。
//!
//! 为什么规则不写在这里：条目定义、取值范围、整型约束、枚举、原子写全都在服务端
//! `server/src/config/manager.js` 里，启动器抄一份就是第二套真相 —— 服务端升版
//! schema 之后两边必然漂移。所以这里只做搬运，真正的规则由随包侧车
//! `vendor/cli/game-config-cli.js` 调用服务端自己的 manager 执行。
//!
//! 副作用边界：**只写 `config/*.json`**（写前先整份备份到 `_local/config-backups/`），
//! 不碰 `server/` 下的任何源码，也不碰 `config/version.json` 的版本号。
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;

use crate::sidecar;

/// 侧车文件名（随包释放到 `<exe 同级>/_launcher/cli/`，见 seed.rs）
const SCRIPT: &str = "game-config-cli.js";
/// 读：167 条定义 + 快照，耗时以 node 冷启动为主
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 写：先备份再原子写若干个域文件
const SAVE_TIMEOUT: Duration = Duration::from_secs(60);

/// 调一次游戏参数侧车（A7，2026-10-29）：流程与 storeeditor 逐字相同，已收在 `sidecar` 里，
/// 这里只给自己的脚本名、文案与超时（三处 SLA 不同，超时绝不统一）。
pub(crate) async fn call(
    root: &Path,
    args: Vec<String>,
    stdin: Option<&str>,
    timeout: Duration,
) -> Value {
    sidecar::call_sidecar(root, SCRIPT, "游戏参数", args, stdin, timeout).await
}

/// 读全部条目定义、当前值与来源。纯读，不写盘。
pub async fn read(root: &Path) -> Value {
    call(
        root,
        vec![
            "read".to_string(),
            "--root".to_string(),
            root.to_string_lossy().to_string(),
        ],
        None,
        READ_TIMEOUT,
    )
    .await
}

/// 写一批配置项（键 → 值）。校验、备份、原子写都在侧车里完成。
pub async fn save(root: &Path, patch: &Map<String, Value>) -> Value {
    let payload = json!({ "patch": Value::Object(patch.clone()) }).to_string();
    call(
        root,
        vec![
            "save".to_string(),
            "--root".to_string(),
            root.to_string_lossy().to_string(),
        ],
        Some(&payload),
        SAVE_TIMEOUT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 随包侧车必须在仓里，且必须复用服务端的 createConfigManager
    /// （抄进 Rust 或另写一套规则都会让「服务端升版即漂移」重现）
    #[test]
    fn vendored_cli_reuses_the_server_config_manager() {
        let vendored = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("cli")
            .join(SCRIPT);
        assert!(vendored.is_file(), "随包侧车缺失：{}", vendored.display());
        let text = std::fs::read_to_string(&vendored).unwrap();
        assert!(
            text.contains("createConfigManager") && text.contains("saveConfig"),
            "侧车必须走服务端 manager 的 createConfigManager / saveConfig"
        );
    }
}
