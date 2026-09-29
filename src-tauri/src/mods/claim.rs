//! 作者身份丢失后的「认领」：重装系统 / 换电脑 / 删掉私钥之后再回来更新旧模组。
//!
//! 认人的东西只有两样：清单里的 `author.id`（登记标识）与 `author.keyId`（签名公钥指纹），
//! 真正的凭据是本机私钥（只落在 `_launcher/data/mod-keys/`，永不外传）。作者重装系统后
//! 私钥没了，本机会先生成一套新身份，于是 `sign_mod_folder` / `prepare_submission` 的
//! 归属保护就会拒绝他给自己几年前的模组签名（「不能替别人签名」）。
//!
//! 那条保护本身是对的（防止误改别人的署名、防止把别人的模组签成自己的），缺的是**恢复通道**：
//! 只要作者还能证明「这个模组的仓库是我的」，就应该把归属转回自己名下。
//!
//! 能程序化核验的证明只有一条：**GitHub 仓库的写权限**。索引缓存里每条模组都记着 `repo`
//! （`https://github.com/<owner>/<repo>`），发新版本本来也要推到那个仓库；所以
//! 「当前令牌对这个仓库有 push 权限 / 这个仓库就在令牌账号名下」＝「我就是这个模组的作者」。
//! 核验通过后落一条认领记录，归属保护只对**认领过的那一个 id** 放行。
//!
//! 两条出路，认领是后一条：
//!   1) 私钥还在（以前导出过 `.eve-key`）→ 直接 `author:importKey` 还原，什么都不用认领；
//!   2) 私钥彻底没了 → 用新身份认领；认领后用新密钥重签，索引里的 `keyId` 随之更新。
//!
//! 为什么要有记录而不是「查出仓库是你的就直接放行」：归属核验必须联网（GitHub），
//! 而签名 / 打包是离线动作，离线路径上只能读一份本机的结论 —— 那份结论就是认领记录。
use crate::github;
use crate::mods::{join_within, mods_root, pkg, registry, scan, submit};
use crate::runtime::RuntimePaths;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const CLAIMS_FILE: &str = "author-claims.json";

fn claims_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.user_data.join(CLAIMS_FILE)
}

fn read_file(runtime: &RuntimePaths) -> Value {
    let fallback = json!({ "schemaVersion": 1, "items": [] });
    let Ok(raw) = fs::read_to_string(claims_path(runtime)) else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return fallback;
    };
    if parsed.get("items").and_then(Value::as_array).is_none() {
        return fallback;
    }
    json!({
        "schemaVersion": 1,
        "items": parsed.get("items").cloned().unwrap_or_else(|| json!([])),
    })
}

/// 全部认领记录
pub fn claims(runtime: &RuntimePaths) -> Vec<Value> {
    read_file(runtime)
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 这个模组 id 是否已被本机认领 —— 归属保护据此放行（离线路径上唯一的判据）
pub fn is_claimed(runtime: &RuntimePaths, id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    claims(runtime)
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(id))
}

/// 落一条认领记录（同一个 id 覆盖旧的：重新认领等于刷新凭据）
pub(crate) fn record_claim(
    runtime: &RuntimePaths,
    id: &str,
    prev_author_id: &str,
    prev_key_id: &str,
    repo: &str,
    login: &str,
    verified_by: &str,
) -> Result<(), String> {
    let mut file = read_file(runtime);
    let mut items: Vec<Value> = file
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(id))
        .collect();
    items.push(json!({
        "id": id,
        "prevAuthorId": prev_author_id,
        "prevKeyId": prev_key_id,
        "repo": repo,
        "login": login,
        "verifiedBy": verified_by,
        "claimedAt": crate::process::iso_timestamp(),
        "claimedAtMs": pkg::epoch_ms(),
    }));
    file["items"] = json!(items);
    let path = claims_path(runtime);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(&file).map_err(|err| err.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|err| err.to_string())
}

/* ------------------------------ 仓库归属 ------------------------------ */

/// `https://github.com/owner/name`、`owner/name`、`git@github.com:owner/name.git` → (owner, name)
pub fn repo_slug(value: &str) -> Option<(String, String)> {
    let mut text = value.trim().to_string();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
        "git@github.com:",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_string();
            break;
        }
    }
    let text = text.trim().trim_end_matches('/');
    let text = text.strip_suffix(".git").unwrap_or(text);
    let parts: Vec<&str> = text
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    Some((parts[0].trim().to_string(), parts[1].trim().to_string()))
}

