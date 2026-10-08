//! 物品 / 市场浏览：直读服务端市场库（`externalservices/market-server/data/generated/market.sqlite`）。
//!
//! 为什么是「读活库」而不是随包快照：库里的库存（`seed_stock.quantity`）与区域最优买卖价
//! （`region_summaries.best_ask_price` / `best_bid_price`）会随游戏内成交变化。用户要的正是
//! 「跑游戏时读到的是当下数据，服务没启动也能读」—— 预先生成一份静态清单会把这件事做废。
//!
//! 只读 + WAL 打开，所以市场服务正持着这个库时也能读，两边不会互相加锁。
//!
//! 读是直连库，**写**走市场服务自己的管理接口 `POST /v1/admin/seed-stock/adjust`
//! （见 `adjust_seed_stock`）：服务端处理完会精确失效摘要与盘口缓存，改完立刻生效。
//!
//! 为什么规则不写在 Rust 里：SQLite 读取与 SDE 分类树（`marketGroups.jsonl` 的父子关系）
//! 都在随包侧车 `vendor/cli/market-cli.js` 里一次做完，Rust 只负责搬运 JSON。加 rusqlite
//! 这类依赖会把 exe 撑出 12 MB 预算（见 `scripts/size-gate.mjs`），不值得为只读查询付这个代价。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::config::DEFAULT_MARKET_PORT;
use crate::hotreload;
use crate::net;
use crate::runtime::RuntimePaths;
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
/// 管理接口走本机回环 HTTP，写一笔种子库存不该等太久。市场服务没跑时连接会被当场拒掉，
/// 这个超时只兜「连上了却不回包」的病态情况。
const ADMIN_TIMEOUT: Duration = Duration::from_secs(8);

/// 失败回包。`supported=false` 表示这台机器根本没带侧车（打包缺件）；
/// 「库不存在」是侧车自己回的 `{ok:false, reason}` —— 那不是启动器的错，是服务端还没建种子。
fn failed(reason: String, supported: bool) -> Value {
    json!({ "ok": false, "supported": supported, "reason": reason })
}

/// 跑侧车、取回 stdout 原文。缺件 / 没有输出时回一个能直接透给用户的 `{ok:false}`。
///
/// 与 [`call`] 分开是为了简介索引：那份回包 7 MB 上下，先解析成 `Value` 再搬进结构体
/// 会白占一倍内存，所以那条路直接反序列化进结构体。
async fn call_text(root: &Path, args: Vec<String>) -> Result<String, Value> {
    let Some(script) = sidecar::script_path(root, MARKET_CLI) else {
        return Err(failed(
            format!("随包侧车 {MARKET_CLI} 不存在，无法读取市场库"),
            false,
        ));
    };
    match sidecar::run_script(&script, root, &args, None, TIMEOUT).await {
        Ok(outcome) => {
            let text = outcome.stdout.trim().to_string();
            if text.is_empty() {
                let detail = sidecar::first_line(&outcome.stderr);
                return Err(failed(
                    if detail.is_empty() {
                        "市场侧车没有任何输出".to_string()
                    } else {
                        detail
                    },
                    true,
                ));
            }
            Ok(text)
        }
        Err(reason) => Err(failed(reason, true)),
    }
}

/// 侧车回的不是 JSON：把错误与原文前 200 字符一起透出来，别只说「解析失败」
fn parse_failed(text: &str, err: &serde_json::Error) -> Value {
    failed(
        format!(
            "市场侧车返回的不是 JSON：{err}（前 200 字符：{}）",
            sidecar::truncate(text, 200)
        ),
        true,
    )
}

