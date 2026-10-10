//! 新伊甸商城（服务端 `newEdenStore` 权威数据）的读写通道。
//!
//! 为什么规则不写在这里：商品目录的形状、PLEX 定价、发货规则（fulfillment）、整棵写盘与
//! 缓存失效全都在服务端 `server/src/services/newEdenStore/storeState.js` 里。启动器抄一份
//! 就是第二套真相 —— 服务端升版之后两边必然漂移。所以这里只做搬运，真正的规则由随包侧车
//! `vendor/cli/store-cli.js` 调用服务端自己的 `getEditorSnapshot` / `saveEditorAuthority` 执行。
//!
//! 副作用边界：**只写服务端的 `newEdenStore` 表**，不碰 `server/` 下的任何源码，
//! 也不碰存档里的其它表。注意 `saveEditorAuthority` 是**整棵覆盖**，所以写回的内容必须是
//! 「读出来的整棵 authority + 改过的字段」，不能只送差异 —— 侧车与渲染层都按这个约定走。
//!
//! 服务在跑时**读可以、写拒绝**：服务端进程自己持有商城缓存并会对同一张表写入
//! （购买结算会追加流水），两边同时写必然互相覆盖。这个判断在 ipc 层用
//! `danger::blocked_by_services` 做 —— 侧车自己看不到服务状态。
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use crate::sidecar;

/// 侧车文件名（随包释放到 `<exe 同级>/_launcher/cli/`，见 seed.rs）。
/// 名字带商城前缀：查重门禁要求文件级 const 名唯一，`SCRIPT` / `MARKET_CLI` 已被占走。
const STORE_CLI: &str = "store-cli.js";
/// 读：整棵 authority（本机实测约 57 KB）+ node 冷启动
const STORE_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
/// 写：整棵覆盖一张表
const STORE_SAVE_TIMEOUT: Duration = Duration::from_secs(60);
/// 查物品：要现读数据根下 22 MB 的 itemTypes + itemIcons，耗时以解析为主
const STORE_ITEM_LOOKUP_TIMEOUT: Duration = Duration::from_secs(60);

/// 统一的失败回包：`supported=false` 表示这台机器的服务端没有商城这套东西（不是用法错误）
fn unsupported(reason: String) -> Value {
    json!({ "ok": false, "supported": false, "reason": reason })
}

pub(crate) async fn call(
    root: &Path,
    args: Vec<String>,
    stdin: Option<&str>,
    timeout: Duration,
) -> Value {
    let Some(script) = sidecar::script_path(root, STORE_CLI) else {
        return unsupported(format!("随包侧车 {STORE_CLI} 不存在，无法读写商城"));
    };
    match sidecar::run_script(&script, root, &args, stdin, timeout).await {
        Ok(outcome) => {
            let text = outcome.stdout.trim();
            if text.is_empty() {
                let detail = sidecar::first_line(&outcome.stderr);
                return unsupported(if detail.is_empty() {
                    "商城侧车没有任何输出".to_string()
                } else {
                    detail
                });
            }
            match serde_json::from_str::<Value>(text) {
                Ok(value) => value,
                Err(err) => unsupported(format!(
                    "商城侧车返回的不是 JSON：{err}（前 200 字符：{}）",
                    sidecar::truncate(text, 200)
                )),
            }
        }
        Err(reason) => unsupported(reason),
    }
}

/// 读：整棵商城权威数据 + 摘要 + 配置。纯读，不写盘、不受服务运行状态限制。
pub async fn snapshot(root: &Path) -> Value {
    call(
        root,
        vec![
            "snapshot".to_string(),
            "--root".to_string(),
            root.to_string_lossy().to_string(),
        ],
        None,
        STORE_SNAPSHOT_TIMEOUT,
    )
    .await
}

/// 写：整棵 authority 覆盖 `newEdenStore` 表。形状自检、写盘都在侧车里完成。
pub async fn save(root: &Path, authority: &Value) -> Value {
    let payload = json!({ "authority": authority }).to_string();
    call(
        root,
        vec![
            "save".to_string(),
            "--root".to_string(),
            root.to_string_lossy().to_string(),
        ],
        Some(&payload),
        STORE_SAVE_TIMEOUT,
    )
    .await
}

/// 查物品：给上架向导用。校验 typeID 在不在服务端物品库里，并解析它的客户端图标路径
/// （图标规则：`itemIcons.iconsByID[itemTypes[typeID].iconID]`；`iconID` 为 null 的物品
/// 在客户端里没有图标，游戏内会画问号占位 —— 侧车会如实回空串，界面据此提前警告）。
pub async fn item_lookup(root: &Path, type_ids: &[Value]) -> Value {
    if type_ids.is_empty() {
        return json!({ "ok": false, "supported": true, "reason": "没有要查的 typeID" });
    }
    let payload = json!({ "typeIDs": type_ids }).to_string();
    call(
        root,
        vec![
            "item-lookup".to_string(),
            "--root".to_string(),
            root.to_string_lossy().to_string(),
        ],
        Some(&payload),
        STORE_ITEM_LOOKUP_TIMEOUT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 随包侧车必须在仓里，且必须复用服务端的 storeState
    /// （抄进 Rust 或另写一套规则都会让「服务端升版即漂移」重现）
    #[test]
    fn vendored_cli_reuses_the_server_store_state() {
        let vendored = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("cli")
            .join(STORE_CLI);
        assert!(vendored.is_file(), "随包侧车缺失：{}", vendored.display());
        let text = std::fs::read_to_string(&vendored).unwrap();
        assert!(
            text.contains("getEditorSnapshot") && text.contains("saveEditorAuthority"),
            "侧车必须走服务端 storeState 的 getEditorSnapshot / saveEditorAuthority"
        );
        // 整棵覆盖前必须挡住「把 meta/stores 丢掉」的写空，这是界面上看不见的损坏
        assert!(
            text.contains("authority.meta") && text.contains("authority.stores")
                || text.contains("`authority.${key}"),
            "侧车必须自检 authority.meta / authority.stores 再整棵覆盖"
        );
    }

    #[test]
    fn failure_payload_is_marked_unsupported() {
        let value = unsupported("boom".to_string());
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["supported"], json!(false));
        assert_eq!(value["reason"], json!("boom"));
    }
}
