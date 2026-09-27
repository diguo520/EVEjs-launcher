//! WebView2 运行时预检（S4 / G4：让「双击没反应」变成「看得懂的中文指引」）。
//!
//! NSIS 安装包那条路由 Tauri 的 `webviewInstallMode: downloadBootstrapper` 负责自动装；
//! 但**便携版**没有任何安装器，裸 exe 双击时 Tauri 只会给一句英文提示（甚至什么都不显示）。
//! 这里在创建窗口之前先查一次注册表：
//!   - 已装 → 正常启动；
//!   - 未装 → 弹中文对话框（含**离线**办法），点「是」用系统默认浏览器打开官方下载页，然后退出。
//!
//! 检测依据（Microsoft 官方口径）：EdgeUpdate 的 WebView2 客户端 GUID
//! `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 下的 `pv` 值；`pv` 为空串表示「已卸载」。//!
//! 诊断开关：设 `EVEJS_SIMULATE_NO_WEBVIEW2=1` 会把本次预检强制判为「未装」，便于在
//! 已装 WebView2 的机器上验证引导流程（见 scripts/smoke-webview2-missing.ps1）。
use std::ffi::c_void;
use std::os::windows::process::CommandExt;

use crate::win32::{confirm_dialog, wide, CREATE_NO_WINDOW};

/// WebView2 Evergreen 运行时的 EdgeUpdate 客户端 GUID（官方文档固定值）
const CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// 官方下载页（WebView2 Evergreen Bootstrapper，约 2 MB，联网安装）
const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
/// RegGetValueW 的「只接受 REG_SZ」过滤位
const RRF_RT_REG_SZ: u32 = 0x0002;
/// RegGetValueW 专有的 32 位视图位（`KEY_WOW64_32KEY` 只对 RegOpenKeyEx 有效，
/// 传给 RegGetValueW 会直接返回 ERROR_INVALID_PARAMETER —— 本模块因此先按**字面路径**找）
const RRF_SUBKEY_WOW6432KEY: u32 = 0x0001_0000;

#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(
        hkey: isize,
        sub_key: *const u16,
        value: *const u16,
        flags: u32,
        value_type: *mut u32,
        data: *mut c_void,
        data_size: *mut u32,
    ) -> i32;
}

