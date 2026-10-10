//! loader 注入顺序、启停、排序、卸载、README、签名：对齐现役版 `src/main/modManager.ts`
//! （注入计划 / 启停 / 排序 / 卸载 / README 部分）。
//!
//! 两条硬约定：
//!   - **不改服务端文件**：启用/禁用只是 `loader.js` ↔ `loader.js.disabled` 改名；
//!   - **不替别人签名**：清单里已声明别的 author.id / keyId 时拒绝签名（归属保护）；
//!     唯一的例外是**认领过**的模组（`mods/claim.rs`）：作者重装系统丢了私钥之后，
//!     只要证明得了「这个模组的仓库是我的」，就允许把归属接回本机身份。
use crate::author;
use crate::mods::claim;
use crate::mods::scan::{self, ModRecord};
use crate::mods::{safe_folder_name, sanitize_folder_name};
use crate::runtime::RuntimePaths;
use crate::shell;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 用户自定义排序文件：`_launcher/mods/mod-order.json`
pub const ORDER_FILE: &str = "mod-order.json";

fn mod_order_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.root.join("mods").join(ORDER_FILE)
}

/* ------------------------------ 自定义排序 ------------------------------ */

pub fn read_mod_order(runtime: &RuntimePaths) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(mod_order_path(runtime)) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    // 现役版两种形态都认：数组本体，或 { order: [...] }
    let list = if parsed.is_array() {
        parsed.as_array().cloned().unwrap_or_default()
    } else {
        parsed
            .get("order")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    list.iter()
        .filter_map(Value::as_str)
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `mods:setOrder`
pub fn set_mod_order(runtime: &RuntimePaths, folders: &[String]) -> Value {
    let file = mod_order_path(runtime);
    let clean: Vec<String> = folders
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(&json!({ "order": clean })).unwrap_or_default();
        fs::write(&file, format!("{text}\n"))
    })();
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "reason": err.to_string() }),
    }
}

/* ------------------------------ 注入计划 ------------------------------ */

struct Skip {
    id: String,
    reason: String,
}

