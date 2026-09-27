//! 与 Electron `safeStorage`（Chromium OSCrypt）互通的密文读写。
//!
//! 为什么需要它（别想当然）：老（Electron）启动器保存 GitHub 令牌与账号密码时，用的
//! **不是**裸 DPAPI，而是 Chromium 的 OSCrypt。真机实测（把老启动器编译产物里的
//! `saveToken()` 真的跑一遍，再拿它写出的字节去解）确认格式是：
//!
//! ```text
//! "v10" | nonce(12) | AES-256-GCM 密文 | tag(16)
//! ```
//!
//! 而那个 AES 密钥本身用 DPAPI 包了一层，放在 `Local State` 的
//! `os_crypt.encrypted_key` 里（base64 → 去掉 `DPAPI` 五个字节 → `CryptUnprotectData` → 32 字节）。
//! 老启动器把这个 `Local State` 写在 `<运行时根>/cache/`（它把 electron 的 `sessionData`
//! 指到了那里，见现役版 `runtimePaths.ts`）。
//!
//! 少了这一层，老用户升级过来令牌与账号密码会**全部解不开**（只能重填），正是本次迁移
//! 要杜绝的事。所以本模块负责：
//!   1. 找出可用的 AES 密钥（我们自己的副本 → 本机 `Local State` → 老目录的 `Local State`）；
//!   2. 用 `v10 | nonce | ct | tag` 读写密文；
//!   3. 兼容更早的裸 DPAPI 密文（我们上一版自己写过的那种）。
//!
//! AES-256-GCM 走 Windows CNG（bcrypt.dll）手写 FFI，不引第三方 crate —— 与 `secrets.rs`
//! 手写 DPAPI FFI 同一个理由：为了三五个符号拉一整套依赖不划算。
use crate::runtime::RuntimePaths;
use crate::secrets;
use serde_json::Value;
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 密文版本前缀（Chromium OSCrypt 的 v10 方案）
const PREFIX: &[u8; 3] = b"v10";
/// GCM nonce 长度
const NONCE_LEN: usize = 12;
/// GCM tag 长度
const TAG_LEN: usize = 16;
/// AES-256 密钥长度
pub const KEY_LEN: usize = 32;
/// DPAPI 包裹前的前缀（`os_crypt.encrypted_key` 用）
const DPAPI_KEY_PREFIX: &[u8] = b"DPAPI";
/// 我们自己落盘的 AES 密钥文件名（DPAPI 包裹后放 data 目录）
const KEY_FILE: &str = "os-crypt-key.bin";
/// `Local State` 里放密钥的那一项
pub const LOCAL_STATE_FILE: &str = "Local State";
const OS_CRYPT_PREF: &str = "os_crypt";
const OS_CRYPT_KEY_PREF: &str = "encrypted_key";

/* ------------------------------ CNG (bcrypt) FFI ------------------------------ */

#[repr(C)]
struct AuthCipherModeInfo {
    cb_size: u32,
    dw_info_version: u32,
    pb_nonce: *mut u8,
    cb_nonce: u32,
    pb_auth_data: *mut u8,
    cb_auth_data: u32,
    pb_tag: *mut u8,
    cb_tag: u32,
    pb_mac_context: *mut u8,
    cb_mac_context: u32,
    cb_aad: u32,
    cb_data: u64,
    dw_flags: u32,
}

/// `BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_VERSION`
const AUTH_MODE_INFO_VERSION: u32 = 1;

