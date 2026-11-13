//! 模组启动前预检（本工程扩展通道 `mods:preflight`）。
//!
//! 回答「不启动服务端也能回答」的问题（用户 2026-10-04 报障的原始诉求：
//! 「不启动一次是不是就不能提前告知哪些 MOD 有冲突 / 会导致服务起不来」）：
//!
//!   1. **哪些目录被静默忽略**：`mods/<目录>/evejs-launcher.mod.json` 不存在时
//!      `scan_mods` 会整目录跳过 —— 界面上既不报错也不出现。清单被多套了一层
//!      子目录（`mods/冬眠者流浪者舰船操作模组1.5.0/evejs-sleeper-drifters/...`）
//!      是最常见的一种，用户看到的是「我明明放了模组，启动器当没看见」。
//!   2. **哪些模组改同一份服务端源码**：重复引用不等于冲突（方案 D 的注入总线就是
//!      为共存做的），但两个模组都按「整份文件 sha256」校验基线时，后手会静默放弃。
//!      所以顺带把「模组自己声明的基线指纹」与「当前服务端文件」比一遍：
//!      对不上 = 这个模组多半会跳过这份文件（不报错、也不生效）。
//!
//! 还有一件只有真跑才知道的：**loader 在加载期就抛错**。`NODE_OPTIONS` 里 `--require`
//! 的模块抛错会让 node 直接退出，也就是「服务端起不来」。`dry_run()` 把同一批 loader
//! 放进一个一次性 Node 进程里 require 一遍（不绑端口、不连客户端、不建世界库），
//! 顺带量出「加载这批模组花了多少毫秒」。
//!
//! 边界与取舍（写进契约 `why` 里，别当已知差异）：
//!   - 干跑会**真的执行**模组的加载期代码（模组可能在 require 时读写自己的目录）；
//!     实测这批模组是只读的，但这不是保证，所以只在用户点「运行预检」时才跑；
//!   - 干跑报告只覆盖「加载期」，运行期补丁是否命中要真启动才知道 —— 界面文案必须
//!     说成「静态推测」，不能承诺「一定没问题」。
use crate::mods::pkg;
use crate::mods::plan;
use crate::mods::safe_folder_name;
use crate::mods::scan::{
    self, LOADER_DISABLED, LOADER_DISABLED_ALT, LOADER_ENABLED, MANIFEST_NAME,
};
use crate::mods::scan_cache::{self, FileClaims, ModScanCache};
use crate::runtime::RuntimePaths;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// 扫描模组源码时跳过的目录名：体积大、且不可能含服务端补丁路径
const SKIP_DIRS: [&str; 6] = [
    "node_modules",
    "client-data",
    "server-data",
    "ResFiles",
    ".git",
    "dist",
];
/// 单个源文件超过这个大小就不读（补丁脚本到不了 3 MiB）
const MAX_SOURCE_BYTES: u64 = 3 * 1024 * 1024;
/// 一次预检最多读进来的总字节数：几百 MiB 的模组不能把预检拖成几十秒
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// 单次上报的「被引用的服务端文件」上限
const MAX_TARGETS: usize = 64;
/// 注入标记（`// xxx:patch` 这类字符串字面量）的最大长度：再长就不像是标记了
const MAX_MARKER_BYTES: usize = 160;
/// 单次上报的「注入标记冲突」上限
const MAX_MARKER_ROWS: usize = 32;
/// 干跑超时：模组多、磁盘慢时留足余量（服务端本身启动也就几十秒）
const DRY_RUN_TIMEOUT_SECS: u64 = 180;
/// 干跑输出保留的尾部行数
const MAX_OUTPUT_LINES: usize = 60;
/// 干跑落盘目录（`_launcher/temp` 下），与真启动用的 `_launcher/mods/mod-plan.json` 分开
const PREFLIGHT_DIR: &str = "mod-preflight";
// 注入总线正文复用 `process.rs` 的那一份（单一来源，查重门禁盯着）；
// 路径已写进 `mod-host.js` 的注释里，这里只引用不复制。

/* ------------------------------ 源码抠取 ------------------------------ */

/// 路径字面量里允许的字符（含 `/`，这正是以前漏检带路径目标的原因）
fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'/')
}

