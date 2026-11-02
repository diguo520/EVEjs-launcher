//! 模组源码「抠取结果」的按文件记忆化（2026-11-02 提速）。
//!
//! 背景：静态预检每次都要把每个启用模组的源码读一遍（单文件 ≤3 MiB，单趟最多 64 MiB），
//! 从里面抠出「目标路径 / 基线指纹 / 注入标记」。在一台装了 15 个模组的机器上实测：
//! **读扫 32.8 MB 要 2.6 s**，而 `mods:preflight` 在每次面板加载、每次开关模组之后都会跑。
//!
//! 抠取是**纯函数**（bytes → 三个集合），且绝大多数文件不会因为「开关某个模组」而变化 ——
//! 开关只动那个模组自己的 loader 文件名。所以按 `(路径, 体积, mtime)` 把结果记下来即可：
//! 第二次起整趟从秒级降到百毫秒级，而报告内容逐字段不变。
//!
//! 失效口径与既有的 `mod-stats.json` 同一套：**只看体积 + mtime**，不做内容哈希
//! （保守：文件只要被写过就重算；唯一不保守的地方是「同一秒内改文件且体积不变」，
//! 与仓库既有的体积缓存口径一致，最多滞后一轮）。
//!
//! 落在 `_launcher/cache/mod-claims.json`：属于「清空缓存」能删的那一类（见 danger.rs 白名单）。
use crate::runtime::RuntimePaths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 缓存文件名（`_launcher/cache/` 下）
const CLAIMS_CACHE_FILE: &str = "mod-claims.json";
/// 格式版本：解析出来不是这个版本就整份丢掉重算（改结构时记得 +1）
const CACHE_VERSION: u32 = 1;

fn cache_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.cache.join(CLAIMS_CACHE_FILE)
}

/// 文件的「体积 + mtime（毫秒）」：缓存唯一的失效判据
pub fn file_stamp(meta: &fs::Metadata) -> (u64, u64) {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    (meta.len(), mtime_ms)
}