async fn call(root: &Path, args: Vec<String>) -> Value {
    match call_text(root, args).await {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(err) => parse_failed(&text, &err),
        },
        Err(value) => value,
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

/// 把「连不上」翻成用户能照做的一句话。
///
/// ureq 在 Windows 上给的原文是「Connection Failed: Connect error: 由于目标计算机积极拒绝，
/// 无法连接。 (os error 10061)」，直接弹给用户等于没说。其余错误（超时、HTTP 4xx）原样透出，
/// 那些自带原因的错误本来就该让人看见。
///
/// 这句**刻意不带端口号**：带上就成了每次都可能变的动态文案，翻译目录里没法建条目
/// （渲染层对失败原因也过一遍 `t()`），外语用户就只能看到中文。端口在 market-server 的
/// 配置里，要排障的人自己知道去哪看。
fn unreachable_hint(reason: &str) -> String {
    let lower = reason.to_ascii_lowercase();
    let refused = ["connection failed", "connect error", "refused", "10061"]
        .iter()
        .any(|needle| lower.contains(needle));
    if refused {
        return "连不上市场服务 —— 先在「服务」里把市场服务启动起来再改".to_string();
    }
    reason.to_string()
}

/// 拼请求体：字段名照市场服务的 `AdjustSeedStockRequest`（snake_case）。
///
/// 单独抽出来只为一件事 —— 让单测把**字段名**钉住。这是跨进程契约，改错了不会有编译错误，
/// 只会在运行时收到服务端一句反序列化失败。
///
/// 省掉的那一项**不能出现**在 body 里（不是传 null）：服务端按 `Option` 的 `Some/None`
/// 判断这一项改不改，塞个 null 进去 serde 直接当反序列化错误。
fn adjust_payload(
    station_id: u64,
    type_id: u32,
    new_quantity: Option<u64>,
    new_price: Option<f64>,
    reason: Option<String>,
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("station_id".to_string(), json!(station_id));
    payload.insert("type_id".to_string(), json!(type_id));
    if let Some(quantity) = new_quantity {
        payload.insert("new_quantity".to_string(), json!(quantity));
    }
    if let Some(price) = new_price {
        payload.insert("new_price".to_string(), json!(price));
    }
    // reason 只是服务端日志里的一行备注，留个来源好排查；空串不传
    if let Some(note) = reason.filter(|note| !note.trim().is_empty()) {
        payload.insert("reason".to_string(), json!(note));
    }
    Value::Object(payload)
}

/// 改某站某物品的**种子库存**价格 / 数量，改完立刻生效。
///
/// 为什么写走 HTTP 而不是像读那样直连 SQLite：这条是市场服务自己的管理接口
/// （`POST /v1/admin/seed-stock/adjust`，路由见 `market-server/src/main.rs`，请求体见
/// `market-common` 的 `AdjustSeedStockRequest`）。服务端处理完会按
/// (region, system, station, type) 精确失效摘要与盘口缓存，**下一次查询就是新值** ——
/// 不用重启市场服务，也不用重启客户端（游戏里把市场窗口关掉再开就是新价）。
///
/// 自己拿连接写库拿不到这份失效逻辑：库里的数字变了，市场服务内存里的摘要还是旧的，
/// 游戏里根本看不到变化，还会跟它抢写锁。代价是这条路径依赖市场服务正在运行 ——
/// 没跑时回的是「先把市场服务启动起来」，而不是读路径那句「市场库不存在」。
///
/// `new_quantity` 与 `new_price` 各自可省，省掉的那个字段服务端保持原值。
pub fn adjust_seed_stock(
    station_id: u64,
    type_id: u32,
    new_quantity: Option<u64>,
    new_price: Option<f64>,
    reason: Option<String>,
) -> Value {
    if station_id == 0 {
        return failed("没有选中空间站".to_string(), true);
    }
    if type_id == 0 {
        return failed("没有选中物品".to_string(), true);
    }
    if new_quantity.is_none() && new_price.is_none() {
        return failed("价格与库存至少要改一项".to_string(), true);
    }
    if let Some(price) = new_price {
        if !price.is_finite() || price < 0.0 {
            return failed("价格不能是负数".to_string(), true);
        }
    }

    let body = match serde_json::to_vec(&adjust_payload(
        station_id,
        type_id,
        new_quantity,
        new_price,
        reason,
    )) {
        Ok(bytes) => bytes,
        Err(err) => return failed(format!("请求体序列化失败：{err}"), true),
    };
    let url = format!("http://127.0.0.1:{DEFAULT_MARKET_PORT}/v1/admin/seed-stock/adjust");
    let response = match net::send(
        "POST",
        &url,
        &[("Accept", "application/json")],
        Some((body.as_slice(), "application/json")),
        ADMIN_TIMEOUT,
    ) {
        Ok(response) => response,
        Err(reason) => return failed(unreachable_hint(&reason), true),
    };

    // 成功是 {"ok":true,"data":{...}}，失败是 {"ok":false,"error":"..."}（ApiError 的形状）
    let parsed = response.json().unwrap_or(Value::Null);
    let detail = parsed
        .get("error")
        .or_else(|| parsed.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if !(200..300).contains(&response.status) {
        return failed(
            detail.unwrap_or_else(|| format!("市场服务回了 HTTP {}", response.status)),
            true,
        );
    }
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return failed(
            detail.unwrap_or_else(|| "市场服务没有返回 ok".to_string()),
            true,
        );
    }

    let data = parsed.get("data").cloned().unwrap_or(Value::Null);
    json!({
        "ok": true,
        "supported": true,
        "stationId": station_id,
        "typeId": type_id,
        // 服务端回的是改完的落地值：界面拿它直接覆盖那一行，不用再拉一次盘口
        "quantity": data.get("quantity").and_then(Value::as_u64).unwrap_or_default(),
        "price": data.get("price").and_then(Value::as_f64).unwrap_or_default(),
    })
}

/* ------------------------- 简介 / 属性（悬停提示用） ------------------------- */

/// 悬停提示的简介 / 属性索引：一次构建、内存常驻、按界面语言失效。
///
/// 数据全在**服务端自己的**静态数据里（SDE 的 types.jsonl / dogmaAttributes.jsonl /
/// dogmaUnits.jsonl 与静态表 typeDogma），由侧车 typeinfo 一趟折好再交给这里 ——
/// 悬停是毫秒级交互，每次悬停起一个 node 进程去扫 144 MB 的 SDE 是等不起的。
/// 启动器侧**不落任何磁盘产物**：服务端换了 SDE，重启启动器读到的就是新的。
///
/// 首次调用要等侧车扫一遍 SDE（约 1.5 s），所以界面在打开市场页时先发一条 typeId = 0
/// 的预热请求，之后每次悬停都只是内存查表。
static INFO_INDEX: tokio::sync::Mutex<Option<InfoIndex>> = tokio::sync::Mutex::const_new(None);

#[derive(Debug, Default)]
struct InfoIndex {
    lang: String,
    counts: Value,
    units: HashMap<u16, String>,
    categories: HashMap<u16, String>,
    attributes: HashMap<u16, InfoAttrMeta>,
    types: HashMap<u32, Vec<(u16, f64)>>,
    /// typeID → { 属性 id: 原厂值 }，侧车只回**与 SDE 不一致**的那几条（见 typeinfo 第 5 步）。
    /// 改属性时**不动这份**：它就是「还原」要写回去的目标值。
    modified: HashMap<u32, HashMap<u16, f64>>,
    descriptions: HashMap<u32, String>,
    names: HashMap<u32, String>,
    bonuses: HashMap<u32, Vec<InfoBonusSection>>,
}

/// 一条加成：`(数值, 单位 id, 文字)`。数值为 None = 这条只有文字（如「可以安装拦截泡发射器」）。
type InfoBonusEntry = (Option<f64>, Option<u16>, String);
/// 一组加成：`(技能 typeID, 条目)`；技能为 0 表示「特有加成」（游戏里排在最末一段）。
///
/// 技能**必须**用 u32：typeID 早就越过 65535 了（实测大到 93983，`u16` 会让整份回包
/// 反序列化失败——用户看到的是「市场侧车返回的不是 JSON」）。
type InfoBonusSection = (u32, Vec<InfoBonusEntry>);

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InfoAttrMeta {
    name: String,
    #[serde(default)]
    unit: Option<u16>,
    #[serde(default)]
    high_is_good: bool,
    #[serde(default)]
    category: u16,
}

/// 侧车 typeinfo 的回包，字段名与 vendor/cli/market-cli.js 一一对应
#[derive(Debug, serde::Deserialize)]
struct InfoPayload {
    /// 侧车把「预期内的失败」（SDE 不在 / 市场库还没建种子）也写进 stdout 并以退出码 0
    /// 结束，所以这里必须自己看 ok —— 否则一份缺 SDE 的回包会被当成「索引是空的」，
    /// 用户看到的是「这个物品没有简介与属性」，而不是真正的原因
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    lang: String,
    #[serde(default)]
    counts: Value,
    #[serde(default)]
    units: HashMap<u16, String>,
    #[serde(default)]
    categories: HashMap<u16, String>,
    #[serde(default)]
    attributes: HashMap<u16, InfoAttrMeta>,
    #[serde(default)]
    types: HashMap<u32, Vec<(u16, f64)>>,
    #[serde(default)]
    modified: HashMap<u32, HashMap<u16, f64>>,
    #[serde(default)]
    descriptions: HashMap<u32, String>,
    #[serde(default)]
    names: HashMap<u32, String>,
    #[serde(default)]
    bonuses: HashMap<u32, Vec<InfoBonusSection>>,
}

/// unitID=116 是「typeID」：属性值指向另一个物品（技能需求、弹药…），界面要显示名字
const INFO_TYPE_REF_UNIT: u16 = 116;

/// SDE 只认这 8 种语言，而启动器的界面语言里有 nl（荷兰语）—— 统一在这里退成英文。
///
/// **必须与侧车同一个口径**：两边不一致就会每次调用都判定「语言变了」而重建索引。
fn sde_lang(value: &str) -> String {
    let lower = value.trim().to_ascii_lowercase();
    let primary = lower.split(['-', '_']).next().unwrap_or_default();
    match primary {
        "zh" | "en" | "ja" | "ko" | "fr" | "de" | "ru" | "es" => primary.to_string(),
        _ => "en".to_string(),
    }
}

/// 一条属性：原始数值 + 单位符号；「值是 typeID」的那种额外给一个解析出来的名字。
///
/// `original` 是 SDE 原厂值 —— **只在这一条确实被改过时才有**：界面要在弹窗里画
/// 「原值 / 现值」的差异，并给一个「还原」。
///
/// 数值的格式化（千分位、小数位、单位拼接）刻意留在渲染层：那里才有当前语言。
fn info_attribute(index: &InfoIndex, id: u16, value: f64, original: Option<f64>) -> Value {
    let meta = index.attributes.get(&id);
    let unit_id = meta.and_then(|meta| meta.unit);
    let unit = unit_id.and_then(|unit| index.units.get(&unit).cloned());
    let type_name = if unit_id == Some(INFO_TYPE_REF_UNIT) && value > 0.0 {
        index.names.get(&(value as u32)).cloned()
    } else {
        None
    };
    json!({
        "id": id,
        "name": meta.map(|meta| meta.name.clone()).unwrap_or_default(),
        "value": value,
        // 原厂值（SDE）：null = 没改过，或这条属性在 SDE 里查不到（那也写不回去）
        "originalValue": original,
        // true = 现值与原厂值不同；界面据此标「已修改」并画「还原」
        "modified": original.is_some(),
        // unitId 交给渲染层定格式：101 的「秒」实际以毫秒存、108 是抗性共振系数、
        // 115 / 116 是「值指向另一个对象」，只靠本地化后的单位符号分不出来
        "unitId": unit_id,
        "unit": unit,
        "highIsGood": meta.map(|meta| meta.high_is_good).unwrap_or(false),
        "category": meta.map(|meta| meta.category).unwrap_or_default(),
        "typeName": type_name,
    })
}

/// 物品的加成：技能加成按「技能名」分组，特有加成（技能 typeID = 0）排在最后 —— 与客户端一致。
///
/// 数值与单位符号的拼装留在渲染层（那里才有当前语言）；技能名查不到就回空串，
/// 界面退成一句通用标题，而不是印一个 typeID 给用户看。
fn info_bonuses(index: &InfoIndex, type_id: u32) -> Value {
    let Some(sections) = index.bonuses.get(&type_id) else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        sections
            .iter()
            .map(|(skill_id, entries)| {
                json!({
                    "skillId": skill_id,
                    "skill": index
                        .names
                        .get(skill_id)
                        .cloned()
                        .unwrap_or_default(),
                    "entries": entries
                        .iter()
                        .map(|(value, unit_id, text)| {
                            json!({
                                "value": value,
                                "unitId": unit_id,
                                "unit": unit_id.and_then(|id| index.units.get(&id)),
                                "text": text,
                            })
                        })
                        .collect::<Vec<Value>>(),
                })
            })
            .collect(),
    )
}