fn is_hex_byte(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// JS 正则里 \b 的口径：字母 / 数字 / 下划线都算词内字符
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// 抠出形如 `[任意前缀/]src/xxx/yyy.js` 的相对路径，统一成 `src/...`。
///
/// 模组里两种写法都有：`server/src/network/tcp/handshake.js`（总线 target）
/// 与 `src/network/tcp/handshake.js`（相对服务端目录）。都从 `src/` 起算。
fn extract_paths(source: &[u8]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut index = 0usize;
    while index + 4 <= source.len() {
        if &source[index..index + 4] != b"src/" {
            index += 1;
            continue;
        }
        let mut end = index + 4;
        while end < source.len() && is_ident_byte(source[end]) {
            end += 1;
        }
        let token = &source[index..end];
        if token.len() >= 8 && token.ends_with(b".js") {
            if let Ok(text) = std::str::from_utf8(token) {
                out.insert(text.to_string());
            }
        }
        index = if end > index { end } else { index + 1 };
    }
    out
}

/// 抠出 64 位十六进制串（模组声明的 sha256 基线指纹）
fn extract_hashes(source: &[u8]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut index = 0usize;
    while index + 64 <= source.len() {
        if !is_hex_byte(source[index]) || (index > 0 && is_word_byte(source[index - 1])) {
            index += 1;
            continue;
        }
        let mut end = index;
        while end < source.len() && is_hex_byte(source[end]) {
            end += 1;
        }
        if end - index == 64 && (end >= source.len() || !is_word_byte(source[end])) {
            if let Ok(text) = std::str::from_utf8(&source[index..end]) {
                out.insert(text.to_string());
            }
        }
        index = if end > index { end } else { index + 1 };
    }
    out
}

/// 抠出模组声明的「注入标记」：形如 `"// xxx:patch"` 的字符串字面量。
///
/// 新机制里 `SOURCE_PATCH.marker` 就是这个形状（骨架默认 `// <模组 id>:patch`），
/// 而总线的去重判断正是「当前源码里有没有这串标记」—— 两个模组撞同一个标记时，
/// 后注册的那个会被**静默跳过**。所以「同一份文件 + 同一个标记」是真冲突，
/// 必须与「只是改同一份文件」（总线按 slot 依次串链，能共存）分开报。
///
/// 只认 `//` 开头的短字面量，且左边不能是词内字符（`x+"//y"` 这种拼接不算一条独立声明）。
fn extract_markers(source: &[u8]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut index = 0usize;
    while index < source.len() {
        let quote = source[index];
        if quote != b'"' && quote != b'\'' && quote != b'`' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < source.len() && source[end] != quote && source[end] != b'\n' {
            if source[end] == b'\\' {
                end += 1;
            }
            end += 1;
        }
        if end < source.len() && source[end] == quote {
            let slice = &source[start..end];
            let boundary = index == 0 || !is_word_byte(source[index - 1]);
            if boundary && slice.starts_with(b"//") && slice.len() <= MAX_MARKER_BYTES {
                if let Ok(text) = std::str::from_utf8(slice) {
                    if !text.chars().any(|ch| (ch as u32) < 0x20) {
                        out.insert(text.to_string());
                    }
                }
            }
        }
        index = if end > index { end + 1 } else { index + 1 };
    }
    out
}

/// 遍历模组目录下的文本文件；`budget` 是共享的总字节预算
/// 访问一个源码文件之后告诉遍历器：这几步怎么继续
#[derive(PartialEq, Eq)]
enum SourceVisit {
    /// 这些字节这一轮已经算过账（扣过预算），可以接着看下一个
    Consumed,
    /// 这个文件读不到 / 装不进预算：不扣预算，接着看下一个
    Skipped,
    /// 预算用完：立刻收手，别再走剩下的目录了
    Stop,
}

/// 遍历模组源码目录：只看「可能是补丁脚本」的文本文件（跳过 6 类大目录、单文件 ≤3 MiB），
/// 把「模组内相对路径 + 绝对路径 + 体积 + mtime」交给调用方 —— 由它决定读盘还是命中缓存
/// （见 `scan_cache.rs`）。返回 `true` 表示遍历已收手（预算用完）。
fn walk_source_files(
    dir: &Path,
    root: &Path,
    visit: &mut impl FnMut(&str, &Path, u64, u64) -> SourceVisit,
) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if walk_source_files(&entry.path(), root, visit) {
                return true;
            }
            continue;
        }
        if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let (size, mtime_ms) = scan_cache::file_stamp(&meta);
        if visit(&relative, &entry.path(), size, mtime_ms) == SourceVisit::Stop {
            return true;
        }
    }
    false
}

/// 一个模组对服务端源码的主张：声明了哪些文件、每份文件上的基线指纹与注入标记。
///
/// 归属口径：**同一个文件里**同时出现目标路径与指纹（或标记）时才算「为它声明」
/// （补丁脚本就是这个形状：`RELATIVE_PATH` 与 `BASELINES` / `MARKER` 挨在一起）。
/// 取并集而不是按窗口切分，宁可漏报也不误报 —— 误报会让用户去改本来好好的模组。
#[derive(Default)]
struct ModClaims {
    /// { 服务端相对路径: 该模组为它声明的 sha256 基线指纹 }
    fingerprints: BTreeMap<String, BTreeSet<String>>,
    /// { 服务端相对路径: 该模组为它声明的注入标记 }
    markers: BTreeMap<String, BTreeSet<String>>,
}

