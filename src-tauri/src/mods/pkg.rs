//! ZIP 打包 / 导入 / 覆盖更新：对齐现役版 `src/main/modPack.ts` +
//! `modManager.ts` 的 `importModZip` / `updateMod` / `findManifestRoot` / `safeFolderName`。
//!
//! 两个关键取舍：
//!   - **不引 zip crate**：解压继续用系统自带的 `Expand-Archive`（现役版就是这么做的），
//!     打包用 .NET 的 `ZipFile::CreateFromDirectory`（`Compress-Archive` 会在 ZIP 里写反斜杠，
//!     别的解压工具会出错，现役版注释里专门写了这一点）；
//!   - **A3 路径穿越防护**：解压前先自己解析 ZIP 的中央目录，拒绝 `..`、绝对路径、盘符与
//!     控制字符条目。这台机器上 `Expand-Archive`（.NET Framework）对路径穿越的历史行为
//!     不可依赖，所以宁可自己先断言一遍。
use crate::mods::scan::{self, MANIFEST_NAME};
use crate::mods::{plan, sanitize_folder_name};
use crate::runtime::RuntimePaths;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

/// 看起来像「用户私有数据」的文件/目录：更新时要保留旧的（新包里的同名文件另存 .new）
pub const USER_DATA_NAMES: [&str; 7] = [
    "settings.json",
    "preferences.json",
    "user-config.json",
    "profile",
    "profiles",
    "data",
    "config.json",
];

use crate::win32::CREATE_NO_WINDOW;

/* ------------------------------ 通用小工具 ------------------------------ */

/// 递归复制目录（`fs.cpSync(src, dest, {recursive:true})` 的等价物）
pub fn copy_dir_all(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 文件的 sha256（小写 hex）与体积
pub fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let bytes = fs::read(path).map_err(|err| format!("读取文件失败：{err}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok((hex, bytes.len() as u64))
}

/// 字节的 sha256（市场包校验用）
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// PowerShell 单引号字符串转义
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 跑一段 PowerShell（隐藏窗口）；失败返回 stderr/stdout 的首行
fn run_powershell(script: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|err| format!("无法启动 PowerShell：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let reason = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("命令执行失败")
        .to_string();
    Err(reason)
}

/// 解压到目标目录（现役版用 `Expand-Archive -Force`）
fn expand_archive(zip: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| format!("创建临时目录失败：{err}"))?;
    let script = format!(
        "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
        ps_quote(&zip.to_string_lossy()),
        ps_quote(&dest.to_string_lossy())
    );
    run_powershell(&script)
}

/* ------------------------------ ZIP 中央目录解析 ------------------------------ */

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const EOCD_MIN_SIZE: usize = 22;
const MAX_COMMENT: usize = 65_535;

/// 读 ZIP 中央目录里的所有条目名（只读、不依赖任何第三方库）
/// 中央目录里一条条目的关键信息
struct ZipEntry {
    name: String,
    /// `external file attributes` 高 16 位的 Unix 模式（Windows 打的包是 0）
    unix_mode: u32,
}

impl ZipEntry {
    /// 符号链接条目（A3）：解压出来可能是指向任意路径的链接，一律拒绝
    fn is_symlink(&self) -> bool {
        self.unix_mode & 0xF000 == 0xA000
    }
}

pub fn zip_entry_names(path: &Path) -> Result<Vec<String>, String> {
    Ok(zip_entries(path)?
        .into_iter()
        .map(|entry| entry.name)
        .collect())
}

fn zip_entries(path: &Path) -> Result<Vec<ZipEntry>, String> {
    let bytes = fs::read(path).map_err(|err| format!("读不到 ZIP：{err}"))?;
    if bytes.len() < EOCD_MIN_SIZE {
        return Err("不是有效的 ZIP（文件太小）".to_string());
    }
    let search_start = bytes.len().saturating_sub(EOCD_MIN_SIZE + MAX_COMMENT);
    let mut eocd = None;
    for offset in (search_start..=bytes.len() - EOCD_MIN_SIZE).rev() {
        if read_u32(&bytes, offset) == Some(EOCD_SIGNATURE) {
            eocd = Some(offset);
            break;
        }
    }
    let Some(eocd) = eocd else {
        return Err("不是有效的 ZIP（找不到中央目录结尾）".to_string());
    };
    let count = read_u16(&bytes, eocd + 10).unwrap_or(0) as usize;
    let directory_offset = read_u32(&bytes, eocd + 16).unwrap_or(0) as usize;
    if count == 0xffff || directory_offset == 0xffff_ffff {
        return Err("暂不支持 Zip64 格式的压缩包".to_string());
    }

    let mut entries = Vec::with_capacity(count);
    let mut cursor = directory_offset;
    for _ in 0..count {
        if read_u32(&bytes, cursor) != Some(CENTRAL_SIGNATURE) {
            return Err("ZIP 中央目录结构异常".to_string());
        }
        let name_len = read_u16(&bytes, cursor + 28).unwrap_or(0) as usize;
        let extra_len = read_u16(&bytes, cursor + 30).unwrap_or(0) as usize;
        let comment_len = read_u16(&bytes, cursor + 32).unwrap_or(0) as usize;
        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        let raw = bytes
            .get(name_start..name_end)
            .ok_or_else(|| "ZIP 条目名越界".to_string())?;
        // 38 = 中央目录头里 external file attributes 的偏移；高 16 位是 Unix 模式
        let external = read_u32(&bytes, cursor + 38).unwrap_or(0);
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(raw).to_string(),
            unix_mode: external >> 16,
        });
        cursor = name_end + extra_len + comment_len;
    }
    Ok(entries)
}

