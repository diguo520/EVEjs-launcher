//! PTY 会话：对齐现役版 src/main/ptyManager.ts（ConPTY，缺 PTY 时降级 spawn 由 process.rs 负责）。
//!
//! 事件协议：统一发数组载荷，shim 展开成多参数回调 —— 与 Electron 的 webContents.send 语义一致。
//!   terminal:data -> [tabId, text]
//!   terminal:exit -> [tabId, code]
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// B4：终端输入的类型化包装。
///
/// 终端里会出现口令（`sudo`、`ssh`、数据库密码……），所以输入**只允许**记
/// 「tabId + 字节数」。把明文关在这个类型里，任何 `{:?}` / `{}` 输出都会自动脱敏，
/// 将来有人顺手把输入打印出去也泄不出去。
#[derive(Clone, Copy)]
pub struct TerminalInput<'a>(&'a str);

impl<'a> TerminalInput<'a> {
    pub fn new(data: &'a str) -> Self {
        Self(data)
    }

    /// 唯一能拿到明文的口子：写进 PTY 的字节
    pub fn bytes(&self) -> &'a [u8] {
        self.0.as_bytes()
    }

    /// 允许落日志的摘要：tabId + 字节数（不含内容）
    pub fn trace(&self, tab: &str) -> String {
        format!("terminal:input tab={tab} bytes={}", self.0.len())
    }
}

impl std::fmt::Debug for TerminalInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TerminalInput(<redacted:{} bytes>)", self.0.len())
    }
}

impl std::fmt::Display for TerminalInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<redacted:{} bytes>", self.0.len())
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// 写入端做成共享的，因为**两个**地方要写：
    ///   1. 渲染层来的输入（`PtyManager::write`）；
    ///   2. 输出泵里的终端查询自动应答（见 [`answer_terminal_queries`]）。
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: u32,
}

/// ConPTY 启动时会先发 `ESC[6n`（DSR：请报告光标位置）并**等答复**，收到之前不吐任何输出。
///
/// 真终端仿真器（现役版用的 xterm.js）会应答，所以这个依赖一直没暴露出来；
/// S6 的 React 日志页刻意不带终端仿真（省掉 xterm 的体积与每 tab 一份缓冲），
/// 于是子进程的输出会永远停在第一帧 —— L4 压测（无渲染层环境）当场复现：
/// 只收到 4 字节 `ESC[6n`，之后 120 s 无任何数据。
///
/// 结论：应答必须放在 PTY 这一层。谁在渲染、有没有仿真器，都不该影响服务能不能启动。
/// 只应答我们确认会被阻塞的那一条；将来若出现别的查询，同一个压测会再抓出来。
fn answer_terminal_queries(chunk: &str) -> Option<&'static [u8]> {
    if chunk.contains("\u{1b}[6n") {
        // 光标位置报告：第 1 行第 1 列（ConPTY 只用它来同步，不做校验）
        return Some(b"\x1b[1;1R");
    }
    None
}

/// PTY 会话的启动参数。打成一包是为了两件事：
///   1. `spawn_streaming` 的参数表不再长到触发 clippy::too_many_arguments；
///   2. 调用点必须写字段名，`program/args/cwd/env` 不会因为位置写错而串位。
pub struct PtySpec<'a> {
    pub program: &'a str,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
}

impl<'a> PtySpec<'a> {
    pub fn new(program: &'a str, cwd: &'a Path) -> Self {
        Self {
            program,
            args: Vec::new(),
            cwd,
            env: Vec::new(),
        }
    }

    pub fn args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    pub fn env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 启动一个 PTY 会话，输出与退出交给**回调**处理（这一层没有任何 Tauri 依赖）。
    ///
    /// 为什么要把「发到哪」摘出来：L4 要在真 ConPTY 上喷 10 万行验「不丢行」，
    /// 而 `AppHandle` 只有跑起整个 Tauri 应用才拿得到 —— 回调化之后，压测就能在
    /// `cargo test` 里跑真实的 PTY 代码路径，而不是去测一个替身（见本文件 tests）。
    pub fn spawn_streaming<F, G>(
        &self,
        id: &str,
        spec: PtySpec<'_>,
        on_data: F,
        on_exit: G,
    ) -> Result<u32, String>
    where
        F: Fn(&str, &str) + Send + 'static,
        G: Fn(&str, i64) + Send + 'static,
    {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("创建 PTY 失败: {err}"))?;