/// 一个源码文件的抠取结果（纯数据，可直接落盘）
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileClaims {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub hashes: Vec<String>,
    #[serde(default)]
    pub markers: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ClaimEntry {
    size: u64,
    mtime_ms: u64,
    claims: FileClaims,
}

#[derive(Clone, Serialize, Deserialize)]
struct PrintEntry {
    size: u64,
    mtime_ms: u64,
    prints: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct ModScanCache {
    #[serde(default)]
    version: u32,
    /// { 模组目录名: { 模组内相对路径（`/` 分隔）: 抠取结果 } }
    #[serde(default)]
    claims: BTreeMap<String, BTreeMap<String, ClaimEntry>>,
    /// { 服务端文件绝对路径: 指纹集 }
    #[serde(default)]
    fingerprints: BTreeMap<String, PrintEntry>,
    #[serde(skip)]
    dirty: bool,
}

impl ModScanCache {
    /// 读缓存；读不到 / 版本不符 / 解析失败一律当空缓存（预检照常出报告，只是慢一轮）
    pub fn load(runtime: &RuntimePaths) -> Self {
        let parsed = fs::read_to_string(cache_path(runtime))
            .ok()
            .and_then(|raw| serde_json::from_str::<Self>(raw.trim_start_matches('\u{feff}')).ok());
        match parsed {
            Some(cache) if cache.version == CACHE_VERSION => cache,
            _ => Self {
                version: CACHE_VERSION,
                ..Self::default()
            },
        }
    }

    /// 只在真的有变化时写盘；写不进去也静默（缓存不是数据）
    pub fn save(&self, runtime: &RuntimePaths) {
        if !self.dirty {
            return;
        }
        let path = cache_path(runtime);
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(self) {
            let _ = fs::write(path, text);
        }
    }

    /// 抠取一个源码文件：命中 `(路径, 体积, mtime)` 就复用，否则现算并回填。
    ///
    /// `extract` 回 `None` 表示「这次读不到」——那种情况**不写缓存、也不算这一轮的字节预算**，
    /// 与旧实现「读失败就跳过」一致（下一次照旧会尝试读）。
    /// 返回 `None` 同上；`Some` 表示这一轮的预算已经记在它头上了。
    pub fn claims_for(
        &mut self,
        folder: &str,
        rel: &str,
        size: u64,
        mtime_ms: u64,
        extract: impl FnOnce() -> Option<FileClaims>,
    ) -> Option<FileClaims> {
        if let Some(hit) = self.claims.get(folder).and_then(|files| files.get(rel)) {
            if hit.size == size && hit.mtime_ms == mtime_ms {
                return Some(hit.claims.clone());
            }
        }
        let claims = extract()?;
        self.claims.entry(folder.to_string()).or_default().insert(
            rel.to_string(),
            ClaimEntry {
                size,
                mtime_ms,
                claims: claims.clone(),
            },
        );
        self.dirty = true;
        Some(claims)
    }

    /// 同上，给「服务端文件指纹」用（读整份 + 3 次 sha256，比抠取更贵）
    pub fn fingerprints_for(
        &mut self,
        abs: &Path,
        size: u64,
        mtime_ms: u64,
        extract: impl FnOnce() -> Option<Vec<String>>,
    ) -> Option<Vec<String>> {
        let key = abs.to_string_lossy().to_string();
        if let Some(hit) = self.fingerprints.get(&key) {
            if hit.size == size && hit.mtime_ms == mtime_ms {
                return Some(hit.prints.clone());
            }
        }
        let prints = extract()?;
        self.fingerprints.insert(
            key,
            PrintEntry {
                size,
                mtime_ms,
                prints: prints.clone(),
            },
        );
        self.dirty = true;
        Some(prints)
    }

    /// 丢掉「模组目录已经不在」「服务端文件已经不在」的条目。
    ///
    /// 只做这一层：模组目录内部被删掉的文件条目会留到下次那个目录本身被删 —— 那点残留最多几 KB，
    /// 而逐条 stat 一遍会把省下来的时间又花回去。
    pub fn prune(&mut self, mods_root: &Path) {
        let before = self.claims.len() + self.fingerprints.len();
        self.claims
            .retain(|folder, _| mods_root.join(folder).is_dir());
        self.fingerprints
            .retain(|path, _| Path::new(path).is_file());
        if self.claims.len() + self.fingerprints.len() != before {
            self.dirty = true;
        }
    }

    /// 仅供测试：条目数（抠取结果条数, 指纹条数）
    #[cfg(test)]
    pub fn entry_count(&self) -> (usize, usize) {
        (
            self.claims.values().map(|files| files.len()).sum(),
            self.fingerprints.len(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_for(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-scan-cache-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        RuntimePaths::from_root(dir, true)
    }

    #[test]
    fn hits_the_cache_until_the_file_stamp_changes() {
        let runtime = runtime_for("hit");
        let dir = std::env::temp_dir().join("evejs-scan-cache-src");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("patch.js");
        fs::write(&file, r#"const P = "src/a/b.js";"#).unwrap();
        let meta = fs::metadata(&file).unwrap();
        let (size, mtime) = file_stamp(&meta);

        let mut cache = ModScanCache::load(&runtime);
        let mut calls = 0;
        let first = cache
            .claims_for("demo", "patch.js", size, mtime, || {
                calls += 1;
                Some(FileClaims {
                    paths: vec!["src/a/b.js".to_string()],
                    ..FileClaims::default()
                })
            })
            .unwrap();
        assert_eq!(calls, 1, "第一次应现算");
        assert_eq!(first.paths, vec!["src/a/b.js".to_string()]);

        let second = cache
            .claims_for("demo", "patch.js", size, mtime, || {
                calls += 1;
                None
            })
            .unwrap();
        assert_eq!(calls, 1, "同一 (体积, mtime) 不该再算");
        assert_eq!(second, first);

        fs::write(&file, r#"const P = "src/a/b.js"; const Q = "src/c/d.js";"#).unwrap();
        let meta = fs::metadata(&file).unwrap();
        let (size2, mtime2) = file_stamp(&meta);
        assert!((size2, mtime2) != (size, mtime));
        let third = cache
            .claims_for("demo", "patch.js", size2, mtime2, || {
                calls += 1;
                Some(FileClaims {
                    paths: vec!["src/a/b.js".to_string(), "src/c/d.js".to_string()],
                    ..FileClaims::default()
                })
            })
            .unwrap();
        assert_eq!(calls, 2, "文件变了就该重算");
        assert_eq!(third.paths.len(), 2);

        assert!(cache.claims_for("gone", "x.js", 1, 1, || None).is_none());
        assert_eq!(cache.entry_count().0, 1, "只有真算出来的那条进缓存");

        cache.save(&runtime);
        let reloaded = ModScanCache::load(&runtime);
        assert_eq!(reloaded.entry_count().0, 1, "落盘后能读回来");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn prune_drops_entries_whose_mod_dir_is_gone() {
        let mut cache = ModScanCache::default();
        cache.claims.insert(
            "keep".to_string(),
            BTreeMap::from([(
                "a.js".to_string(),
                ClaimEntry {
                    size: 1,
                    mtime_ms: 1,
                    claims: FileClaims::default(),
                },
            )]),
        );
        cache.claims.insert("gone".to_string(), BTreeMap::new());
        let mods = std::env::temp_dir().join("evejs-scan-cache-mods");
        let _ = fs::remove_dir_all(&mods);
        fs::create_dir_all(mods.join("keep")).unwrap();
        cache.prune(&mods);
        assert_eq!(cache.claims.len(), 1);
        assert!(cache.claims.contains_key("keep"));
        let _ = fs::remove_dir_all(&mods);
    }
}
