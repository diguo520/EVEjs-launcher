//! Win32 原生文件对话框（手写 comdlg32 FFI）。
//!
//! 为什么不用 `tauri-plugin-dialog`：它会把 `rfd` + `windows` crate 整棵依赖树拉进来，
//! 与「极小体积 / 快速冷启动」的目标相悖（同 `secrets.rs` 手写 DPAPI 的取舍 S2-D2）。
//! 这里只 `#[link]` 3 个符号：`GetOpenFileNameW` / `GetSaveFileNameW` / `GetForegroundWindow`。
//!
//! 线程约定：对话框必须在**主线程**上弹（`GetForegroundWindow()` 取到的才是启动器窗口，
//! 而且 comdlg32 的内部消息泵就在调用线程上），所以统一走
//! `AppHandle::run_on_main_thread` + oneshot 回传，async 调用方不需要阻塞工作线程。
use std::ffi::c_void;
use std::path::PathBuf;
use tauri::AppHandle;

/* ------------------------------ Win32 声明 ------------------------------ */

/// OPENFILENAMEW（字段顺序/类型严格对齐 comdlg32.h；x64 下由 `#[repr(C)]` 自然对齐补齐）
#[repr(C)]
#[allow(dead_code)] // 绝大多数字段只由 comdlg32 读回，Rust 侧只写不读
struct OpenFileNameW {
    l_struct_size: u32,
    hwnd_owner: *mut c_void,
    h_instance: *mut c_void,
    lpstr_filter: *const u16,
    lpstr_custom_filter: *mut u16,
    n_max_cust_filter: u32,
    n_filter_index: u32,
    lpstr_file: *mut u16,
    n_max_file: u32,
    lpstr_file_title: *mut u16,
    n_max_file_title: u32,
    lpstr_initial_dir: *const u16,
    lpstr_title: *const u16,
    flags: u32,
    n_file_offset: u16,
    n_file_extension: u16,
    lpstr_def_ext: *const u16,
    l_cust_data: isize,
    lpfn_hook: *mut c_void,
    lp_template_name: *const u16,
    pv_reserved: *mut c_void,
    dw_reserved: u32,
    flags_ex: u32,
}

const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
const OFN_HIDEREADONLY: u32 = 0x0000_0004;
const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
const OFN_EXPLORER: u32 = 0x0008_0000;
const OFN_DONTADDTORECENT: u32 = 0x0200_0000;

#[link(name = "comdlg32")]
extern "system" {
    fn GetOpenFileNameW(ofn: *mut OpenFileNameW) -> i32;
    fn GetSaveFileNameW(ofn: *mut OpenFileNameW) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> *mut c_void;
}

/// 路径缓冲长度（字符）：够放 `\\?\` 长路径，且远超 `MAX_PATH`
const PATH_BUFFER_CHARS: usize = 4096;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// comdlg32 的过滤器是「标签\0通配\0…\0」的双 NUL 结尾 UTF-16 序列
fn filter_block(filters: &[(String, Vec<String>)]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for (label, extensions) in filters {
        out.extend(wide(label));
        let patterns = if extensions.is_empty() {
            "*.*".to_string()
        } else {
            extensions
                .iter()
                .map(|extension| format!("*.{extension}"))
                .collect::<Vec<_>>()
                .join(";")
        };
        out.extend(wide(&patterns));
    }
    out.push(0);
    out
}

/* ------------------------------ 对话框描述 ------------------------------ */

pub struct DialogSpec {
    title: String,
    filters: Vec<(String, Vec<String>)>,
    default_name: String,
    def_ext: String,
    initial_dir: String,
    save: bool,
}

impl DialogSpec {
    /// 另存为（自动追问覆盖）
    pub fn save(title: &str, default_name: &str, def_ext: &str) -> Self {
        Self {
            title: title.to_string(),
            filters: Vec::new(),
            default_name: default_name.to_string(),
            def_ext: def_ext.to_string(),
            initial_dir: String::new(),
            save: true,
        }
    }

    /// 打开文件
    pub fn open(title: &str) -> Self {
        Self {
            title: title.to_string(),
            filters: Vec::new(),
            default_name: String::new(),
            def_ext: String::new(),
            initial_dir: String::new(),
            save: false,
        }
    }

    pub fn filter(mut self, label: &str, extensions: &[&str]) -> Self {
        self.filters.push((
            label.to_string(),
            extensions
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
        ));
        self
    }

    pub fn initial_dir(mut self, dir: impl Into<String>) -> Self {
        self.initial_dir = dir.into();
        self
    }

    fn flags(&self) -> u32 {
        let base = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_DONTADDTORECENT | OFN_PATHMUSTEXIST;
        if self.save {
            base | OFN_OVERWRITEPROMPT
        } else {
            base | OFN_FILEMUSTEXIST | OFN_HIDEREADONLY
        }
    }

