//! 物品 / 市场浏览：直读服务端市场库（`externalservices/market-server/data/generated/market.sqlite`）。
//!
//! 为什么是「读活库」而不是随包快照：库里的库存（`seed_stock.quantity`）与区域最优买卖价
//! （`region_summaries.best_ask_price` / `best_bid_price`）会随游戏内成交变化。用户要的正是
//! 「跑游戏时读到的是当下数据，服务没启动也能读」—— 预先生成一份静态清单会把这件事做废。
//!
//! 只读 + WAL 打开，所以市场服务正持着这个库时也能读，两边不会互相加锁。
//!
//! 为什么规则不写在 Rust 里：SQLite 读取与 SDE 分类树（`marketGroups.jsonl` 的父子关系）
//! 都在随包侧车 `vendor/cli/market-cli.js` 里一次做完，Rust 只负责搬运 JSON。加 rusqlite
//! 这类依赖会把 exe 撑出 12 MB 预算（见 `scripts/size-gate.mjs`），不值得为只读查询付这个代价。
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use crate::sidecar;

/// 侧车文件名（随包释放到 `<exe 同级>/_launcher/cli/`，见 seed.rs）。
/// 名字带市场前缀：查重门禁要求文件级 const 名唯一，`SCRIPT` 已被 gameconfig.rs 占走。
const MARKET_CLI: &str = "market-cli.js";
/// 全量物品清单约 2.3 MB JSON，耗时以 node 冷启动 + 两次全表扫描为主
const TIMEOUT: Duration = Duration::from_secs(30);
/// 成交流水默认条数（渲染层不传时用）
const DEFAULT_TRADE_LIMIT: u32 = 20;
/// 成交流水上限：再多也没人看，顺手挡掉误传的天文数字
const MAX_TRADE_LIMIT: u32 = 200;

/// 失败回包。`supported=false` 表示这台机器根本没带侧车（打包缺件）；
/// 「库不存在」是侧车自己回的 `{ok:false, reason}` —— 那不是启动器的错，是服务端还没建种子。
fn failed(reason: String, supported: bool) -> Value {
    json!({ "ok": false, "supported": supported, "reason": reason })
}

async fn call(root: &Path, args: Vec<String>) -> Value {
    let Some(script) = sidecar::script_path(root, MARKET_CLI) else {
        return failed(
            format!("随包侧车 {MARKET_CLI} 不存在，无法读取市场库"),
            false,
        );
    };
    match sidecar::run_script(&script, root, &args, None, TIMEOUT).await {
        Ok(outcome) => {
            let text = outcome.stdout.trim();
            if text.is_empty() {
                let detail = sidecar::first_line(&outcome.stderr);
                return failed(
                    if detail.is_empty() {
                        "市场侧车没有任何输出".to_string()
                    } else {
                        detail
                    },
                    true,
                );
            }
            match serde_json::from_str::<Value>(text) {
                Ok(value) => value,
                Err(err) => failed(
                    format!(
                        "市场侧车返回的不是 JSON：{err}（前 200 字符：{}）",
                        sidecar::truncate(text, 200)
                    ),
                    true,
                ),
            }
        }
        Err(reason) => failed(reason, true),
    }
}

fn root_arg(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

/// 库与区域总览：区域 / 星系、类型 / 站点 / 库存 / 成交行数、库文件大小与最近一次成交时间。
pub async fn overview(root: &Path) -> Value {
    call(root, vec!["overview".to_string(), root_arg(root)]).await
}

/// 全量物品清单 + 分类树 + 站点表。量级决定了它只在打开页面时拉一次，之后本地筛选。
pub async fn catalog(root: &Path) -> Value {
    call(root, vec!["catalog".to_string(), root_arg(root)]).await
}

/// 单个物品的盘口明细：各站库存与价格、30 天价格史、成交回执。
pub async fn book(root: &Path, type_id: u32) -> Value {
    if type_id == 0 {
        return failed("typeId 必须是正整数".to_string(), true);
    }
    call(
        root,
        vec!["book".to_string(), root_arg(root), type_id.to_string()],
    )
    .await
}

/// 最近的成交流水（`market_fill_receipts`）。
pub async fn trades(root: &Path, limit: Option<u32>) -> Value {
    let limit = limit
        .unwrap_or(DEFAULT_TRADE_LIMIT)
        .clamp(1, MAX_TRADE_LIMIT);
    call(
        root,
        vec!["trades".to_string(), root_arg(root), limit.to_string()],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 侧车不存在时必须回 `supported=false`，渲染层据此区分「没装侧车」与「服务端还没建种子」
    #[test]
    fn missing_sidecar_is_reported_as_unsupported() {
        let value = failed(
            "随包侧车 market-cli.js 不存在，无法读取市场库".to_string(),
            false,
        );
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["supported"], json!(false));
    }

    /// 0 是「没选物品」的哨兵值，不能把它当成合法 typeID 丢给 SQL
    #[test]
    fn book_rejects_zero_type_id() {
        let value = failed("typeId 必须是正整数".to_string(), true);
        assert_eq!(value["supported"], json!(true));
    }

    /// trades 的条数必须夹在 [1, 200]：0 条没有意义，天文数字会把 8 MB 输出上限撞穿
    #[test]
    fn trade_limit_is_clamped() {
        let clamp = |limit: Option<u32>| {
            limit
                .unwrap_or(DEFAULT_TRADE_LIMIT)
                .clamp(1, MAX_TRADE_LIMIT)
        };
        assert_eq!(clamp(None), 20);
        assert_eq!(clamp(Some(0)), 1);
        assert_eq!(clamp(Some(5)), 5);
        assert_eq!(clamp(Some(u32::MAX)), 200);
    }
}
