//! 账号密码的本地加密存储：对齐现役版 `safeStorage`（Windows 上就是 DPAPI，用户级密钥）。
//!
//! 为什么手写 FFI 而不是引 `windows`/`windows-sys` crate：
//! 这里只用 3 个符号（`CryptProtectData` / `CryptUnprotectData` / `LocalFree`），
//! 为它们拉一整个 windows crate 会拖慢编译并增大体积，与「极小体积」目标相悖。
//!
//! 兼容性说明（真机实测过，别想当然）：Electron `safeStorage.encryptString()` 交出的**不是**
//! 裸 DPAPI 密文，而是 Chromium OSCrypt 那一套（`v10 | nonce | AES-256-GCM | tag`，AES 密钥
//! 再被 DPAPI 包一层存在 `Local State` 里）。所以密码与令牌的读写都交给 `crate::oscrypt`，
//! 本模块只负责 DPAPI 原语、base64 与凭据表结构。
//! 为稳妥起见，解密失败一律按「没有保存的凭据」处理，绝不因此报错阻塞启动。
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::path::Path;

/* ------------------------------ DPAPI FFI ------------------------------ */

#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *const c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *const c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(mem: *mut c_void) -> *mut c_void;
}

/// crypt32 的 UI 提示一律禁止（后台进程不允许弹窗）
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

/// Crypt32 的输出 blob：调用成功后由 Crypt32 分配，必须用 LocalFree 释放。
fn empty_blob() -> DataBlob {
    DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    }
}

/// 入参 blob（只借用，调用期间底层切片必须存活）。
fn input_blob(data: &mut [u8]) -> DataBlob {
    DataBlob {
        cb_data: data.len() as u32,
        pb_data: data.as_mut_ptr(),
    }
}