/// 计算要注入的 loader 顺序（loadAfter/loadBefore 拓扑排序，成环则退回目录顺序）
pub fn plan_loaders(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let scan_result = scan::scan_mods(repo_root, runtime);
    // 顺序文件里可能记着已经删掉的目录名：先留一份「本地都有哪些目录」，
    // 待会儿用它把「找不到对应模组」的那些条目如实报出来（以前是静默忽略）
    let all_folders: Vec<String> = scan_result
        .mods
        .iter()
        .map(|item| item.folder.clone())
        .collect();
    let mut skipped: Vec<Skip> = Vec::new();

    let mut candidates: Vec<ModRecord> = Vec::new();
    for item in scan_result.mods.into_iter() {
        if item.kind != "loader" || !item.enabled {
            continue;
        }
        if !item.valid {
            skipped.push(Skip {
                id: item.id.clone(),
                reason: format!("清单校验失败: {}", item.error),
            });
            continue;
        }
        // 只有「密钥可信但签名不匹配」才拦截（确定被篡改）；密钥未知时只红标
        if item.signature_state == "invalid" && item.signature_trusted {
            skipped.push(Skip {
                id: item.id.clone(),
                reason: format!("签名校验失败: {}", item.signature_error),
            });
            continue;
        }
        if !item.missing_requires.is_empty() {
            skipped.push(Skip {
                id: item.id.clone(),
                reason: format!("缺少依赖: {}", item.missing_requires.join(", ")),
            });
            continue;
        }
        if !item.active_conflicts.is_empty() {
            skipped.push(Skip {
                id: item.id.clone(),
                reason: format!("与已启用模组冲突: {}", item.active_conflicts.join(", ")),
            });
            continue;
        }
        let loader_ok = item
            .loader_file
            .as_ref()
            .map(|path| Path::new(path).exists())
            .unwrap_or(false);
        if !loader_ok {
            skipped.push(Skip {
                id: item.id.clone(),
                reason: "loader.js 不存在".to_string(),
            });
            continue;
        }
        candidates.push(item);
    }

    // edges: key -> 「必须先于 key 加载」的 key 集合（保持插入序，等价 JS Set）
    let mut index_of: BTreeMap<String, usize> = BTreeMap::new();
    for (index, item) in candidates.iter().enumerate() {
        index_of.insert(item.id.to_lowercase(), index);
    }
    let mut edges: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let push_edge = |edges: &mut BTreeMap<String, Vec<String>>, key: String, dep: String| {
        let entry = edges.entry(key).or_default();
        if !entry.contains(&dep) {
            entry.push(dep);
        }
    };
    for item in &candidates {
        let key = item.id.to_lowercase();
        for id in &item.load_after {
            if let Some(target) = index_of.get(&id.to_lowercase()) {
                push_edge(
                    &mut edges,
                    key.clone(),
                    candidates[*target].id.to_lowercase(),
                );
            }
        }
    }
    for item in &candidates {
        for id in &item.load_before {
            let Some(target) = index_of.get(&id.to_lowercase()) else {
                continue;
            };
            push_edge(
                &mut edges,
                candidates[*target].id.to_lowercase(),
                item.id.to_lowercase(),
            );
        }
    }

    let mut ordered: Vec<usize> = Vec::new();
    let mut state: BTreeMap<String, u8> = BTreeMap::new(); // 0=未访问 1=访问中 2=完成
    let mut cycle = false;
    let mut stack: Vec<String> = Vec::new();
    for candidate in &candidates {
        visit(
            &candidate.id.to_lowercase(),
            &edges,
            &index_of,
            &mut state,
            &mut ordered,
            &mut cycle,
            &mut stack,
        );
    }

    let final_order: Vec<usize> = if cycle {
        (0..candidates.len()).collect()
    } else {
        ordered
    };
    let paths: Vec<String> = final_order
        .iter()
        .filter_map(|index| candidates[*index].loader_file.as_ref())
        .map(|path| path.replace('\\', "/"))
        .collect();

    // ---- 给界面看的「生效顺序」：每一位是你拖的，还是清单约束排的 ----
    //
    // `index_of` 的下标就是**用户手动顺序**（candidates 来自 scan，已按 mod-order.json 排过），
    // 所以 baseIndex 与 index 不一致就说明「这一位被清单里的 loadAfter / loadBefore 挪过」。
    let enabled_ids: BTreeSet<String> = index_of.keys().cloned().collect();
    let order: Vec<Value> = final_order
        .iter()
        .enumerate()
        .map(|(position, index)| {
            let item = &candidates[*index];
            let key = item.id.to_lowercase();
            let declared = |ids: &[String]| -> Vec<String> {
                ids.iter()
                    .filter(|id| enabled_ids.contains(&id.to_lowercase()))
                    .cloned()
                    .collect()
            };
            let base = index_of.get(&key).copied();
            json!({
                "id": item.id,
                "folder": item.folder,
                "name": item.display_name,
                "index": position,
                "baseIndex": base,
                // 位置与手动顺序不同 ⇒ 被清单里的约束挪过，界面上单独标一下
                "reordered": base != Some(position),
                "loadAfter": declared(&item.load_after),
                "loadBefore": declared(&item.load_before),
            })
        })
        .collect();

    // ---- 被忽略的顺序声明：以前静默丢掉，现在如实报出来 ----
    let mut ignored: Vec<Value> = Vec::new();
    for item in &candidates {
        for (field, ids) in [
            ("loadAfter", &item.load_after),
            ("loadBefore", &item.load_before),
        ] {
            for id in ids {
                if enabled_ids.contains(&id.to_lowercase()) {
                    continue;
                }
                ignored.push(json!({
                    "field": field,
                    "id": item.id,
                    "target": id,
                    "reason": format!(
                        "{id} 不在已启用的模组里（没安装或已停用），这条顺序声明本次不生效"
                    ),
                }));
            }
        }
    }
    for folder in read_mod_order(runtime) {
        if all_folders.iter().any(|name| name == &folder) {
            continue;
        }
        ignored.push(json!({
            "field": "order",
            "id": Value::Null,
            "target": folder,
            "reason": "手动顺序里记着的这个目录已经不存在了（重新装回来它会回到原来的位置）",
        }));
    }

    json!({
        "paths": paths,
        "order": order,
        "ignored": ignored,
        // 成环时下面这行会退回「完全按用户手动顺序」，界面要把这件事说清楚
        "cycle": cycle,
        "skipped": skipped
            .iter()
            .map(|item| json!({ "id": item.id, "reason": item.reason }))
            .collect::<Vec<_>>(),
    })
}