/// 条目名是否安全（A3）：拒绝空名、绝对路径、盘符、`..` 组件与控制字符
pub fn entry_is_safe(name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    if name.chars().any(|ch| (ch as u32) < 0x20) {
        return false;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return false;
    }
    // 盘符（C:）或 NTFS 数据流（name:stream）
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return false;
    }
    !Path::new(name)
        .components()
        .any(|part| matches!(part, Component::ParentDir))
}
/* ------------------------------ 打包 / 导入 / 更新 ------------------------------ */

pub(crate) fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// Unix 毫秒 → ISO-8601 UTC 字符串，形状对齐 JS `new Date(ms).toISOString()`：
/// `YYYY-MM-DDTHH:MM:SS.mmmZ`。现役版用它写 `.evejs-source.json` 与索引分片的 `publishedAt`。
///
/// 为了一个时间戳不引 `chrono` / `time`，这里用 Howard Hinnant 的 days→civil 算法
/// （公历 1582 年以后都正确，且闰年规则与 JS 一致）：
/// 先按 400 年一个 era 把天数拆成 (era, day-of-era)，再算年内第几天与月份。
pub(crate) fn iso_from_ms(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rem = ms % 86_400_000;
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3_600_000;
    let minute = (rem / 60_000) % 60;
    let second = (rem / 1000) % 60;
    let milli = rem % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// ISO-8601 时间戳 → Unix 毫秒（UTC）。认得启动器自己写出去的两种形状：
/// 纯日期 `YYYY-MM-DD`（JS `Date.parse` 按 UTC 零点）与 `YYYY-MM-DDTHH:MM:SS[.mmm]Z`。
/// 解析失败返回 `None`，调用方回退到「现在」。
pub(crate) fn ms_from_iso_date(text: &str) -> Option<u64> {
    let mut parts = text.splitn(2, 'T');
    let date = parts.next()?;
    let mut fields = date.split('-');
    let year: i64 = fields.next()?.trim().parse().ok()?;
    let month: i64 = fields.next()?.parse().ok()?;
    let day: i64 = fields.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let mut millis = days * 86_400_000;
    if let Some(time) = parts.next() {
        let cleaned = time.trim_end_matches('Z').trim_end_matches('z');
        let mut clock = cleaned.split(':');
        if let Some(hour) = clock
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
        {
            millis += hour.clamp(0, 23) * 3_600_000;
        }
        if let Some(minute) = clock
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
        {
            millis += minute.clamp(0, 59) * 60_000;
        }
        if let Some(second) = clock.next() {
            let mut sec = second.splitn(2, '.');
            if let Some(value) = sec.next().and_then(|item| item.trim().parse::<i64>().ok()) {
                millis += value.clamp(0, 59) * 1000;
            }
            if let Some(fraction) = sec.next() {
                let digits: String = fraction
                    .chars()
                    .take(3)
                    .filter(|ch| ch.is_ascii_digit())
                    .collect();
                if !digits.is_empty() {
                    let padded = format!("{digits:0<3}");
                    millis += padded.parse::<i64>().unwrap_or(0);
                }
            }
        }
    }
    if millis < 0 {
        return None;
    }
    Some(millis as u64)
}

/// 公历 (年, 月, 日) → 自 1970-01-01 起的天数（`civil_from_days` 的逆运算）
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let month = month as i64;
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
/// 自 1970-01-01 起的天数 → (年, 月, 日)
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 复制「文件或目录」（`fs.cpSync(src, dest, {recursive:true})` 的等价物）
pub fn copy_any(source: &Path, dest: &Path) -> std::io::Result<()> {
    if fs::metadata(source)?.is_dir() {
        return copy_dir_all(source, dest);
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::copy(source, dest).map(|_| ())
}

/// 删文件或目录（失败静默：清理动作不影响主结果）
pub(crate) fn cleanup_path(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else if path.exists() {
        let _ = fs::remove_file(path);
    }
}

/// 只保留非 `null` 的键：对齐 TS 里 `undefined` 字段不出现在 IPC 结果里的行为
fn result_obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in pairs {
        if value.is_null() {
            continue;
        }
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// 一级子目录（读不到就是空）
fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect()
}

/// 在解包目录里找清单所在的那一层（ZIP 可能多套一层目录）—— 对齐现役版 `findManifestRoot`
pub fn find_manifest_root(dir: &Path) -> Option<PathBuf> {
    if dir.join(MANIFEST_NAME).is_file() {
        return Some(dir.to_path_buf());
    }
    let dirs = child_dirs(dir);
    if dirs.len() == 1 {
        let nested = &dirs[0];
        if nested.join(MANIFEST_NAME).is_file() {
            return Some(nested.clone());
        }
    }
    None
}

/// 导入时的包根定位：根有清单就用根，否则找唯一一个含清单的一级子目录（跳过 `__MACOSX`）
fn locate_package_root(temp_root: &Path) -> Result<PathBuf, String> {
    if temp_root.join(MANIFEST_NAME).is_file() {
        return Ok(temp_root.to_path_buf());
    }
    let Ok(entries) = fs::read_dir(temp_root) else {
        return Err(format!("读不到解压目录：{}", temp_root.display()));
    };
    let dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter(|entry| entry.file_name() != "__MACOSX")
        .map(|entry| entry.path())
        .filter(|dir| dir.join(MANIFEST_NAME).is_file())
        .collect();
    match dirs.len() {
        0 => Err(format!("ZIP 里没有 {MANIFEST_NAME}")),
        1 => Ok(dirs.into_iter().next().expect("长度已确认")),
        _ => Err("ZIP 里有多个模组包，请一次只导入一个".to_string()),
    }
}

/// A3：解压前先自己解析中央目录，确认没有任何条目能写到目标目录之外。
///
/// 这台机器上 `Expand-Archive`（.NET Framework）对路径穿越的历史行为不可依赖，
/// 所以宁可自己先断言一遍再交给系统解压。
fn assert_zip_entries_safe(zip: &Path) -> Result<(), String> {
    let entries = zip_entries(zip)?;
    if let Some(bad) = entries.iter().find(|entry| !entry_is_safe(&entry.name)) {
        return Err(format!("压缩包里含有不安全的条目名：{}", bad.name));
    }
    if let Some(link) = entries.iter().find(|entry| entry.is_symlink()) {
        return Err(format!("压缩包里含有符号链接条目：{}", link.name));
    }
    Ok(())
}
/* ------------------------------ 打包 ------------------------------ */

/// 目录 → ZIP（ZIP 内根就是模组根，不含外层目录），并算好 sha256 / sizeBytes。
///
/// 用 .NET 的 `ZipFile::CreateFromDirectory` 而不是 `Compress-Archive`：
/// 部分 PowerShell 版本的 `Compress-Archive` 会用反斜杠当 ZIP 内的路径分隔符，
/// 别的工具解压就出错。
pub fn pack_mod_zip(source_dir: &Path, dest_zip: &Path) -> Value {
    if !source_dir.exists() {
        return json!({ "ok": false, "reason": format!("源目录不存在：{}", source_dir.display()) });
    }
    match fs::metadata(source_dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return json!({ "ok": false, "reason": format!("源路径不是目录：{}", source_dir.display()) });
        }
        Err(err) => {
            return json!({ "ok": false, "reason": format!("读不到源目录：{err}") });
        }
    }

    if let Some(parent) = dest_zip.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(err) = fs::create_dir_all(parent) {
                return json!({ "ok": false, "reason": format!("准备目标文件失败：{err}") });
            }
        }
    }
    if dest_zip.exists() {
        if let Err(err) = fs::remove_file(dest_zip) {
            return json!({ "ok": false, "reason": format!("准备目标文件失败：{err}") });
        }
    }

    let script = format!(
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory({}, {}, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
        ps_quote(&source_dir.to_string_lossy()),
        ps_quote(&dest_zip.to_string_lossy())
    );
    if let Err(err) = run_powershell(&script) {
        return json!({ "ok": false, "reason": format!("打包失败：{err}") });
    }
    if !dest_zip.is_file() {
        return json!({ "ok": false, "reason": "打包命令执行完了但没生成 ZIP" });
    }
    match sha256_file(dest_zip) {
        Ok((sha256, size_bytes)) => json!({
            "ok": true,
            "zipPath": dest_zip.to_string_lossy(),
            "sha256": sha256,
            "sizeBytes": size_bytes
        }),
        Err(err) => json!({ "ok": false, "reason": err }),
    }
}

