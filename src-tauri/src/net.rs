//! 出网层：启动器**所有** HTTPS 请求都从这里出去（对齐现役版 `net.fetch` / `node:https`）。
//!
//! 选型（见 `docs/S2-发布与市场-实施记录.md` D19）：
//!   - 用 `ureq` 而不是 `reqwest`：只需要「取 JSON / 下文件」两种能力，reqwest 会拉进
//!     hyper 一整棵依赖树，体积与常驻内存都不划算；
//!   - TLS 走 `native-tls`（Windows 上就是系统自带的 schannel）：复用系统证书库，
//!     不用额外打包根证书；再开 `win-system-proxy` 复用系统代理设置，
//!     代理环境下的行为与浏览器一致。不启用默认的 rustls，省掉加密后端的体积；
//!   - 请求是**阻塞**的：调用方（IPC 分发）用 `spawn_blocking` 包一层，不占 tokio 工作线程；
//!     ureq 没有后台线程，闲置时零开销。
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// 与现役版一致的 UA（GitHub / jsDelivr / Pages 都会按它识别启动器）
pub const USER_AGENT: &str = "EveJS-Launcher";

/// 用户点「取消下载」时的统一错误文案（调用方据此区分「主动取消」与「真失败」）
pub const CANCELLED: &str = "已取消下载";

/// 一次完整响应（状态码 + 原始字节）
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    /// 解析 JSON：空体或非法 JSON 一律 None（对齐现役版 `parseJson` 的容错口径）
    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&self.text()).ok()
    }
}

/// 下载结果
pub struct DownloadOutcome {
    pub bytes: u64,
}

/// 建一个「一次用完就丢」的 agent：它只是连接池 + 配置，
/// 而各通道的超时口径不同（索引 8s / API 20s / 下载 120s），按需建更直白。
fn agent(timeout: Duration) -> ureq::Agent {
    // TLS 三件套缺一不可：provider 选 native-tls（未开 rustls 特性时默认值是 rustls，
    // 会在运行时报「provider is Rustls but feature is not enabled」）；
    // 根证书必须显式改成 PlatformVerifier，否则默认的 WebPki 会去找我们没启用的
    // `native-tls-webpki-roots` 内置证书清单 —— 而系统证书库才是我们想要的。
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        .tls_config(tls)
        // 4xx/5xx 不当异常抛：调用方要自己读 status（现役版就是读 res.status）
        .http_status_as_error(false)
        .build()
        .into()
}

/// 把底层错误翻成现役版同款文案
fn friendly(message: &str, timeout: Duration) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") || lower.contains("deadline") {
        format!("请求超时（{}s）", timeout.as_secs())
    } else {
        message.to_string()
    }
}

/// 统一挂上自定义头（ureq 的 `RequestBuilder<B>` 对任何 body 状态都提供 `header`）
fn with_headers<B>(
    mut request: ureq::RequestBuilder<B>,
    headers: &[(&str, &str)],
) -> ureq::RequestBuilder<B> {
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request
}

/// 发一个请求并把响应体整个读回来。
///
/// ureq 3 的 builder 分「有 body / 无 body」两种状态，所以这里按方法分派：
/// GET/HEAD/DELETE 走 `call()`，POST/PUT/PATCH 走 `send()`（无 body 时发空串，
/// GitHub 的建 fork / 建 ref 端点都接受空体）。
pub fn send(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<(&[u8], &str)>,
    timeout: Duration,
) -> Result<Response, String> {
    let agent = agent(timeout);
    let (bytes, content_type) = match body {
        Some((bytes, content_type)) => (bytes, content_type),
        None => (&[][..], "application/json"),
    };
    let upper = method.to_ascii_uppercase();
    let result = match upper.as_str() {
        "GET" => with_headers(agent.get(url), headers).call(),
        "HEAD" => with_headers(agent.head(url), headers).call(),
        "DELETE" => with_headers(agent.delete(url), headers).call(),
        "POST" => with_headers(agent.post(url), headers)
            .header("Content-Type", content_type)
            .send(bytes),
        "PUT" => with_headers(agent.put(url), headers)
            .header("Content-Type", content_type)
            .send(bytes),
        "PATCH" => with_headers(agent.patch(url), headers)
            .header("Content-Type", content_type)
            .send(bytes),
        _ => return Err(format!("不支持的请求方法：{method}")),
    };
    let mut response = result.map_err(|err| friendly(&err.to_string(), timeout))?;
    let status = response.status().as_u16();
    let mut buffer = Vec::new();
    response
        .body_mut()
        .as_reader()
        .read_to_end(&mut buffer)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    Ok(Response {
        status,
        body: buffer,
    })
}