fn visit(
    key: &str,
    edges: &BTreeMap<String, Vec<String>>,
    index_of: &BTreeMap<String, usize>,
    state: &mut BTreeMap<String, u8>,
    ordered: &mut Vec<usize>,
    cycle: &mut bool,
    stack: &mut Vec<String>,
) {
    match state.get(key).copied() {
        Some(2) => return,
        Some(1) => {
            *cycle = true;
            return;
        }
        _ => {}
    }
    state.insert(key.to_string(), 1);
    stack.push(key.to_string());
    if let Some(deps) = edges.get(key) {
        for dep in deps {
            if stack.iter().any(|item| item == dep) {
                *cycle = true;
                continue;
            }
            visit(dep, edges, index_of, state, ordered, cycle, stack);
        }
    }
    stack.retain(|item| item != key);
    state.insert(key.to_string(), 2);
    if let Some(index) = index_of.get(key) {
        if !ordered.contains(index) {
            ordered.push(*index);
        }
    }
}
/* ------------------------------ 启停 / 目录 / 卸载 ------------------------------ */

/// `mods:setEnabled`：只做文件改名
pub fn set_mod_enabled(
    repo_root: &Path,
    folder: &str,
    enabled: bool,
    _runtime: &RuntimePaths,
) -> Value {
    // B1：统一走 join_within（组件级包含判定），`mods-evil` 之类的同级前缀目录不会被误放行
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "路径非法" });
    };
    let safe = safe_folder_name(folder);
    let record = scan::read_mod_dir(&safe, &dir);
    if !record.valid {
        return json!({ "ok": false, "reason": format!("清单校验失败: {}", record.error) });
    }
    if record.kind != "loader" || record.strategy != "loader_rename" {
        return json!({ "ok": false, "reason": "M1 目前只支持 loader（loader_rename）模组的启停" });
    }

    let enabled_path = dir.join(scan::LOADER_ENABLED);
    let outcome = (|| -> Result<(), String> {
        if enabled {
            if enabled_path.is_file() {
                return Ok(());
            }
            let source = scan::LOADER_DISABLED_ALT
                .iter()
                .map(|name| dir.join(name))
                .find(|path| path.is_file())
                .or_else(|| {
                    let fallback = dir.join(scan::LOADER_DISABLED);
                    fallback.is_file().then_some(fallback)
                });
            let Some(source) = source else {
                return Err("未找到 loader.js.disabled".to_string());
            };
            fs::rename(source, &enabled_path).map_err(|err| err.to_string())
        } else {
            if !enabled_path.is_file() {
                return Ok(());
            }
            let disabled_path = dir.join(scan::LOADER_DISABLED);
            if disabled_path.exists() {
                return Err(format!("{} 已存在，未做改动", scan::LOADER_DISABLED));
            }
            fs::rename(&enabled_path, &disabled_path).map_err(|err| err.to_string())
        }
    })();

    match outcome {
        Ok(()) => json!({ "ok": true, "mod": scan::read_mod_dir(&safe, &dir).to_json() }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

/// `mods:createFolder`
pub fn create_mods_folder(repo_root: &Path) -> Value {
    let root = crate::mods::mods_root(repo_root);
    match fs::create_dir_all(&root) {
        Ok(()) => json!({ "ok": true, "root": root.to_string_lossy() }),
        Err(err) => json!({
            "ok": false,
            "root": root.to_string_lossy(),
            "reason": err.to_string(),
        }),
    }
}

/// `mods:uninstall`：优先移入系统回收站（用户能自己还原），回收站不可用时才直接删除
pub fn uninstall_mod(repo_root: &Path, folder: &str) -> Value {
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "目录名非法" });
    };
    if !dir.exists() {
        return json!({ "ok": false, "reason": format!("目录不存在：{}", dir.to_string_lossy()) });
    }

    let safe = safe_folder_name(folder);
    // 先禁用，避免服务端仍按启用状态引用它
    let enabled = dir.join(scan::LOADER_ENABLED);
    if enabled.is_file() {
        let _ = fs::rename(&enabled, dir.join(scan::LOADER_DISABLED));
    }

    if shell::to_recycle_bin(&dir).is_ok() {
        return json!({
            "ok": true,
            "folder": safe,
            "dir": dir.to_string_lossy(),
            "trashed": true,
        });
    }
    match fs::remove_dir_all(&dir) {
        Ok(()) => json!({
            "ok": true,
            "folder": safe,
            "dir": dir.to_string_lossy(),
            "trashed": false,
        }),
        Err(err) => json!({
            "ok": false,
            "reason": err.to_string(),
            "dir": dir.to_string_lossy(),
        }),
    }
}

/* ------------------------------ README ------------------------------ */