impl AuthCipherModeInfo {
    fn new(nonce: &mut [u8], tag: &mut [u8]) -> Self {
        Self {
            cb_size: std::mem::size_of::<Self>() as u32,
            dw_info_version: AUTH_MODE_INFO_VERSION,
            pb_nonce: nonce.as_mut_ptr(),
            cb_nonce: nonce.len() as u32,
            pb_auth_data: std::ptr::null_mut(),
            cb_auth_data: 0,
            pb_tag: tag.as_mut_ptr(),
            cb_tag: tag.len() as u32,
            pb_mac_context: std::ptr::null_mut(),
            cb_mac_context: 0,
            cb_aad: 0,
            cb_data: 0,
            dw_flags: 0,
        }
    }
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptOpenAlgorithmProvider(
        ph_algorithm: *mut *mut c_void,
        psz_algorithm: *const u16,
        psz_implementation: *const u16,
        dw_flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(h_algorithm: *mut c_void, dw_flags: u32) -> i32;
    fn BCryptSetProperty(
        h_object: *mut c_void,
        psz_property: *const u16,
        pb_input: *const u8,
        cb_input: u32,
        dw_flags: u32,
    ) -> i32;
    fn BCryptGenerateSymmetricKey(
        h_algorithm: *mut c_void,
        ph_key: *mut *mut c_void,
        pb_key_object: *mut u8,
        cb_key_object: u32,
        pb_secret: *const u8,
        cb_secret: u32,
        dw_flags: u32,
    ) -> i32;
    fn BCryptDestroyKey(h_key: *mut c_void) -> i32;
    fn BCryptEncrypt(
        h_key: *mut c_void,
        pb_input: *const u8,
        cb_input: u32,
        p_padding_info: *mut c_void,
        pb_iv: *mut u8,
        cb_iv: u32,
        pb_output: *mut u8,
        cb_output: u32,
        pcb_result: *mut u32,
        dw_flags: u32,
    ) -> i32;
    fn BCryptDecrypt(
        h_key: *mut c_void,
        pb_input: *const u8,
        cb_input: u32,
        p_padding_info: *mut c_void,
        pb_iv: *mut u8,
        cb_iv: u32,
        pb_output: *mut u8,
        cb_output: u32,
        pcb_result: *mut u32,
        dw_flags: u32,
    ) -> i32;
}

/// Rust 字符串 → 带 NUL 的 UTF-16
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开一个 AES-256-GCM 对称密钥句柄
fn open_gcm_key(key: &[u8; KEY_LEN]) -> Option<*mut c_void> {
    let mut algorithm: *mut c_void = std::ptr::null_mut();
    let aes = wide("AES");
    if unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, aes.as_ptr(), std::ptr::null(), 0) } < 0
    {
        return None;
    }
    let property = wide("ChainingMode");
    let value = wide("ChainingModeGCM");
    let value_bytes =
        unsafe { std::slice::from_raw_parts(value.as_ptr() as *const u8, value.len() * 2) };
    let set = unsafe {
        BCryptSetProperty(
            algorithm,
            property.as_ptr(),
            value_bytes.as_ptr(),
            value_bytes.len() as u32,
            0,
        )
    };
    if set < 0 {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
        return None;
    }
    let mut handle: *mut c_void = std::ptr::null_mut();
    let generated = unsafe {
        BCryptGenerateSymmetricKey(
            algorithm,
            &mut handle,
            std::ptr::null_mut(),
            0,
            key.as_ptr(),
            KEY_LEN as u32,
            0,
        )
    };
    unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
    if generated < 0 || handle.is_null() {
        return None;
    }
    Some(handle)
}

fn gcm_encrypt(key: &[u8; KEY_LEN], nonce: &[u8], plain: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let handle = open_gcm_key(key)?;
    let mut nonce = nonce.to_vec();
    let mut tag = vec![0u8; TAG_LEN];
    let mut info = AuthCipherModeInfo::new(&mut nonce, &mut tag);
    let mut out = vec![0u8; plain.len()];
    let mut done: u32 = 0;
    let status = unsafe {
        BCryptEncrypt(
            handle,
            plain.as_ptr(),
            plain.len() as u32,
            &mut info as *mut AuthCipherModeInfo as *mut c_void,
            std::ptr::null_mut(),
            0,
            out.as_mut_ptr(),
            out.len() as u32,
            &mut done,
            0,
        )
    };
    unsafe { BCryptDestroyKey(handle) };
    if status < 0 {
        return None;
    }
    out.truncate(done as usize);
    Some((out, tag))
}

