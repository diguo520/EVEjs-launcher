//! Win32 常量与系统探针（**单一来源**）。
//!
//! 这些值原先在 env/init/metrics/process/shell/updater 各写一份字面量；
//! 集中到这里后，`scripts/audit-dedup.mjs` 会断言「同名常量只声明一次」，再抄一份直接失败。
//!
//! 启动期的系统弹窗（MessageBoxW）也住在这里 —— 生产代码禁用 println!/eprintln!（见 audit-security 的 B4），
//! 所以「缺 WebView2 指引」与「参数拼错提示」只能走弹窗，而它们是同一类 Win32 调用，属同一来源。
//!
//! 只在 Windows 目标下编译（整个外壳本来就是 Windows 专用）。

use std::ffi::c_void;

/// 不给子进程分配控制台窗口：后台跑的 node / npm / cargo / git 一律用它。
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 完全不分配控制台。客户端直登用它（配合客户端自己的 `/noconsole`）。
///
/// **不能**再叠加 windowsHide / STARTF_USESHOWWINDOW + SW_HIDE（见 B8 与 `process.rs` 注释）。
pub const DETACHED_PROCESS: u32 = 0x0000_0008;

/// 独立进程组：Ctrl+C / Ctrl+Break 不会波及启动器自身（与 DETACHED_PROCESS 搭配使用）。
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/* ----------------------- 启动期系统弹窗（单一来源） ----------------------- */

/// `MessageBoxW` 的按钮/图标位（WinUser.h）
const MB_YESNO: u32 = 0x0000_0004;
const MB_ICONWARNING: u32 = 0x0000_0030;
const MB_SETFOREGROUND: u32 = 0x0001_0000;
/// 用户在「是/否」里点了「是」
const IDYES: i32 = 6;

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

/// UTF-16 + 结尾 NUL（注册表与 MessageBoxW 都要这个形状）
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 「是/否」弹窗：返回用户是否点了「是」。
///
/// 为什么弹窗要集中在这里：`scripts/audit-security.mjs` 的 B4 规则禁用生产代码里的
/// println!/eprintln!（那会是终端输入的潜在日志出口），所以启动期的诊断信息只能走系统弹窗。
/// 缺 WebView2 的引导与 `--ui` 参数拼错都走这两个函数。
pub fn confirm_dialog(title: &str, text: &str) -> bool {
    let text = wide(text);
    let caption = wide(title);
    let choice = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND,
        )
    };
    choice == IDYES
}

/// 只有一个「确定」的提示弹窗（用户不需要做选择，只是别静默吞掉配置错误）
pub fn warn_dialog(title: &str, text: &str) {
    let text = wide(text);
    let caption = wide(title);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_ICONWARNING | MB_SETFOREGROUND,
        );
    }
}
/* --------------------- 进程树探针（S5 / L6：停服无残留） --------------------- */

/// 进程快照的一条登记项（Toolhelp32 的子集；`exe_file` 只取文件名）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

/// `TH32CS_SNAPPROCESS`：把全系统进程列表拉进快照
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
/// `CreateToolhelp32Snapshot` 失败时的返回值
const INVALID_HANDLE_VALUE: isize = -1;
/// `MAX_PATH`：PROCESSENTRY32W.szExeFile 的长度
const MAX_PATH: usize = 260;
/// `OpenProcess` 的最小权限（只要读退出码，够用且不会被拦）
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
/// `GetExitCodeProcess` 的「仍在运行」哨兵值
const STILL_ACTIVE: u32 = 259;

/// `PROCESSENTRY32W`（WinBase.h）。字段名改成不带匈牙利前缀，布局必须逐字节一致。
#[repr(C)]
struct ProcessEntry32W {
    size: u32,
    usage: u32,
    pid: u32,
    default_heap: usize,
    module_id: u32,
    threads: u32,
    parent_pid: u32,
    pri_class_base: i32,
    flags: u32,
    exe_file: [u16; MAX_PATH],
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
    fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn GetExitCodeProcess(handle: isize, code: *mut u32) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

/// 拉一次全系统进程快照。
///
/// 为什么不用 PowerShell（`Get-CimInstance Win32_Process`）：它要起一个 200–400 ms 的
/// WMI 会话，而 L6 的断言要在「停服后 20 s 内轮询到 0 残留」这种节奏上跑十几次；
/// 直接调 Toolhelp32 是微秒级，也没有额外的进程要管。
pub fn snapshot_processes() -> Vec<ProcessEntry> {
    let mut out = Vec::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return out;
    }
    // SAFETY: PROCESSENTRY32W 是 POD，全零 + 正确的 dwSize 是该 API 要求的入参形态。
    let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;

    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let len = entry
            .exe_file
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(MAX_PATH);
        out.push(ProcessEntry {
            pid: entry.pid,
            parent_pid: entry.parent_pid,
            name: String::from_utf16_lossy(&entry.exe_file[..len]),
        });
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    out
}