/// `mods:readme`：只读、限长，读不到就返回空串（详情里没有说明不算错误）
pub fn read_mod_readme(repo_root: &Path, folder: &str) -> Value {
    // B1：先按白名单清洗，再断言结果没逃出 mods/（旧实现 sanitize 为空时会回落到原始 folder，
    // 于是 `..` 这种输入能读到 mods/../README.md）
    let safe = sanitize_folder_name(folder);
    let name = if safe.is_empty() {
        folder.to_string()
    } else {
        safe
    };
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), &name) else {
        return json!({ "ok": false, "reason": "目录名非法" });
    };
    let target = dir.join("README.md");
    if !dir.exists() {
        return json!({
            "ok": false,
            "text": "",
            "path": target.to_string_lossy(),
            "reason": "目录不存在",
        });
    }
    for candidate in ["README.md", "readme.md", "Readme.md", "README.MD"] {
        let file = dir.join(candidate);
        if !file.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        let text: String = raw
            .trim_start_matches('\u{feff}')
            .chars()
            .take(128 * 1024)
            .collect();
        return json!({ "ok": true, "text": text, "path": file.to_string_lossy() });
    }
    json!({
        "ok": false,
        "text": "",
        "path": target.to_string_lossy(),
        "reason": "没有 README.md",
    })
}

/* ------------------------------ 签名 ------------------------------ */

