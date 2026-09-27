//! 老（Electron）启动器数据接管：让老用户换到新框架后不用重置作者身份 key 与 GitHub 令牌。
//!
//! 背景：老用户本机已经攒下了三样东西，迁移时最怕丢：
//!   1. 作者身份 `author.json`（含 id / keyId / publicKey / privateKeyPath）；
//!   2. 私钥 `mod-keys/<keyId>.key`（老版写明文 PEM，新版能读）；
//!   3. GitHub 令牌 `github-token.bin`（DPAPI 密文字节，老版由 safeStorage 写）。
//!
//! 新旧两版的运行时路径语义逐行对齐（见 `runtime.rs`），所以**把新启动器解压进老启动器目录**时
//! 两边天然共用 `_launcher/data`，什么都不用做。本模块负责另一种情况：新启动器被放到别处，
//! 本机 `_launcher/data` 还是空的 —— 这时从老启动器的数据目录**首次接管**一份过来。
//!
//! 规则（宁可少做，也不要错认）：
//!   - 只在目标文件不存在时接管，绝不覆盖本机已有数据；
//!   - 候选目录必须真的存在，且 `author.json` 必须是带非空 `id` 的合法 JSON；
//!   - `EVEJS_USER_DATA_DIR` 生效（测试 / 隔离模式）时完全不接管 —— 那条路径是显式指定的；
//!   - 令牌是 Electron safeStorage 密文（Chromium OSCrypt），它依赖的 AES 密钥在隔壁
//!     `cache/Local State` 里。所以搬令牌时必须**连密钥一起搬**，否则搬过去的是一坨解不开的字节。
//!     密钥用 DPAPI 解出来后再用 DPAPI 包一层，存进 `data/os-crypt-key.bin`（见 `oscrypt.rs`）。
//!   - 一处老目录里接管到东西就停手，不把两台不同安装的身份混在一起。
use crate::author::{AUTHOR_FILE, KEY_DIR};
use crate::github::TOKEN_FILE;
use crate::runtime::RuntimePaths;
use crate::secrets::CREDENTIALS_KEY;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SETTINGS_FILE: &str = "launcher-settings.json";
const STATE_FILE: &str = "legacy-adoption.json";
const DATA_DIR: &str = "data";
const LAUNCHER_DIR: &str = "_launcher";

/// 一次启动里做了什么接管（空 items = 什么都没做）
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Adoption {
    /// 接管过来的条目（相对 `_launcher/data` 的路径，给人看）
    pub items: Vec<String>,
    /// 来源数据目录
    pub source: Option<String>,
    /// 没接管的原因（给设置页 / 诊断看，正常情况是空的）
    pub skipped: String,
}

impl Adoption {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "adopted": !self.is_empty(),
            "items": self.items,
            "source": self.source,
            "skipped": self.skipped,
        })
    }
}

/// exe 所在目录（拿不到就 None）
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 候选：本机上「老启动器会写数据的地方」。
///
/// 老版安装形态：`<repo>/launcher/launcher/`（源码目录，开发态与绿色版都在这），
/// 其下 `_launcher/data`；打包出来的解包版另有一份 `release/win-unpacked/_launcher/data`。
fn candidates(repo_root: &Path, own: &Path) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if dir != *own && !list.contains(&dir) {
            list.push(dir);
        }
    };
    let inline = repo_root.join("launcher").join("launcher");
    push(inline.join(LAUNCHER_DIR).join(DATA_DIR));
    push(
        inline
            .join("release")
            .join("win-unpacked")
            .join(LAUNCHER_DIR)
            .join(DATA_DIR),
    );
    push(repo_root.join("launcher").join(LAUNCHER_DIR).join(DATA_DIR));
    push(repo_root.join(LAUNCHER_DIR).join(DATA_DIR));
    if let Some(dir) = exe_dir() {
        push(dir.join(LAUNCHER_DIR).join(DATA_DIR));
    }
    if let Ok(cwd) = std::env::current_dir() {
        push(cwd.join(LAUNCHER_DIR).join(DATA_DIR));
    }
    list.retain(|dir| dir.is_dir());
    list
}

/// 合法的老身份文件：必须是带非空 `id` 的 JSON 对象
fn read_author(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let id = value.get("id")?.as_str()?;
    if id.trim().is_empty() {
        return None;
    }
    Some(value)
}