/// 索引缓存里所有登记的仓库：**整份只读一遍**。
///
/// 以前是每个候选分别去读一遍（读文件 + JSON 解析 + Ed25519 验签），本机装了一万个
/// 别人的模组就是一万次验签 —— 这正是「找回旧模组」卡住的根因。
fn index_repo_map(runtime: &RuntimePaths) -> HashMap<String, String> {
    let Some(index) = registry::read_index_cache(runtime) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for entry in index
        .get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let repo = entry
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if repo.is_empty() {
            continue;
        }
        map.entry(id.to_string())
            .or_insert_with(|| repo.to_string());
    }
    map
}

/// 发布台账里所有用过的仓库：同样只读一遍（台账 JSON 每次重新解析也不便宜）
fn ledger_repo_map(runtime: &RuntimePaths) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for item in submit::submission_items(runtime) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let repo = item
            .get("sourceRepo")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if repo.is_empty() {
            continue;
        }
        map.entry(id.to_string())
            .or_insert_with(|| repo.to_string());
    }
    map
}

/// 这个模组的来源仓库：索引登记 > 本地市场标记（`.evejs-source.json`）> 发布台账
fn resolve_repo(
    record: &scan::ModRecord,
    index: &HashMap<String, String>,
    ledger: &HashMap<String, String>,
) -> (String, &'static str) {
    if let Some(repo) = index.get(&record.id) {
        return (repo.clone(), "index");
    }
    if !record.source_repo.trim().is_empty() {
        return (record.source_repo.clone(), "source");
    }
    if let Some(repo) = ledger.get(&record.id) {
        return (repo.clone(), "ledger");
    }
    (String::new(), "")
}

/// 认领核验（纯函数，好测）：这个仓库得是当前令牌主人自己的。
/// 返回「凭什么认的」：`owner`＝仓库就在令牌账号名下；`push`＝GitHub 明确回了写权限。
fn verify(repo: &str, owner: &str, login: &str, access: &Value) -> Result<&'static str, String> {
    if repo.trim().is_empty() {
        return Err("索引与本地记录里都没有这个模组的仓库地址，无法核实归属".to_string());
    }
    if login.trim().is_empty() {
        return Err("拿不到 GitHub 登录名（令牌可能已失效）".to_string());
    }
    if !owner.is_empty() && owner.eq_ignore_ascii_case(login) {
        return Ok("owner");
    }
    let exists = access
        .get("exists")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let push = access.get("push").and_then(Value::as_bool).unwrap_or(false);
    if exists && push {
        return Ok("push");
    }
    if !exists {
        return Err(format!(
            "令牌账号（{login}）看不到仓库 {repo}：它可能已被删除或改名"
        ));
    }
    Err(format!(
        "仓库 {repo} 不在令牌账号（{login}）名下，也没有写权限，不能认领"
    ))
}

/// 一条候选的形状（认领列表与「已认领」回显共用）
fn candidate_json(
    record: &scan::ModRecord,
    declared_author_id: &str,
    declared_key_id: &str,
    claimed: bool,
) -> Value {
    json!({
        "id": record.id,
        "folder": record.folder,
        "displayName": if record.display_name.is_empty() { record.id.clone() } else { record.display_name.clone() },
        "version": record.version,
        "declaredAuthorId": declared_author_id,
        "declaredKeyId": declared_key_id,
        "declaredAuthorName": record.author_name,
        "claimed": claimed,
    })
}

/* ------------------------------ 通道实现 ------------------------------ */

/// 一页默认多少条：本机装了上万个别人的模组时，列表不能把上万条一次塞给界面
pub const CLAIM_PAGE_DEFAULT: usize = 50;
/// 一页的上限（界面「加载更多」也只能按这个步长要）
pub const CLAIM_PAGE_MAX: usize = 200;

/// `mods:claimCandidates` 的入参：分页 + 搜索。
///
/// 为什么必须分页：候选是「本机 `mods/` 里由别的身份署名的模组」，装了上万个模组的人
/// 候选就是上万条 —— 序列化、跨进程传输、渲染都是上万份，界面会直接卡住。
///
/// `scope` 决定列表范围：候选里的绝大部分其实是「从市场装的别人的模组」（仓库在别人
/// 名下，认领一定被拒）。`Mine` 只留仓库在本令牌账号名下（或已认领）的那些，被藏起来的
/// 条数用 `foreignCount` 如实报出来，界面据此给一个「查看全部」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimScope {
    Mine,
    All,
}

