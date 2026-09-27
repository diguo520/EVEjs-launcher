//! Win32 shell 辅助：回收站、资源管理器定位、系统区域排序。
//!
//! 同样坚持「手写 FFI 而不是引依赖」：`SHFileOperationW` 就是 Electron
//! `shell.trashItem` 在 Windows 上的同一套实现（FO_DELETE + FOF_ALLOWUNDO），
//! `CompareStringW` 则是 `String.prototype.localeCompare` 最接近的系统级等价物
//! （现役版用它排模组显示名，直接换成码点比较会让中文模组顺序和现役版不一样）。
use std::cmp::Ordering;
use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::Path;

const FO_DELETE: u32 = 0x0003;
const FOF_SILENT: u16 = 0x0004;
const FOF_NOCONFIRMATION: u16 = 0x0010;
const FOF_ALLOWUNDO: u16 = 0x0040;
const FOF_NOERRORUI: u16 = 0x0400;

use crate::win32::CREATE_NO_WINDOW;

#[repr(C)]
#[allow(dead_code)] // 字段只由 shell32 读回
struct ShFileOpStructW {
    hwnd: *mut c_void,
    w_func: u32,
    p_from: *const u16,
    p_to: *const u16,
    f_flags: u16,
    f_any_operations_aborted: i32,
    h_name_mappings: *mut c_void,
    lpsz_progress_title: *const u16,
}

#[link(name = "shell32")]
extern "system" {
    fn SHFileOperationW(file_op: *mut ShFileOpStructW) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    // 用 CompareStringW 而不是 CompareStringExW：后者只由 KernelBase.dll 导出，
    // 当前 Windows SDK 的 kernel32.Lib 里没有对应的导入符号（实测 LINK2019），
    // 而 LOCALE_USER_DEFAULT 版本的排序行为与 CompareStringEx + LOCALE_NAME_USER_DEFAULT 等价。
    fn CompareStringW(
        locale: u32,
        flags: u32,
        string1: *const u16,
        count1: i32,
        string2: *const u16,
        count2: i32,
    ) -> i32;
}

/// `LOCALE_USER_DEFAULT`
const LOCALE_USER_DEFAULT: u32 = 0x0400;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// 把路径移进回收站（对齐 Electron `shell.trashItem`）。
/// 失败时返回原因，调用方自行决定是否退化为直接删除。
pub fn to_recycle_bin(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("回收站只接受绝对路径".to_string());
    }
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.to_string_lossy()));
    }
    let text = path.to_string_lossy().to_string();
    if text.contains('/') {
        // SHFileOperationW 只认反斜杠；出现斜杠说明上游没做规范化，直接拒绝比删错好
        return Err("回收站路径必须是反斜杠形式".to_string());
    }
    // pFrom 是「以双 NUL 结尾的字符串列表」
    let mut from: Vec<u16> = wide(&text);
    from.push(0);
    from.push(0);

    let mut op = ShFileOpStructW {
        hwnd: std::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: from.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("移入回收站失败（SHFileOperation 错误码 {code}）"));
    }
    if op.f_any_operations_aborted != 0 {
        return Err("移入回收站被中止".to_string());
    }
    Ok(())
}

/// 在资源管理器里定位并选中某个文件/目录（对齐 Electron `shell.showItemInFolder`）
pub fn reveal_in_explorer(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy().to_string();
    if text.is_empty() {
        return Err("路径为空".to_string());
    }
    // 用 raw_arg 精确控制引号：explorer 要求 /select,"<path>" 这种形态
    let mut command = std::process::Command::new("explorer.exe");
    command.raw_arg(format!("/select,\"{text}\""));
    command.creation_flags(CREATE_NO_WINDOW);
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(err) => Err(format!("无法打开资源管理器：{err}")),
    }
}

/// 系统区域排序（null 区域名 = 用户默认区域），等价于现役版的 `a.localeCompare(b)`。
/// 系统调用失败时退化为「小写后按码点比较」，保证排序永远不会 panic。
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    let a = wide(left);
    let b = wide(right);
    let result = unsafe {
        CompareStringW(
            LOCALE_USER_DEFAULT,
            0,
            a.as_ptr(),
            a.len() as i32,
            b.as_ptr(),
            b.len() as i32,
        )
    };
    match result {
        // CSTR_LESS_THAN = 1, CSTR_EQUAL = 2, CSTR_GREATER_THAN = 3
        1 => Ordering::Less,
        2 => Ordering::Equal,
        3 => Ordering::Greater,
        _ => left.to_lowercase().cmp(&right.to_lowercase()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shfileopstruct_layout_matches_win64() {
        assert_eq!(std::mem::size_of::<ShFileOpStructW>(), 56);
        let probe = ShFileOpStructW {
            hwnd: std::ptr::null_mut(),
            w_func: 0,
            p_from: std::ptr::null(),
            p_to: std::ptr::null(),
            f_flags: 0,
            f_any_operations_aborted: 0,
            h_name_mappings: std::ptr::null_mut(),
            lpsz_progress_title: std::ptr::null(),
        };
        let base = std::ptr::addr_of!(probe) as usize;
        let offset = |field: *const u8| field as usize - base;
        assert_eq!(offset(std::ptr::addr_of!(probe.p_from) as *const u8), 16);
        assert_eq!(offset(std::ptr::addr_of!(probe.f_flags) as *const u8), 32);
        assert_eq!(
            offset(std::ptr::addr_of!(probe.lpsz_progress_title) as *const u8),
            48
        );
    }

    #[test]
    fn recycle_bin_rejects_relative_and_missing_paths() {
        assert!(to_recycle_bin(Path::new("relative\\thing")).is_err());
        assert!(to_recycle_bin(Path::new("E:\\nope\\definitely-missing-evejs")).is_err());
    }

    #[test]
    fn locale_compare_is_case_insensitive_at_primary_level() {
        assert_eq!(locale_compare("apple", "banana"), Ordering::Less);
        assert_eq!(locale_compare("banana", "apple"), Ordering::Greater);
        assert_eq!(locale_compare("same", "same"), Ordering::Equal);
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
    }
}