    /// 阻塞式弹出（必须在主线程调用）；`None` = 用户取消
    fn blocking_pick(&self) -> Option<PathBuf> {
        let filters = filter_block(&self.filters);
        let title = wide(&self.title);
        let initial_dir = wide(&self.initial_dir);
        let def_ext = wide(&self.def_ext);

        let mut buffer = vec![0u16; PATH_BUFFER_CHARS];
        if !self.default_name.is_empty() {
            let name = wide(&self.default_name);
            let len = name.len().min(buffer.len());
            buffer[..len].copy_from_slice(&name[..len]);
            buffer[len - 1] = 0; // 截断时保证结尾仍是 NUL
        }

        let mut ofn = OpenFileNameW {
            l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            hwnd_owner: unsafe { GetForegroundWindow() },
            h_instance: std::ptr::null_mut(),
            lpstr_filter: filters.as_ptr(),
            lpstr_custom_filter: std::ptr::null_mut(),
            n_max_cust_filter: 0,
            n_filter_index: 1,
            lpstr_file: buffer.as_mut_ptr(),
            n_max_file: buffer.len() as u32,
            lpstr_file_title: std::ptr::null_mut(),
            n_max_file_title: 0,
            lpstr_initial_dir: if self.initial_dir.is_empty() {
                std::ptr::null()
            } else {
                initial_dir.as_ptr()
            },
            lpstr_title: title.as_ptr(),
            flags: self.flags(),
            n_file_offset: 0,
            n_file_extension: 0,
            lpstr_def_ext: if self.def_ext.is_empty() {
                std::ptr::null()
            } else {
                def_ext.as_ptr()
            },
            l_cust_data: 0,
            lpfn_hook: std::ptr::null_mut(),
            lp_template_name: std::ptr::null(),
            pv_reserved: std::ptr::null_mut(),
            dw_reserved: 0,
            flags_ex: 0,
        };

        let ok = unsafe {
            if self.save {
                GetSaveFileNameW(&mut ofn)
            } else {
                GetOpenFileNameW(&mut ofn)
            }
        };
        if ok == 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(buffer.len());
        if end == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
    }
}

/// 在主线程弹对话框并等待结果；`Ok(None)` = 用户取消
pub async fn pick(app: &AppHandle, spec: DialogSpec) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(spec.blocking_pick());
    })
    .map_err(|err| err.to_string())?;
    receiver.await.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_is_nul_terminated() {
        assert_eq!(wide("ab"), vec![0x61, 0x62, 0x00]);
        assert_eq!(wide(""), vec![0x00]);
    }

    #[test]
    fn filter_block_uses_double_nul_terminator() {
        let block = filter_block(&[
            ("EveJS author key".to_string(), vec!["eve-key".to_string()]),
            ("所有文件".to_string(), vec!["*".to_string()]),
        ]);
        // 标签\0通配\0 标签\0通配\0 \0
        let parts: Vec<String> = String::from_utf16_lossy(&block)
            .split('\u{0}')
            .map(|part| part.to_string())
            .collect();
        assert_eq!(
            parts,
            vec![
                "EveJS author key".to_string(),
                "*.eve-key".to_string(),
                "所有文件".to_string(),
                "*.*".to_string(),
                String::new(),
                String::new(),
            ]
        );
    }

    #[test]
    fn save_and_open_flags_differ_where_expected() {
        let save = DialogSpec::save("t", "a.eve-key", "eve-key").flags();
        assert_ne!(save & OFN_OVERWRITEPROMPT, 0);
        assert_eq!(save & OFN_FILEMUSTEXIST, 0);
        let open = DialogSpec::open("t").flags();
        assert_eq!(open & OFN_OVERWRITEPROMPT, 0);
        assert_ne!(open & OFN_FILEMUSTEXIST, 0);
        // 两者都必须带 EXPLORER（否则拿不到完整路径）与 NOCHANGEDIR
        for flags in [save, open] {
            assert_ne!(flags & OFN_EXPLORER, 0);
            assert_ne!(flags & OFN_NOCHANGEDIR, 0);
        }
    }

    #[test]
    fn open_filename_struct_size_matches_win64_layout() {
        // x64 上 OPENFILENAMEW 的标准大小是 152 字节（含尾部 padding）；
        // 字段布局写错时 comdlg32 会因为 lStructSize 不符直接返回失败。
        assert_eq!(std::mem::size_of::<OpenFileNameW>(), 152);
        // 关键偏移抽查：lpstrFile @48、Flags @96、FlagsEx @148
        let probe = OpenFileNameW {
            l_struct_size: 0,
            hwnd_owner: std::ptr::null_mut(),
            h_instance: std::ptr::null_mut(),
            lpstr_filter: std::ptr::null(),
            lpstr_custom_filter: std::ptr::null_mut(),
            n_max_cust_filter: 0,
            n_filter_index: 0,
            lpstr_file: std::ptr::null_mut(),
            n_max_file: 0,
            lpstr_file_title: std::ptr::null_mut(),
            n_max_file_title: 0,
            lpstr_initial_dir: std::ptr::null(),
            lpstr_title: std::ptr::null(),
            flags: 0,
            n_file_offset: 0,
            n_file_extension: 0,
            lpstr_def_ext: std::ptr::null(),
            l_cust_data: 0,
            lpfn_hook: std::ptr::null_mut(),
            lp_template_name: std::ptr::null(),
            pv_reserved: std::ptr::null_mut(),
            dw_reserved: 0,
            flags_ex: 0,
        };
        // 注意用 addr_of!：几个指针字段本身是 null，不能拿字段值当地址
        let base = std::ptr::addr_of!(probe) as usize;
        let offset = |field: *const u8| field as usize - base;
        assert_eq!(
            offset(std::ptr::addr_of!(probe.lpstr_file) as *const u8),
            48
        );
        assert_eq!(offset(std::ptr::addr_of!(probe.flags) as *const u8), 96);
        assert_eq!(offset(std::ptr::addr_of!(probe.flags_ex) as *const u8), 148);
    }
}