fn gcm_decrypt(key: &[u8; KEY_LEN], nonce: &[u8], cipher: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
    let handle = open_gcm_key(key)?;
    let mut nonce = nonce.to_vec();
    let mut tag = tag.to_vec();
    let mut info = AuthCipherModeInfo::new(&mut nonce, &mut tag);
    let mut out = vec![0u8; cipher.len()];
    let mut done: u32 = 0;
    let status = unsafe {
        BCryptDecrypt(
            handle,
            cipher.as_ptr(),
            cipher.len() as u32,
            &mut info as *mut AuthCipherModeInfo as *mut c_void,
            std::ptr::null_mut(),
            0,
            out.as_mut_ptr(),
            out.len() as u32,
            &mut done,
            0,
        )
    };
    unsafe { BCryptDestroyKey(handle) };
    if status < 0 {
        return None;
    }
    out.truncate(done as usize);
    Some(out)
}

/* ------------------------------ 密钥来源 ------------------------------ */

/// 我们自己那份 AES 密钥的落盘位置
pub fn key_store_path(runtime: &RuntimePaths) -> PathBuf {
    runtime.user_data.join(KEY_FILE)
}

/// 老启动器把 Chromium 的 `Local State` 放在 `sessionData`，现役版把它指到了 `<根>/cache`
pub fn local_state_in(cache_dir: &Path) -> PathBuf {
    cache_dir.join(LOCAL_STATE_FILE)
}

fn key_from_store(path: &Path) -> Option<[u8; KEY_LEN]> {
    let raw = fs::read(path).ok()?;
    let plain = secrets::unprotect(&raw)?;
    if plain.len() != KEY_LEN {
        return None;
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&plain);
    Some(key)
}

/// 把 `Local State` 里的 `os_crypt.encrypted_key` 还原成 32 字节 AES 密钥
pub fn key_from_local_state(path: &Path) -> Option<[u8; KEY_LEN]> {
    let text = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let encoded = parsed
        .get(OS_CRYPT_PREF)?
        .get(OS_CRYPT_KEY_PREF)?
        .as_str()?;
    let blob = secrets::base64_decode(encoded.trim())?;
    let wrapped = blob.strip_prefix(DPAPI_KEY_PREFIX)?;
    let plain = secrets::unprotect(wrapped)?;
    if plain.len() != KEY_LEN {
        return None;
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&plain);
    Some(key)
}

/// 把密钥明文用 DPAPI 包裹后写进 `path`。`force = false` 时只在文件不存在时写
/// （接管老数据用），`force = true` 时覆盖（文件坏了或内容解不开时重建）。
fn write_key(path: &Path, key: &[u8; KEY_LEN], force: bool) -> bool {
    if !force && path.is_file() {
        return false;
    }
    let Some(wrapped) = secrets::protect(key) else {
        return false;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    fs::write(path, wrapped).is_ok()
}

/// 把一个 AES 密钥用 DPAPI 包裹后落到我们自己的密钥文件里（只在文件不存在时写）
pub fn store_key(runtime: &RuntimePaths, key: &[u8; KEY_LEN]) -> bool {
    write_key(&key_store_path(runtime), key, false)
}

/// 现生成一把 AES 密钥并落盘。只在调用方已经确认「一把密钥都没有」时用。
fn generate_key(runtime: &RuntimePaths) -> Option<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    if getrandom::fill(&mut key).is_err() {
        return None;
    }
    // 就算写盘失败，也用这把内存里的密钥，好过退回裸 DPAPI
    let _ = write_key(&key_store_path(runtime), &key, true);
    Some(key)
}

/// 本机能拿到的全部候选密钥：我们自己的副本 → 本机 `cache/Local State` → data 目录旁的 `Local State`
fn collect_keys(runtime: &RuntimePaths) -> Vec<[u8; KEY_LEN]> {
    let mut seen: BTreeSet<[u8; KEY_LEN]> = BTreeSet::new();
    let mut out: Vec<[u8; KEY_LEN]> = Vec::new();
    let mut push = |key: Option<[u8; KEY_LEN]>| {
        if let Some(key) = key {
            if seen.insert(key) {
                out.push(key);
            }
        }
    };
    push(key_from_store(&key_store_path(runtime)));
    push(key_from_local_state(&local_state_in(&runtime.session_data)));
    push(key_from_local_state(&local_state_in(&runtime.user_data)));
    out
}

/// 进程级密钥表。正常启动会在 `init()` 里提前装好；万一没装（单测、工具进程），
/// 第一次用到时也会按需装好，并且保证至少有一把密钥——绝不悄悄退回裸 DPAPI。
static KEYS: OnceLock<Vec<[u8; KEY_LEN]>> = OnceLock::new();