/// 一次遍历同时抠出两样东西：分两遍扫会把 64 MiB 的字节预算算两遍，也会慢一倍。
fn mod_claims(dir: &Path, folder: &str, budget: &mut u64, cache: &mut ModScanCache) -> ModClaims {
    let mut collected: Vec<FileClaims> = Vec::new();
    walk_source_files(dir, dir, &mut |relative, abs, size, mtime_ms| {
        if *budget == 0 {
            return SourceVisit::Stop;
        }
        // 装不进这一轮的字节预算：与旧实现一致，跳过且不记账
        if size > *budget {
            return SourceVisit::Skipped;
        }
        let claims = cache.claims_for(folder, relative, size, mtime_ms, || {
            let bytes = fs::read(abs).ok()?;
            // 非 UTF-8 的源码不抠取（但它确实被读了，所以照旧记账 + 进缓存）
            if std::str::from_utf8(&bytes).is_err() {
                return Some(FileClaims::default());
            }
            let paths: Vec<String> = extract_paths(&bytes).into_iter().collect();
            if paths.is_empty() {
                return Some(FileClaims::default());
            }
            Some(FileClaims {
                paths,
                hashes: extract_hashes(&bytes).into_iter().collect(),
                markers: extract_markers(&bytes).into_iter().collect(),
            })
        });
        match claims {
            None => SourceVisit::Skipped,
            Some(claims) => {
                *budget -= size;
                if !claims.paths.is_empty() {
                    collected.push(claims);
                }
                SourceVisit::Consumed
            }
        }
    });

    let mut claims = ModClaims::default();
    for item in collected {
        for path in item.paths {
            let fingerprints = claims.fingerprints.entry(path.clone()).or_default();
            for hash in &item.hashes {
                fingerprints.insert(hash.clone());
            }
            let claimed = claims.markers.entry(path).or_default();
            for marker in &item.markers {
                claimed.insert(marker.clone());
            }
        }
    }
    claims
}

/// 一份服务端文件的指纹集合：原始字节 / LF 归一化 / LF 归一化再去尾部空白。
///
/// 三个都算，因为各模组的口径不一样（0.12.8 与 0.12.9 的差别就是 CRLF 与一次重排版）。
fn file_fingerprints(abs: &Path, cache: &mut ModScanCache) -> Option<BTreeSet<String>> {
    let meta = fs::metadata(abs).ok()?;
    let (size, mtime_ms) = scan_cache::file_stamp(&meta);
    let prints = cache.fingerprints_for(abs, size, mtime_ms, || {
        let bytes = fs::read(abs).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let normalized = text.replace("\r\n", "\n");
        let trimmed = normalized.trim_end();
        let mut out = vec![
            pkg::sha256_hex(&bytes),
            pkg::sha256_hex(normalized.as_bytes()),
        ];
        if trimmed != normalized {
            out.push(pkg::sha256_hex(trimmed.as_bytes()));
        }
        out.sort();
        out.dedup();
        Some(out)
    })?;
    Some(prints.into_iter().collect())
}

/// 把 `src/...` 落到实际文件：优先 `<根>/server/<src/...>`，其次 `<根>/<src/...>`
fn resolve_server_file(repo_root: &Path, target: &str) -> Option<PathBuf> {
    let candidate = repo_root.join("server").join(target);
    if candidate.is_file() {
        return Some(candidate);
    }
    let fallback = repo_root.join(target);
    if fallback.is_file() {
        return Some(fallback);
    }
    None
}

/* ------------------------------ 被忽略的目录 ------------------------------ */

fn loader_names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if dir.join(LOADER_ENABLED).is_file() {
        out.push(LOADER_ENABLED.to_string());
    }
    if dir.join(LOADER_DISABLED).is_file() {
        out.push(LOADER_DISABLED.to_string());
    }
    for alt in LOADER_DISABLED_ALT {
        if dir.join(alt).is_file() {
            out.push(alt.to_string());
        }
    }
    out
}

/// 清单被套在下一层子目录里时返回那个子目录名（用户要做的就是把内容挪上来）
fn nested_manifest_child(dir: &Path) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        if safe_folder_name(&name).is_empty() {
            continue;
        }
        if entry.path().join(MANIFEST_NAME).is_file() {
            return Some(name);
        }
    }
    None
}

fn ignored_dirs(mods_root: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(mods_root) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, Value)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let dir = entry.path();
        if !dir.is_dir() || name.starts_with('.') {
            continue;
        }
        if dir.join(MANIFEST_NAME).is_file() {
            continue;
        }
        let loaders = loader_names(&dir);
        let nested = nested_manifest_child(&dir);
        if nested.is_none() && loaders.is_empty() {
            continue;
        }
        let row = json!({
            "folder": name,
            "reasonKind": if nested.is_some() { "nested" } else { "no-manifest" },
            "subFolder": nested.clone().unwrap_or_default(),
            "loaderFiles": loaders,
            "sizeBytes": scan::dir_stats(&dir).0,
        });
        rows.push((name, row));
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    rows.into_iter().map(|(_, row)| row).collect()
}

/* ------------------------------ 静态预检 ------------------------------ */

/// 一个启用中的模组对某份服务端源码文件的主张
struct TargetRef {
    folder: String,
    id: String,
    enabled: bool,
    /// 该模组为这份文件声明的 sha256 基线指纹（没声明就是空集）
    declared: BTreeSet<String>,
}