fn read_credentials(settings_file: &Path) -> Option<Map<String, Value>> {
    let text = fs::read_to_string(settings_file).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let map = value.get(CREDENTIALS_KEY)?.as_object()?.clone();
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

fn settings_has_credentials(settings_file: &Path) -> bool {
    read_credentials(settings_file).is_some()
}

/// 老启动器的 OSCrypt 密钥位置：`<launcher>/_launcher/cache/Local State`。
/// 注意它**不参与**「找到东西就停手」的判定 —— 老启动器只要用过 safeStorage 就会有这个文件，
/// 让它算作「接管到了东西」会提前收工，把隔壁那份身份挡在门外。
fn oscrypt_key_beside(data_dir: &Path) -> Option<[u8; crate::oscrypt::KEY_LEN]> {
    let launcher_dir = data_dir.parent()?;
    let local_state = crate::oscrypt::local_state_in(&launcher_dir.join("cache"));
    crate::oscrypt::key_from_local_state(&local_state)
}

fn copy_file(from: &Path, to: &Path) -> bool {
    if to.is_file() || !from.is_file() {
        return false;
    }
    if let Some(parent) = to.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    fs::copy(from, to).is_ok()
}

fn write_state(runtime: &RuntimePaths, adoption: &Adoption) {
    let file = runtime.user_data.join(STATE_FILE);
    if let Ok(text) = serde_json::to_string_pretty(&adoption.to_json()) {
        let _ = fs::write(file, text);
    }
}

/// 上次启动的接管结果（读不到就给空的）
pub fn last_state(runtime: &RuntimePaths) -> Value {
    fs::read_to_string(runtime.user_data.join(STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| Adoption::default().to_json())
}

/// 启动时调一次：把老启动器的身份 / 私钥 / 令牌 / 账号凭据首次接管进本机数据目录。
pub fn adopt(runtime: &RuntimePaths, repo_root: &Path) -> Adoption {
    if std::env::var_os("EVEJS_USER_DATA_DIR").is_some() {
        return Adoption {
            items: Vec::new(),
            source: None,
            skipped: "隔离模式（EVEJS_USER_DATA_DIR）：不做接管".to_string(),
        };
    }
    let own = runtime.user_data.clone();
    adopt_from(runtime, &own, candidates(repo_root, &own))
}

/// 接管主体的可注入版本：候选目录由调用方给定（单测用，避免碰进程环境变量）。
fn adopt_from(runtime: &RuntimePaths, own: &Path, cands: Vec<PathBuf>) -> Adoption {
    let want_author = !own.join(AUTHOR_FILE).is_file();
    let want_token = !own.join(TOKEN_FILE).is_file();
    let want_creds = !settings_has_credentials(&own.join(SETTINGS_FILE));
    // 顺路捡到的第一把 OSCrypt 密钥（万一接管数据的那份目录里没有密钥时兜底）
    let mut loose_key: Option<([u8; crate::oscrypt::KEY_LEN], String)> = None;
    for cand in cands {
        let mut items: Vec<String> = Vec::new();
        let cand_key = oscrypt_key_beside(&cand);
        if loose_key.is_none() {
            if let Some(key) = cand_key {
                loose_key = Some((key, cand.to_string_lossy().to_string()));
            }
        }

        if want_author {
            if let Some(profile) = read_author(&cand.join(AUTHOR_FILE)) {
                if copy_file(&cand.join(AUTHOR_FILE), &own.join(AUTHOR_FILE)) {
                    items.push(AUTHOR_FILE.to_string());
                    // 私钥路径来自 author.json（相对 data 目录），原样搬
                    if let Some(rel) = profile.get("privateKeyPath").and_then(Value::as_str) {
                        let rel_path = PathBuf::from(rel);
                        if !rel_path.is_absolute()
                            && copy_file(&cand.join(&rel_path), &own.join(&rel_path))
                        {
                            items.push(rel_path.to_string_lossy().to_string());
                        }
                    }
                    // 兜底：老目录 mod-keys 里其余的 key 也一并带上（历史 key / 多身份）
                    if let Ok(entries) = fs::read_dir(cand.join(KEY_DIR)) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            let is_key = path
                                .extension()
                                .map(|ext| ext.eq_ignore_ascii_case("key"))
                                .unwrap_or(false);
                            if !is_key {
                                continue;
                            }
                            let name = entry.file_name().to_string_lossy().to_string();
                            if copy_file(&path, &own.join(KEY_DIR).join(&name)) {
                                items.push(format!("{KEY_DIR}/{name}"));
                            }
                        }
                    }
                }
            }
        }

        if want_token {
            let from = cand.join(TOKEN_FILE);
            if copy_file(&from, &own.join(TOKEN_FILE)) {
                items.push(TOKEN_FILE.to_string());
            }
        }

        if want_creds {
            if let Some(creds) = read_credentials(&cand.join(SETTINGS_FILE)) {
                let mut patch = Map::new();
                patch.insert(CREDENTIALS_KEY.to_string(), Value::Object(creds));
                let written = crate::config::write_settings(&own.join(SETTINGS_FILE), &patch);
                if written.contains_key(CREDENTIALS_KEY) {
                    items.push(format!("{SETTINGS_FILE}:{CREDENTIALS_KEY}"));
                }
            }
        }

        if !items.is_empty() {
            // 搬了令牌 / 凭据，就必须把解它们的密钥也一起搬过来（同源的优先）
            let key = cand_key.or_else(|| loose_key.as_ref().map(|(key, _)| *key));
            if let Some(key) = key {
                if crate::oscrypt::store_key(runtime, &key) {
                    items.push(format!(
                        "cache/{}:{}",
                        crate::oscrypt::LOCAL_STATE_FILE,
                        "os_crypt.encrypted_key"
                    ));
                }
            }
            let adoption = Adoption {
                items,
                source: Some(cand.to_string_lossy().to_string()),
                skipped: String::new(),
            };
            write_state(runtime, &adoption);
            return adoption;
        }
    }

    // 一份数据条目都没接管到，但捡到了密钥：说明本机数据目录里已经有令牌 / 凭据，
    // 只是缺那把 AES 密钥 —— 也记一笔，不然那些令牌就是解不开的字节。
    if let Some((key, source)) = loose_key {
        if crate::oscrypt::store_key(runtime, &key) {
            let adoption = Adoption {
                items: vec![format!(
                    "cache/{}:{}",
                    crate::oscrypt::LOCAL_STATE_FILE,
                    "os_crypt.encrypted_key"
                )],
                source: Some(source),
                skipped: String::new(),
            };
            write_state(runtime, &adoption);
            return adoption;
        }
    }

    let adoption = Adoption {
        items: Vec::new(),
        source: None,
        skipped: "没找到老启动器的数据目录".to_string(),
    };
    write_state(runtime, &adoption);
    adoption
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-legacy-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能建临时目录");
        dir
    }

    /// 造一个「老启动器的数据目录」
    fn legacy_dir(root: &Path, key_id: &str) -> PathBuf {
        let dir = root
            .join("launcher")
            .join("launcher")
            .join(LAUNCHER_DIR)
            .join(DATA_DIR);
        fs::create_dir_all(dir.join(KEY_DIR)).unwrap();
        fs::write(
            dir.join(AUTHOR_FILE),
            serde_json::to_string_pretty(&json!({
                "id": "au-legacy000001",
                "name": "老指挥官",
                "since": 1790365600263i64,
                "keyId": key_id,
                "publicKey": "kTt/8BE4aU81RG/9sZLb+AH3m5Xf6TgNauV/oQOXE+I=",
                "privateKeyPath": format!("mod-keys\\\\{key_id}.key"),
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(KEY_DIR).join(format!("{key_id}.key")),
            "-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----\\n",
        )
        .unwrap();
        fs::write(dir.join(TOKEN_FILE), [1u8, 2, 3, 4]).unwrap();
        fs::write(
            dir.join(SETTINGS_FILE),
            json!({ "windowBounds": { "x": 1 }, "accountCredentials": { "pilot": "AAAA" } })
                .to_string(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn copies_author_key_token_and_credentials() {
        let root = temp("adopt");
        let legacy = legacy_dir(&root, "72847ce48f45");
        let own = root.join("newdata");
        fs::create_dir_all(&own).unwrap();
        let paths = RuntimePaths::from_root(own.clone(), true);

        let adoption = adopt_from(&paths, &own, vec![legacy.clone()]);
        assert_eq!(
            adoption.source.as_deref().map(PathBuf::from),
            Some(legacy.clone())
        );
        assert!(adoption.items.iter().any(|item| item == AUTHOR_FILE));
        assert!(adoption.items.iter().any(|item| item.ends_with(".key")));
        assert!(adoption.items.iter().any(|item| item == TOKEN_FILE));

        // 身份与私钥必须原样搬过来（字节级一致）
        assert_eq!(
            fs::read(own.join(AUTHOR_FILE)).unwrap(),
            fs::read(legacy.join(AUTHOR_FILE)).unwrap()
        );
        assert_eq!(
            fs::read(own.join(KEY_DIR).join("72847ce48f45.key")).unwrap(),
            fs::read(legacy.join(KEY_DIR).join("72847ce48f45.key")).unwrap()
        );
        // DPAPI 密文按字节搬，不做任何再编码
        assert_eq!(fs::read(own.join(TOKEN_FILE)).unwrap(), vec![1u8, 2, 3, 4]);
        // 账号凭据要被合并进来，原有设置不能丢
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(own.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(settings[CREDENTIALS_KEY]["pilot"], json!("AAAA"));
        assert!(
            settings.get("windowBounds").is_none(),
            "不该把老窗口几何也搬过来"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn second_run_does_not_overwrite_and_reports_skipped() {
        let root = temp("again");
        let legacy = legacy_dir(&root, "aaaaaaaaaaaa");
        let own = root.join("newdata");
        fs::create_dir_all(&own).unwrap();
        let paths = RuntimePaths::from_root(own.clone(), true);

        let first = adopt_from(&paths, &own, vec![legacy.clone()]);
        assert!(!first.is_empty());
        // 本机身份已被用户改过名字：第二次接管绝不能把它覆盖回去
        fs::write(
            own.join(AUTHOR_FILE),
            json!({ "id": "au-mine000001" }).to_string(),
        )
        .unwrap();

        let second = adopt_from(&paths, &own, vec![legacy]);
        assert!(second.is_empty(), "已有本机数据时不该再接管");
        let kept: Value =
            serde_json::from_str(&fs::read_to_string(own.join(AUTHOR_FILE)).unwrap()).unwrap();
        assert_eq!(kept["id"], json!("au-mine000001"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ignores_broken_author_json() {
        let root = temp("broken");
        let legacy = legacy_dir(&root, "bbbbbbbbbbbb");
        fs::write(legacy.join(AUTHOR_FILE), "{ not json").unwrap();
        let own = root.join("newdata");
        fs::create_dir_all(&own).unwrap();
        let paths = RuntimePaths::from_root(own.clone(), true);

        let adoption = adopt_from(&paths, &own, vec![legacy]);
        assert!(!adoption.items.iter().any(|item| item == AUTHOR_FILE));
        assert!(!own.join(AUTHOR_FILE).exists());
        // 令牌与凭据仍然要接管：它们与身份文件是否损坏无关
        assert!(own.join(TOKEN_FILE).is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn first_candidate_with_content_wins() {
        let root = temp("order");
        let first = legacy_dir(&root, "111111111111");
        let second = root.join("other").join(LAUNCHER_DIR).join(DATA_DIR);
        fs::create_dir_all(second.join(KEY_DIR)).unwrap();
        fs::write(
            second.join(AUTHOR_FILE),
            json!({ "id": "au-second000001", "privateKeyPath": "mod-keys\\2.key" }).to_string(),
        )
        .unwrap();
        let own = root.join("newdata");
        fs::create_dir_all(&own).unwrap();
        let paths = RuntimePaths::from_root(own.clone(), true);

        let adoption = adopt_from(&paths, &own, vec![first.clone(), second]);
        assert_eq!(adoption.source.as_deref().map(PathBuf::from), Some(first));
        let kept: Value =
            serde_json::from_str(&fs::read_to_string(own.join(AUTHOR_FILE)).unwrap()).unwrap();
        assert_eq!(kept["id"], json!("au-legacy000001"));

        let _ = fs::remove_dir_all(&root);
    }
}
