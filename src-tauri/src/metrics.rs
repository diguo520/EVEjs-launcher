//! 系统指标：CPU / 内存 / 交换区 / 磁盘 / 网络速率 / 在线人数。
//!
//! 口径对齐现役版 `ipc.ts` 的 `metrics:get`：
//!   - CPU/内存走 `sysinfo`（现役版用 `os.cpus()` 的两次采样差，二者同口径）；
//!   - 磁盘卷沿用 `sysinfo::Disks`（现役版用 `fs.statfsSync` 枚举 A–Z）；
//!   - 网络速率与在线人数沿用现役版的 `netstat` 解析（不引入 Win32 计数器，省体积）。
//!
//! 两个本机口径差异（都写在 S2 记录里）：
//!   - `netstat` 有 100–300 ms 开销，所以放在**后台线程 + 5 s 缓存**里刷新，
//!     `collect()` 只读缓存值（现役版是在 handler 里 `await`，会拖慢一次 IPC）；
//!   - GPU 相关字段现役版走 PowerShell CIM，S1 起就是 `null`（渲染层有降级显示），
//!     本轮不补，避免为一个「可选仪表」把 PowerShell 拉回热路径。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::{Disks, Pid, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

/// 后台采样间隔（毫秒）：与现役版 GPU 缓存的 5 s 对齐
const TRAFFIC_REFRESH_MS: u64 = 5_000;

#[derive(Default)]
struct TrafficStats {
    at: u64,
    refreshing: bool,
    net_rate: f64,
    last_net_bytes: Option<u64>,
    last_net_at: u64,
    online: Option<u64>,
}

/// 单个进程的读数（服务卡片用）。
pub struct ProcStat {
    /// 占**整机** CPU 的百分比：sysinfo 的进程读数是「一核 = 100%」的口径，
    /// 这里按逻辑核心数折算过，跟仪表盘上那个全局 CPU 同一口径。
    /// 两次采样间隔不足 `MINIMUM_CPU_UPDATE_INTERVAL` 时为 None（界面画 "—"）。
    pub cpu_percent: Option<f64>,
    pub mem_mb: f64,
}