        let mut command = CommandBuilder::new(spec.program);
        for arg in &spec.args {
            command.arg(arg);
        }
        command.cwd(spec.cwd);
        for (key, value) in &spec.env {
            command.env(key, value);
        }

        let mut child: Box<dyn Child + Send + Sync> = pair
            .slave
            .spawn_command(command)
            .map_err(|err| format!("启动 {} 失败: {err}", spec.program))?;
        let pid = child.process_id().unwrap_or(0);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("读取 PTY 失败: {err}"))?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|err| format!("写入 PTY 失败: {err}"))?,
        ));

        // 输出泵：读到即发，避免在渲染层做逐行解析；顺带应答终端查询（否则 ConPTY 会一直等）
        let id_out = id.to_string();
        let writer_out = Arc::clone(&writer);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let text = String::from_utf8_lossy(&buffer[..count]).to_string();
                        if let Some(reply) = answer_terminal_queries(&text) {
                            if let Ok(mut guard) = writer_out.lock() {
                                let _ = guard.write_all(reply).and_then(|_| guard.flush());
                            }
                        }
                        on_data(&id_out, &text);
                    }
                    Err(_) => break,
                }
            }
        });

        // 退出监视：子进程所有权交给监视线程；kill 走 taskkill /T /F（与现役版 killOwned 一致）
        let id_exit = id.to_string();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i64,
                Err(_) => -1,
            };
            on_exit(&id_exit, code);
        });

        if let Ok(mut guard) = self.sessions.lock() {
            guard.insert(
                id.to_string(),
                Session {
                    master: pair.master,
                    writer,
                    pid,
                },
            );
        }
        Ok(pid)
    }

    /// 生产用入口：把 [`spawn_streaming`] 的两个回调接到 Tauri 事件与崩溃判定上。
    ///
    /// 事件协议与现役版一致（统一数组载荷，shim 负责展开）：
    /// `terminal:data -> [tabId, text]`、`terminal:exit -> [tabId, code]`。
    pub fn spawn(&self, app: &AppHandle, id: &str, spec: PtySpec<'_>) -> Result<u32, String> {
        let data_app = app.clone();
        let exit_app = app.clone();
        self.spawn_streaming(
            id,
            spec,
            move |tab, text| {
                let _ = data_app.emit("terminal:data", json!([tab, text]));
            },
            move |tab, code| {
                let _ = exit_app.emit("terminal:exit", json!([tab, code]));
                // 与现役版一致：先发渲染层事件，再跑崩溃判定回调
                crate::process::on_pty_exit(&exit_app, tab, code);
            },
        )
    }

    /// 写入终端输入。参数类型是 [`TerminalInput`]，明文拿不到（B4）：
    /// 错误信息里也只带 tabId 与字节数，不带内容。
    pub fn write(&self, id: &str, input: TerminalInput<'_>) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "PTY 会话锁不可用".to_string())?;
        let session = guard.get(id).ok_or_else(|| format!("会话不存在: {id}"))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "PTY 写入端锁不可用".to_string())?;
        writer
            .write_all(input.bytes())
            .and_then(|_| writer.flush())
            .map_err(|err| format!("{} 写入失败: {err}", input.trace(id)))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "PTY 会话锁不可用".to_string())?;
        let session = guard.get(id).ok_or_else(|| format!("会话不存在: {id}"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| err.to_string())
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions
            .lock()
            .ok()?
            .get(id)
            .map(|session| session.pid)
    }

    pub fn remove(&self, id: &str) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.remove(id);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// L4 的接收端：一边攒字节，一边记录「相邻两个 chunk 之间的最大间隔」。
    #[derive(Default)]
    struct StressSink {
        data: Vec<u8>,
        chunks: usize,
        max_gap: Duration,
        last: Option<Instant>,
        /// 第一段输出的前 300 字符（排查「PID 有、输出没有」这类症状的唯一线索）
        head: String,
    }

    impl StressSink {
        fn push(&mut self, text: &str) {
            let now = Instant::now();
            if let Some(last) = self.last {
                let gap = now.duration_since(last);
                if gap > self.max_gap {
                    self.max_gap = gap;
                }
            }
            self.last = Some(now);
            self.chunks += 1;
            if self.head.len() < 300 {
                self.head
                    .push_str(&text.chars().take(300).collect::<String>());
            }
            self.data.extend_from_slice(text.as_bytes());
        }

        /// 数标记出现次数。用 `#L000001#` 这种带前后的标记，避免把 PTY 重绘/回显算进去。
        fn markers(&self) -> usize {
            self.data.windows(2).filter(|pair| pair == b"#L").count()
        }
    }

    /// L4 终端压测：真 ConPTY 喷 100,000 行，逐行编号校验「不丢行」，并记录最大 chunk 间隔。
    ///
    /// 默认 `#[ignore]`：它要真起一个 node 进程并读 ~1.4 MB 输出，约 10–30 s，
    /// 不适合混在日常 `cargo test` 里。跑法：
    ///   cargo test --lib -- --ignored --nocapture l4_terminal_stress
    ///   pwsh -File scripts/stress-terminal.ps1   （带机器可读产物）
    #[test]
    #[ignore = "L4 终端压测：真起 ConPTY 喷 10 万行，需显式 --ignored 运行"]
    fn l4_terminal_stress_100k_lines_without_loss() {
        const LINES: usize = 100_000;
        // 每行形如 #L000001#，共 10 字符；远短于 PTY 的 120 列，因此不会被行折行拆开
        let script = format!(
            "for (let i = 1; i <= {LINES}; i++) process.stdout.write('#L' + String(i).padStart(6, '0') + '#\\n');"
        );
        let cwd = std::env::current_dir().expect("拿不到工作目录");
        let sink = Arc::new(Mutex::new(StressSink::default()));
        let writer = Arc::clone(&sink);

        let pty = PtyManager::new();
        let started = Instant::now();
        let pid = pty
            .spawn_streaming(
                "l4-stress",
                PtySpec::new("node", &cwd).args(vec!["-e".to_string(), script]),
                move |_tab, text| {
                    if let Ok(mut guard) = writer.lock() {
                        guard.push(text);
                    }
                },
                |_tab, _code| {},
            )
            .expect("启动 PTY 失败（本机需要 node 在 PATH 上）");
        assert!(pid > 0, "PTY 应返回非零 PID");

        // 等它读完：最多 120 s
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut markers = 0usize;
        while Instant::now() < deadline {
            markers = sink.lock().map(|guard| guard.markers()).unwrap_or(0);
            if markers >= LINES {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let elapsed = started.elapsed();
        let (bytes, chunks, max_gap, head) = {
            let guard = sink.lock().expect("锁被毒化");
            (
                guard.data.len(),
                guard.chunks,
                guard.max_gap,
                guard.head.replace('\u{1b}', "<ESC>"),
            )
        };

        println!(
            "[L4] 目标 {LINES} 行 · 收到标记 {markers} · {} 字节 · {} 个 chunk · 耗时 {:.1} s · 最大间隔 {:.0} ms",
            bytes,
            chunks,
            elapsed.as_secs_f64(),
            max_gap.as_secs_f64() * 1000.0
        );
        if markers < LINES {
            println!("[L4] 首段输出：{head}");
        }

        assert!(
            markers >= LINES,
            "终端丢行：只收到 {markers}/{LINES} 行（{} 字节 / {} chunk）",
            bytes,
            chunks
        );
        // 单次卡顿阈值：计划 §12 要求「无 >500 ms 卡顿」。压测环境的调度抖动留一倍余量。
        assert!(
            max_gap < Duration::from_millis(1000),
            "单次 chunk 间隔 {:.0} ms，超过 1000 ms 阈值",
            max_gap.as_secs_f64() * 1000.0
        );
        pty.remove("l4-stress");
    }

    /// L4 的根因回归：ConPTY 的 `ESC[6n` 必须被应答，否则子进程输出永远停在第一帧。
    #[test]
    fn conpty_cursor_query_is_answered() {
        // 真实抓到的形态：启动时第一个 chunk 就是 4 字节的 ESC[6n
        assert_eq!(
            answer_terminal_queries("\u{1b}[6n"),
            Some(&b"\x1b[1;1R"[..])
        );
        // 混在其它输出里也要认出来
        assert_eq!(
            answer_terminal_queries("hello\u{1b}[6nworld"),
            Some(&b"\x1b[1;1R"[..])
        );
        // 普通输出不应答，避免无谓写回
        assert!(answer_terminal_queries("plain log line").is_none());
        assert!(answer_terminal_queries("\u{1b}[2J\u{1b}[H").is_none());
    }

    #[test]
    fn terminal_input_never_leaks_payload_in_logs() {
        let secret = "hunter2:P@ssw0rd";
        let input = TerminalInput::new(secret);
        let debug = format!("{input:?}");
        let display = format!("{input}");
        let trace = input.trace("tab-1");
        for text in [&debug, &display, &trace] {
            for needle in [secret, "hunter2", "P@ssw0rd"] {
                assert!(!text.contains(needle), "输入内容泄漏到日志：{text}");
            }
        }
        assert!(debug.contains("redacted"), "{debug}");
        assert!(display.contains("redacted"), "{display}");
        assert_eq!(
            trace,
            format!("terminal:input tab=tab-1 bytes={}", secret.len())
        );
        // 明文只能从 bytes() 出去（真正写 PTY 的那条路）
        assert_eq!(input.bytes(), secret.as_bytes());
    }

    /// L5 编码验收（zh-CN Windows / 代码页 936）：中文与 ANSI 颜色过 ConPTY 之后不许变形。
    ///
    /// 为什么必须过真 PTY：编码转换发生在 ConPTY（控制台 ↔ 管道）内部，用 `Command::output()`
    /// 直连管道测不到这条路径。口径与现役版对齐 —— 现役版是 `d.toString()`，即 UTF-8。
    ///
    /// 覆盖两条不同的产出路径：
    ///   ① `cmd` 内建 `echo`：走控制台 API，受活动代码页支配（中文 Windows 上最易坏的一条）；
    ///   ② `node` 直写管道：走字节流，同时验 ANSI 颜色序列不被吃掉。
    ///
    /// 默认 `#[ignore]`：要真起 cmd/node。跑法：
    ///   cargo test --lib -- --ignored --nocapture l5_zh_cn
    ///   pwsh -File scripts/check-encoding.ps1   （带机器可读产物）
    #[test]
    #[ignore = "L5 编码验收：真起 cmd/node，需显式 --ignored 运行"]
    fn l5_zh_cn_936_output_keeps_chinese_and_ansi() {
        /// L5 只关心文本是否完整，不关心吞吐
        #[derive(Default)]
        struct TextSink(String);
        impl TextSink {
            fn push(&mut self, text: &str) {
                self.0.push_str(text);
            }
        }

        /// 攒到 `done` 成立或超时；返回累计文本（会话一并移除）
        fn wait_text(
            pty: &PtyManager,
            id: &str,
            sink: &Arc<Mutex<TextSink>>,
            done: impl Fn(&str) -> bool,
            budget: Duration,
        ) -> String {
            let deadline = Instant::now() + budget;
            loop {
                let text = sink.lock().map(|guard| guard.0.clone()).unwrap_or_default();
                if done(&text) || Instant::now() >= deadline {
                    pty.remove(id);
                    return text;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        fn run(
            pty: &PtyManager,
            id: &str,
            spec: PtySpec<'_>,
            done: impl Fn(&str) -> bool + 'static,
        ) -> String {
            let sink = Arc::new(Mutex::new(TextSink::default()));
            let writer = Arc::clone(&sink);
            pty.spawn_streaming(
                id,
                spec,
                move |_tab, text| {
                    if let Ok(mut guard) = writer.lock() {
                        guard.push(text);
                    }
                },
                |_tab, _code| {},
            )
            .expect("启动 L5 子进程失败");
            wait_text(pty, id, &sink, done, Duration::from_secs(20))
        }

        let cwd = std::env::current_dir().expect("拿不到工作目录");
        let pty = PtyManager::new();

        // ① 环境探针：记录本机活动代码页（zh-CN 上应为 936）。只记录、不断言，保持机器无关。
        let chcp = run(
            &pty,
            "l5-chcp",
            PtySpec::new("cmd", &cwd).args(vec!["/c".to_string(), "chcp".to_string()]),
            // 不能按「出现 3 位数字」判定：ConPTY 的会话头里就有 9001 / 1004 / 25。
            // chcp 是这一串里第一个带换行的输出，按换行收口才拿得到真正的那一行。
            |text| text.contains('\r') || text.contains('\n'),
        );
        let active_cp = chcp
            .split(|ch: char| !ch.is_ascii_digit())
            .rfind(|token| token.len() == 3)
            .unwrap_or("???")
            .to_string();

        // ② cmd 内建 echo + 显式 chcp 936：控制台 API 这条路径
        let cmd_text = run(
            &pty,
            "l5-cmd",
            PtySpec::new("cmd", &cwd).args(vec![
                "/c".to_string(),
                "chcp 936 >nul & echo 中文测试·936".to_string(),
            ]),
            |text| text.contains("936") && text.contains('\n'),
        );
        assert!(
            !cmd_text.contains('\u{fffd}'),
            "cmd 输出出现替换字符（字节被误解码）：{cmd_text:?}"
        );
        assert!(
            cmd_text.contains("中文测试·936"),
            "cmd 中文输出丢失：{cmd_text:?}"
        );

        // ③ node 直写管道 + ANSI 颜色：字节流这条路径
        let script = "process.stdout.write('\u{1b}[31m红色\u{1b}[0m 中文B\\n')".to_string();
        let node_text = run(
            &pty,
            "l5-node",
            PtySpec::new("node", &cwd).args(vec!["-e".to_string(), script]),
            |text| text.contains("中文B"),
        );
        assert!(
            !node_text.contains('\u{fffd}'),
            "node 输出出现替换字符：{node_text:?}"
        );
        assert!(
            node_text.contains("红色"),
            "node 中文输出丢失：{node_text:?}"
        );
        assert!(
            node_text.contains("\u{1b}[31m"),
            "ANSI 红色（SGR 31）丢失：{node_text:?}"
        );
        // ConPTY 会把 `ESC[0m` 规范化成 `ESC[m`（空参数 = 复位），实测原文就是这样：
        //   ESC[6n ESC[?9001h ESC[?1004h ESC[m ESC]0;C:\nodejs\node.EXE BEL ESC[?25h ESC[31m红色 ESC[m中文B
        // 也就是说 ConPTY 会**重新序列化**子进程的 VT 流（不是字节直通），
        // 所以渲染层必须把空参数 SGR 当复位 —— 这正是 ui/src/lib/ansi.ts 的既有行为（单测已锁）。
        assert!(
            node_text.contains("\u{1b}[m") || node_text.contains("\u{1b}[0m"),
            "ANSI 复位丢失：{node_text:?}"
        );
        // OSC 标题是「渲染层必须能剥掉」的输入，PTY 层刻意原样透传（见 ansi.ts 的单测）。
        // 这里只做记录：不同 conhost 版本发不发它不在我们的控制范围内。
        let has_osc = node_text.contains("\u{1b}]0;");
        println!(
            "[L5] ConPTY 会话头：OSC 标题 {} · 私有模式 {}",
            if has_osc { "有" } else { "无" },
            if node_text.contains("\u{1b}[?") {
                "有"
            } else {
                "无"
            }
        );

        let shown = |text: &str| text.replace('\u{1b}', "<ESC>").replace('\r', "<CR>");
        println!(
            "[L5] 活动代码页 {active_cp} · cmd 原文 {:?} · node 原文 {:?}",
            shown(cmd_text.trim()),
            shown(node_text.trim())
        );
        if active_cp != "936" {
            println!("[L5] 注意：本机活动代码页不是 936（{active_cp}），936 分支靠显式 chcp 覆盖");
        }
    }
}