/* ------------------------------ 导入 ------------------------------ */

/// 从 ZIP 导入模组：解压 → 定位 `evejs-launcher.mod.json` → 校验 → 复制到 `mods/<id>`。
///
/// 导入后强制为「禁用」状态（把 loader.js 改回 loader.js.disabled），
/// 避免用户意外启用未知模组。
/// A2：导入的包若命中索引里同一 `id` + `version`，整包 sha256 必须与索引登记值一致。
///
/// 返回 `(trusted, note)`：
///   - `trusted = true`  → **索引背书**（哈希逐字节一致）
///   - `trusted = false` → 索引里没有这个 id+版本（自签包 / 未上架 / 缓存不可用），标「未签名」
///
/// 命中但哈希不一致 → `Err`，调用方必须中止安装（包被改过）。
///
/// 注意：「索引背书」与「包内自称的签名」是两件事 —— 后者只能说明「谁打的包」，
/// 前者才说明「维护者收录过这个字节串」，所以 `trusted` 只认索引。
fn check_index_endorsement(
    zip_sha256: &str,
    manifest: &Value,
    runtime: &RuntimePaths,
) -> Result<(bool, String), String> {
    let index = crate::mods::registry::read_index_cache(runtime);
    endorsement_from_index(zip_sha256, manifest, index.as_ref())
}

/// `check_index_endorsement` 的纯函数部分：索引由调用方喂进来，
/// 单测因此不需要触碰缓存文件与全局信任表。
fn endorsement_from_index(
    zip_sha256: &str,
    manifest: &Value,
    index: Option<&Value>,
) -> Result<(bool, String), String> {
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let Some(index) = index else {
        return Ok((false, "未签名（索引缓存不可用，未做索引校验）".to_string()));
    };
    let Some(entries) = index.get("mods").and_then(Value::as_array) else {
        return Ok((false, "未签名（索引里没有 mods 数组）".to_string()));
    };
    let Some(entry) = entries.iter().find(|item| {
        item.get("id").and_then(Value::as_str).map(str::trim) == Some(id.as_str())
            && item.get("version").and_then(Value::as_str).map(str::trim) == Some(version.as_str())
    }) else {
        return Ok((false, format!("未签名（索引里没有 {id} {version}）")));
    };
    let expected = entry
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if expected.is_empty() {
        return Ok((
            false,
            format!("未签名（索引条目 {id} {version} 没有 sha256）"),
        ));
    }
    if zip_sha256.to_ascii_lowercase() != expected {
        return Err(format!(
            "这个包与索引登记的 {id} {version} 不一致（sha256 不匹配），已拒绝安装"
        ));
    }
    Ok((true, format!("索引背书（{id} {version}）")))
}