pub struct MetricsCollector {
    system: System,
    disks: Disks,
    traffic: Arc<Mutex<TrafficStats>>,
    /// 进程第一次被看到的时刻：CPU 百分比是两次采样的差值，间隔不够时 sysinfo
    /// 也不会重算，这里就不报数（宁可画 "—" 也不给一个假的 0.0%）
    proc_seen: HashMap<u32, Instant>,
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsCollector {
    pub fn new() -> Self {
        let mut system = System::new_all();
        system.refresh_cpu_all();
        system.refresh_memory();
        Self {
            system,
            disks: Disks::new_with_refreshed_list(),
            traffic: Arc::new(Mutex::new(TrafficStats::default())),
            proc_seen: HashMap::new(),
        }
    }

    pub fn collect(&mut self, repo_root: &Path) -> Value {
        self.system.refresh_cpu_all();
        self.system.refresh_memory();
        self.disks.refresh(true);
        self.schedule_traffic_refresh(repo_root);

        const GB: f64 = 1024.0 * 1024.0 * 1024.0;
        let cpu_percent = self.system.global_cpu_usage() as f64;

        let repo_drive = drive_letter(repo_root);
        let mut volumes: Vec<Value> = Vec::new();
        let mut current: Option<Value> = None;
        for disk in self.disks.list() {
            let total = disk.total_space();
            let available = disk.available_space();
            let used = total.saturating_sub(available);
            let mount = disk.mount_point().to_string_lossy().to_string();
            let percent = if total > 0 {
                (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            let entry = json!({
                "root": mount,
                "totalGB": total as f64 / GB,
                "usedGB": used as f64 / GB,
                "freeGB": available as f64 / GB,
                "percent": percent
            });
            if let Some(letter) = repo_drive.as_ref() {
                let mount_upper = mount.to_uppercase();
                if mount_upper.starts_with(letter.as_str()) {
                    current = Some(entry.clone());
                }
            }
            volumes.push(entry);
        }
        let current = current.or_else(|| volumes.first().cloned()).unwrap_or_else(|| {
            json!({ "root": repo_drive.clone().unwrap_or_default(), "totalGB": 0.0, "usedGB": 0.0, "freeGB": 0.0, "percent": 0.0 })
        });

        let commit = crate::win32::commit_memory();
        let virtual_used = commit
            .map(|value| json!(value.used_bytes() as f64 / GB))
            .unwrap_or(Value::Null);
        let virtual_total = commit
            .map(|value| json!(value.total_bytes as f64 / GB))
            .unwrap_or(Value::Null);

        let (net_rate, online) = match self.traffic.lock() {
            Ok(guard) => (guard.net_rate, guard.online),
            Err(_) => (0.0, None),
        };

        json!({
            "cpuPercent": cpu_percent,
            "memUsedGB": self.system.used_memory() as f64 / GB,
            "memTotalGB": self.system.total_memory() as f64 / GB,
            "diskUsedGB": current["usedGB"],
            "diskTotalGB": current["totalGB"],
            "diskRoot": current["root"],
            "volumes": volumes,
            "netBytesPerSec": net_rate,
            // GPU 仪表（现役版走 PowerShell CIM，渲染层可降级显示，暂留 null）
            "gpuPercent": Value::Null,
            "gpuDedicatedUsedGB": Value::Null,
            "gpuDedicatedTotalGB": Value::Null,
            "gpuSharedUsedGB": Value::Null,
            "gpuMemoryUsedGB": Value::Null,
            "gpuMemoryTotalGB": Value::Null,
            // 虚拟内存 = Windows 的「提交限制」（现役版走 CIM 的 TotalVirtualMemorySize /
            // FreeVirtualMemory，口径相同；见 win32::commit_memory）。
            // 早先这里错误地用了 sysinfo 的 swap（页面文件用量），与现役版不是同一个量。
            "virtualMemUsedGB": virtual_used,
            "virtualMemTotalGB": virtual_total,
            // netstat 数不到时给 null（现役版同样区分「0 人」与「查不到」）
            "onlinePlayers": online.map(|value| json!(value)).unwrap_or(Value::Null)
        })
    }

    /// 到期就在后台线程采样一次（`netstat` 有开销，不能占着 IPC 线程）
    fn schedule_traffic_refresh(&self, repo_root: &Path) {
        let Ok(mut guard) = self.traffic.lock() else {
            return;
        };
        let now = now_ms();
        if guard.refreshing || now.saturating_sub(guard.at) < TRAFFIC_REFRESH_MS {
            return;
        }
        guard.refreshing = true;
        drop(guard);

        let shared = Arc::clone(&self.traffic);
        let root = repo_root.to_path_buf();
        std::thread::spawn(move || {
            let net_bytes = net_total_bytes();
            let online = count_online_players(&root);
            let now = now_ms();
            if let Ok(mut guard) = shared.lock() {
                if let Some(current) = net_bytes {
                    if let Some(previous) = guard.last_net_bytes {
                        let elapsed =
                            ((now.saturating_sub(guard.last_net_at)) as f64 / 1000.0).max(0.1);
                        // 计数器回绕时（重启网卡）不报负数
                        guard.net_rate = if current >= previous {
                            (current - previous) as f64 / elapsed
                        } else {
                            0.0
                        };
                    }
                    guard.last_net_bytes = Some(current);
                    guard.last_net_at = now;
                }
                guard.online = online;
                guard.at = now;
                guard.refreshing = false;
            }
        });
    }
}

impl MetricsCollector {
    /// 逐进程读数：给服务卡片用（CPU% / 内存 MB）。
    ///
    /// **按整棵进程树**统计，不是只报根进程。
    ///
    /// 启动器拉起来的是 `cmd.exe /c npm start`，真正的服务在它的子进程里（node）——
    /// 只报外壳那个 cmd.exe 的读数会严重偏小（实测 9.7 MB vs 真正的 68 MB），
    /// 所以顺着 parent 关系把子树收进来：CPU 与内存都求和，口径与任务管理器的
    /// 「进程树」一致。
    pub fn process_stats(&mut self, pids: &[u32]) -> HashMap<u32, ProcStat> {
        let mut out = HashMap::new();
        if pids.is_empty() {
            self.proc_seen.clear();
            return out;
        }
        // 要顺着 parent 找子进程，就得看整张表（sysinfo 没有「查子进程」的接口）。
        // 2s 一轮的整表刷新是进程监视器的常规开销，可以接受。
        self.system.refresh_processes(ProcessesToUpdate::All, true);
        // 消失的 pid 不留痕：pid 会被系统复用，留着旧的采样时刻会污染下一轮
        self.proc_seen.retain(|pid, _| pids.contains(pid));

        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                children
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid.as_u32());
            }
        }

        let cores = self.system.cpus().len().max(1) as f64;
        let now = Instant::now();
        for pid in pids {
            if self.system.process(Pid::from_u32(*pid)).is_none() {
                continue;
            }
            let first_seen = *self.proc_seen.entry(*pid).or_insert(now);
            let sampled = now.duration_since(first_seen) >= MINIMUM_CPU_UPDATE_INTERVAL;

            // 广度优先收子树（根 + 所有后代）
            let mut tree = vec![*pid];
            let mut index = 0;
            while index < tree.len() {
                if let Some(kids) = children.get(&tree[index]) {
                    tree.extend(kids.iter().copied());
                }
                index += 1;
            }

            let mut cpu = 0.0f64;
            let mut mem = 0.0f64;
            for id in &tree {
                if let Some(process) = self.system.process(Pid::from_u32(*id)) {
                    cpu += process.cpu_usage() as f64;
                    mem += process.memory() as f64;
                }
            }
            out.insert(
                *pid,
                ProcStat {
                    cpu_percent: if sampled { Some(cpu / cores) } else { None },
                    mem_mb: mem / (1024.0 * 1024.0),
                },
            );
        }
        out
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 现役版 `readNetworkBytes`：`netstat -e` 里第一行「恰好两个数字」的那行求和
fn parse_net_total_bytes(stdout: &str) -> Option<u64> {
    for line in stdout.lines() {
        let numbers: Vec<u64> = line
            .trim()
            .split(|ch: char| !ch.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<u64>().ok())
            .collect();
        if numbers.len() == 2 {
            return Some(numbers[0].saturating_add(numbers[1]));
        }
    }
    None
}

fn net_total_bytes() -> Option<u64> {
    let output = run_hidden("netstat", &["-e"])?;
    parse_net_total_bytes(&output)
}

/// 现役版 `countOnlinePlayers`：数 `netstat -ano -p TCP` 里连到游戏端口的 ESTABLISHED
fn parse_established(stdout: &str, port: u16) -> u64 {
    let suffix = format!(":{port}");
    let mut count = 0u64;
    for line in stdout.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        if !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("ESTABLISHED") {
            continue;
        }
        if !cols[1].ends_with(&suffix) {
            continue;
        }
        count += 1;
    }
    count
}

fn count_online_players(repo_root: &Path) -> Option<u64> {
    let configured = crate::config::read_server_config(repo_root).ports.game;
    let port = if configured > 0 {
        configured
    } else {
        crate::config::DEFAULT_GAME_PORT
    };
    let output = run_hidden("netstat", &["-ano", "-p", "TCP"])?;
    Some(parse_established(&output, port))
}

/// 跑一个外部命令并取回 stdout（隐藏控制台窗口；失败返回 None）
fn run_hidden(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use crate::win32::CREATE_NO_WINDOW;
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn drive_letter(path: &Path) -> Option<String> {
    let text = path.to_string_lossy().to_string();
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) => Some(format!("{}:", letter.to_ascii_uppercase())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_total_takes_first_line_with_two_numbers() {
        let sample = [
            "Interface Statistics",
            "",
            "                           Received            Sent",
            "",
            "Bytes                    1234567          7654321",
            "Unicast Packets            12345            23456",
        ]
        .join("\r\n");
        assert_eq!(parse_net_total_bytes(&sample), Some(1234567 + 7654321));
        assert_eq!(parse_net_total_bytes("nothing here"), None);
        // 只有「恰好两个数字」的行才算（表头那行有 4 个数字，必须跳过）
        assert_eq!(parse_net_total_bytes("1 2 3 4\r\nBytes 10 20"), Some(30));
    }

    #[test]
    fn established_counter_filters_by_state_and_port() {
        let sample = [
            "  活动连接",
            "",
            "  协议  本地地址          外部地址        状态           PID",
            "  TCP    127.0.0.1:26000        127.0.0.1:51234        ESTABLISHED     1234",
            "  TCP    127.0.0.1:26000        127.0.0.1:51235        TIME_WAIT       1234",
            "  TCP    127.0.0.1:26002        127.0.0.1:51236        ESTABLISHED     4321",
            "  TCP    127.0.0.1:2600         127.0.0.1:51237        ESTABLISHED     1234",
            "  UDP    127.0.0.1:26000        *:*                                    1234",
        ]
        .join("\r\n");
        assert_eq!(parse_established(&sample, 26000), 1);
        assert_eq!(parse_established(&sample, 26002), 1);
        assert_eq!(parse_established(&sample, 26001), 0);
        // 前缀相同但端口不同的（2600 vs 26000）不能被误算：只有那一行真正的 :2600 被计入
        assert_eq!(parse_established(&sample, 2600), 1);
    }

    #[test]
    fn drive_letter_reads_windows_root() {
        assert_eq!(drive_letter(Path::new("e:\\repo")), Some("E:".to_string()));
        assert_eq!(drive_letter(Path::new("\\\\server\\share")), None);
    }
}