#[derive(Debug, Clone)]
pub struct ClaimOptions {
    pub offset: usize,
    pub limit: usize,
    pub query: String,
    pub scope: ClaimScope,
}

impl Default for ClaimOptions {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: CLAIM_PAGE_DEFAULT,
            query: String::new(),
            scope: ClaimScope::All,
        }
    }
}

impl ClaimOptions {
    /// 兼容两种调用：`modsClaimCandidates()`（全用默认）与
    /// `modsClaimCandidates({ offset, limit, query, scope })`。
    pub fn parse(args: &[Value]) -> Self {
        let object = args.iter().find_map(Value::as_object);
        let number = |key: &str| object.and_then(|map| map.get(key)).and_then(Value::as_u64);
        let offset = number("offset").unwrap_or(0) as usize;
        let limit = number("limit")
            .map(|value| value as usize)
            .filter(|value| *value > 0)
            .map(|value| value.min(CLAIM_PAGE_MAX))
            .unwrap_or(CLAIM_PAGE_DEFAULT);
        let query = object
            .and_then(|map| map.get("query"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let scope = match object
            .and_then(|map| map.get("scope"))
            .and_then(Value::as_str)
            .unwrap_or("all")
        {
            "mine" => ClaimScope::Mine,
            _ => ClaimScope::All,
        };
        Self {
            offset,
            limit,
            query,
            scope,
        }
    }
}

/// 没配令牌时给界面的回包：核验不了仓库归属，候选列表对他没有意义。
///
/// 这一步同时是**性能闸门** —— 装了上万个市场模组的普通玩家根本用不到这个列表，
/// 不该为它读一整份索引（含 Ed25519 验签）与一整份发布台账。
fn needs_token_payload() -> Value {
    json!({
        "ok": true,
        "items": [],
        "skipped": [],
        "total": 0,
        "skippedCount": 0,
        "needsToken": true,
        "reason": "找回旧模组要先核验仓库归属：先在「令牌配置」里配好 GitHub 令牌",
    })
}

/// 排序口径与界面 `orderClaimItems` 一致：像自己的最前，仓库归属待确认的居中，已认领垫底。
/// 后端必须先排好再切片，否则「加载更多」翻页会前后矛盾（同一条出现两次或漏掉）。
fn order_candidates(items: &mut [Value], login: &str) {
    let rank = |item: &Value| -> u8 {
        if item
            .get("claimed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            2
        } else if is_mine_candidate(item, login) {
            0
        } else {
            1
        }
    };
    items.sort_by(|left, right| {
        rank(left).cmp(&rank(right)).then_with(|| {
            let left_name = left
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let right_name = right
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_name.cmp(right_name)
        })
    });
}

/// 这条候选的仓库是不是在本令牌账号名下。
///
/// 已认领的永远算「我的」（认领记录本身就是核验过归属的结论）。
fn is_mine_candidate(item: &Value, login: &str) -> bool {
    if item
        .get("claimed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return true;
    }
    let owner = item
        .get("repoOwner")
        .and_then(Value::as_str)
        .unwrap_or_default();
    !owner.is_empty() && owner.eq_ignore_ascii_case(login.trim())
}

/// 搜索：id / 显示名 / 原署名 / 仓库地址，任意一处包含关键字即命中（不区分大小写）
fn matches_query(item: &Value, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let needle = needle.to_lowercase();
    [
        "id",
        "displayName",
        "declaredAuthorId",
        "declaredAuthorName",
        "repo",
    ]
    .iter()
    .filter_map(|key| item.get(*key).and_then(Value::as_str))
    .any(|value| value.to_lowercase().contains(&needle))
}

/// `mods:claimCandidates`：本机 `mods/` 里由**别的身份**署名的模组（认领候选），按页返回。
///
/// **离线**：只读本机文件（外加一份登录名缓存用于排序），不碰网络 —— 归属核验留给
/// `claim_mod`（那一步本来就要联网）。列表里给出仓库与仓库主人，界面据此标出
/// 「这个像是你的」。
pub fn claim_candidates(repo_root: &Path, runtime: &RuntimePaths, opts: &ClaimOptions) -> Value {
    let token = github::get_token(runtime);
    claim_candidates_for(repo_root, runtime, opts, &token)
}

/// 带令牌的候选列表：`token` 单独传进来，单测就能在不碰全局令牌的情况下跑门禁
pub(crate) fn claim_candidates_for(
    repo_root: &Path,
    runtime: &RuntimePaths,
    opts: &ClaimOptions,
    token: &str,
) -> Value {
    if token.is_empty() {
        return needs_token_payload();
    }
    // 登录名只读本机缓存、**不联网**：这个调用挂在界面加载链路上，不能为它等一次 GitHub
    let login = github::cached_login(runtime, token);
    claim_candidates_with(repo_root, runtime, opts, &login)
}

/// 候选筛选的实体：整份索引与整份台账各读一次，循环里只剩查表。
fn claim_candidates_with(
    repo_root: &Path,
    runtime: &RuntimePaths,
    opts: &ClaimOptions,
    login: &str,
) -> Value {
    let identity = match crate::author::read_identity_at(runtime) {
        Ok(identity) => identity,
        Err(reason) => {
            return json!({
                "ok": false,
                "items": [],
                "skipped": [],
                "total": 0,
                "skippedCount": 0,
                "reason": format!("读不到本机作者身份：{reason}"),
            })
        }
    };

    let scanned = scan::scan_mods(repo_root, runtime).mods;
    let index_repos = index_repo_map(runtime);
    let ledger_repos = ledger_repo_map(runtime);
    // 认领记录同样整份读一次：以前每条候选都要把认领文件重新读一遍
    let claimed_ids: HashSet<String> = claims(runtime)
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();

    let mut items: Vec<Value> = Vec::new();
    let mut skipped_count = 0usize;
    for record in &scanned {
        let declared_author_id = record.author_id.trim().to_string();
        let declared_key_id = record.author_key_id.trim().to_string();
        let claimed = claimed_ids.contains(&record.id);
        // 本次身份签的模组不用认领；作者块整个是空的也不用（签名时会自动补上）
        let foreign = (!declared_author_id.is_empty() && declared_author_id != identity.id)
            || (!declared_key_id.is_empty() && declared_key_id != identity.key_id);
        if !foreign && !claimed {
            continue;
        }
        let (repo, repo_source) = resolve_repo(record, &index_repos, &ledger_repos);
        let has_repo = !repo.trim().is_empty();
        if !claimed && !has_repo {
            // 解析不出仓库 = 核验不了归属 = 放哪儿都办不了事，只计数、不回条目
            skipped_count += 1;
            continue;
        }
        let mut item = candidate_json(record, &declared_author_id, &declared_key_id, claimed);
        item["repo"] = json!(repo);
        item["repoSource"] = json!(repo_source);
        item["repoOwner"] = json!(repo_slug(&repo).map(|(owner, _)| owner).unwrap_or_default());
        item["canClaim"] = json!(claimed || has_repo);
        item["reason"] = json!(if has_repo {
            ""
        } else {
            "索引与本地记录里都没有这个模组的仓库地址"
        });
        items.push(item);
    }

    order_candidates(&mut items, login);
    if !opts.query.is_empty() {
        items.retain(|item| matches_query(item, &opts.query));
    }

    // 只有令牌账号名下的仓库才认领得动 —— 候选里剩下的多半是「从市场装的别人的模组」。
    // 登录名还没核验出来时判不了归属，这时宁可一条都不筛（组织名下的仓库只能靠
    // 「查看全部」看见，误筛会把真作者挡在门外）。
    let login_known = !login.trim().is_empty();
    let foreign_count = if login_known {
        items
            .iter()
            .filter(|item| !is_mine_candidate(item, login))
            .count()
    } else {
        0
    };
    if login_known && opts.scope == ClaimScope::Mine {
        items.retain(|item| is_mine_candidate(item, login));
    }

    let total = items.len();
    let page: Vec<Value> = items
        .into_iter()
        .skip(opts.offset)
        .take(opts.limit)
        .collect();
    json!({
        "ok": true,
        "items": page,
        "skipped": [],
        "skippedCount": skipped_count,
        "total": total,
        "foreignCount": foreign_count,
        "scope": match opts.scope {
            ClaimScope::Mine => "mine",
            ClaimScope::All => "all",
        },
        "login": login,
        "offset": opts.offset,
        "limit": opts.limit,
        "needsToken": false,
    })
}

/// `mods:claimMod`：核实这个模组的仓库归当前令牌主人，通过后落认领记录。
///
/// 核验只用公开信息（索引里登记的仓库 + GitHub 的写权限），不接受「我说是我的」。
pub fn claim_mod(repo_root: &Path, runtime: &RuntimePaths, folder: &str) -> Value {
    let Some(dir) = join_within(&mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "模组目录名非法" });
    };
    let safe = crate::mods::safe_folder_name(folder);
    let record = scan::read_mod_dir(&safe, &dir);
    if !record.valid {
        return json!({ "ok": false, "reason": format!("清单校验失败：{}", record.error) });
    }
    if is_claimed(runtime, &record.id) {
        return json!({ "ok": true, "id": record.id, "alreadyClaimed": true });
    }
    let identity = match crate::author::read_identity_at(runtime) {
        Ok(identity) => identity,
        Err(reason) => {
            return json!({ "ok": false, "reason": format!("读不到本机作者身份：{reason}") })
        }
    };
    let declared_author_id = record.author_id.trim().to_string();
    let declared_key_id = record.author_key_id.trim().to_string();
    if declared_author_id.is_empty() && declared_key_id.is_empty() {
        return json!({
            "ok": false,
            "reason": "这个模组的清单里没有作者标识，直接签名即可，不需要认领",
        });
    }
    if declared_author_id == identity.id
        && (declared_key_id.is_empty() || declared_key_id == identity.key_id)
    {
        return json!({ "ok": false, "reason": "这个模组本来就是本机身份签的，不需要认领" });
    }
    // 单条认领：索引与台账各读一次就够，不必像候选列表那样整份建表
    let (repo, repo_source) =
        resolve_repo(&record, &index_repo_map(runtime), &ledger_repo_map(runtime));
    let Some((owner, repo_name)) = repo_slug(&repo) else {
        return json!({
            "ok": false,
            "repo": repo,
            "reason": if repo.trim().is_empty() {
                "索引与本地记录里都没有这个模组的仓库地址，无法核实归属；先在「发布模组」里把仓库填对再试".to_string()
            } else {
                format!("仓库地址不合法：{repo}")
            },
        });
    };