/// 纯静态预检（不执行任何模组代码）：被忽略的目录 + 共享服务端文件 + 基线指纹
pub fn static_report(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let scan_result = scan::scan_mods(repo_root, runtime);
    let ignored = ignored_dirs(&crate::mods::mods_root(repo_root));
    // 抠取结果与指纹按文件记忆化（见 `scan_cache.rs`）：开关一个模组只会动它自己的
    // loader 文件名，其余源码文件的抠取结果可以整批复用 —— 预检从「读扫几十 MB」降到
    // 「只读变化的那几个文件」。
    let mut cache = ModScanCache::load(runtime);

    let mut budget = MAX_TOTAL_BYTES;
    let mut by_target: BTreeMap<String, Vec<TargetRef>> = BTreeMap::new();
    // { (服务端相对路径, 注入标记) → [模组] }：撞同一个标记的模组组
    let mut by_marker: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    for item in &scan_result.mods {
        if item.kind != "loader" || !item.valid || !item.enabled {
            continue;
        }
        // 同一份文件 + 同一个标记 → 后注册的会被静默跳过，单独收一份做真冲突上报
        let claims = mod_claims(&item.dir, &item.folder, &mut budget, &mut cache);
        for (target, markers) in &claims.markers {
            for marker in markers {
                by_marker
                    .entry((target.clone(), marker.clone()))
                    .or_default()
                    .push((item.folder.clone(), item.id.clone()));
            }
        }
        for (target, hashes) in claims.fingerprints {
            by_target.entry(target).or_default().push(TargetRef {
                folder: item.folder.clone(),
                id: item.id.clone(),
                enabled: item.enabled,
                declared: hashes,
            });
        }
    }

    // (共享, 有基线不符, 路径, 回包)：共享的排前面，其次是「对不上」的
    let mut rows: Vec<(bool, bool, String, Value)> = Vec::new();
    let mut shared_count = 0usize;
    let mut stale_count = 0usize;
    for (target, refs) in &by_target {
        let fingerprints = resolve_server_file(repo_root, target)
            .and_then(|abs| file_fingerprints(&abs, &mut cache));
        let mut mods_json: Vec<Value> = Vec::new();
        let mut has_stale = false;
        for reference in refs {
            let TargetRef {
                folder,
                id,
                enabled,
                declared,
            } = reference;
            let verdict = match (&fingerprints, declared.is_empty()) {
                (None, _) => "missing-file",
                (Some(_), true) => "unknown",
                (Some(set), false) => {
                    if declared.iter().any(|hash| set.contains(hash)) {
                        "ok"
                    } else {
                        has_stale = true;
                        "stale"
                    }
                }
            };
            mods_json.push(json!({
                "folder": folder,
                "id": id,
                "enabled": enabled,
                "verdict": verdict,
                "declaredFingerprints": declared.len(),
            }));
        }
        let shared = refs.len() > 1;
        if shared {
            shared_count += 1;
        }
        if has_stale {
            stale_count += 1;
        }
        rows.push((
            shared,
            has_stale,
            target.clone(),
            json!({
                "file": target,
                "shared": shared,
                "mods": mods_json,
            }),
        ));
    }
    // 共享的排前面（用户先在意的就是「谁和谁抢同一个文件」），其次是基线对不上的；
    // 先排序再截断，免得 MAX_TARGETS 把真正有问题的那几条切掉。
    rows.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let shared_listed = rows.iter().take(MAX_TARGETS).filter(|row| row.0).count();
    let stale_listed = rows.iter().take(MAX_TARGETS).filter(|row| row.1).count();
    let targets: Vec<Value> = rows
        .into_iter()
        .take(MAX_TARGETS)
        .map(|(_, _, _, row)| row)
        .collect();

    // 注入标记冲突：同一份文件 + 同一个标记 → 总线按 (slot, 注册先后) 串链时，
    // 后一层看到标记已经在源码里就整段跳过自己（不报错、也不生效）。
    // 这是真冲突，跟「只是改同一份文件」分开上报，界面上才敢让用户「停用其中一个」。
    let marker_conflicts: Vec<Value> = by_marker
        .into_iter()
        .filter(|(_, mods)| mods.len() > 1)
        .take(MAX_MARKER_ROWS)
        .map(|((target, marker), mods)| {
            json!({
                "target": target,
                "marker": marker,
                "mods": mods
                    .into_iter()
                    .map(|(folder, id)| json!({ "folder": folder, "id": id }))
                    .collect::<Vec<Value>>(),
            })
        })
        .collect();
    let marker_conflict_count = marker_conflicts.len();

    // 缓存收尾：丢掉「模组目录 / 服务端文件已经不在了」的条目，再按需落盘。
    // 顺序放在报告构造之前 —— 报告只用内存里的数据，落盘失败也不影响这一轮结论。
    cache.prune(&crate::mods::mods_root(repo_root));
    cache.save(runtime);

    json!({
        "ok": true,
        "dryRun": false,
        "root": repo_root.to_string_lossy(),
        "ignored": ignored,
        "markerConflicts": marker_conflicts,
        "targets": targets,
        "summary": {
            "ignored": ignored.len(),
            "targets": by_target.len(),
            "shared": shared_count,
            "stale": stale_count,
            "sharedListed": shared_listed,
            "staleListed": stale_listed,
            "markerConflicts": marker_conflict_count,
            "scannedMods": scan_result.mods.iter().filter(|item| item.kind == "loader" && item.valid && item.enabled).count(),
        },
    })
}

