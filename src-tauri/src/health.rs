//! 探活：对齐现役版 src/main/healthChecker.ts（26000 TCP / 26001 HTTP / 26002 /health / 40110 TCP）。
use crate::config::{
    DEFAULT_GAME_PORT, DEFAULT_GATEWAY_PORT, DEFAULT_IMAGES_PORT, DEFAULT_MARKET_PORT,
};
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const TCP_TIMEOUT_MS: u64 = 1500;
const HTTP_TIMEOUT_MS: u64 = 2000;

pub async fn tcp_alive(port: u16) -> bool {
    tcp_latency(port).await.is_some()
}

pub async fn tcp_latency(port: u16) -> Option<u64> {
    let started = Instant::now();
    match timeout(
        Duration::from_millis(TCP_TIMEOUT_MS),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Ok(_stream)) => Some(started.elapsed().as_millis() as u64),
        _ => None,
    }
}

/// 极简 HTTP 探活：单次 TCP + `GET <path> HTTP/1.0`，只看状态行。
///
/// 刻意不引入 reqwest/hyper（连 TLS 栈一起省掉约 1.2 MB 体积与数十个 crate）：
/// 这里只探本机 26001/26002，明文 HTTP/1.0 足够；S2 访问 GitHub HTTPS API 时
/// 再单独引入体积可控的 `ureq`（含 rustls）。
///
/// 判定与现役版 checkHttp 一致：任何 2xx/3xx/4xx 都算在线。
pub async fn http_alive(url: &str) -> bool {
    let Some((host, port, path)) = parse_http_url(url) else {
        return false;
    };
    let connect = timeout(
        Duration::from_millis(HTTP_TIMEOUT_MS),
        TcpStream::connect((host.as_str(), port)),
    )
    .await;
    let Ok(Ok(mut stream)) = connect else {
        return false;
    };
    let request = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut buffer = [0u8; 128];
    let read = timeout(
        Duration::from_millis(HTTP_TIMEOUT_MS),
        stream.read(&mut buffer),
    )
    .await;
    match read {
        Ok(Ok(count)) if count > 0 => {
            let head = String::from_utf8_lossy(&buffer[..count]).to_string();
            match parse_status_code(&head) {
                Some(status) => (200..500).contains(&status),
                None => false,
            }
        }
        // 超时（Elapsed）与 IO 错误一律视为离线
        _ => false,
    }
}

/// 解析 `http://host:port/path`（仅 http，未带端口时按 80 处理）
fn parse_http_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("HTTP://"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (authority, 80),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port, path.to_string()))
}

fn parse_status_code(head: &str) -> Option<u16> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_http_urls() {
        let (host, port, path) = parse_http_url("http://127.0.0.1:26002/health").expect("应能解析");
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 26002);
        assert_eq!(path, "/health");
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(parse_http_url("https://github.com/").is_none());
        assert!(parse_http_url("file:///C:/").is_none());
    }

    #[test]
    fn extracts_status_code() {
        assert_eq!(parse_status_code("HTTP/1.1 404 Not Found\r\n"), Some(404));
        assert_eq!(parse_status_code("HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_code("garbage"), None);
    }

    /// 借系统要一个当前空闲的端口（绑上拿到号就放掉，紧接着自己占回来；测试里够稳）
    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("要不到空闲端口");
        let port = listener.local_addr().expect("拿不到端口号").port();
        drop(listener);
        port
    }

    /// 进程已经退出 → 立刻认死，不把 60s 预算空耗在等一个不存在的进程上
    #[tokio::test]
    async fn wait_port_until_gives_up_at_once_when_the_process_is_gone() {
        let port = free_port();
        let started = Instant::now();
        let outcome = wait_port_until(port, 60_000, 500, || false).await;
        assert_eq!(outcome, PortWait::Exited);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "不该空等预算：{:?}",
            started.elapsed()
        );
    }

    /// 慢启动（450ms 才监听）但进程活着 → 等到就算成功，这才是 L4 场景的判据
    #[tokio::test]
    async fn wait_port_until_sees_a_listener_that_shows_up_late() {
        let port = free_port();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(450)).await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("绑定失败");
            // 保持监听：wait_port_until 的探针只连一下就断，不需要 accept
            tokio::time::sleep(Duration::from_millis(1_500)).await;
            drop(listener);
        });
        assert_eq!(
            wait_port_until(port, 5_000, 100, || true).await,
            PortWait::Ready
        );
    }

    /// 进程活着但端口一直不开 → 到点返回 Timeout（调用方据此决定继续等还是停）
    #[tokio::test]
    async fn wait_port_until_stops_at_the_deadline_while_the_process_lives() {
        let port = free_port();
        let started = Instant::now();
        let outcome = wait_port_until(port, 600, 100, || true).await;
        assert_eq!(outcome, PortWait::Timeout);
        assert!(started.elapsed() >= Duration::from_millis(600));
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResult {
    pub game: bool,
    pub images: bool,
    pub gateway: bool,
    pub market: bool,
}

pub async fn check_all() -> HealthResult {
    let images_url = format!("http://127.0.0.1:{DEFAULT_IMAGES_PORT}/");
    let gateway_url = format!("http://127.0.0.1:{DEFAULT_GATEWAY_PORT}/health");
    let (game, images, gateway, market) = tokio::join!(
        tcp_alive(DEFAULT_GAME_PORT),
        http_alive(&images_url),
        http_alive(&gateway_url),
        tcp_alive(DEFAULT_MARKET_PORT)
    );
    HealthResult {
        game,
        images,
        gateway,
        market,
    }
}

/// 端口等待的三种结局。
///
/// 现役版的 waitPort 只有「到点返回 false」一种结局：进程早就崩了也要空等满预算，
/// 「慢」和「死」被混成同一个「启动超时」。拆开之后调用方才能分别处理 ——
/// 死了立刻带原因报错，活着就继续等（启动慢不等于启动失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortWait {
    /// 端口开始监听
    Ready,
    /// 进程已退出，端口不可能再开了
    Exited,
    /// 到点仍未监听，但进程还活着
    Timeout,
}

/// 轮询等待端口就绪，同时盯着进程是否还活着（现役版 waitPort 的等价物）。
///
/// `alive` 每轮调一次（默认 500ms 一轮，开销可以忽略）：返回 false 立刻收摊，
/// 不把预算耗在「等一个已经不在的进程」上，也就不会丢掉真正的失败原因。
/// 到点仍在等就返回 [`PortWait::Timeout`]，杀不杀由调用方决定（主服务器选择不杀：见 process.rs）。
pub async fn wait_port_until<F>(port: u16, total_ms: u64, step_ms: u64, mut alive: F) -> PortWait
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + Duration::from_millis(total_ms);
    loop {
        if tcp_alive(port).await {
            return PortWait::Ready;
        }
        if !alive() {
            // 退出与监听可能挤在同一个瞬间（子进程已经监听、父壳才退出）：补探一次再认死
            return if tcp_alive(port).await {
                PortWait::Ready
            } else {
                PortWait::Exited
            };
        }
        if Instant::now() >= deadline {
            return PortWait::Timeout;
        }
        tokio::time::sleep(Duration::from_millis(step_ms)).await;
    }
}
