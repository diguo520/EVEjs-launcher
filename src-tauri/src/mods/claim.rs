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

/// 索引缓存里这条模组登记的仓库地址（认领核验的权威来源）
fn index_repo(runtime: &RuntimePaths, id: &str) -> String {
    let Some(index) = registry::read_index_cache(runtime) else {
        return String::new();
    };
    index
        .get("mods")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
                .filter_map(|entry| entry.get("repo").and_then(Value::as_str))
                .map(str::to_string)
                .find(|value| !value.trim().is_empty())
        })
        .unwrap_or_default()
}

/// 发布台账里这条模组用过的仓库（索引还没更新的兜底）
fn ledger_repo(runtime: &RuntimePaths, id: &str) -> String {
    submit::submission_items(runtime)
        .iter()
        .filter(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .filter_map(|item| item.get("sourceRepo").and_then(Value::as_str))
        .map(str::to_string)
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

/// 这个模组的来源仓库：索引登记 > 本地市场标记（`.evejs-source.json`）> 发布台账
fn resolve_repo(runtime: &RuntimePaths, record: &scan::ModRecord) -> (String, &'static str) {
    let from_index = index_repo(runtime, &record.id);
    if !from_index.is_empty() {
        return (from_index, "index");
    }
    if !record.source_repo.trim().is_empty() {
        return (record.source_repo.clone(), "source");
    }
    let from_ledger = ledger_repo(runtime, &record.id);
    if !from_ledger.is_empty() {
        return (from_ledger, "ledger");
    }
    (String::new(), "")
}

/// 清单里声明的签名密钥指纹（`author.keyId`）
fn declared_key_id(record: &scan::ModRecord) -> String {
    scan::read_manifest(&record.manifest_path)
        .ok()
        .and_then(|manifest| manifest.get("author").cloned())
        .and_then(|author| {
            author
                .get("keyId")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        })
        .unwrap_or_default()
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

/// `mods:claimCandidates`：本机 `mods/` 里由**别的身份**署名的模组（认领候选）。
///
/// **纯离线**：只读本机文件，不碰网络、不读令牌 —— 归属核验留给 `claim_mod`
/// （那一步本来就要联网）。列表里给出仓库与仓库主人，界面可以据此标出「这个像是你的」。
pub fn claim_candidates(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let identity = match crate::author::read_identity_at(runtime) {
        Ok(identity) => identity,
        Err(reason) => {
            return json!({
                "ok": false,
                "items": [],
                "skipped": [],
                "reason": format!("读不到本机作者身份：{reason}"),
            })
        }
    };

    let scanned = scan::scan_mods(repo_root, runtime).mods;
    let mut items: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for record in &scanned {
        let declared_author_id = record.author_id.trim().to_string();
        let declared_key_id = declared_key_id(record);
        let claimed = is_claimed(runtime, &record.id);
        // 本次身份签的模组不用认领；作者块整个是空的也不用（签名时会自动补上）
        let foreign = (!declared_author_id.is_empty() && declared_author_id != identity.id)
            || (!declared_key_id.is_empty() && declared_key_id != identity.key_id);
        if !foreign && !claimed {
            continue;
        }
        let (repo, repo_source) = resolve_repo(runtime, record);
        let has_repo = !repo.trim().is_empty();
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
        if claimed || has_repo {
            items.push(item);
        } else {
            skipped.push(item);
        }
    }
    json!({ "ok": true, "items": items, "skipped": skipped })
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
    let declared_key_id = declared_key_id(&record);
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
    let (repo, repo_source) = resolve_repo(runtime, &record);
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
        // 别人署名：是候选（本机没有索引缓存，解析不出仓库 → 只能进 skipped）
        write_mod(
            &repo,
            "foreign",
            manifest("foreign", json!({ "id": "au-someone", "keyId": "deadbeef" })),
        );
        let result = claim_candidates(&repo, &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["items"].as_array().unwrap().len(), 0, "{result}");
        let skipped = result["skipped"].as_array().unwrap();
        assert_eq!(skipped.len(), 1, "{result}");
        assert_eq!(skipped[0]["id"], json!("foreign"));
        assert_eq!(skipped[0]["canClaim"], json!(false));
        assert!(!skipped[0]["reason"].as_str().unwrap().is_empty());

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
        let after = claim_candidates(&repo, &runtime);
        let items = after["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], json!("foreign"));
        assert_eq!(items[0]["claimed"], json!(true));
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