fn keys() -> &'static Vec<[u8; KEY_LEN]> {
    KEYS.get_or_init(|| {
        let runtime = crate::runtime::active();
        let mut found = collect_keys(runtime);
        if found.is_empty() {
            if let Some(key) = generate_key(runtime) {
                found.push(key);
            }
        }
        found
    })
}

/// 启动时调一次：装好密钥表；一个都找不到就**现生成一把**并落盘，
/// 之后新写的密文就用它（这样即使没接老数据，新启动器自己的令牌也能稳定保存）。
pub fn init(runtime: &RuntimePaths) {
    let mut found = collect_keys(runtime);
    if found.is_empty() {
        if let Some(key) = generate_key(runtime) {
            found.push(key);
        }
    }
    let _ = KEYS.set(found);
}

/* ------------------------------ 对外读写 ------------------------------ */

/// 加密：`v10 | nonce | ct | tag`。
///
/// 拿不到 AES 密钥时退化成裸 DPAPI（解密端两种都认），绝不静默返回明文。
pub(crate) fn encrypt(plain: &[u8]) -> Option<Vec<u8>> {
    if let Some(key) = keys().first() {
        let mut nonce = [0u8; NONCE_LEN];
        if getrandom::fill(&mut nonce).is_ok() {
            if let Some((cipher, tag)) = gcm_encrypt(key, &nonce, plain) {
                let mut out = PREFIX.to_vec();
                out.extend_from_slice(&nonce);
                out.extend_from_slice(&cipher);
                out.extend_from_slice(&tag);
                return Some(out);
            }
        }
    }
    secrets::protect(plain)
}

/// 解密：`v10` 开头的走 AES-256-GCM（逐个候选密钥试，GCM 的 tag 校验保证试错不会误判）；
/// 其余按裸 DPAPI 解（我们上一版自己写过的格式）。
pub(crate) fn decrypt(cipher: &[u8]) -> Option<Vec<u8>> {
    if cipher.is_empty() {
        return None;
    }
    let Some(body) = cipher.strip_prefix(PREFIX.as_slice()) else {
        return secrets::unprotect(cipher);
    };
    if body.len() <= NONCE_LEN + TAG_LEN {
        return None;
    }
    let nonce = &body[..NONCE_LEN];
    let tag = &body[body.len() - TAG_LEN..];
    let data = &body[NONCE_LEN..body.len() - TAG_LEN];
    for key in keys() {
        if let Some(plain) = gcm_decrypt(key, nonce, data, tag) {
            return Some(plain);
        }
    }
    None
}