/* ------------------------------ 干跑 ------------------------------ */

fn clear_old_reports(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("report.json") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 最新一份 `report.json.<pid>.json`（干跑只写 per-pid，不会覆盖真启动的总报告）
fn newest_report(dir: &Path) -> Option<Value> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("report.json") || !name.ends_with(".json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let stamp = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        if best.as_ref().map(|(at, _)| stamp > *at).unwrap_or(true) {
            best = Some((stamp, entry.path()));
        }
    }
    let (_, file) = best?;
    let raw = fs::read_to_string(file).ok()?;
    serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok()
}

fn tail_lines(text: &str, out: &mut Vec<String>, cap: usize) {
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        out.push(trimmed.to_string());
        if out.len() > cap {
            out.remove(0);
        }
    }
}

/// 干跑：把 `plan_loaders` 选中的 loader 放进一次性 Node 进程里 require 一遍。
///
/// 只回「加载期」结论：require 抛错 → 真启动时 `--require` 也会让 node 退出。
pub async fn dry_run(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let plan_value = plan::plan_loaders(repo_root, runtime);
    let paths: Vec<String> = plan_value
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if paths.is_empty() {
        return json!({
            "ok": true,
            "dryRun": true,
            "reason": "no-loaders",
            "loaders": [],
            "failed": 0,
            "elapsedMs": 0,
            "output": [],
        });
    }

    let dir = runtime.temp.join(PREFLIGHT_DIR);
    if let Err(err) = fs::create_dir_all(&dir) {
        return json!({ "ok": false, "dryRun": true, "reason": format!("预检目录创建失败：{err}") });
    }
    clear_old_reports(&dir);
    let host = dir.join("mod-host.js");
    if let Err(err) = fs::write(&host, crate::process::MOD_HOST_JS) {
        let _ = fs::remove_dir_all(&dir);
        return json!({ "ok": false, "dryRun": true, "reason": format!("注入总线写入失败：{err}") });
    }
    let plan_file = dir.join("mod-plan.json");
    let payload = json!({
        "schemaVersion": 1,
        "api": 1,
        "root": repo_root.to_string_lossy().replace('\\', "/"),
        "loaders": paths,
        "generatedAt": pkg::epoch_ms() as u64,
    });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_default();
    if let Err(err) = fs::write(&plan_file, format!("{text}\n")) {
        let _ = fs::remove_dir_all(&dir);
        return json!({ "ok": false, "dryRun": true, "reason": format!("模组清单写入失败：{err}") });
    }
    let report = dir.join("report.json");

    // 方案 B 预热的关键：与真启动同一个编译缓存目录。没有它，干跑只热了系统文件缓存，
    // V8 字节码缓存不写 —— 预热对「模组多」的启动就没了主要收益。
    let compile_cache = runtime.cache.join("node-compile");
    let _ = fs::create_dir_all(&compile_cache);
    let node = match crate::sidecar::node_executable() {
        Ok(path) => path,
        Err(err) => {
            return json!({ "ok": false, "dryRun": true, "reason": format!("找不到 Node.js：{err}") })
        }
    };

    let mut command = tokio::process::Command::new(node);
    command
        .arg("--require")
        .arg(&host)
        .arg("--eval")
        .arg("")
        .current_dir(repo_root)
        .env("EVEJS_MODS_PLAN", &plan_file)
        .env("EVEJS_MODS_REPORT", &report)
        .env("EVEJS_MODS_ROOT", repo_root)
        .env("NODE_COMPILE_CACHE", &compile_cache)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let started = std::time::Instant::now();
    let outcome =
        tokio::time::timeout(Duration::from_secs(DRY_RUN_TIMEOUT_SECS), command.output()).await;
    let (status_ok, stdout, stderr) = match outcome {
        Ok(Ok(output)) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Ok(Err(err)) => {
            return json!({ "ok": false, "dryRun": true, "reason": format!("Node 启动失败：{err}") })
        }
        Err(_) => {
            return json!({
                "ok": false,
                "dryRun": true,
                "reason": format!("预检超时（{DRY_RUN_TIMEOUT_SECS}s）"),
            })
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let mut output: Vec<String> = Vec::new();
    tail_lines(&stdout, &mut output, MAX_OUTPUT_LINES);
    tail_lines(&stderr, &mut output, MAX_OUTPUT_LINES);

    let report_value = newest_report(&dir);
    // 干跑的全部产物都读完了：这块是纯草稿（真启动的报告在 _launcher/logs 下），
    // 立刻清掉 —— 既不攒垃圾，也让端到端沙箱的两轮文件指纹保持逐字节一致
    // （报告文件名里带 pid，留在盘上每轮都不一样）。
    let _ = fs::remove_dir_all(&dir);
    let Some(report_value) = report_value else {
        return json!({
            "ok": false,
            "dryRun": true,
            "reason": "预检没有写出报告（loader 可能把进程拖住了）",
            "elapsedMs": elapsed_ms,
            "output": output,
        });
    };

    let loaders: Vec<Value> = report_value
        .get("loaders")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "id": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "path": item.get("path").and_then(Value::as_str).unwrap_or_default(),
                        "ok": item.get("ok").and_then(Value::as_bool).unwrap_or(false),
                        "reason": item.get("reason").and_then(Value::as_str).unwrap_or_default(),
                        "ms": item.get("ms").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let failed = loaders
        .iter()
        .filter(|item| !item.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();

    json!({
        "ok": status_ok && failed == 0,
        "dryRun": true,
        "root": repo_root.to_string_lossy(),
        "loaders": loaders,
        "failed": failed,
        "elapsedMs": elapsed_ms,
        "loadersMs": report_value.get("loadersDoneMs").and_then(Value::as_u64).unwrap_or(0),
        "output": output,
    })
}

/// 方案 B：后台预热。复用干跑内核（同一批 loader、同一个 `NODE_COMPILE_CACHE` 目录），
/// 把 V8 编译缓存 + 系统文件缓存写热，让下一次真启动少编译、少读冷盘。
/// 静默、best-effort：不绑端口、不连客户端，任何失败都只影响缓存命中率，不报给用户。
pub async fn warmup_loaders(repo_root: &Path, runtime: &RuntimePaths) -> Value {
    let value = dry_run(repo_root, runtime).await;
    json!({
        "ok": value.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "elapsedMs": value.get("elapsedMs").and_then(Value::as_u64).unwrap_or(0),
    })
}

/* ------------------------------ 单测 ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::scan::MANIFEST_NAME as MANIFEST;

    fn repo_for(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-preflight-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("mods")).expect("应能建 mods 目录");
        dir
    }

    fn runtime_for(label: &str) -> RuntimePaths {
        let dir = std::env::temp_dir().join(format!("evejs-preflight-rt-{label}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("应能建运行时目录");
        RuntimePaths::from_root(dir, true)
    }

    fn manifest(id: &str) -> String {
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 3,
            "id": id,
            "displayName": id,
            "version": "1.0.0",
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" }
        }))
        .unwrap()
    }

    fn write_mod(repo: &Path, folder: &str, id: &str, loader: &str) {
        let dir = repo.join("mods").join(folder);
        fs::create_dir_all(dir.join("lib")).unwrap();
        fs::write(dir.join(MANIFEST), manifest(id)).unwrap();
        fs::write(dir.join(LOADER_ENABLED), "module.exports = 1;\n").unwrap();
        fs::write(dir.join("lib").join("patch.js"), loader).unwrap();
    }

    fn write_server_file(repo: &Path, relative: &str, body: &str) -> PathBuf {
        let abs = repo.join("server").join(relative);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, body).unwrap();
        abs
    }

    #[test]
    fn extracts_paths_and_hashes_from_sources() {
        let source = br#"
            const RELATIVE_PATH = "server/src/network/tcp/handshake.js";
            const BASELINES = new Set([
              "ac4939663342d0573055792ffb1f67539238ce50e0c14acaaec83beea45574a5",
            ]);
            const other = "src/space/runtime.js";
        "#;
        let paths = extract_paths(source);
        assert!(paths.contains("src/network/tcp/handshake.js"), "{paths:?}");
        assert!(paths.contains("src/space/runtime.js"), "{paths:?}");
        let hashes = extract_hashes(source);
        assert_eq!(hashes.len(), 1);
        assert!(hashes.contains("ac4939663342d0573055792ffb1f67539238ce50e0c14acaaec83beea45574a5"));
    }

    #[test]
    fn extracts_markers_only_from_short_slash_literals() {
        let source = br#"
            const MARKER = "// demo:patch";
            const other = "not a marker";
            const url = "https://example.com";
        "#;
        let markers = extract_markers(source);
        assert_eq!(markers.len(), 1, "{markers:?}");
        assert!(markers.contains("// demo:patch"), "{markers:?}");
    }

    #[test]
    fn marker_collision_is_reported_for_the_same_file_and_marker() {
        let repo = repo_for("marker");
        let runtime = runtime_for("marker");
        write_server_file(&repo, "src/network/tcp/handshake.js", "// server file\n");
        let body = "const RELATIVE_PATH = \"server/src/network/tcp/handshake.js\";\nconst MARKER = \"// demo:patch\";\n";
        write_mod(&repo, "甲", "jia", body);
        write_mod(&repo, "乙", "yi", body);

        let report = static_report(&repo, &runtime);
        let rows = report["markerConflicts"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{report}");
        assert_eq!(rows[0]["target"], "src/network/tcp/handshake.js");
        assert_eq!(rows[0]["marker"], "// demo:patch");
        assert_eq!(rows[0]["mods"].as_array().unwrap().len(), 2);
        assert_eq!(report["summary"]["markerConflicts"], 1, "{report}");
    }

    #[test]
    fn same_file_with_distinct_markers_is_not_a_marker_collision() {
        let repo = repo_for("marker-distinct");
        let runtime = runtime_for("marker-distinct");
        write_server_file(&repo, "src/network/tcp/handshake.js", "// server file\n");
        write_mod(
            &repo,
            "甲",
            "jia",
            "const P = \"server/src/network/tcp/handshake.js\";\nconst M = \"// jia:patch\";\n",
        );
        write_mod(
            &repo,
            "乙",
            "yi",
            "const P = \"server/src/network/tcp/handshake.js\";\nconst M = \"// yi:patch\";\n",
        );

        let report = static_report(&repo, &runtime);
        assert!(
            report["markerConflicts"].as_array().unwrap().is_empty(),
            "{report}"
        );
        // 但「改同一份文件」照旧要报 —— 这两件事必须分开，界面上的处置方式也不同
        assert_eq!(report["summary"]["shared"], 1, "{report}");
    }

    #[test]
    fn nested_manifest_dir_is_reported_with_hint() {
        let repo = repo_for("nested");
        let runtime = runtime_for("nested");
        let outer = repo.join("mods").join("冬眠者1.5.0");
        let inner = outer.join("evejs-sleeper-drifters");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join(MANIFEST), manifest("sleeper-drifters")).unwrap();
        fs::write(inner.join("loader.js.disabled"), "module.exports = 1;\n").unwrap();

        let report = static_report(&repo, &runtime);
        let ignored = report.get("ignored").unwrap().as_array().unwrap();
        assert_eq!(ignored.len(), 1, "{report}");
        assert_eq!(ignored[0]["folder"], "冬眠者1.5.0");
        assert_eq!(ignored[0]["reasonKind"], "nested");
        assert_eq!(ignored[0]["subFolder"], "evejs-sleeper-drifters");
        // 套了一层的那份清单不能被当成已装载的模组
        assert_eq!(report["summary"]["scannedMods"], 0);
    }

    #[test]
    fn manifestless_dir_with_loader_is_reported() {
        let repo = repo_for("manifestless");
        let runtime = runtime_for("manifestless");
        let dir = repo.join("mods").join("忘了放清单");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(LOADER_ENABLED), "module.exports = 1;\n").unwrap();

        let report = static_report(&repo, &runtime);
        let ignored = report.get("ignored").unwrap().as_array().unwrap();
        assert_eq!(ignored.len(), 1, "{report}");
        assert_eq!(ignored[0]["reasonKind"], "no-manifest");
        assert_eq!(ignored[0]["subFolder"], "");
        assert_eq!(ignored[0]["loaderFiles"][0], "loader.js");
    }

    #[test]
    fn plain_folder_without_loader_is_not_reported() {
        let repo = repo_for("plain");
        let runtime = runtime_for("plain");
        fs::create_dir_all(repo.join("mods").join("随手放的东西")).unwrap();
        let report = static_report(&repo, &runtime);
        assert_eq!(report["ignored"].as_array().unwrap().len(), 0, "{report}");
    }

    #[test]
    fn shared_targets_carry_baseline_verdicts() {
        let repo = repo_for("shared");
        let runtime = runtime_for("shared");
        let abs = write_server_file(&repo, "src/network/tcp/handshake.js", "// server file\r\n");
        let mut cache = ModScanCache::load(&runtime);
        let fingerprints = file_fingerprints(&abs, &mut cache).unwrap();
        let raw = pkg::sha256_hex(&fs::read(&abs).unwrap());
        assert!(fingerprints.contains(&raw));

        // 甲：基线就是当前文件 → ok
        write_mod(
            &repo,
            "甲",
            "jia",
            &format!("const RELATIVE_PATH = \"server/src/network/tcp/handshake.js\";\nconst BASELINES = new Set([\"{raw}\"]);\n"),
        );
        // 乙：引用了同一份文件，但基线是旧版本 → stale
        write_mod(
            &repo,
            "乙",
            "yi",
            "const P = \"server/src/network/tcp/handshake.js\";\nconst BASELINES = new Set([\"0000000000000000000000000000000000000000000000000000000000000000\"]);\n",
        );

        let report = static_report(&repo, &runtime);
        assert_eq!(report["summary"]["shared"], 1, "{report}");
        assert_eq!(report["summary"]["stale"], 1, "{report}");
        let target = &report["targets"][0];
        assert_eq!(target["file"], "src/network/tcp/handshake.js");
        assert_eq!(target["shared"], true);
        // 回包顺序跟扫描排序（显示名）走，测试只钉「每个模组各自的判定」
        let mods = target["mods"].as_array().unwrap();
        assert_eq!(mods.len(), 2);
        let verdict_of = |folder: &str| -> String {
            mods.iter()
                .find(|item| item["folder"] == folder)
                .map(|item| item["verdict"].as_str().unwrap_or_default().to_string())
                .unwrap_or_default()
        };
        assert_eq!(verdict_of("甲"), "ok");
        assert_eq!(verdict_of("乙"), "stale");
    }

    #[test]
    fn missing_server_file_is_reported_not_guessed() {
        let repo = repo_for("missing-file");
        let runtime = runtime_for("missing-file");
        write_mod(
            &repo,
            "丙",
            "bing",
            "const P = \"server/src/services/nope/gone.js\";\nconst BASELINES = new Set([\"1111111111111111111111111111111111111111111111111111111111111111\"]);\n",
        );
        let report = static_report(&repo, &runtime);
        assert_eq!(
            report["targets"][0]["mods"][0]["verdict"], "missing-file",
            "{report}"
        );
        assert_eq!(report["summary"]["stale"], 0, "{report}");
    }

    #[test]
    fn disabled_mods_do_not_pollute_the_report() {
        let repo = repo_for("disabled");
        let runtime = runtime_for("disabled");
        write_server_file(&repo, "src/space/runtime.js", "// runtime\n");
        write_mod(
            &repo,
            "丁",
            "ding",
            "const P = \"server/src/space/runtime.js\";\n",
        );
        fs::rename(
            repo.join("mods").join("丁").join(LOADER_ENABLED),
            repo.join("mods").join("丁").join(LOADER_DISABLED),
        )
        .unwrap();
        let report = static_report(&repo, &runtime);
        assert_eq!(report["summary"]["targets"], 0, "{report}");
        assert_eq!(report["summary"]["scannedMods"], 0, "{report}");
    }

    /// 2026-11-02 提速回归：缓存只许省时间，不许改结论。
    ///
    /// 同一份仓库连跑两次静态预检（第二次全程命中缓存），报告必须逐字段一致；
    /// 再把模组源码改一改（体积与 mtime 变），报告要跟着变 —— 说明缓存真的失效了。
    #[test]
    fn static_report_is_identical_on_a_warm_cache() {
        let repo = repo_for("cache-stable");
        let runtime = runtime_for("cache-stable");
        write_server_file(&repo, "src/network/tcp/handshake.js", "// server file\n");
        let body =
            "const P = \"server/src/network/tcp/handshake.js\";\nconst M = \"// demo:patch\";\n";
        write_mod(&repo, "甲", "jia", body);

        let cold = static_report(&repo, &runtime);
        let warm = static_report(&repo, &runtime);
        assert_eq!(cold, warm, "命中缓存的那一趟结论必须一模一样");
        assert!(
            runtime.cache.join("mod-claims.json").is_file(),
            "预检应把抠取结果落盘到 _launcher/cache/mod-claims.json"
        );

        // 多声明一份服务端文件：体积与 mtime 都变了 → 缓存失效，结论跟着变
        let more = format!("{body}const Q = \"src/space/runtime.js\";\n");
        write_mod(&repo, "甲", "jia", &more);
        let after = static_report(&repo, &runtime);
        assert_ne!(after, warm, "改过源码之后结论要跟着变");
        assert_eq!(after["summary"]["targets"], 2, "{after}");
    }

    /// 真机基准（默认不跑）：在**真实安装**上量一遍静态预检的冷 / 热耗时。
    /// 手动执行：
    ///   `EVEJS_ROOT=<服务端目录> cargo test --lib preflight::tests::live_static_report_timing -- --ignored --nocapture`
    ///
    /// 「热」= 缓存已经在盘上（正常使用下就是这一档）；「冷」= 先删缓存再跑一次。
    #[test]
    #[ignore]
    fn live_static_report_timing() {
        let Ok(root) = std::env::var("EVEJS_ROOT") else {
            println!("跳过：没给 EVEJS_ROOT");
            return;
        };
        let repo = PathBuf::from(&root);
        let runtime = RuntimePaths::from_root(repo.join("_launcher"), true);
        let cache_file = runtime.cache.join("mod-claims.json");

        // 分段量：扫描 / 冷抠取 / 热抠取 —— 三段相加才是整趟预检的钱
        let scan_start = std::time::Instant::now();
        let scan_result = scan::scan_mods(&repo, &runtime);
        let scan_ms = scan_start.elapsed().as_millis();

        let _ = fs::remove_file(&cache_file);
        let cold = std::time::Instant::now();
        let cold_report = static_report(&repo, &runtime);
        let cold_ms = cold.elapsed().as_millis();

        let warm = std::time::Instant::now();
        let warm_report = static_report(&repo, &runtime);
        let warm_ms = warm.elapsed().as_millis();

        let warm2 = std::time::Instant::now();
        let warm2_report = static_report(&repo, &runtime);
        let warm2_ms = warm2.elapsed().as_millis();

        println!(
            "scan_mods {} ms · 预检冷 {} ms · 预检热 {} ms · 预检热(第三趟) {} ms · 模组 {} 个 / 启用 loader {} / targets {} / ignored {}",
            scan_ms,
            cold_ms,
            warm_ms,
            warm2_ms,
            scan_result.mods.len(),
            cold_report["summary"]["scannedMods"],
            cold_report["summary"]["targets"],
            cold_report["summary"]["ignored"],
        );
        assert_eq!(cold_report, warm_report, "冷热两趟的结论必须一致");
        assert_eq!(warm_report, warm2_report, "热跑几趟结论都要一致");
    }

    #[tokio::test]
    async fn warmup_loaders_skips_silently_without_loaders() {
        let repo = repo_for("warmup-empty");
        let runtime = runtime_for("warmup-empty");
        let value = super::warmup_loaders(&repo, &runtime).await;
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(value.get("elapsedMs").and_then(Value::as_u64), Some(0));
        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(runtime.root);
    }
}
