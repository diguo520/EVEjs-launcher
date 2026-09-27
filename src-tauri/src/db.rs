//! 数据库管理：对齐现役版 `src/main/databaseManager.ts`。
//!
//! 实现方式是**调用仓库自带的 `database-cli.js`**（见 `sidecar` 模块的迁移决策），
//! 因此这里只负责：拼参数、写保护检查、把 CLI 的 JSON 原样回给渲染层。
//!
//! 写保护：数据库写入/恢复前必须没有服务在跑（现役版 writeBlocked()），
//! 否则 SQLite 可能出现「服务端持锁 + 启动器写库」的双写冲突。
use crate::sidecar;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const DATABASE_CLI: &str = "database-cli.js";
const DATABASE_CLI_TIMEOUT: Duration = Duration::from_secs(30);

fn arg(value: impl Into<String>) -> String {
    value.into()
}

/// 与现役版一致：只要不是 idle/error，就认为服务在跑，禁止写库
fn write_blocked(active: &[String]) -> Option<String> {
    if active.is_empty() {
        None
    } else {
        Some(format!("请先停止服务：{}", active.join("、")))
    }
}

async fn call(repo_root: &Path, args: Vec<String>) -> Value {
    match sidecar::run_json(repo_root, DATABASE_CLI, &args, DATABASE_CLI_TIMEOUT).await {
        Ok(value) => value,
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

pub async fn overview(repo_root: &Path) -> Value {
    call(
        repo_root,
        vec![arg("overview"), arg(repo_root.to_string_lossy())],
    )
    .await
}

pub async fn table(repo_root: &Path, table: &str, limit: u32, offset: u32) -> Value {
    call(
        repo_root,
        vec![
            arg("table"),
            arg(repo_root.to_string_lossy()),
            arg(table),
            arg(limit.to_string()),
            arg(offset.to_string()),
        ],
    )
    .await
}

pub async fn backup(repo_root: &Path) -> Value {
    call(
        repo_root,
        vec![
            arg("backup"),
            arg(repo_root.to_string_lossy()),
            arg("gamestore"),
        ],
    )
    .await
}

pub async fn backups(repo_root: &Path) -> Value {
    call(
        repo_root,
        vec![arg("backups"), arg(repo_root.to_string_lossy())],
    )
    .await
}

pub async fn restore(repo_root: &Path, name: &str, active: &[String]) -> Value {
    if let Some(reason) = write_blocked(active) {
        return json!({ "ok": false, "reason": reason });
    }
    call(
        repo_root,
        vec![
            arg("restore"),
            arg(repo_root.to_string_lossy()),
            arg(name),
            arg("--apply"),
        ],
    )
    .await
}

pub async fn save_row(repo_root: &Path, table: &str, values: &Value, active: &[String]) -> Value {
    write_row(repo_root, "save", table, values, active).await
}

pub async fn insert_row(repo_root: &Path, table: &str, values: &Value, active: &[String]) -> Value {
    write_row(repo_root, "insert", table, values, active).await
}

pub async fn delete_row(repo_root: &Path, table: &str, values: &Value, active: &[String]) -> Value {
    if let Some(reason) = write_blocked(active) {
        return json!({ "ok": false, "reason": reason });
    }
    call(
        repo_root,
        vec![
            arg("delete"),
            arg(repo_root.to_string_lossy()),
            arg(table),
            serde_json::to_string(values).unwrap_or_else(|_| "{}".to_string()),
            arg("--apply"),
        ],
    )
    .await
}

async fn write_row(
    repo_root: &Path,
    command: &str,
    table: &str,
    values: &Value,
    active: &[String],
) -> Value {
    if let Some(reason) = write_blocked(active) {
        return json!({ "ok": false, "reason": reason });
    }
    call(
        repo_root,
        vec![
            arg(command),
            arg(repo_root.to_string_lossy()),
            arg(table),
            serde_json::to_string(values).unwrap_or_else(|_| "{}".to_string()),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_guard_matches_electron_wording() {
        assert!(write_blocked(&[]).is_none());
        let reason = write_blocked(&["主服务器".to_string(), "市场服务".to_string()]);
        assert_eq!(reason.as_deref(), Some("请先停止服务：主服务器、市场服务"));
    }
}