/// 读一次注册表里的 `pv`。`None` = 键或值不存在；`Some("")` = 装过又被卸载。
fn read_pv(root: isize, sub_key_path: &str, extra_flags: u32) -> Option<String> {
    let sub_key = wide(sub_key_path);
    let value_name = wide("pv");
    let mut buffer = [0u16; 128];
    let mut size = (buffer.len() * 2) as u32;
    let mut value_type = 0u32;
    let code = unsafe {
        RegGetValueW(
            root,
            sub_key.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ | extra_flags,
            &mut value_type,
            buffer.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if code != 0 {
        return None;
    }
    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

/// 本机 WebView2 运行时版本。
///
/// 探测顺序按「实际部署形态」排：64 位 Windows 上管理员级安装落在 `WOW6432Node` 下
/// （本机实测 pv 就只在这里），其次是 32 位视图与用户级安装。
pub fn installed_version() -> Option<String> {
    let clients = format!("Microsoft\\EdgeUpdate\\Clients\\{CLIENT_GUID}");
    let attempts = [
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\WOW6432Node\\{clients}"),
            0,
        ),
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\{clients}"), 0),
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\{clients}"),
            RRF_SUBKEY_WOW6432KEY,
        ),
        (
            HKEY_CURRENT_USER,
            format!("SOFTWARE\\WOW6432Node\\{clients}"),
            0,
        ),
        (HKEY_CURRENT_USER, format!("SOFTWARE\\{clients}"), 0),
    ];
    for (root, path, flags) in attempts {
        if let Some(value) = read_pv(root, &path, flags) {
            return Some(value);
        }
    }
    None
}

/// `pv` 是否是「已安装」的版本号形态（EdgeUpdate 卸载后会留空串）
pub fn looks_like_version(value: &str) -> bool {
    let mut parts = value.trim().split('.');
    let major = parts.next().unwrap_or("");
    major.len() >= 2
        && major.chars().all(|ch| ch.is_ascii_digit())
        && parts.all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
}

pub fn is_installed() -> bool {
    installed_version()
        .map(|value| looks_like_version(&value))
        .unwrap_or(false)
}

/// 未装 WebView2 时的中文指引（离线办法写在这里，不依赖任何网络请求）
pub fn prompt_text() -> String {
    format!(
        "EvEJS 启动器需要 Microsoft Edge WebView2 运行时，本机未检测到。\n\n\
         联网安装：点「是」打开官方下载页（约 2 MB 的在线安装器），装完重新打开启动器。\n\
         离线安装：在有网的机器上下载 MicrosoftEdgeWebview2Setup.exe（或 WebView2 Evergreen Standalone \
         Installer），拷到本机运行即可。\n\n\
         下载地址：{DOWNLOAD_URL}\n\n\
         （使用安装包版本时，安装程序会自动完成这一步。）"
    )
}

/// 用系统默认浏览器打开下载页（rundll32 的 FileProtocolHandler，不需要额外依赖）
fn open_download_page() -> Result<(), String> {
    let mut command = std::process::Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", DOWNLOAD_URL]);
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map(|_| ()).map_err(|err| err.to_string())
}

/// 诊断开关的取值判定（纯函数，便于单测）：只有恰好 `1` 才算开启。
pub fn wants_simulation(value: Option<&str>) -> bool {
    value.map(|raw| raw.trim() == "1").unwrap_or(false)
}

/// 读环境变量版的诊断开关（见模块文档；只影响本模块，不改变任何权限或数据路径）
fn simulated_missing() -> bool {
    wants_simulation(std::env::var("EVEJS_SIMULATE_NO_WEBVIEW2").ok().as_deref())
}

/// 启动前预检：返回 `false` 表示「缺 WebView2，已给指引，应该退出」。
pub fn ensure_installed() -> bool {
    if !simulated_missing() && is_installed() {
        return true;
    }
    // 弹窗走 win32.rs 的单一实现（与「--ui 参数拼错」同一来源，见 audit-dedup）
    if confirm_dialog("EvEJS 启动器 · 缺少 WebView2 运行时", &prompt_text()) {
        let _ = open_download_page();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_guid_is_the_official_webview2_id() {
        assert_eq!(CLIENT_GUID, "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    }

    #[test]
    fn version_shape_is_validated() {
        assert!(looks_like_version("131.0.2903.86"));
        assert!(looks_like_version("100.0"));
        // EdgeUpdate 卸载后写空串 → 必须判为「未安装」
        assert!(!looks_like_version(""));
        assert!(!looks_like_version("not-a-version"));
        assert!(!looks_like_version("1"));
    }

    #[test]
    fn prompt_mentions_both_online_and_offline_paths() {
        let text = prompt_text();
        assert!(text.contains("离线"), "{text}");
        assert!(text.contains(DOWNLOAD_URL), "{text}");
    }

    #[test]
    fn simulation_switch_only_accepts_one() {
        assert!(wants_simulation(Some("1")));
        assert!(wants_simulation(Some(" 1 ")));
        assert!(!wants_simulation(Some("0")));
        assert!(!wants_simulation(Some("true")));
        assert!(!wants_simulation(None));
    }

    /// 本机断言：开发机（能跑 Tauri）必然装了 WebView2 —— 顺便证明注册表探测路径真的能读到值。
    #[test]
    fn probe_finds_webview2_on_this_machine() {
        let version = installed_version().expect("开发机应能读到 WebView2 的 pv 值");
        assert!(looks_like_version(&version), "pv 值异常：{version}");
        assert!(is_installed());
    }
}