pub fn import_mod_zip(repo_root: &Path, zip_path: &str, runtime: &RuntimePaths) -> Value {
    let raw = zip_path.trim();
    let zip = Path::new(raw);
    if raw.is_empty() || !zip.is_file() {
        return json!({ "ok": false, "reason": "找不到 ZIP 文件" });
    }
    let is_zip = zip
        .extension()
        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        return json!({ "ok": false, "reason": "只支持 .zip 文件" });
    }
    if let Err(reason) = assert_zip_entries_safe(zip) {
        return json!({ "ok": false, "reason": reason });
    }
    // A2：整包哈希先算出来 —— 既用于与索引对账，也回给渲染层/作者对账
    let (zip_sha256, zip_bytes) = match sha256_file(zip) {
        Ok(value) => value,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };

    let temp_root = runtime.temp.join(format!("mod-import-{}", epoch_ms()));
    let outcome = (|| -> Result<Value, String> {
        expand_archive(zip, &temp_root)?;
        let package_root = locate_package_root(&temp_root)?;
        let manifest = scan::read_manifest(&package_root.join(MANIFEST_NAME))?;
        let manifest_value = Value::Object(manifest.clone());
        // A2：索引对账不通过就直接失败，绝不让改过的包落进 mods/
        let (trusted, note) = check_index_endorsement(&zip_sha256, &manifest_value, runtime)?;
        let own = crate::mods::sign::verify_manifest_signature(&manifest_value);

        let manifest_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let zip_stem = zip
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let from_id = sanitize_folder_name(&manifest_id);
        let folder = if !from_id.is_empty() {
            from_id
        } else {
            let from_zip = sanitize_folder_name(&zip_stem);
            if from_zip.is_empty() {
                "imported-mod".to_string()
            } else {
                from_zip
            }
        };

        // B1：folder 可能来自 ZIP 清单里的 id（远端数据），必须做包含判定
        let target = crate::mods::join_within(&crate::mods::mods_root(repo_root), &folder)
            .ok_or_else(|| format!("安装目录名非法：{folder}"))?;
        if target.exists() {
            return Err(format!("已存在同名模组目录：{folder}"));
        }
        if let Err(err) = fs::create_dir_all(crate::mods::mods_root(repo_root)) {
            return Err(format!("创建 mods 目录失败：{err}"));
        }
        copy_dir_all(&package_root, &target).map_err(|err| format!("复制模组目录失败：{err}"))?;

        // 强制禁用
        let mut disabled_after_import = false;
        let enabled_loader = target.join(scan::LOADER_ENABLED);
        let disabled_loader = target.join(scan::LOADER_DISABLED);
        if enabled_loader.is_file()
            && !disabled_loader.exists()
            && fs::rename(&enabled_loader, &disabled_loader).is_ok()
        {
            disabled_after_import = true;
        }

        let record = scan::read_mod_dir(&folder, &target);
        Ok(result_obj(vec![
            ("ok", json!(true)),
            ("folder", json!(folder)),
            ("id", json!(record.id)),
            ("displayName", json!(record.display_name)),
            ("disabledAfterImport", json!(disabled_after_import)),
            // A2：索引背书 = 维护者收录过这个字节串；包内自称的签名只作参考
            ("trusted", json!(trusted)),
            ("trustNote", json!(note)),
            ("sha256", json!(zip_sha256)),
            ("sizeBytes", json!(zip_bytes)),
            ("signed", json!(own.state.as_str())),
            ("selfSignedByTrustedKey", json!(own.trusted)),
        ]))
    })();

    cleanup_path(&temp_root);
    match outcome {
        Ok(value) => value,
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}
/* ------------------------------ 覆盖更新 ------------------------------ */