/// GET 文本（`accept` 一般是 `application/json`）
pub fn get(url: &str, accept: &str, timeout: Duration) -> Result<Response, String> {
    send("GET", url, &[("Accept", accept)], None, timeout)
}

/// GitHub REST 调用：对齐现役版 `githubSubmit.ts::call()` 的请求头与超时。
/// `X-GitHub-Api-Version` 必须带上，否则部分端点会退回旧版行为。
pub fn github_api(
    token: &str,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
    timeout: Duration,
) -> Result<Response, String> {
    let url = format!("https://api.github.com{path}");
    let authorization = format!("Bearer {token}");
    let mut headers: Vec<(&str, &str)> = vec![
        ("Authorization", authorization.as_str()),
        ("Accept", "application/vnd.github+json"),
        ("X-GitHub-Api-Version", "2022-11-28"),
    ];
    let payload = match body {
        Some(value) => {
            let bytes =
                serde_json::to_vec(value).map_err(|err| format!("请求体序列化失败：{err}"))?;
            headers.push(("Content-Type", "application/json"));
            Some(bytes)
        }
        None => None,
    };
    let body_ref = payload
        .as_ref()
        .map(|bytes| (bytes.as_slice(), "application/json"));
    send(method, &url, &headers, body_ref, timeout)
}
/// 流式下载到本地文件，边下边回报进度（`on_progress(已下字节, 总字节)`）。
///
/// `total` 取 `Content-Length`，取不到就是 `None`（对齐现役版 `content-length` 口径）。
/// 中途任何失败都留下半截文件，调用方负责清理（现役版也是这样）。
pub fn download(
    url: &str,
    dest: &Path,
    timeout: Duration,
    on_progress: impl FnMut(u64, Option<u64>),
) -> Result<DownloadOutcome, String> {
    download_cancellable(url, dest, timeout, || false, on_progress)
}

/// `download` 的可取消版本：每读一块前问一次 `is_cancelled`。
///
/// 为什么要单独开一个函数：`ureq` 的 body reader 没有「中断正在等的 socket」的口子，
/// 而更新器必须做到「点取消立刻停」，所以只能在块与块之间轮询取消标志。
/// 取消与网络失败一样回 `Err`，半截文件由调用方删（现役版也是这么做的）。
pub fn download_cancellable(
    url: &str,
    dest: &Path,
    timeout: Duration,
    mut is_cancelled: impl FnMut() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<DownloadOutcome, String> {
    let agent = agent(timeout);
    let mut response = agent
        .get(url)
        .call()
        .map_err(|err| friendly(&err.to_string(), timeout))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let total = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let mut file = std::fs::File::create(dest).map_err(|err| format!("写不进目标文件：{err}"))?;
    let mut reader = response.body_mut().as_reader();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        if is_cancelled() {
            return Err(CANCELLED.to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|err| friendly(&err.to_string(), timeout))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|err| format!("写盘失败：{err}"))?;
        downloaded += read as u64;
        on_progress(downloaded, total);
    }
    let _ = file.flush();
    Ok(DownloadOutcome { bytes: downloaded })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_translates_timeouts() {
        assert_eq!(
            friendly("timed out waiting for response", Duration::from_secs(8)),
            "请求超时（8s）"
        );
        assert_eq!(
            friendly("Deadline has elapsed", Duration::from_secs(20)),
            "请求超时（20s）"
        );
        // 其它错误原样透出，方便用户看到 DSN / 证书之类的真实原因
        assert_eq!(
            friendly("connection refused", Duration::from_secs(8)),
            "connection refused"
        );
    }

    #[test]
    fn response_json_is_lenient() {
        let ok = Response {
            status: 200,
            body: br#"{"a":1}"#.to_vec(),
        };
        assert_eq!(ok.json().and_then(|v| v["a"].as_u64()), Some(1));
        let broken = Response {
            status: 200,
            body: b"<html>502</html>".to_vec(),
        };
        assert!(broken.json().is_none());
        assert_eq!(broken.text(), "<html>502</html>");
    }

    /// 真机 HTTPS 冒烟（默认不跑）：验证 schannel + 系统代理这条链路真的能出网。
    /// 手动执行：`cargo test --lib net::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_https_round_trip() {
        let response = get(
            "https://api.github.com/",
            "application/json",
            Duration::from_secs(20),
        )
        .unwrap();
        assert!(
            response.status == 200 || response.status == 403,
            "status={}",
            response.status
        );
        assert!(!response.body.is_empty());
    }
}