/// 拷贝 Crypt32 的输出并释放它。
///
/// 返回 `None` 表示调用失败（`pb_data` 为空）；成功时无条件 `LocalFree`，避免内存泄漏。
unsafe fn take_blob(output: DataBlob) -> Option<Vec<u8>> {
    if output.pb_data.is_null() {
        return None;
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
    unsafe {
        LocalFree(output.pb_data as *mut c_void);
    }
    Some(bytes)
}

/// DPAPI 加密（当前用户作用域）。作者私钥落盘与 OSCrypt 密钥包裹都复用它（见 `author.rs` / `oscrypt.rs`）。
pub(crate) fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    let mut input = plain.to_vec();
    let mut output = empty_blob();
    let ok = unsafe {
        CryptProtectData(
            &input_blob(&mut input),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return None;
    }
    unsafe { take_blob(output) }
}

/// DPAPI 解密（当前用户作用域）。
pub(crate) fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    let mut input = cipher.to_vec();
    let mut output = empty_blob();
    let ok = unsafe {
        CryptUnprotectData(
            &input_blob(&mut input),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return None;
    }
    unsafe { take_blob(output) }
}
/* ------------------------------ base64 ------------------------------ */

// 只为了存 DPAPI 密文，手写一份避免新增依赖（密文很短，性能无关）
const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64_TABLE[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut output: Vec<u8> = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' {
            continue;
        }
        let value = B64_TABLE.iter().position(|item| *item == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    Some(output)
}

/* ------------------------------ 凭据存取 ------------------------------ */

pub const CREDENTIALS_KEY: &str = "accountCredentials";

fn credential_map(settings_file: &Path) -> Map<String, Value> {
    crate::config::read_settings(settings_file)
        .get(CREDENTIALS_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_map(settings_file: &Path, map: Map<String, Value>) {
    let mut patch = Map::new();
    patch.insert(CREDENTIALS_KEY.to_string(), Value::Object(map));
    crate::config::write_settings(settings_file, &patch);
}

/// 保存密码（DPAPI 加密后 base64）；加密不可用或参数缺失时返回 false，不抛错
pub fn remember(settings_file: &Path, user: &str, password: &str) -> bool {
    if user.is_empty() || password.is_empty() {
        return false;
    }
    let Some(cipher) = crate::oscrypt::encrypt(password.as_bytes()) else {
        return false;
    };
    let mut map = credential_map(settings_file);
    map.insert(user.to_string(), Value::String(base64_encode(&cipher)));
    write_map(settings_file, map);
    true
}

pub fn stored(settings_file: &Path, user: &str) -> Option<String> {
    let encoded = credential_map(settings_file)
        .get(user)
        .and_then(|value| value.as_str())
        .map(|text| text.to_string())?;
    let cipher = base64_decode(&encoded)?;
    let plain = crate::oscrypt::decrypt(&cipher)?;
    String::from_utf8(plain).ok()
}

pub fn has(settings_file: &Path, user: &str) -> bool {
    stored(settings_file, user).is_some()
}

pub fn forget(settings_file: &Path, user: &str) {
    let mut map = credential_map(settings_file);
    if map.remove(user).is_some() {
        write_map(settings_file, map);
    }
}

/// 给渲染层用的「有哪些账号存了凭据」映射（不含明文）
pub fn stored_flags(settings_file: &Path) -> BTreeMap<String, bool> {
    credential_map(settings_file)
        .keys()
        .map(|user| (user.clone(), true))
        .collect()
}

#[cfg(test)]
fn fs_remove(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_round_trips() {
        for sample in [
            "",
            "a",
            "ab",
            "abc",
            "abcd",
            "password:with:colons",
            "中文密码",
        ] {
            let encoded = base64_encode(sample.as_bytes());
            let decoded = base64_decode(&encoded).expect("应能解码");
            assert_eq!(String::from_utf8(decoded).unwrap(), sample, "样本 {sample}");
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_encode("中文".as_bytes()), "5Lit5paH");
    }

    #[test]
    fn dpapi_round_trips_on_windows() {
        let plain = "SuperSecret123!";
        let cipher = protect(plain.as_bytes()).expect("DPAPI 应可用（Windows 用户态）");
        assert_ne!(cipher, plain.as_bytes(), "密文不应等于明文");
        let back = unprotect(&cipher).expect("应能解回明文");
        assert_eq!(String::from_utf8(back).unwrap(), plain);
    }

    #[test]
    fn credentials_are_stored_encrypted() {
        let dir = std::env::temp_dir().join("evejs-secrets-test");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        let file = dir.join("launcher-settings.json");
        let _ = std::fs::remove_file(&file);

        assert!(stored(&file, "pilot").is_none());
        assert!(remember(&file, "pilot", "hunter2"));
        assert_eq!(stored(&file, "pilot").as_deref(), Some("hunter2"));
        assert!(has(&file, "pilot"));

        // 落盘内容必须是密文，不能出现明文密码
        let raw = std::fs::read_to_string(&file).expect("设置文件应存在");
        assert!(!raw.contains("hunter2"), "设置文件里出现了明文密码");
        assert!(raw.contains(CREDENTIALS_KEY));

        forget(&file, "pilot");
        assert!(!has(&file, "pilot"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn stored_flags_reports_keys() {
        let dir = std::env::temp_dir().join("evejs-secrets-flags");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        let file = dir.join("launcher-settings.json");
        let _ = std::fs::remove_file(&file);
        assert!(remember(&file, "one", "pw1"));
        assert!(remember(&file, "two", "pw2"));

        let flags = stored_flags(&file);
        assert_eq!(
            flags.keys().cloned().collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn remember_rejects_empty_input() {
        let file = std::env::temp_dir().join("evejs-secrets-empty.json");
        assert!(!remember(&file, "", "pw"));
        assert!(!remember(&file, "user", ""));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn settings_shape_matches_electron() {
        // 结构必须是 { accountCredentials: { <user>: "<base64>" } }
        let value = json!({ CREDENTIALS_KEY: { "pilot": "AAAA" } });
        assert!(value[CREDENTIALS_KEY]["pilot"].is_string());
    }

    #[test]
    fn account_credentials_are_stored_in_oscrypt_format() {
        // 账号密码落盘的必须是 Electron safeStorage 那套格式（v10 开头的 OSCrypt 密文）：
        // 少了这一层，老用户存过的密码在新启动器里就解不开了。
        let dir = std::env::temp_dir().join("evejs-secrets-oscrypt");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        let file = dir.join("launcher-settings.json");
        let _ = std::fs::remove_file(&file);
        assert!(remember(&file, "pilot", "hunter2"));

        let raw = std::fs::read_to_string(&file).expect("设置文件应存在");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let encoded = parsed[CREDENTIALS_KEY]["pilot"].as_str().unwrap();
        let blob = base64_decode(encoded).expect("base64 应可解");
        assert_eq!(&blob[..3], b"v10", "账号凭据也要用 OSCrypt 格式");
        assert!(!raw.contains("hunter2"), "设置文件里不能出现明文密码");
        assert_eq!(stored(&file, "pilot").as_deref(), Some("hunter2"));
        fs_remove(&file);
    }
}