/// 覆盖更新一个已安装的模组。
///
/// 步骤：解包到临时目录读清单 → 备份旧目录 → 导入新包 → 还原启用状态 →
/// 还原用户私有数据 → 还原排序位置。
/// 备份留在 `_launcher/temp/mod-backup/`，失败可人工回滚。
pub fn update_mod(repo_root: &Path, zip_path: &str, runtime: &RuntimePaths) -> Value {
    let raw = zip_path.trim();
    let zip = Path::new(raw);
    if raw.is_empty() || !zip.is_file() {
        return json!({ "ok": false, "reason": format!("ZIP 不存在：{raw}") });
    }
    if let Err(reason) = assert_zip_entries_safe(zip) {
        return json!({ "ok": false, "reason": reason });
    }

    // 1) 先解到临时目录，只为读出 id 与版本
    let probe_dir = runtime.temp.join(format!("update-probe-{}", epoch_ms()));
    if let Err(err) = expand_archive(zip, &probe_dir) {
        cleanup_path(&probe_dir);
        return json!({ "ok": false, "reason": format!("解包失败：{err}") });
    }
    let Some(root) = find_manifest_root(&probe_dir) else {
        cleanup_path(&probe_dir);
        return json!({ "ok": false, "reason": format!("ZIP 里没有 {MANIFEST_NAME}") });
    };
    let probe_folder = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let probe = scan::read_mod_dir(&probe_folder, &root);
    let id = probe.id.trim().to_string();
    let new_version = probe.version.clone();
    cleanup_path(&probe_dir);

    if id.is_empty() {
        return json!({ "ok": false, "reason": "ZIP 里的清单缺少 id" });
    }

    // 目录名与导入保持一致（导入用 safeFolderName(id) 建目录），否则「已装」判断会错位
    let sanitized = sanitize_folder_name(&id);
    let folder = if sanitized.is_empty() {
        id.clone()
    } else {
        sanitized
    };
    let mods_dir = crate::mods::mods_root(repo_root);
    // B1：folder 源自远端索引 id，拼路径要通过组件级包含判定
    let Some(mut target) = crate::mods::join_within(&mods_dir, &folder) else {
        return result_obj(vec![
            ("ok", json!(false)),
            ("id", json!(id)),
            ("reason", json!("模组目录名非法")),
        ]);
    };
    let installed = target.is_dir();

    // 没装过就直接当新装
    if !installed {
        let imported = import_mod_zip(repo_root, zip_path, runtime);
        let ok = imported.get("ok").and_then(Value::as_bool).unwrap_or(false);
        return result_obj(vec![
            ("ok", json!(ok)),
            ("id", json!(id)),
            (
                "folder",
                imported
                    .get("folder")
                    .and_then(Value::as_str)
                    .map(|value| json!(value))
                    .unwrap_or_else(|| json!(folder)),
            ),
            ("newVersion", json!(new_version)),
            (
                "reason",
                imported.get("reason").cloned().unwrap_or(Value::Null),
            ),
        ]);
    }

    let previous = scan::read_mod_dir(&folder, &target);
    let was_enabled = previous.enabled;
    let order = plan::read_mod_order(runtime);
    let id_lower = folder.to_lowercase();
    let order_index = order
        .iter()
        .position(|item| item.to_lowercase() == id_lower);

    // 2) 备份旧目录
    let previous_version = if previous.version.is_empty() {
        "0".to_string()
    } else {
        previous.version.clone()
    };
    let backup_dir = runtime
        .temp
        .join("mod-backup")
        .join(format!("{folder}-{previous_version}-{}", epoch_ms()));
    let backup = (|| -> std::io::Result<()> {
        if let Some(parent) = backup_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_dir_all(&target, &backup_dir)?;
        fs::remove_dir_all(&target)
    })();
    if let Err(err) = backup {
        return json!({ "ok": false, "reason": format!("备份旧目录失败：{err}") });
    }

    // 3) 导入新包（此时目标不存在，import_mod_zip 会成功；它强制禁用）
    let imported = import_mod_zip(repo_root, zip_path, runtime);
    if imported.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = imported
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // 回滚
        cleanup_path(&target);
        let _ = copy_dir_all(&backup_dir, &target);
        return result_obj(vec![
            ("ok", json!(false)),
            ("id", json!(id)),
            ("folder", json!(folder)),
            ("previousVersion", json!(previous.version)),
            (
                "reason",
                json!(format!("导入新版本失败（已回滚）：{reason}")),
            ),
        ]);
    }

    let actual_folder = imported
        .get("folder")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| folder.clone());
    // B1：imported.folder 来自刚导入的包，同样只接受白名单目录名
    let Some(next) = crate::mods::join_within(&mods_dir, &actual_folder) else {
        return result_obj(vec![
            ("ok", json!(false)),
            ("id", json!(id)),
            ("reason", json!("模组目录名非法")),
        ]);
    };
    target = next;

    // 4) 还原启用状态
    if was_enabled {
        let disabled = target.join(scan::LOADER_DISABLED);
        let enabled = target.join(scan::LOADER_ENABLED);
        if disabled.is_file() && !enabled.exists() {
            let _ = fs::rename(&disabled, &enabled);
        }
    }

    // 5) 还原用户私有数据：新包里没有的照搬旧的；两边都有的把新的另存 .new（不覆盖用户改动）
    let mut restored: Vec<String> = Vec::new();
    let mut kept_as_new: Vec<String> = Vec::new();
    for name in USER_DATA_NAMES {
        let old_path = backup_dir.join(name);
        if !old_path.exists() {
            continue;
        }
        let new_path = target.join(name);
        if !new_path.exists() {
            if copy_any(&old_path, &new_path).is_ok() {
                restored.push(name.to_string());
            }
            continue;
        }
        let stash = PathBuf::from(format!("{}.new", new_path.display()));
        if copy_any(&new_path, &stash).is_ok() {
            cleanup_path(&new_path);
            if copy_any(&old_path, &new_path).is_ok() {
                kept_as_new.push(name.to_string());
            }
        }
    }

    // 6) 还原排序位置（新目录名与 id 一致，只需保证它还在原下标）
    if let Some(index) = order_index {
        let mut next: Vec<String> = plan::read_mod_order(runtime)
            .into_iter()
            .filter(|item| item.to_lowercase() != actual_folder.to_lowercase())
            .collect();
        let position = index.min(next.len());
        next.insert(position, actual_folder.clone());
        let _ = plan::set_mod_order(runtime, &next);
    }

    result_obj(vec![
        ("ok", json!(true)),
        ("id", json!(id)),
        ("folder", json!(actual_folder)),
        ("previousVersion", json!(previous.version)),
        ("newVersion", json!(new_version)),
        ("backupDir", json!(backup_dir.to_string_lossy())),
        ("restored", json!(restored)),
        ("keptAsNew", json!(kept_as_new)),
    ])
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evejs-mods-pkg-{tag}-{}", epoch_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn runtime_at(root: &Path) -> RuntimePaths {
        let runtime = RuntimePaths::from_root(root.join("_launcher"), false);
        for dir in [&runtime.root, &runtime.temp] {
            fs::create_dir_all(dir).expect("建运行时目录");
        }
        runtime
    }

    fn write_manifest(dir: &Path, id: &str, version: &str) {
        fs::create_dir_all(dir).expect("建模组目录");
        let manifest = json!({
            "schemaVersion": 3,
            "id": id,
            "displayName": "测试模组",
            "version": version,
            "kind": "loader",
            "restart": "none",
            "activation": { "strategy": "loader_rename" }
        });
        fs::write(
            dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .expect("写清单");
    }

    /// 手搓一个 stored（不压缩）ZIP：只为验证条目名解析与路径穿越防线，
    /// 不需要真 CRC，因为这两条路上都不会真的解压。
    fn write_stored_zip(path: &Path, entries: &[(&str, &str)]) {
        let with_modes: Vec<(&str, &str, u32)> = entries
            .iter()
            .map(|(name, contents)| (*name, *contents, 0))
            .collect();
        write_stored_zip_with_modes(path, &with_modes);
    }

    /// 同 `write_stored_zip`，但可指定 Unix 模式（写进中央目录的 external attributes）
    fn write_stored_zip_with_modes(path: &Path, entries: &[(&str, &str, u32)]) {
        let mut out: Vec<u8> = Vec::new();
        let mut offsets: Vec<u32> = Vec::new();
        for (name, contents, _mode) in entries {
            offsets.push(out.len() as u32);
            let name_bytes = name.as_bytes();
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(contents.len() as u32).to_le_bytes());
            out.extend_from_slice(&(contents.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(contents.as_bytes());
        }
        let central_offset = out.len() as u32;
        for ((name, contents, mode), offset) in entries.iter().zip(offsets.iter()) {
            let name_bytes = name.as_bytes();
            out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(contents.len() as u32).to_le_bytes());
            out.extend_from_slice(&(contents.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&(mode << 16).to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(name_bytes);
        }
        let central_size = out.len() as u32 - central_offset;
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        fs::write(path, out).expect("写测试 ZIP");
    }

    #[test]
    fn entry_is_safe_blocks_escapes() {
        assert!(entry_is_safe("loader.js"));
        assert!(entry_is_safe("mod/loader.js"));
        for bad in [
            "",
            "   ",
            "/abs.js",
            "\\abs.js",
            "C:/abs.js",
            "c:x.js",
            "../up.js",
            "a/../../b.js",
            "bad\u{1}.js",
        ] {
            assert!(!entry_is_safe(bad), "{bad} 应被拒绝");
        }
    }

    /// A3 夹具：含 `..` / 绝对路径 / 盘符 / 符号链接的 ZIP 必须在解压前被拒，
    /// 且临时目录外不会多出任何文件
    #[test]
    fn assert_zip_entries_safe_rejects_traversal_and_symlinks() {
        /// (zip 名, [(条目名, 内容, unix 模式)])
        type ZipCase<'a> = (&'a str, Vec<(&'a str, &'a str, u32)>);
        let root = temp_dir("zip-traversal");
        let cases: Vec<ZipCase<'_>> = vec![
            ("dotdot.zip", vec![("../evil.js", "x", 0)]),
            ("nested-dotdot.zip", vec![("a/../../evil.js", "x", 0)]),
            ("windows-dotdot.zip", vec![("..\\..\\evil.js", "x", 0)]),
            ("absolute.zip", vec![("/etc/passwd", "x", 0)]),
            ("drive.zip", vec![("C:/Windows/System32/calc.exe", "x", 0)]),
            // 0xA1FF = S_IFLNK | 0777：解压出来可能是指向任意位置的链接
            ("symlink.zip", vec![("link.js", "../../../evil.js", 0xA1FF)]),
        ];
        for (name, entries) in &cases {
            let case_dir = root.join(name.trim_end_matches(".zip"));
            fs::create_dir_all(&case_dir).unwrap();
            let zip = case_dir.join(name);
            write_stored_zip_with_modes(&zip, entries);
            let err = assert_zip_entries_safe(&zip).unwrap_err();
            assert!(
                err.contains("不安全的条目名") || err.contains("符号链接"),
                "{name} 的拒绝理由不对：{err}"
            );
            // 断言「没有被解压出来」：这个用例目录里只有 ZIP 自己
            let leaked: Vec<String> = fs::read_dir(&case_dir)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|item| item != name)
                .collect();
            assert!(leaked.is_empty(), "{name} 疑似解压出额外文件：{leaked:?}");
        }

        // 正常条目（含子目录、中文名、点开头的文件）必须放行
        let ok_zip = root.join("good.zip");
        write_stored_zip_with_modes(
            &ok_zip,
            &[
                (MANIFEST_NAME, "{}", 0),
                ("loader.js", "x", 0o100644),
                ("data/说明.txt", "x", 0),
                (".gitignore", "x", 0),
            ],
        );
        assert_zip_entries_safe(&ok_zip).unwrap();
    }

    /// A2：索引背书判定（纯函数，不碰缓存与信任表）
    #[test]
    fn endorsement_requires_matching_index_sha256() {
        let manifest = json!({ "id": "demo.mod", "version": "1.0.0" });
        let index = json!({
            "mods": [
                { "id": "demo.mod", "version": "1.0.0", "sha256": "aa11" },
                { "id": "demo.mod", "version": "0.9.0", "sha256": "bb22" },
                { "id": "other.mod", "version": "1.0.0", "sha256": "cc33" }
            ]
        });

        // 命中且哈希一致 → 索引背书
        let (trusted, note) = endorsement_from_index("aa11", &manifest, Some(&index)).unwrap();
        assert!(trusted);
        assert!(note.contains("索引背书"));

        // 大小写不敏感
        let (trusted, _) = endorsement_from_index("AA11", &manifest, Some(&index)).unwrap();
        assert!(trusted);

        // 命中但哈希不一致 → 拒绝安装
        let err = endorsement_from_index("ff00", &manifest, Some(&index)).unwrap_err();
        assert!(err.contains("sha256 不匹配"), "{err}");

        // 索引里只有别的版本 → 未签名（放行但标记）
        let (trusted, note) = endorsement_from_index(
            "aa11",
            &manifest,
            Some(&json!({
                "mods": [{ "id": "demo.mod", "version": "2.0.0", "sha256": "aa11" }]
            })),
        )
        .unwrap();
        assert!(!trusted);
        assert!(note.contains("未签名"), "{note}");

        // 缓存不可用 / 没有 sha256 → 未签名
        let (trusted, note) = endorsement_from_index("aa11", &manifest, None).unwrap();
        assert!(!trusted && note.contains("索引缓存不可用"), "{note}");
        let (trusted, note) = endorsement_from_index(
            "aa11",
            &manifest,
            Some(&json!({ "mods": [{ "id": "demo.mod", "version": "1.0.0" }] })),
        )
        .unwrap();
        assert!(!trusted && note.contains("没有 sha256"), "{note}");
    }

    /// A2 端到端：手工导入的包若命中索引且哈希不一致，必须拒装且不留目录
    #[test]
    fn import_refuses_tampered_package_when_index_disagrees() {
        use crate::mods::sign;
        let root = temp_dir("import-endorse");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        // 1) 打一个合法的模组包
        let source = root.join("src").join("demo.mod");
        write_manifest(&source, "demo.mod", "1.0.0");
        fs::write(source.join(scan::LOADER_ENABLED), "// loader\n").unwrap();
        let zip = root.join("demo.zip");
        let packed = pack_mod_zip(&source, &zip);
        assert_eq!(packed["ok"], json!(true), "{packed}");

        // 2) 造一份「索引里登记了另一个哈希」的缓存（签名用测试密钥，注入信任表）
        let key = sign::generate_signing_key().unwrap();
        let key_id = sign::key_id_of(&key);
        sign::trust_public_key(&key_id, &sign::public_key_base64(&key));
        let mut index = json!({
            "schemaVersion": 1,
            "mods": [{ "id": "demo.mod", "version": "1.0.0", "sha256": "00ff" }]
        });
        index["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id,
            "sig": sign::sign_manifest(&index, &key)
        });
        fs::create_dir_all(&runtime.cache).unwrap();
        fs::write(
            crate::mods::registry::cache_path(&runtime),
            serde_json::to_string(&json!({ "fetchedAt": 1, "index": index })).unwrap(),
        )
        .unwrap();

        // 3) 索引说哈希不对 → 拒装，mods/ 下不留任何东西
        let refused = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(refused["ok"], json!(false), "{refused}");
        assert!(
            refused["reason"]
                .as_str()
                .unwrap()
                .contains("sha256 不匹配"),
            "{refused}"
        );
        assert!(
            !repo.join("mods").join("demo.mod").exists(),
            "拒装后不该留目录"
        );

        // 4) 把索引改成真实哈希 → 通过，并标为索引背书
        let real = packed["sha256"].as_str().unwrap().to_string();
        let mut index = json!({
            "schemaVersion": 1,
            "mods": [{ "id": "demo.mod", "version": "1.0.0", "sha256": real }]
        });
        index["signature"] = json!({
            "alg": "ed25519",
            "keyId": key_id,
            "sig": sign::sign_manifest(&index, &key)
        });
        fs::write(
            crate::mods::registry::cache_path(&runtime),
            serde_json::to_string(&json!({ "fetchedAt": 1, "index": index })).unwrap(),
        )
        .unwrap();
        let accepted = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(accepted["ok"], json!(true), "{accepted}");
        assert_eq!(accepted["trusted"], json!(true), "{accepted}");
        assert_eq!(accepted["sha256"], json!(real));
        assert!(repo.join("mods").join("demo.mod").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_entry_names_reads_central_directory() {
        let root = temp_dir("zipnames");
        let zip = root.join("names.zip");
        write_stored_zip(&zip, &[("a/loader.js", "x"), (MANIFEST_NAME, "{}")]);
        let names = zip_entry_names(&zip).expect("应能解析中央目录");
        assert_eq!(
            names,
            vec!["a/loader.js".to_string(), MANIFEST_NAME.to_string()]
        );

        let truncated = root.join("truncated.zip");
        let bytes = fs::read(&zip).unwrap();
        fs::write(&truncated, &bytes[..10]).unwrap();
        assert!(zip_entry_names(&truncated).is_err(), "截断的 ZIP 必须报错");
    }

    #[test]
    fn find_manifest_root_prefers_root_then_single_nested() {
        let root = temp_dir("manifest-root");
        assert!(find_manifest_root(&root).is_none());

        let nested = root.join("package");
        write_manifest(&nested, "pkg", "1.0.0");
        assert_eq!(find_manifest_root(&root).as_deref(), Some(nested.as_path()));

        // 多了一层无清单的目录 → 不再猜
        fs::create_dir_all(root.join("noise")).unwrap();
        assert!(find_manifest_root(&root).is_none());

        // 根自己有清单 → 优先用根
        write_manifest(&root, "root-pkg", "1.0.0");
        assert_eq!(find_manifest_root(&root).as_deref(), Some(root.as_path()));
    }

    #[test]
    fn pack_mod_zip_reports_missing_source() {
        let root = temp_dir("pack-missing");
        let packed = pack_mod_zip(&root.join("nope"), &root.join("out.zip"));
        assert_eq!(packed["ok"], json!(false));
        assert!(packed["reason"].as_str().unwrap().contains("源目录不存在"));
    }

    #[test]
    fn import_forces_disabled_and_blocks_duplicates() {
        let root = temp_dir("import");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let source = root.join("src");
        write_manifest(&source, "demo-mod", "1.0.0");
        fs::write(source.join("loader.js"), "require('./x.js')\n").unwrap();
        let zip = root.join("demo.zip");
        let packed = pack_mod_zip(&source, &zip);
        assert_eq!(packed["ok"], json!(true), "{packed}");
        assert_eq!(packed["sha256"].as_str().unwrap().len(), 64);

        let imported = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(imported["ok"], json!(true), "{imported}");
        assert_eq!(imported["folder"], json!("demo-mod"));
        assert_eq!(imported["id"], json!("demo-mod"));
        assert_eq!(imported["disabledAfterImport"], json!(true));

        let target = repo.join("mods").join("demo-mod");
        assert!(!target.join(scan::LOADER_ENABLED).exists());
        assert!(target.join(scan::LOADER_DISABLED).is_file());

        let again = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(again["ok"], json!(false));
        assert!(again["reason"]
            .as_str()
            .unwrap()
            .contains("已存在同名模组目录"));

        let leftovers: Vec<String> = fs::read_dir(&runtime.temp)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("mod-import-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录应清理干净：{leftovers:?}");
    }

    #[test]
    fn import_rejects_zip_traversal() {
        let root = temp_dir("traversal");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let zip = root.join("evil.zip");
        write_stored_zip(&zip, &[("../pwned.js", "x"), (MANIFEST_NAME, "{}")]);
        let result = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(result["ok"], json!(false));
        assert!(
            result["reason"].as_str().unwrap().contains("不安全"),
            "{result}"
        );
        assert!(!root.join("pwned.js").exists());
        assert!(!runtime.temp.join("pwned.js").exists());
    }

    #[test]
    fn import_rejects_non_zip_extension_and_unsafe_manifest_id() {
        let root = temp_dir("unsafe-id");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let txt = root.join("plain.txt");
        fs::write(&txt, "nope").unwrap();
        let bad_ext = import_mod_zip(&repo, txt.to_string_lossy().as_ref(), &runtime);
        assert_eq!(bad_ext["reason"], json!("只支持 .zip 文件"));

        // 清单里的 id 带路径分隔符 → 被 safeFolderName 消毒成 '-'（与现役版一致）
        let squashed = root.join("src-squashed");
        write_manifest(&squashed, "..\\evil", "1.0.0");
        let squashed_zip = root.join("squashed.zip");
        assert_eq!(pack_mod_zip(&squashed, &squashed_zip)["ok"], json!(true));
        let first = import_mod_zip(&repo, squashed_zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(first["ok"], json!(true), "{first}");
        assert_eq!(first["folder"], json!("-evil"));
        assert!(repo.join("mods").join("-evil").is_dir());

        // 消毒后什么都不剩 → 退回 ZIP 文件名
        let source = root.join("src");
        write_manifest(&source, "...", "1.0.0");
        let zip = root.join("fallback-name.zip");
        assert_eq!(pack_mod_zip(&source, &zip)["ok"], json!(true));
        let imported = import_mod_zip(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(imported["ok"], json!(true), "{imported}");
        assert_eq!(imported["folder"], json!("fallback-name"));
        assert!(repo.join("mods").join("fallback-name").is_dir());
    }

    #[test]
    fn update_mod_keeps_user_data_and_restores_enabled() {
        let root = temp_dir("update");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        // 先装 v1.0.0（手工放好并处于启用态）
        let installed = repo.join("mods").join("demo.mod");
        write_manifest(&installed, "demo.mod", "1.0.0");
        fs::write(installed.join(scan::LOADER_ENABLED), "require('./a.js')\n").unwrap();
        fs::write(installed.join("settings.json"), "{\"from\":\"user\"}").unwrap();
        let _ = plan::set_mod_order(&runtime, &["other".to_string(), "demo.mod".to_string()]);

        // v2.0.0 的包：自带的 settings.json 是新的
        let source = root.join("src-v2");
        write_manifest(&source, "demo.mod", "2.0.0");
        fs::write(source.join(scan::LOADER_ENABLED), "require('./b.js')\n").unwrap();
        fs::write(source.join("settings.json"), "{\"from\":\"pack\"}").unwrap();
        let zip = root.join("demo-2.0.0.zip");
        assert_eq!(pack_mod_zip(&source, &zip)["ok"], json!(true));

        let updated = update_mod(&repo, zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(updated["ok"], json!(true), "{updated}");
        assert_eq!(updated["id"], json!("demo.mod"));
        assert_eq!(updated["previousVersion"], json!("1.0.0"));
        assert_eq!(updated["newVersion"], json!("2.0.0"));
        assert_eq!(updated["restored"], json!(Vec::<String>::new()));

        // 启用状态还原
        assert!(installed.join(scan::LOADER_ENABLED).is_file());
        // 用户数据保留，新包的同名文件另存 .new
        assert_eq!(
            fs::read_to_string(installed.join("settings.json")).unwrap(),
            "{\"from\":\"user\"}"
        );
        assert_eq!(
            fs::read_to_string(installed.join("settings.json.new")).unwrap(),
            "{\"from\":\"pack\"}"
        );
        // 排序位置还原
        assert_eq!(
            plan::read_mod_order(&runtime),
            vec!["other".to_string(), "demo.mod".to_string()]
        );
        // 备份留在 _launcher/temp/mod-backup 下
        let backup = PathBuf::from(updated["backupDir"].as_str().unwrap());
        assert!(backup.is_dir());
        assert!(backup.join(scan::LOADER_ENABLED).is_file());

        // 未装过的 id → 当作新装
        let fresh_source = root.join("src-fresh");
        write_manifest(&fresh_source, "brand-new", "1.0.0");
        fs::write(fresh_source.join(scan::LOADER_ENABLED), "x\n").unwrap();
        let fresh_zip = root.join("brand-new.zip");
        assert_eq!(pack_mod_zip(&fresh_source, &fresh_zip)["ok"], json!(true));
        let fresh = update_mod(&repo, fresh_zip.to_string_lossy().as_ref(), &runtime);
        assert_eq!(fresh["ok"], json!(true), "{fresh}");
        assert_eq!(fresh["folder"], json!("brand-new"));
        assert_eq!(fresh["newVersion"], json!("1.0.0"));
        assert!(repo
            .join("mods")
            .join("brand-new")
            .join(scan::LOADER_DISABLED)
            .is_file());
    }
}