    let token = github::get_token(runtime);
    if token.is_empty() {
        return json!({
            "ok": false,
            "needsToken": true,
            "repo": repo,
            "reason": "认领要核验仓库归属：先在「令牌配置」里配好 GitHub 令牌",
        });
    }
    let me = github::validate_token(&token);
    let login = me
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if login.is_empty() {
        return json!({
            "ok": false,
            "needsToken": true,
            "repo": repo,
            "reason": me
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("GitHub 令牌无效，先在「令牌配置」里重新授权"),
        });
    }
    // 令牌有效就把「这个令牌是谁」记下来：候选列表靠这份缓存排序，不必再打一遍 GitHub
    github::remember_login(runtime, &token, &login);
    let access = github::repo_access(&token, &owner, &repo_name);
    let verified_by = match verify(&repo, &owner, &login, &access) {
        Ok(verified_by) => verified_by,
        Err(reason) => return json!({ "ok": false, "repo": repo, "reason": reason }),
    };
    if let Err(reason) = record_claim(
        runtime,
        &record.id,
        &declared_author_id,
        &declared_key_id,
        &repo,
        &login,
        verified_by,
    ) {
        return json!({ "ok": false, "reason": format!("认领记录写入失败：{reason}") });
    }
    json!({
        "ok": true,
        "id": record.id,
        "repo": repo,
        "repoSource": repo_source,
        "login": login,
        "verifiedBy": verified_by,
        "prevAuthorId": declared_author_id,
        "prevKeyId": declared_key_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::scan::MANIFEST_NAME;
    use crate::mods::MOD_SOURCE_FILE;
    use serde_json::json;

    fn runtime_for(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-claim-rt-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能建测试目录");
        RuntimePaths::from_root(dir, true)
    }

    fn repo_for(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-claim-repo-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("mods")).expect("应能建 mods 目录");
        dir
    }

    fn write_mod(repo: &Path, folder: &str, manifest: Value) {
        let dir = repo.join("mods").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn manifest(id: &str, author: Value) -> Value {
        json!({
            "schemaVersion": 3,
            "id": id,
            "displayName": id,
            "version": "1.0.0",
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" },
            "author": author,
        })
    }

    /// 写一份「从市场装的」标记：仓库地址由此解析出来（等价于索引里登记了 repo）
    fn mark_market_source(repo: &Path, folder: &str, source_repo: &str) {
        fs::write(
            repo.join("mods").join(folder).join(MOD_SOURCE_FILE),
            json!({ "source": "market", "repo": source_repo, "version": "1.0.0" }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn repo_slug_accepts_url_slug_and_ssh() {
        assert_eq!(
            repo_slug("https://github.com/diguo520/evejs-mod-x"),
            Some(("diguo520".to_string(), "evejs-mod-x".to_string()))
        );
        assert_eq!(
            repo_slug("diguo520/evejs-mod-x"),
            Some(("diguo520".to_string(), "evejs-mod-x".to_string()))
        );
        assert_eq!(
            repo_slug("git@github.com:JUZIMandarin/evejs-mod-y.git"),
            Some(("JUZIMandarin".to_string(), "evejs-mod-y".to_string()))
        );
        assert_eq!(
            repo_slug("https://github.com/owner/name/"),
            Some(("owner".to_string(), "name".to_string()))
        );
        assert_eq!(repo_slug(""), None);
        assert_eq!(repo_slug("https://github.com/onlyowner"), None);
    }

    #[test]
    fn verify_accepts_own_repo_and_push_access_only() {
        let access = json!({ "ok": true, "exists": true, "push": false });
        assert_eq!(
            verify("diguo520/x", "diguo520", "diguo520", &access),
            Ok("owner")
        );
        // 大小写不敏感（GitHub 登录名与 owner 都不区分大小写）
        assert_eq!(
            verify("Diguo520/x", "Diguo520", "diguo520", &access),
            Ok("owner")
        );
        // 组织仓库：owner 不是自己，但 GitHub 明确给了 push
        let push = json!({ "ok": true, "exists": true, "push": true });
        assert_eq!(verify("org/x", "org", "someone", &push), Ok("push"));
        // 别人的仓库：既不是自己名下也没有写权限
        let denied = verify("other/x", "other", "someone", &access);
        assert!(denied.unwrap_err().contains("不能认领"));
        // 仓库没了
        let missing = json!({ "ok": true, "exists": false, "push": false });
        assert!(verify("other/x", "other", "someone", &missing)
            .unwrap_err()
            .contains("看不到仓库"));
        // 没有仓库地址 / 没有登录名
        assert!(verify("", "", "someone", &access)
            .unwrap_err()
            .contains("没有这个模组的仓库地址"));
        assert!(verify("other/x", "other", "", &access)
            .unwrap_err()
            .contains("拿不到 GitHub 登录名"));
    }

    #[test]
    fn claim_records_round_trip_and_drive_is_claimed() {
        let runtime = runtime_for("store");
        assert!(!is_claimed(&runtime, "evejs-x"));
        record_claim(
            &runtime,
            "evejs-x",
            "au-old",
            "oldkey",
            "https://github.com/diguo520/evejs-mod-x",
            "diguo520",
            "owner",
        )
        .expect("应能落认领记录");
        assert!(is_claimed(&runtime, "evejs-x"));
        assert!(!is_claimed(&runtime, "evejs-y"));
        let items = claims(&runtime);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["prevAuthorId"], json!("au-old"));
        assert_eq!(items[0]["verifiedBy"], json!("owner"));

        // 重新认领同一个 id：覆盖而不是追加
        record_claim(
            &runtime,
            "evejs-x",
            "au-old2",
            "oldkey2",
            "https://github.com/diguo520/evejs-mod-x",
            "diguo520",
            "push",
        )
        .unwrap();
        let items = claims(&runtime);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["prevAuthorId"], json!("au-old2"));
    }

    #[test]
    fn claim_file_falls_back_when_missing_or_broken() {
        let runtime = runtime_for("broken");
        assert!(claims(&runtime).is_empty());
        fs::write(claims_path(&runtime), "not json").unwrap();
        assert!(claims(&runtime).is_empty());
        fs::write(claims_path(&runtime), "{\"items\":\"nope\"}").unwrap();
        assert!(claims(&runtime).is_empty());
    }

    #[test]
    fn candidates_skip_own_mods_and_keep_foreign_ones() {
        let repo = repo_for("candidates");
        let runtime = runtime_for("candidates");
        let state = crate::author::get_state(&runtime);
        assert_eq!(state["ok"], json!(true));
        let me_id = state["author"]["id"].as_str().unwrap().to_string();
        let me_key = state["author"]["keyId"].as_str().unwrap().to_string();
        // 本机身份签的：不是候选
        write_mod(
            &repo,
            "mine",
            manifest("mine", json!({ "id": me_id, "keyId": me_key })),
        );
        // 作者块整个空的：签名时自动补，不是候选
        write_mod(&repo, "blank", manifest("blank", json!({})));
        // 别人署名：是候选（本机没有索引缓存也没有市场标记，解析不出仓库 → 只能计数）
        write_mod(
            &repo,
            "foreign",
            manifest(
                "foreign",
                json!({ "id": "au-someone", "keyId": "deadbeef" }),
            ),
        );
        let result = claim_candidates_for(&repo, &runtime, &ClaimOptions::default(), "tok");
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["items"].as_array().unwrap().len(), 0, "{result}");
        // 解析不出仓库的只计数：条目本身没有可操作的信息，不必跨进程搬运
        assert_eq!(result["skippedCount"], json!(1), "{result}");

        // 认领过之后即使解析不出仓库也照样回显（认领记录本身就是结论）
        record_claim(
            &runtime,
            "foreign",
            "au-someone",
            "deadbeef",
            "https://github.com/someone/evejs-mod-foreign",
            "someone",
            "owner",
        )
        .unwrap();
        let after = claim_candidates_for(&repo, &runtime, &ClaimOptions::default(), "tok");
        let items = after["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], json!("foreign"));
        assert_eq!(items[0]["claimed"], json!(true));
    }

    #[test]
    fn missing_token_short_circuits_the_whole_scan() {
        // 没配令牌 = 核验不了仓库归属：候选列表对他没有意义，连一次全量扫描都不该做
        let repo = repo_for("no-token");
        let runtime = runtime_for("no-token");
        write_mod(
            &repo,
            "foreign",
            manifest(
                "foreign",
                json!({ "id": "au-someone", "keyId": "deadbeef" }),
            ),
        );
        mark_market_source(
            &repo,
            "foreign",
            "https://github.com/someone/evejs-mod-foreign",
        );
        let result = claim_candidates_for(&repo, &runtime, &ClaimOptions::default(), "");
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["needsToken"], json!(true), "{result}");
        assert_eq!(result["items"].as_array().unwrap().len(), 0, "{result}");
        assert!(!result["reason"].as_str().unwrap().is_empty());
    }

    #[test]
    fn claim_options_parse_defaults_and_clamp() {
        let parsed = ClaimOptions::parse(&[]);
        assert_eq!(parsed.offset, 0);
        assert_eq!(parsed.limit, CLAIM_PAGE_DEFAULT);
        assert!(parsed.query.is_empty());

        let parsed = ClaimOptions::parse(&[json!({
            "offset": 20,
            "limit": 1_000_000,
            "query": "  eve  ",
        })]);
        assert_eq!(parsed.offset, 20);
        // 界面传多大的页都要封顶：一次回几万条等于没分页
        assert_eq!(parsed.limit, CLAIM_PAGE_MAX);
        assert_eq!(parsed.query, "eve");

        // limit 缺失 / 0 / 负数一律退回默认，不会给出一个空页
        assert_eq!(ClaimOptions::parse(&[json!({})]).limit, CLAIM_PAGE_DEFAULT);
        assert_eq!(
            ClaimOptions::parse(&[json!({ "limit": 0 })]).limit,
            CLAIM_PAGE_DEFAULT
        );
        assert_eq!(
            ClaimOptions::parse(&[json!({ "limit": -5 })]).limit,
            CLAIM_PAGE_DEFAULT
        );

        // 范围默认「全部」；只有明确写 mine 才收窄（不认识的取值一律退回全部）
        assert_eq!(ClaimOptions::parse(&[]).scope, ClaimScope::All);
        assert_eq!(
            ClaimOptions::parse(&[json!({ "scope": "mine" })]).scope,
            ClaimScope::Mine
        );
        assert_eq!(
            ClaimOptions::parse(&[json!({ "scope": "nonsense" })]).scope,
            ClaimScope::All
        );
    }

    #[test]
    fn candidates_page_sort_and_search() {
        let repo = repo_for("paging");
        let runtime = runtime_for("paging");
        // 先造出本机身份：没有身份时整个候选列表都不该有结果
        assert_eq!(crate::author::get_state(&runtime)["ok"], json!(true));
        for (folder, owner) in [
            ("alpha", "someone-a"),
            ("bravo", "diguo520"),
            ("charlie", "someone-c"),
        ] {
            write_mod(
                &repo,
                folder,
                manifest(
                    folder,
                    json!({ "id": format!("au-{folder}"), "keyId": format!("key-{folder}") }),
                ),
            );
            mark_market_source(
                &repo,
                folder,
                &format!("https://github.com/{owner}/evejs-mod-{folder}"),
            );
        }

        // 搜索命中（id / 显示名 / 署名 / 仓库任意一处）
        let hit = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 0,
                limit: 10,
                query: "charlie".to_string(),
                scope: ClaimScope::All,
            },
            "tok",
        );
        assert_eq!(hit["total"], json!(1), "{hit}");
        assert_eq!(hit["items"][0]["id"], json!("charlie"), "{hit}");

        // 先排序再切片：「像自己的」排最前，翻页不重不漏
        // 登录名走本机缓存（`checkToken` 与认领成功时写入），候选列表不必再打一遍 GitHub
        github::remember_login(&runtime, "tok", "diguo520");
        assert_eq!(github::cached_login(&runtime, "tok"), "diguo520");
        let page1 = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 0,
                limit: 2,
                query: String::new(),
                scope: ClaimScope::All,
            },
            "tok",
        );
        assert_eq!(page1["total"], json!(3), "{page1}");
        assert_eq!(page1["items"][0]["id"], json!("bravo"), "{page1}");
        assert_eq!(page1["items"][1]["id"], json!("alpha"), "{page1}");
        assert_eq!(page1["limit"], json!(2), "{page1}");

        let page2 = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 2,
                limit: 2,
                query: String::new(),
                scope: ClaimScope::All,
            },
            "tok",
        );
        let seen: Vec<&str> = page1["items"]
            .as_array()
            .unwrap()
            .iter()
            .chain(page2["items"].as_array().unwrap().iter())
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(seen, vec!["bravo", "alpha", "charlie"], "{page2}");
    }

    #[test]
    fn mine_scope_hides_repos_that_are_not_on_the_token_account() {
        let repo = repo_for("scope");
        let runtime = runtime_for("scope");
        assert_eq!(crate::author::get_state(&runtime)["ok"], json!(true));
        write_mod(
            &repo,
            "mine",
            manifest("mine", json!({ "id": "au-mine", "keyId": "key-mine" })),
        );
        mark_market_source(&repo, "mine", "https://github.com/diguo520/evejs-mod-mine");
        write_mod(
            &repo,
            "other",
            manifest("other", json!({ "id": "au-other", "keyId": "key-other" })),
        );
        mark_market_source(
            &repo,
            "other",
            "https://github.com/JUZIMandarin/evejs-mod-other",
        );

        // 令牌账号是 diguo520：别人名下的仓库不该出现在候选里（点了也一定被拒），
        // 但要说清楚被藏了几条，界面才有机会给一个「查看全部」
        github::remember_login(&runtime, "tok", "diguo520");
        let mine = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 0,
                limit: 10,
                query: String::new(),
                scope: ClaimScope::Mine,
            },
            "tok",
        );
        assert_eq!(mine["total"], json!(1), "{mine}");
        assert_eq!(mine["items"][0]["id"], json!("mine"), "{mine}");
        assert_eq!(mine["foreignCount"], json!(1), "{mine}");
        assert_eq!(mine["login"], json!("diguo520"), "{mine}");
        assert_eq!(mine["scope"], json!("mine"), "{mine}");

        // 登录名还没核验出来（缓存是冷的）时判不了归属：宁可不筛，也不误伤真作者
        let cold = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 0,
                limit: 10,
                query: String::new(),
                scope: ClaimScope::Mine,
            },
            "cold-token",
        );
        assert_eq!(cold["total"], json!(2), "{cold}");
        assert_eq!(cold["foreignCount"], json!(0), "{cold}");

        // scope=all：全都列出来（界面上的「查看全部」）
        let all = claim_candidates_for(
            &repo,
            &runtime,
            &ClaimOptions {
                offset: 0,
                limit: 10,
                query: String::new(),
                scope: ClaimScope::All,
            },
            "tok",
        );
        assert_eq!(all["total"], json!(2), "{all}");
        assert_eq!(all["foreignCount"], json!(1), "{all}");
    }

    #[test]
    fn claim_mod_refuses_mods_that_are_already_mine() {
        let repo = repo_for("already");
        let runtime = runtime_for("already");
        let state = crate::author::get_state(&runtime);
        let me_id = state["author"]["id"].as_str().unwrap().to_string();
        write_mod(&repo, "mine", manifest("mine", json!({ "id": me_id })));
        let result = claim_mod(&repo, &runtime, "mine");
        assert_eq!(result["ok"], json!(false), "{result}");
        assert!(result["reason"].as_str().unwrap().contains("不需要认领"));
        // 目录不存在
        let ghost = claim_mod(&repo, &runtime, "ghost");
        assert!(ghost["reason"].as_str().unwrap().contains("清单校验失败"));
    }
}