/// `root_pid` 的全部后代（传递闭包，广度优先）。
///
/// Windows 的 `ParentProcessID` 在创建时固定、**不会**因父进程退出而重挂，
/// 所以父进程被杀之后，用同一份快照仍然数得出孤儿 —— 这正是「停服有没有收干净」的判据。
pub fn descendants(root_pid: u32) -> Vec<ProcessEntry> {
    let all = snapshot_processes();
    let mut out: Vec<ProcessEntry> = Vec::new();
    let mut frontier = vec![root_pid];
    while let Some(parent) = frontier.pop() {
        for entry in all.iter().filter(|item| item.parent_pid == parent) {
            if entry.pid == root_pid || out.iter().any(|item| item.pid == entry.pid) {
                continue;
            }
            out.push(entry.clone());
            frontier.push(entry.pid);
        }
    }
    out
}

/// 进程是否还活着。`OpenProcess` 失败（含进程已退出）一律按「不在了」算。
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle == 0 {
        return false;
    }
    let mut code = 0u32;
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    ok != 0 && code == STILL_ACTIVE
}

/* ------------------------- 系统内存探针（S5 / L2 修正） ------------------------- */

/// 「提交限制（commit limit）」与可用提交量（字节）。
///
/// 口径与现役版 `Win32_OperatingSystem.TotalVirtualMemorySize / FreeVirtualMemory` 一致
/// —— MSDN 明确这两项就是提交限制与可用提交量（单位 KB）；
/// `GlobalMemoryStatusEx` 的 `ullTotalPageFile / ullAvailPageFile` 是同一对数字。
///
/// 现役版把这两个值放在 GPU 探针（PowerShell CIM）里顺带取，探针失败就整体为 null；
/// 我们改成直接调 Win32（快得多，也不依赖 PowerShell），探针不会失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitMemory {
    pub total_bytes: u64,
    pub avail_bytes: u64,
}

impl CommitMemory {
    pub fn used_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.avail_bytes)
    }
}

#[repr(C)]
struct MemoryStatusEx {
    length: u32,
    memory_load: u32,
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    total_virtual: u64,
    avail_virtual: u64,
    avail_extended_virtual: u64,
}

#[link(name = "kernel32")]
extern "system" {
    fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
}

/// 读一次系统提交限制。`None` = 调用失败（正常情况下不会发生）。
pub fn commit_memory() -> Option<CommitMemory> {
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: buffer 是本函数栈上的 MemoryStatusEx，length 已按 ABI 要求填成本结构体大小；
    // 该 API 只在成功时写入这块内存，不会持有指针。
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return None;
    }
    Some(CommitMemory {
        total_bytes: status.total_page_file,
        avail_bytes: status.avail_page_file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 探针自证：自己的进程必须在快照里、必须判为活着；0 号进程必须判为不存在。
    /// （后代关系随机器而变，不在单测里断言 —— 那部分交给 L6 的真父子进程测试。）
    #[test]
    fn process_probe_sees_this_process() {
        let me = std::process::id();
        let snapshot = snapshot_processes();
        assert!(
            snapshot.len() > 1,
            "进程快照不该只有一条：{}",
            snapshot.len()
        );
        assert!(
            snapshot.iter().any(|entry| entry.pid == me),
            "快照里没有自己（pid {me}）"
        );
        assert!(alive(me), "自己应当判为活着");
        assert!(!alive(0), "0 号进程不存在");
        assert!(descendants(me).iter().all(|entry| entry.pid != me));
    }

    #[test]
    fn commit_memory_reports_sane_numbers() {
        let commit = commit_memory().expect("本机应能读到提交限制");
        assert!(commit.total_bytes > 0, "提交限制为 0：{commit:?}");
        assert!(
            commit.avail_bytes <= commit.total_bytes,
            "可用提交量大于提交限制：{commit:?}"
        );
        assert!(commit.used_bytes() <= commit.total_bytes);
        // 提交限制至少要能装下物理内存（不然连内核都跑不起来）
        assert!(
            commit.total_bytes >= 1024 * 1024 * 1024,
            "提交限制异常小：{commit:?}"
        );
    }
}