/// 给诊断用：本机拿到几把候选密钥（不泄露密钥内容）
pub fn key_count() -> usize {
    keys().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_runtime(tag: &str) -> RuntimePaths {
        let root = std::env::temp_dir().join(format!(
            "evejs-oscrypt-{tag}-{}-{}",
            std::process::id(),
            crate::mods::pkg::epoch_ms()
        ));
        let paths = RuntimePaths::from_root(root, true);
        for dir in [&paths.root, &paths.user_data, &paths.cache, &paths.temp] {
            let _ = fs::create_dir_all(dir);
        }
        paths
    }

    #[test]
    fn aes_gcm_round_trips_with_the_v10_layout() {
        let key = [7u8; KEY_LEN];
        let nonce = [3u8; NONCE_LEN];
        let plain = b"token:ghp_example_payload";
        let (cipher, tag) = gcm_encrypt(&key, &nonce, plain).expect("CNG 应可用");
        assert_eq!(cipher.len(), plain.len());
        assert_ne!(cipher.as_slice(), plain.as_slice());
        assert_eq!(
            gcm_decrypt(&key, &nonce, &cipher, &tag).expect("应能解开"),
            plain
        );
        // 换一把密钥必须失败（GCM 的 tag 校验兜底）
        assert!(gcm_decrypt(&[8u8; KEY_LEN], &nonce, &cipher, &tag).is_none());
        // tag 被篡改必须失败
        let mut bad = tag.clone();
        bad[0] ^= 0x01;
        assert!(gcm_decrypt(&key, &nonce, &cipher, &bad).is_none());
    }

    #[test]
    fn store_and_reload_key_round_trips() {
        let runtime = temp_runtime("store");
        let key = [42u8; KEY_LEN];
        assert!(store_key(&runtime, &key), "首次应写入成功");
        assert!(!store_key(&runtime, &key), "已存在就不再覆盖");
        assert_eq!(key_from_store(&key_store_path(&runtime)), Some(key));
        let raw = fs::read(key_store_path(&runtime)).unwrap();
        assert!(
            secrets::unprotect(&raw).is_some(),
            "落盘的密钥必须是 DPAPI 密文"
        );
        let _ = fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn local_state_key_is_read_back() {
        // 造一份「老启动器的 Local State」：base64("DPAPI" + DPAPI(32 字节))
        let runtime = temp_runtime("localstate");
        let key = [9u8; KEY_LEN];
        let wrapped = secrets::protect(&key).unwrap();
        let mut blob = DPAPI_KEY_PREFIX.to_vec();
        blob.extend_from_slice(&wrapped);
        let encoded = secrets::base64_encode(&blob);
        let json = serde_json::json!({ OS_CRYPT_PREF: { OS_CRYPT_KEY_PREF: encoded } });
        let path = local_state_in(&runtime.session_data);
        fs::write(&path, json.to_string()).unwrap();
        assert_eq!(key_from_local_state(&path), Some(key));
        // 垃圾内容不能崩、也不能误判
        fs::write(&path, "not json").unwrap();
        assert_eq!(key_from_local_state(&path), None);
        fs::write(&path, "{}").unwrap();
        assert_eq!(key_from_local_state(&path), None);
        let _ = fs::remove_dir_all(&runtime.root);
    }

    #[test]
    fn prefix_less_payload_still_decodes_as_bare_dpapi() {
        // 上一版自己写过的格式（裸 DPAPI）必须继续能读
        let bare = secrets::protect(b"legacy_bare").unwrap();
        assert_eq!(
            String::from_utf8(decrypt(&bare).unwrap()).unwrap(),
            "legacy_bare"
        );
        assert!(decrypt(b"").is_none());
    }

    #[test]
    fn v10_payload_with_garbage_key_is_rejected() {
        // v10 开头但密钥不对：必须明确失败，不能退化成「拿裸 DPAPI 再试一遍」
        let mut blob = PREFIX.to_vec();
        blob.extend_from_slice(&[0u8; NONCE_LEN]);
        blob.extend_from_slice(b"garbage-ciphertext");
        blob.extend_from_slice(&[0u8; TAG_LEN]);
        assert!(decrypt(&blob).is_none());
    }

    /// 真机交叉验证：把**老启动器真的写出来**的 `github-token.bin` 解回明文。
    ///
    /// 那份密文与它依赖的 AES 密钥都是「本机 + 本用户」的，不能进仓当固定夹具，
    /// 所以由环境变量喂：`EVEJS_LEGACY_TOKEN_FIXTURE=<token 文件路径>`，
    /// 密钥由 `<cache>/Local State` 现场解出（`EVEJS_LEGACY_LOCAL_STATE=<路径>`）。
    #[test]
    fn decodes_real_legacy_electron_token() {
        let (Ok(token_path), Ok(local_state)) = (
            std::env::var("EVEJS_LEGACY_TOKEN_FIXTURE"),
            std::env::var("EVEJS_LEGACY_LOCAL_STATE"),
        ) else {
            return;
        };
        let key = key_from_local_state(Path::new(&local_state))
            .expect("老启动器的 Local State 应能解出 AES 密钥");
        let cipher = fs::read(&token_path).expect("令牌文件应可读");
        let body = cipher
            .strip_prefix(PREFIX.as_slice())
            .expect("应带 v10 前缀");
        let nonce = &body[..NONCE_LEN];
        let tag = &body[body.len() - TAG_LEN..];
        let data = &body[NONCE_LEN..body.len() - TAG_LEN];
        let plain = gcm_decrypt(&key, nonce, data, tag).expect("必须能解开老启动器写的令牌");
        assert!(
            String::from_utf8(plain).unwrap().starts_with("ghp_"),
            "解出来应该是 GitHub 令牌"
        );
    }
}