/// `mods:sign`：用本机作者私钥给模组清单签名并写回
pub fn sign_mod_folder(repo_root: &Path, folder: &str, runtime: &RuntimePaths) -> Value {
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "模组目录名非法" });
    };
    let safe = safe_folder_name(folder);
    let manifest_path = dir.join(scan::MANIFEST_NAME);
    if !manifest_path.is_file() {
        return json!({ "ok": false, "reason": format!("找不到 {}", scan::MANIFEST_NAME) });
    }
    let manifest = match scan::read_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    // 签名前重跑一遍清单校验，校验不过不给签
    let record = scan::read_mod_dir(&safe, &dir);
    if !record.valid {
        return json!({ "ok": false, "reason": format!("清单校验失败: {}", record.error) });
    }

    let Some(private_key) = author::read_signing_key(runtime) else {
        return json!({
            "ok": false,
            "reason": "本机私钥不可用（请先在「作者身份」里建好身份，或导入 .eve-key）"
        });
    };
    let Ok(me) = author::read_identity_at(runtime) else {
        return json!({ "ok": false, "reason": "读不到本机作者身份" });
    };

    // 归属保护（必须在主进程）：渲染层的提示可以被绕过，直接调 IPC 也不该能改掉别人的署名
    let declared = manifest.get("author").and_then(Value::as_object);
    let declared_author_id = declared
        .and_then(|block| block.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let declared_key_id = declared
        .and_then(|block| block.get("keyId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // 认领过的模组放行（见 mods/claim.rs）：作者重装系统后旧私钥不可能再有了，
    // 唯一能做的就是改署名为本机身份 —— 但只对**核验过仓库归属**的那一个 id 放行。
    let foreign_author = !declared_author_id.is_empty() && declared_author_id != me.id;
    let foreign_key = !declared_key_id.is_empty() && declared_key_id != me.key_id;
    let reclaimed = (foreign_author || foreign_key) && claim::is_claimed(runtime, &record.id);
    if foreign_author && !reclaimed {
        return json!({
            "ok": false,
            "reason": format!(
                "这个模组的作者标识是 {}，不是本机作者（{}），不能替别人签名。\
                 如果这个模组本来就是你做的（重装过系统 / 换过电脑），先在「找回旧模组」里认领它；\
                 当年导出过 .eve-key 的话，直接在「令牌配置」里导入就能用回原身份。",
                declared_author_id, me.id
            ),
        });
    }
    if foreign_key && !reclaimed {
        return json!({
            "ok": false,
            "reason": format!(
                "清单里记的签名密钥（{}）与本机密钥（{}）不一致，拒绝签名。\
                 如果这个模组本来就是你做的（重装过系统 / 换过电脑），先在「找回旧模组」里认领它；\
                 当年导出过 .eve-key 的话，直接在「令牌配置」里导入就能用回原身份。",
                declared_key_id, me.key_id
            ),
        });
    }
    let attached_author = declared.is_none();
    // 认领过的：署名整块换成本机身份，否则签名里的 keyId 与清单里的对不上
    let attach_author = attached_author || reclaimed;

    let mut draft = manifest.clone();
    draft.remove("signature");
    if attach_author {
        draft.insert(
            "author".to_string(),
            json!({
                "id": me.id,
                "name": me.name,
                "keyId": me.key_id,
                "publicKey": me.public_key,
            }),
        );
    }

    let signature = json!({
        "alg": "ed25519",
        "keyId": me.key_id,
        "sig": crate::mods::sign::sign_manifest(&Value::Object(draft.clone()), &private_key),
        "signedAt": crate::process::iso_timestamp(),
    });
    draft.insert("signature".to_string(), signature);

    let text = match serde_json::to_string_pretty(&Value::Object(draft)) {
        Ok(text) => format!("{text}\n"),
        Err(err) => return json!({ "ok": false, "reason": format!("序列化失败: {err}") }),
    };
    match fs::write(&manifest_path, text) {
        Ok(()) => json!({
            "ok": true,
            "keyId": me.key_id,
            "manifestPath": manifest_path.to_string_lossy(),
            "attachedAuthor": attached_author,
            "reclaimed": reclaimed,
            "previousAuthorId": declared_author_id,
            "previousKeyId": declared_key_id,
        }),
        Err(err) => json!({ "ok": false, "reason": format!("写入失败: {err}") }),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::scan::{MANIFEST_NAME, MOD_SOURCE_FILE};
    use serde_json::json;

    fn runtime_for(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-plan-rt-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能建测试目录");
        RuntimePaths::from_root(dir, true)
    }

    fn repo_for(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-plan-repo-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("mods")).expect("应能建 mods 目录");
        dir
    }

    fn manifest(id: &str, extra: Value) -> Value {
        let mut base = json!({
            "schemaVersion": 3,
            "id": id,
            "displayName": id,
            "version": "1.0.0",
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" }
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn write_mod(repo: &Path, folder: &str, manifest: Value, loader: Option<&str>) {
        let dir = repo.join("mods").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        if let Some(source) = loader {
            fs::write(dir.join(scan::LOADER_ENABLED), source).unwrap();
        }
    }

    #[test]
    fn plan_honours_load_after_and_returns_forward_slash_paths() {
        let repo = repo_for("plan-order");
        // 显示名让默认顺序是 b,a；依赖要求 a 先加载
        write_mod(
            &repo,
            "b",
            manifest("b", json!({ "displayName": "A-first", "loadAfter": ["a"] })),
            Some("// b"),
        );
        write_mod(
            &repo,
            "a",
            manifest("a", json!({ "displayName": "Z-last" })),
            Some("// a"),
        );
        let runtime = runtime_for("plan-order");
        let plan = plan_loaders(&repo, &runtime);
        let paths: Vec<String> = plan["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("a/loader.js"), "{paths:?}");
        assert!(paths[1].ends_with("b/loader.js"), "{paths:?}");
        assert!(
            paths.iter().all(|path| !path.contains('\\')),
            "注入路径必须是正斜杠：{paths:?}"
        );
        assert_eq!(plan["skipped"].as_array().unwrap().len(), 0);
        // 给界面看的生效顺序：手动顺序（按显示名）本来是 b,a；b 声明 loadAfter a
        // 之后两者都被挪过，所以两条都标 reordered，并带上各自的 baseIndex
        let order = plan["order"].as_array().unwrap();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0]["id"], json!("a"));
        assert_eq!(order[0]["index"], json!(0));
        assert_eq!(order[0]["baseIndex"], json!(1));
        assert_eq!(order[0]["reordered"], json!(true));
        assert_eq!(order[1]["id"], json!("b"));
        assert_eq!(order[1]["baseIndex"], json!(0));
        assert_eq!(order[1]["reordered"], json!(true));
        assert_eq!(order[1]["loadAfter"], json!(["a"]));
        assert_eq!(plan["cycle"], json!(false));
        assert_eq!(plan["ignored"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn plan_reports_ignored_declarations_and_stale_order_entries() {
        let repo = repo_for("plan-ignored");
        write_mod(
            &repo,
            "a",
            manifest(
                "a",
                json!({ "loadAfter": ["ghost"], "loadBefore": ["also-ghost"] }),
            ),
            Some("// a"),
        );
        let runtime = runtime_for("plan-ignored");
        // 顺序文件里留一条已经删掉的目录名：以前静默忽略，现在要报出来
        set_mod_order(&runtime, &["gone-forever".to_string(), "a".to_string()]);

        let plan = plan_loaders(&repo, &runtime);
        let ignored = plan["ignored"].as_array().unwrap();
        let fields: Vec<&str> = ignored
            .iter()
            .map(|item| item["field"].as_str().unwrap())
            .collect();
        assert!(fields.contains(&"loadAfter"), "{ignored:?}");
        assert!(fields.contains(&"loadBefore"), "{ignored:?}");
        assert!(fields.contains(&"order"), "{ignored:?}");
        let stale = ignored
            .iter()
            .find(|item| item["field"] == json!("order"))
            .unwrap();
        assert_eq!(stale["target"], json!("gone-forever"));
        // 目标不在已启用模组里 ⇒ 声明本次不生效，但模组本身照常加载
        assert_eq!(plan["skipped"].as_array().unwrap().len(), 0);
        assert_eq!(plan["order"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn plan_falls_back_to_directory_order_on_cycle() {
        let repo = repo_for("plan-cycle");
        write_mod(
            &repo,
            "a",
            manifest("a", json!({ "loadAfter": ["b"] })),
            Some("// a"),
        );
        write_mod(
            &repo,
            "b",
            manifest("b", json!({ "loadAfter": ["a"] })),
            Some("// b"),
        );
        let runtime = runtime_for("plan-cycle");
        let plan = plan_loaders(&repo, &runtime);
        let paths: Vec<String> = plan["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        // 成环 → 退回扫描顺序（按显示名 a, b）
        assert!(paths[0].ends_with("a/loader.js"), "{paths:?}");
        assert!(paths[1].ends_with("b/loader.js"), "{paths:?}");
    }

    #[test]
    fn plan_skips_broken_and_tampered_mods() {
        let repo = repo_for("plan-skip");
        // 缺依赖
        write_mod(
            &repo,
            "needy",
            manifest("needy", json!({ "requires": ["ghost"] })),
            Some("// needy"),
        );
        // 清单非法
        write_mod(
            &repo,
            "broken",
            json!({ "schemaVersion": 1 }),
            Some("// broken"),
        );
        // 被篡改的签名：先签再改 version
        let key = crate::mods::sign::generate_signing_key().expect("应能生成密钥");
        let key_id = crate::mods::sign::key_id_of(&key);
        let public_key = crate::mods::sign::public_key_base64(&key);
        let signed = manifest(
            "signed",
            json!({
                "author": { "id": "au-test", "name": "测试", "keyId": key_id.clone(), "publicKey": public_key }
            }),
        );
        let sig = crate::mods::sign::sign_manifest(&signed, &key);
        let mut tampered = signed.clone();
        tampered["version"] = json!("9.9.9");
        tampered["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id,
            "sig": sig,
            "signedAt": "2026-09-25T00:00:00.000Z"
        });
        write_mod(&repo, "tampered", tampered, Some("// tampered"));
        // 正常模组
        write_mod(&repo, "good", manifest("good", json!({})), Some("// good"));

        let runtime = runtime_for("plan-skip");
        let plan = plan_loaders(&repo, &runtime);
        let paths: Vec<String> = plan["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths.len(), 1, "只有 good 能被注入：{paths:?}");
        assert!(paths[0].ends_with("good/loader.js"));

        let skipped = plan["skipped"].as_array().unwrap();
        let reasons: String = skipped
            .iter()
            .map(|item| item["reason"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(reasons.contains("缺少依赖: ghost"), "{reasons}");
        assert!(reasons.contains("清单校验失败"), "{reasons}");
        assert!(reasons.contains("签名校验失败"), "{reasons}");
    }

    #[test]
    fn disabled_loader_is_not_planned() {
        let repo = repo_for("plan-disabled");
        write_mod(&repo, "off", manifest("off", json!({})), None);
        let dir = repo.join("mods").join("off");
        fs::write(dir.join(scan::LOADER_DISABLED), "// off").unwrap();
        let runtime = runtime_for("plan-disabled");
        let plan = plan_loaders(&repo, &runtime);
        assert!(plan["paths"].as_array().unwrap().is_empty());

        // 启用后就能进计划
        let enabled = set_mod_enabled(&repo, "off", true, &runtime);
        assert_eq!(enabled["ok"], json!(true));
        assert_eq!(enabled["mod"]["enabled"], json!(true));
        assert!(dir.join(scan::LOADER_ENABLED).is_file());
        assert!(!dir.join(scan::LOADER_DISABLED).exists());
        assert_eq!(
            plan_loaders(&repo, &runtime)["paths"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // 再禁用回来
        let disabled = set_mod_enabled(&repo, "off", false, &runtime);
        assert_eq!(disabled["ok"], json!(true));
        assert!(dir.join(scan::LOADER_DISABLED).is_file());

        // 目录里同时有 loader.js.disabled 时拒绝禁用（现役版同款保护）
        fs::write(dir.join(scan::LOADER_ENABLED), "// again").unwrap();
        let conflict = set_mod_enabled(&repo, "off", false, &runtime);
        assert_eq!(conflict["ok"], json!(false));
        assert!(conflict["reason"].as_str().unwrap().contains("已存在"));
    }

    #[test]
    fn set_enabled_rejects_bad_folder_and_non_loader() {
        let repo = repo_for("plan-guard");
        write_mod(
            &repo,
            "settingsy",
            manifest("settingsy", json!({ "kind": "settings" })),
            None,
        );
        let runtime = runtime_for("plan-guard");
        for folder in ["", "..", "a/b", "a\\b"] {
            let result = set_mod_enabled(&repo, folder, true, &runtime);
            assert_eq!(result["ok"], json!(false), "{folder} 应被拒");
        }
        let wrong_kind = set_mod_enabled(&repo, "settingsy", true, &runtime);
        assert_eq!(wrong_kind["ok"], json!(false));
        assert!(wrong_kind["reason"]
            .as_str()
            .unwrap()
            .contains("M1 目前只支持"));
    }

    #[test]
    fn create_folder_and_readme_helpers() {
        let repo = repo_for("plan-folder");
        let created = create_mods_folder(&repo);
        assert_eq!(created["ok"], json!(true));
        assert!(repo.join("mods").is_dir());

        // 目录在但没有 README
        write_mod(&repo, "readme", manifest("readme", json!({})), Some("// x"));
        let missing = read_mod_readme(&repo, "readme");
        assert_eq!(missing["ok"], json!(false));
        assert!(missing["reason"].as_str().unwrap().contains("README"));

        fs::write(
            repo.join("mods").join("readme").join("readme.md"),
            "\u{feff}# 标题\n正文",
        )
        .unwrap();
        let found = read_mod_readme(&repo, "readme");
        assert_eq!(found["ok"], json!(true));
        assert_eq!(found["text"], json!("# 标题\n正文"));
        // Windows 文件系统大小写不敏感：候选名里的 README.md 就会命中实际文件，现役版同此行为
        assert!(found["path"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase()
            .ends_with("readme.md"));

        // 不存在的目录
        assert_eq!(
            read_mod_readme(&repo, "nope")["reason"],
            json!("目录不存在")
        );
        // 路径穿越参数被安全化（不会跑出 mods/）
        let evil = read_mod_readme(&repo, "..\\..\\windows");
        assert!(evil["path"].as_str().unwrap().contains("mods"));
    }

    #[test]
    fn uninstall_moves_mod_to_recycle_bin() {
        let repo = repo_for("plan-uninstall");
        write_mod(
            &repo,
            "victim",
            manifest("victim", json!({})),
            Some("// victim"),
        );
        let result = uninstall_mod(&repo, "victim");
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["trashed"], json!(true), "应当走回收站：{result}");
        assert!(!repo.join("mods").join("victim").exists());

        for folder in ["", "..", "a/b"] {
            let bad = uninstall_mod(&repo, folder);
            assert_eq!(bad["ok"], json!(false));
        }
        let gone = uninstall_mod(&repo, "not-there");
        assert!(gone["reason"].as_str().unwrap().contains("目录不存在"));
    }

    #[test]
    fn order_file_accepts_both_shapes() {
        let runtime = runtime_for("plan-orderfile");
        assert!(read_mod_order(&runtime).is_empty());
        assert_eq!(
            set_mod_order(
                &runtime,
                &["a".to_string(), " b ".to_string(), String::new()]
            )["ok"],
            json!(true)
        );
        assert_eq!(
            read_mod_order(&runtime),
            vec!["a".to_string(), "b".to_string()]
        );

        // 老格式：裸数组也认
        let file = mod_order_path(&runtime);
        fs::write(&file, "[\"x\", \"y\"]").unwrap();
        assert_eq!(
            read_mod_order(&runtime),
            vec!["x".to_string(), "y".to_string()]
        );
        fs::write(&file, "not json").unwrap();
        assert!(read_mod_order(&runtime).is_empty());
    }

    #[test]
    fn sign_folder_attaches_author_and_verifies() {
        let repo = repo_for("plan-sign");
        let runtime = runtime_for("plan-sign");
        write_mod(&repo, "mine", manifest("mine", json!({})), Some("// mine"));

        // 先建本机身份（等价现役版先在「作者身份」里建好）
        let state = author::get_state(&runtime);
        assert_eq!(state["ok"], json!(true));
        let key_id = state["author"]["keyId"].as_str().unwrap().to_string();

        let result = sign_mod_folder(&repo, "mine", &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["attachedAuthor"], json!(true));
        assert_eq!(result["keyId"], json!(key_id));

        // 签名后：清单里有 author 块 + signature，且自校验为 valid（作者公钥随之注入信任表）
        let manifest_path = repo.join("mods").join("mine").join(MANIFEST_NAME);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(written["signature"]["alg"], json!("ed25519"));
        assert_eq!(written["signature"]["keyId"], json!(key_id));
        assert_eq!(written["author"]["keyId"], json!(key_id));
        assert!(written["author"]["publicKey"].as_str().unwrap().len() > 20);

        let record = scan::read_mod_dir("mine", &repo.join("mods").join("mine"));
        assert_eq!(
            record.signature_state, "valid",
            "{}",
            record.signature_error
        );
        assert!(record.signature_trusted);
        assert!(record.valid);
        assert_eq!(record.author_id, state["author"]["id"]);

        // 再签一次不报错（幂等：会去掉旧 signature 重签）
        assert_eq!(sign_mod_folder(&repo, "mine", &runtime)["ok"], json!(true));
    }

    #[test]
    fn sign_folder_refuses_other_authors() {
        let repo = repo_for("plan-sign-other");
        let runtime = runtime_for("plan-sign-other");
        author::get_state(&runtime);
        write_mod(
            &repo,
            "other",
            manifest(
                "other",
                json!({ "author": { "id": "au-someone-else", "name": "别人" } }),
            ),
            Some("// other"),
        );
        let result = sign_mod_folder(&repo, "other", &runtime);
        assert_eq!(result["ok"], json!(false));
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("不能替别人签名"));

        // 目录名非法 / 清单缺失
        assert!(sign_mod_folder(&repo, "..", &runtime)["reason"]
            .as_str()
            .unwrap()
            .contains("非法"));
        assert!(sign_mod_folder(&repo, "nothere", &runtime)["reason"]
            .as_str()
            .unwrap()
            .contains("找不到"));
    }

    /// 重装系统丢了私钥之后的正路：认领过的模组允许用**新身份**重签，
    /// 署名整块换成本机身份（旧公钥对应的私钥已经不可能再有了）。
    #[test]
    fn sign_folder_allows_a_claimed_mod_and_swaps_the_author_block() {
        let repo = repo_for("plan-sign-claimed");
        let runtime = runtime_for("plan-sign-claimed");
        let state = author::get_state(&runtime);
        let me_id = state["author"]["id"].as_str().unwrap().to_string();
        let me_key = state["author"]["keyId"].as_str().unwrap().to_string();
        write_mod(
            &repo,
            "old",
            manifest(
                "old",
                json!({ "author": { "id": "au-old-id", "name": "旧署名", "keyId": "oldkeyid12", "publicKey": "AAAA" } }),
            ),
            Some("// old"),
        );
        // 没认领之前：照旧拒绝（归属保护不能被绕过）
        let refused = sign_mod_folder(&repo, "old", &runtime);
        assert_eq!(refused["ok"], json!(false), "{refused}");
        assert!(refused["reason"].as_str().unwrap().contains("找回旧模组"));

        // 认领之后：放行，并把署名换成本机身份
        claim::record_claim(
            &runtime,
            "old",
            "au-old-id",
            "oldkeyid12",
            "https://github.com/me/evejs-mod-old",
            "me",
            "owner",
        )
        .expect("应能落认领记录");
        let result = sign_mod_folder(&repo, "old", &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["reclaimed"], json!(true));
        assert_eq!(result["previousAuthorId"], json!("au-old-id"));
        // 不是「新挂上作者块」而是「换掉别人的」——两者界面提示不一样
        assert_eq!(result["attachedAuthor"], json!(false));

        let manifest_path = repo.join("mods").join("old").join(MANIFEST_NAME);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(written["author"]["id"], json!(me_id));
        assert_eq!(written["author"]["keyId"], json!(me_key));
        assert_eq!(written["author"]["name"], state["author"]["name"]);
        assert_eq!(written["signature"]["keyId"], json!(me_key));
        // 换完署名还要签得对：否则模组一进游戏就被判「被篡改」
        let record = scan::read_mod_dir("old", &repo.join("mods").join("old"));
        assert_eq!(
            record.signature_state, "valid",
            "{}",
            record.signature_error
        );
        assert!(record.valid);
    }

    #[test]
    fn uninstall_ignores_market_marker_file() {
        // 顺带覆盖：市场安装标记跟着目录一起被卸载，不留残留
        let repo = repo_for("plan-marker");
        write_mod(
            &repo,
            "frommarket",
            manifest("frommarket", json!({})),
            Some("// x"),
        );
        fs::write(
            repo.join("mods").join("frommarket").join(MOD_SOURCE_FILE),
            json!({ "source": "market" }).to_string(),
        )
        .unwrap();
        assert_eq!(uninstall_mod(&repo, "frommarket")["ok"], json!(true));
        assert!(!repo.join("mods").join("frommarket").exists());
    }
}