/// 物品的简介 / 属性。type_id = 0 只预热索引（界面打开市场页时先发这一条），回计数。
pub async fn type_info(root: &Path, type_id: u32, lang: &str) -> Value {
    let wanted = sde_lang(lang);
    let mut guard = INFO_INDEX.lock().await;
    let stale = match guard.as_ref() {
        Some(index) => index.lang != wanted,
        None => true,
    };
    if stale {
        let args = vec!["typeinfo".to_string(), root_arg(root), wanted.clone()];
        let text = match call_text(root, args).await {
            Ok(text) => text,
            // 侧车原话（SDE 不在 / 市场库还没建种子）直接透给界面
            Err(value) => return value,
        };
        match serde_json::from_str::<InfoPayload>(&text) {
            Ok(payload) if payload.ok => {
                *guard = Some(InfoIndex {
                    lang: if payload.lang.is_empty() {
                        wanted
                    } else {
                        payload.lang
                    },
                    counts: payload.counts,
                    units: payload.units,
                    categories: payload.categories,
                    attributes: payload.attributes,
                    types: payload.types,
                    modified: payload.modified,
                    descriptions: payload.descriptions,
                    names: payload.names,
                    bonuses: payload.bonuses,
                });
            }
            // 侧车自己回的失败：原话透出去（与 call() 走同一条口径）
            Ok(payload) => return failed(payload.reason, true),
            Err(err) => return parse_failed(&text, &err),
        }
    }
    let Some(index) = guard.as_ref() else {
        return failed("简介索引不可用".to_string(), true);
    };
    if type_id == 0 {
        return json!({
            "ok": true,
            "supported": true,
            "ready": true,
            "lang": index.lang,
            "counts": index.counts,
        });
    }
    // 已改动的属性：现值取自 `types`，原厂值取自 `modified`（两侧同一趟回包，键一定对得上）
    let originals = index.modified.get(&type_id);
    let attributes: Vec<Value> = index
        .types
        .get(&type_id)
        .map(|rows| {
            rows.iter()
                .map(|(id, value)| {
                    info_attribute(
                        index,
                        *id,
                        *value,
                        originals.and_then(|map| map.get(id)).copied(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "ok": true,
        "supported": true,
        "ready": true,
        "typeId": type_id,
        "lang": index.lang,
        "description": index.descriptions.get(&type_id).cloned().unwrap_or_default(),
        "attributes": attributes,
        "bonuses": info_bonuses(index, type_id),
        // 属性分类名（37 条）很小，跟着每条回包一起给：渲染层分组时不用再问一次
        "categories": index.categories,
        "counts": index.counts,
    })
}

/* --------------------------- 属性编辑（写回静态表） --------------------------- */

/// 一条属性改动：`(属性 id, 新值)`。
pub type AttrEdit = (u16, f64);

/// 把刚写进静态表的属性值同步到内存索引 —— **现值与原厂值一起**。
///
/// 为什么不整份重建索引：索引是侧车扫 144 MB SDE + 全量静态表折出来的（实测 1.5-2 s），
/// 只为改几个数重建一次太亏。这里改的 id 一定在索引里出现过（界面就是照它渲染的），
/// 就地覆盖即可；属性按 id 排序，值变了顺序不变，不用重排。
///
/// 原厂值从哪来：侧车只在**确实改过**时才把原值放进 `modified`，所以
/// - 这条之前就改过 → `modified` 里记着的那份就是原厂值，照抄；
/// - 这条之前没改过 → 它**改之前**的现值本来就等于原厂值，在覆盖前取下来。
///
/// 改完与原厂值相等时（用户点了「还原」）要把记录删掉，否则界面会一直挂着一个并不存在的
/// 「已修改」。只更新现值不更新这份，就会导致「刚保存完、还原图标反而消失」。
async fn apply_edits_to_index(type_id: u32, edits: &[AttrEdit]) {
    let mut guard = INFO_INDEX.lock().await;
    let Some(index) = guard.as_mut() else {
        return;
    };
    // 拆成两个互不相干的借用：改现值要 `types` 可变，读原值要 `modified` 不可变
    let InfoIndex {
        types, modified, ..
    } = index;
    let Some(rows) = types.get_mut(&type_id) else {
        return;
    };

    let mut planned: Vec<(u16, f64, f64)> = Vec::new(); // (属性 id, 新值, 原厂值)
    for (id, value) in edits {
        let Some(row) = rows.iter_mut().find(|(row_id, _)| row_id == id) else {
            continue;
        };
        let original = modified
            .get(&type_id)
            .and_then(|known| known.get(id))
            .copied()
            .unwrap_or(row.1);
        row.1 = *value;
        planned.push((*id, *value, original));
    }

    let emptied = {
        let originals = modified.entry(type_id).or_default();
        for (id, value, original) in planned {
            if value == original {
                originals.remove(&id);
            } else {
                originals.insert(id, original);
            }
        }
        originals.is_empty()
    };
    if emptied {
        modified.remove(&type_id);
    }
}

/// 改一个物品的 dogma 属性：写盘 → 热重载 → 就地更新内存索引。
///
/// 写的是服务端静态表 `typeDogma`；舰船属性还有第二份副本
/// `shipDogmaAttributes.shipAttributesByTypeID`，侧车两份一起改（只改一份会让属性页与
/// 装配各读各的）。写完用启动器注入主服务器的热重载 host 把新表换进内存、并清掉
/// `referenceData` 读缓存 —— 服务端进程不用重启。
///
/// 生效边界（按服务端取值路径实测，不是猜的）：
/// - **舰船**基础属性每次构建库存 / 装配数据都直读 `shipDogmaAttributes`
///   （`liveFittingState.readShipBaseAttributes`、`dogmaService._buildShipBaseAttributes`），
///   没有模块级缓存 → 保存后**离舰再登舰**就用新值；
/// - **装备 / 其它物品**走 `liveFittingState.getNormalizedTypeAttributeMap`，那里按 typeID
///   存了进程级永久缓存、且模块没有重置入口 → 多数情况要**重启主服务器**。
///
/// 所以回包里如实带 `needsRestart`，界面照它写提示，不把「重启才生效」说成「马上生效」。
pub async fn set_type_attributes(
    root: &Path,
    runtime: &RuntimePaths,
    type_id: u32,
    edits: Vec<AttrEdit>,
) -> Value {
    if type_id == 0 {
        return failed("typeId 必须是正整数".to_string(), true);
    }
    if edits.is_empty() {
        return failed("没有要改的属性".to_string(), true);
    }

    // 1) 写盘前先留快照。时机是关键：apply 自己的快照照的是「写完之后」的文件，拿它当
    //    回滚点等于把改坏的内容当成原始状态。快照失败就整个取消，不动任何文件。
    let targets = vec!["typeDogma".to_string(), "shipDogmaAttributes".to_string()];
    let Some(snapshot_id) = hotreload::snapshot_tables(root, runtime, &targets) else {
        return failed("改动前快照失败，已取消（没有写任何文件）".to_string(), true);
    };

    // 2) 交给侧车：解析两张表 → 两份副本同值 → 原子写回（缩进与末尾换行跟原文件一致）
    let payload = Value::Array(
        edits
            .iter()
            .map(|(id, value)| json!({ "id": id, "value": value }))
            .collect(),
    );
    let edits_arg = serde_json::to_string(&payload).unwrap_or_else(|_| "[]".to_string());
    let text = match call_text(
        root,
        vec![
            "settypeattributes".to_string(),
            root_arg(root),
            type_id.to_string(),
            edits_arg,
        ],
    )
    .await
    {
        Ok(text) => text,
        Err(value) => return value,
    };
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(err) => return parse_failed(&text, &err),
    };
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        // 侧车自己回的失败（typeID 没有属性 / 值不是数字）原话透出
        return parsed;
    }
    let changed = parsed.get("changed").and_then(Value::as_u64).unwrap_or(0);
    let touched: Vec<String> = parsed
        .get("tables")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let missing = parsed
        .get("missing")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    // 有第二份副本 = 这次改的是一艘船，走「离舰再登舰」那条快路径
    let is_ship = touched.iter().any(|name| name == "shipDogmaAttributes");

    // 3) 一个值都没变（提交的还是当前值）：不写内存、不重载，直接回成功
    if changed == 0 {
        return json!({
            "ok": true,
            "supported": true,
            "typeId": type_id,
            "changed": 0,
            "missing": missing,
            "tables": [],
            "snapshotId": snapshot_id,
            "needsRestart": false,
            "armed": hotreload::armed(runtime),
            "reload": Value::Null,
        });
    }

    // 4) 内存索引就地更新：界面立刻显示新值，不用为重扫 SDE 再等两秒
    apply_edits_to_index(type_id, &edits).await;

    // 5) 热重载：新表换进服务端内存 + 清 referenceData 读缓存。with_snapshot = false，
    //    因为「改前」那一份在第 1 步已经照过了。
    let reload = hotreload::apply(root, runtime, Some(touched.clone()), false).await;
    let armed = reload
        .get("armed")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    json!({
        "ok": true,
        "supported": true,
        "typeId": type_id,
        "changed": changed,
        "missing": missing,
        "tables": touched,
        "snapshotId": snapshot_id,
        // 舰船直读静态表，离舰再登舰即生效；装备有进程级缓存，要重启主服务器
        "needsRestart": !is_ship,
        "armed": armed,
        "reload": reload,
    })
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

    /// 没选空间站 / 物品就不该发请求：本地先挡掉，省一趟往返，也免得服务端回一句英文
    #[test]
    fn adjust_requires_a_target() {
        let value = adjust_seed_stock(0, 34, Some(1), None, None);
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("没有选中空间站"));

        let value = adjust_seed_stock(60000361, 0, Some(1), None, None);
        assert_eq!(value["reason"], json!("没有选中物品"));
    }

    /// 价格与库存都没给 = 白跑一趟（服务端那边也是无操作），本地直接回原因
    #[test]
    fn adjust_requires_something_to_change() {
        let value = adjust_seed_stock(60000361, 34, None, None, None);
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("价格与库存至少要改一项"));
    }

    /// 负价格是输入错误：服务端不校验这个，放进去就是一档负价挂单
    #[test]
    fn adjust_rejects_negative_price() {
        let value = adjust_seed_stock(60000361, 34, None, Some(-1.0), None);
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("价格不能是负数"));
    }

    /// 连不上 40110 要给能照做的提示，而不是 Windows 的「目标计算机积极拒绝」原文
    #[test]
    fn unreachable_hint_translates_refusals() {
        let raw = "http://127.0.0.1:40110/v1/admin/seed-stock/adjust: Connection Failed: \
                   Connect error: 由于目标计算机积极拒绝，无法连接。 (os error 10061)";
        let hint = unreachable_hint(raw);
        assert!(hint.contains("市场服务"), "{hint}");
        assert!(!hint.contains("10061"), "{hint}");
        // 其它错误原样透出，别把真原因吃掉
        assert_eq!(unreachable_hint("请求超时（8s）"), "请求超时（8s）");
    }

    /// 字段名是跨进程契约（市场服务的 `AdjustSeedStockRequest`），编译器查不出来，只能钉住
    #[test]
    fn adjust_payload_uses_the_server_field_names() {
        let payload = adjust_payload(
            60000361,
            34,
            Some(500),
            Some(123.5),
            Some("launcher".to_string()),
        );
        assert_eq!(
            payload,
            json!({
                "station_id": 60000361u64,
                "type_id": 34u32,
                "new_quantity": 500u64,
                "new_price": 123.5f64,
                "reason": "launcher",
            })
        );
    }

    /// 省掉的那一项**不能**以 null 出现：服务端按 Option 的 Some/None 判断改不改，
    /// 传 null 会被 serde 当成反序列化错误，整条请求 400
    #[test]
    fn adjust_payload_omits_untouched_fields() {
        let payload = adjust_payload(60000361, 34, None, Some(1.0), None);
        assert_eq!(
            payload,
            json!({ "station_id": 60000361u64, "type_id": 34u32, "new_price": 1.0f64 })
        );
        assert!(payload.get("new_quantity").is_none());
        assert!(payload.get("reason").is_none());

        // 空 reason 不传：省得服务端日志里多一行空备注
        let payload = adjust_payload(1, 2, Some(3), None, Some("   ".to_string()));
        assert!(payload.get("reason").is_none());
    }

    /// 真机冒烟（默认不跑）：本机市场服务在跑时，验证这条 admin 写通道真的通 ——
    /// 单测只能钉住请求体的形状，连不连得上、回包长什么样只有真打一次才知道。
    /// 传的是当前值（对 Jita IV - Moon 6 的 Tritanium 而言是 9999999 / 100），不会改数据。
    /// 手动执行：`cargo test --lib market::tests::live_admin_adjust -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_admin_adjust() {
        let body = adjust_payload(60000361, 34, Some(9999999), Some(100.0), None);
        let bytes = serde_json::to_vec(&body).expect("请求体应能序列化");
        let url = format!("http://127.0.0.1:{DEFAULT_MARKET_PORT}/v1/admin/seed-stock/adjust");
        match net::send(
            "POST",
            &url,
            &[("Accept", "application/json")],
            Some((bytes.as_slice(), "application/json")),
            ADMIN_TIMEOUT,
        ) {
            Ok(response) => println!("STATUS {} BODY {}", response.status, response.text()),
            Err(reason) => println!("ERR: {reason}"),
        }
    }

    /// 真机冒烟（默认不跑）：拿真的 SDE 跑一次侧车，把整份回包按 `InfoPayload` 反序列化一遍。
    /// 夹具钉不住「真实数据里某个字段越界」—— 2026-10-05 就是这么踩到技能 typeID 77738 > u16，
    /// 整份 6.9 MB 回包在界面里变成「市场侧车返回的不是 JSON」。
    /// 手动执行：`EVEJS_ROOT=<服务端目录> cargo test --lib market::tests::live_typeinfo_payload -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_typeinfo_payload() {
        let Ok(root) = std::env::var("EVEJS_ROOT") else {
            println!("跳过：没给 EVEJS_ROOT");
            return;
        };
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/cli/market-cli.js");
        let out = std::process::Command::new("node")
            .arg(&script)
            .args(["typeinfo", root.as_str(), "zh"])
            .output()
            .expect("本机应有 node");
        assert!(out.status.success(), "侧车退出码 {:?}", out.status.code());
        let text = String::from_utf8_lossy(&out.stdout);
        let payload: InfoPayload = serde_json::from_str(&text).expect("真机回包应能反序列化");
        assert!(payload.ok, "侧车报错：{}", payload.reason);
        let bonused = payload
            .bonuses
            .values()
            .flatten()
            .filter_map(|(skill_id, _)| (*skill_id > u16::MAX as u32).then_some(*skill_id))
            .count();
        println!(
            "OK：{} 字节 / 属性 {} 条 / 加成类型 {} 个 / 技能 id 越过 u16 的分组 {} 个",
            text.len(),
            payload.attributes.len(),
            payload.bonuses.len(),
            bonused
        );
    }

    /// 侧车只认 SDE 的 8 种语言：启动器的 nl 必须落到 en，否则每次调用都会重建索引
    #[test]
    fn sde_lang_falls_back_to_english() {
        assert_eq!(sde_lang("zh"), "zh");
        assert_eq!(sde_lang("zh-Hans-CN"), "zh");
        assert_eq!(sde_lang("EN"), "en");
        assert_eq!(sde_lang("nl"), "en");
        assert_eq!(sde_lang(""), "en");
        assert_eq!(sde_lang("xx"), "en");
    }

    /// 侧车回包的形状（camelCase、[[属性 id, 值]] 的成对数组）变了必须在这里红，
    /// 而不是等真机悬停时才发现「一行属性都没有」
    #[test]
    fn info_payload_matches_the_sidecar_shape() {
        let raw = r#"{
            "ok": true, "lang": "zh",
            "counts": { "marketTypes": 2, "described": 1 },
            "units": { "105": "%", "116": "typeID" },
            "categories": { "28": "Propulsion" },
            "attributes": { "30": { "name": "最大速度加成", "unit": 105, "highIsGood": true, "category": 28 } },
            "types": { "587": [[30, 55.0], [9, 350]] },
            "modified": { "587": { "30": 50.0 } },
            "descriptions": { "587": "裂谷级是一种非常强大的战斗护卫舰。" },
            "names": { "3329": "米玛塔尔护卫舰" },
            "bonuses": { "587": [[3329, [[7.5, 105, "小型射弹炮台射速加成"]]], [0, [[null, null, "可以安装拦截泡发射器"]]]] }
        }"#;
        let payload: InfoPayload = serde_json::from_str(raw).expect("回包应能反序列化");
        assert!(payload.ok);
        assert_eq!(payload.lang, "zh");
        assert_eq!(payload.attributes[&30u16].name, "最大速度加成");
        assert_eq!(payload.attributes[&30u16].unit, Some(105));
        assert!(payload.attributes[&30u16].high_is_good);
        assert_eq!(
            payload.types[&587u32],
            vec![(30u16, 55.0f64), (9u16, 350.0)]
        );
        // 改过的属性：键是 typeID → 属性 id，值是**原厂值**（现值仍在 types 里）
        assert_eq!(payload.modified[&587u32][&30u16], 50.0);
        assert_eq!(
            payload.descriptions[&587u32],
            "裂谷级是一种非常强大的战斗护卫舰。"
        );
        assert_eq!(payload.names[&3329u32], "米玛塔尔护卫舰");
        assert_eq!(payload.bonuses[&587u32].len(), 2);
        assert_eq!(payload.bonuses[&587u32][0].0, 3329u32);
        assert_eq!(
            payload.bonuses[&587u32][0].1[0],
            (Some(7.5), Some(105), "小型射弹炮台射速加成".to_string())
        );
        // 只有文字的那条：数值与单位都是 null，界面据此不画数字
        assert_eq!(payload.bonuses[&587u32][1].1[0].0, None);
    }

    /// 侧车对「SDE 不在」这类**预期失败**回的是 `{ok:false, reason}` —— 字段与成功回包完全不同。
    /// 不能因为少了 lang/types 就当成一份空索引收下：那样界面会把「读不到」说成
    /// 「这个物品没有简介与属性」（2026-10-05 在 parity fixture 上实测踩到）
    #[test]
    fn info_payload_failure_is_not_taken_for_an_empty_index() {
        let raw =
            r#"{"ok":false,"reason":"未找到 SDE 目录：Z:/tmp/sde（简介与属性名都在 SDE 里）"}"#;
        let payload: InfoPayload = serde_json::from_str(raw).expect("失败回包也要能反序列化");
        assert!(!payload.ok);
        assert!(payload.reason.starts_with("未找到 SDE 目录"));
        assert!(payload.types.is_empty());
    }

    fn sample_info_index() -> InfoIndex {
        InfoIndex {
            lang: "zh".to_string(),
            counts: json!({ "marketTypes": 19352 }),
            units: HashMap::from([
                (105u16, "%".to_string()),
                (INFO_TYPE_REF_UNIT, "typeID".to_string()),
            ]),
            categories: HashMap::from([(28u16, "Propulsion".to_string())]),
            attributes: HashMap::from([
                (
                    30u16,
                    InfoAttrMeta {
                        name: "最大速度加成".to_string(),
                        unit: Some(105),
                        high_is_good: true,
                        category: 28,
                    },
                ),
                (
                    182u16,
                    InfoAttrMeta {
                        name: "主技能需求".to_string(),
                        unit: Some(INFO_TYPE_REF_UNIT),
                        high_is_good: true,
                        category: 8,
                    },
                ),
            ]),
            types: HashMap::from([(587u32, vec![(30u16, 55.0f64), (182u16, 3329.0)])]),
            // 30 已被改过（现值 55、原厂 50）：界面要能画出这个差异
            modified: HashMap::from([(587u32, HashMap::from([(30u16, 50.0f64)]))]),
            descriptions: HashMap::from([(
                587u32,
                "裂谷级是一种非常强大的战斗护卫舰。".to_string(),
            )]),
            names: HashMap::from([(3329u32, "米玛塔尔护卫舰".to_string())]),
            bonuses: HashMap::from([(
                587u32,
                vec![
                    (
                        3329u32,
                        vec![
                            (Some(7.5), Some(105u16), "小型射弹炮台射速加成".to_string()),
                            (
                                Some(10.0),
                                Some(105),
                                "小型射弹炮台失准范围加成".to_string(),
                            ),
                        ],
                    ),
                    (0u32, vec![(None, None, "可以安装拦截泡发射器".to_string())]),
                ],
            )]),
        }
    }

    /// 技能 typeID 早就越过 65535（实测 93983，护盾 / 突击护卫舰那一类技能）：
    /// 收成 u16 会让**整份回包**反序列化失败，用户看到的是「市场侧车返回的不是 JSON」。
    #[test]
    fn bonus_skill_ids_beyond_u16_survive_the_round_trip() {
        let raw = r#"{
            "ok": true, "lang": "zh", "counts": {},
            "units": { "105": "%" }, "categories": {},
            "attributes": {}, "types": {}, "descriptions": {},
            "names": { "77738": "突击护卫舰操作" },
            "bonuses": { "587": [[77738, [[10.0, 105, "护盾值加成"]]]] }
        }"#;
        let payload: InfoPayload =
            serde_json::from_str(raw).expect("大 typeID 的技能加成应能反序列化");
        let mut index = sample_info_index();
        index.names = payload.names;
        index.bonuses = payload.bonuses;
        let value = info_bonuses(&index, 587);
        assert_eq!(value[0]["skillId"], json!(77738));
        assert_eq!(value[0]["skill"], json!("突击护卫舰操作"));
        assert_eq!(value[0]["entries"][0]["text"], json!("护盾值加成"));
    }

    /// 加成回包：数值 + 单位符号 + 技能名；特有加成（技能 typeID = 0）也在同一份数组里，
    /// 只有文字的那条不带数字 —— 与客户端「可以安装拦截泡发射器」那一行一致。
    #[test]
    fn info_bonuses_join_units_and_skill_names() {
        let index = sample_info_index();
        let value = info_bonuses(&index, 587);
        let sections = value.as_array().expect("应是数组");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0]["skillId"], json!(3329));
        assert_eq!(sections[0]["skill"], json!("米玛塔尔护卫舰"));
        assert_eq!(sections[0]["entries"][0]["value"], json!(7.5));
        assert_eq!(sections[0]["entries"][0]["unit"], json!("%"));
        assert_eq!(
            sections[0]["entries"][0]["text"],
            json!("小型射弹炮台射速加成")
        );
        assert_eq!(sections[1]["skillId"], json!(0));
        assert_eq!(sections[1]["entries"][0]["value"], Value::Null);
        assert_eq!(sections[1]["entries"][0]["unitId"], Value::Null);
        // 没有加成的物品回空数组 —— 界面据此整块不画，而不是画一个空标题
        assert_eq!(info_bonuses(&index, 34), json!([]));
    }

    /// 属性回包：单位符号按 unitID 查 SDE 的表；「值是 typeID」的那种回名字而不是数字
    #[test]
    fn info_attribute_joins_units_and_type_names() {
        let index = sample_info_index();
        let speed = info_attribute(&index, 30, 55.0, Some(50.0));
        assert_eq!(speed["name"], json!("最大速度加成"));
        assert_eq!(speed["unit"], json!("%"));
        assert_eq!(speed["unitId"], json!(105));
        assert_eq!(speed["highIsGood"], json!(true));
        assert_eq!(speed["category"], json!(28));
        assert_eq!(speed["value"], json!(55.0));
        // 改过的属性：原厂值一起回，界面据此画「原值 / 现值」并给「还原」
        assert_eq!(speed["originalValue"], json!(50.0));
        assert_eq!(speed["modified"], json!(true));

        // 没改过的属性：原值缺省，界面不画那一段，也不会画「还原」
        let untouched = info_attribute(&index, 30, 50.0, None);
        assert_eq!(untouched["originalValue"], Value::Null);
        assert_eq!(untouched["modified"], json!(false));

        // 技能需求：值是技能 id，界面显示「米玛塔尔护卫舰」而不是 3329
        let skill = info_attribute(&index, 182, 3329.0, None);
        assert_eq!(skill["unit"], json!("typeID"));
        assert_eq!(skill["unitId"], json!(116));
        assert_eq!(skill["typeName"], json!("米玛塔尔护卫舰"));

        // 值不是类型 id 的时候别乱回名字
        let zero = info_attribute(&index, 182, 0.0, None);
        assert_eq!(zero["typeName"], Value::Null);
    }

    /// 保存之后内存索引要同时更新**现值**与**原厂值**。
    ///
    /// 只更新现值的话，用户刚存完再打开弹窗就看不到「还原」了 —— 而那正是这个功能唯一的
    /// 存在理由。反过来，把值改回原厂值时（点了「还原」）还得把记录清掉，不然界面会一直
    /// 挂着一个并不存在的「已修改」。
    #[tokio::test]
    async fn applied_edits_refresh_both_value_and_original() {
        *INFO_INDEX.lock().await = Some(sample_info_index());
        // 30 在 fixture 里是「已改过」的（现值 55、原厂 50）；182 没改过（现值 3329，无原值）
        apply_edits_to_index(587, &[(30u16, 50.0f64), (182u16, 9.0f64)]).await;

        let guard = INFO_INDEX.lock().await;
        let index = guard.as_ref().expect("刚设过索引");
        let rows = &index.types[&587u32];
        let value_of = |id: u16| rows.iter().find(|(row_id, _)| *row_id == id).unwrap().1;
        assert_eq!(value_of(30), 50.0);
        assert_eq!(value_of(182), 9.0);

        let modified = &index.modified[&587u32];
        // 30 改回了原厂值 → 记录删掉；182 从 3329 改成 9 → 记下它的原厂值 3329
        assert!(!modified.contains_key(&30u16));
        assert_eq!(modified[&182u16], 3329.0);
    }

    /// typeId = 0 是「没选物品」的哨兵，不能拿它去改表。
    /// 这条必须在做快照 / 起 node 之前就挡掉 —— 否则写盘路径会被一个空 id 触发。
    #[tokio::test]
    async fn set_attributes_rejects_zero_type_id() {
        let runtime =
            RuntimePaths::from_root(std::env::temp_dir().join("evejs-attrs-guard"), false);
        let value =
            set_type_attributes(Path::new("E:\\nonexistent"), &runtime, 0, vec![(11, 1.0)]).await;
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("typeId 必须是正整数"));
    }

    /// 一条改动都没给：本地直接回原因，不写盘也不起侧车
    #[tokio::test]
    async fn set_attributes_rejects_empty_edits() {
        let runtime =
            RuntimePaths::from_root(std::env::temp_dir().join("evejs-attrs-guard"), false);
        let value =
            set_type_attributes(Path::new("E:\\nonexistent"), &runtime, 34, Vec::new()).await;
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["reason"], json!("没有要改的属性"));
    }
}
