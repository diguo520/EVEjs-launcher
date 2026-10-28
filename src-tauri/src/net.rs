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
use std::fs::{File, OpenOptions};
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
    /// `x-oauth-scopes`：只有 classic / OAuth 令牌会返回这个头（逗号分隔的 scope 清单）；
    /// fine-grained 令牌与 GitHub App 令牌没有它。启动器靠这个差别判断「这枚令牌能不能
    /// 碰别人名下的索引仓库」—— fine-grained 只能给「自己有权限的仓库」授权，投稿索引仓库
    /// 在维护者名下，普通作者根本勾不到，所以那种令牌会 403。
    pub oauth_scopes: Option<String>,
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
    /// 下载完成后本地文件的总字节数（**含**这次续传前已有的那部分）
    pub bytes: u64,
    /// 这次是从第几字节接着下的（0 = 全新下载）。调用方据此判断「是不是续传」。
    pub resumed_from: u64,
}

/// —— 传输超时口径（2026-10-27 改造）——
///
/// 老口径是「一个 120s 的总时限走天下」：5 GB 的包要 ≥43 MB/s 才能下完，慢网必死；
/// 而且它把「连不上」和「下到一半卡住」算成同一个错。
///
/// 现在按用途分开，并配合「分段 Range」把单个请求的体量压小（见 `download_cancellable`）：
///   · 握手（连接 / 发请求 / 收响应头）：30s —— 死掉的主机要快速失败；
///   · 收/发 body：按**本次请求的体积**算预算（`transfer_budget`），不是拍一个死数；
///   · 没有「多久没读到数据」的超时可用（ureq 只有总体预算），所以用分段来兜：
///     一段卡住最多浪费一段的预算，重试还能从断点接着下。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// 保底速度：预算 = 60s + 体积 / 这个值。
///
/// 2026-10-28 从 256 KB/s 下调到 64 KB/s：t4 实测本机 ~110 KiB/s，
/// 按 256 KB/s 算的话每一段都必然撞超时（用户侧表现就是「大包永远下不完」）。
/// 64 KB/s 只用于**给慢链路留活路**，不代表我们对速度的期望。
const MIN_TRANSFER_SPEED: u64 = 64 * 1024;
/// 预算下限，也是「体积未知」时的兜底
const TRANSFER_BUDGET_FLOOR: Duration = Duration::from_secs(60);
/// 分段下载的段大小：每段一个独立的 Range 请求。
///
/// 为什么必须分段：ureq 的 `timeout_recv_body` 是**收完整个 body 的总预算**，
/// 没有「每读一次」的口子。一口气下一整包时，连接卡住只能等预算耗尽（5 GB ≈ 5.7 小时）。
/// 切成 64 MB 一段之后，每段自己的预算是「64 MB / 256 KB/s ≈ 4 分钟」，
/// 卡住最多浪费一段；而且段与段之间天然就是断点，重试直接从那一段接着下。
/// 2026-10-28 从 64 MiB 收到 16 MiB：段越小，单段预算越短、慢网上越不容易整段超时；
/// 代价只是请求数变多（5 GB / 16 MiB ≈ 320 次，GitHub 扛得住）。
pub const RANGE_CHUNK: u64 = 16 * 1024 * 1024;

/// 按体积算传输预算：60s 起步 + 体积 / 保底速度。
pub fn transfer_budget(size_hint: Option<u64>) -> Duration {
    match size_hint {
        Some(size) if size > 0 => {
            TRANSFER_BUDGET_FLOOR + Duration::from_secs(size / MIN_TRANSFER_SPEED)
        }
        _ => TRANSFER_BUDGET_FLOOR,
    }
}

/// TLS 三件套缺一不可：provider 选 native-tls（未开 rustls 特性时默认值是 rustls，
/// 会在运行时报「provider is Rustls but feature is not enabled」）；
/// 根证书必须显式改成 PlatformVerifier，否则默认的 WebPki 会去找我们没启用的
/// `native-tls-webpki-roots` 内置证书清单 —— 而系统证书库才是我们想要的。
fn tls_config() -> ureq::tls::TlsConfig {
    ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build()
}

/// 建一个「一次用完就丢」的 agent：它只是连接池 + 配置，
/// 而各通道的超时口径不同（索引 8s / API 20s / 更新清单 30s），按需建更直白。
fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        .tls_config(tls_config())
        // 4xx/5xx 不当异常抛：调用方要自己读 status（现役版就是读 res.status）
        .http_status_as_error(false)
        .build()
        .into()
}

/// 传文件用的 agent：握手快速失败，body 按体积给预算，总时限不再压死。
fn transfer_agent(size_hint: Option<u64>) -> ureq::Agent {
    let budget = transfer_budget(size_hint);
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(None)
        .timeout_connect(Some(HANDSHAKE_TIMEOUT))
        .timeout_send_request(Some(HANDSHAKE_TIMEOUT))
        .timeout_recv_response(Some(HANDSHAKE_TIMEOUT))
        .timeout_await_100(Some(HANDSHAKE_TIMEOUT))
        .timeout_recv_body(Some(budget))
        .timeout_send_body(Some(budget))
        .tls_config(tls_config())
        .http_status_as_error(false)
        .build()
        .into()
}

/// 把底层错误翻成现役版同款文案
fn friendly(message: &str, timeout: Duration) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") || lower.contains("deadline") {
        // L1（2026-10-28）：以前一律报「传输预算」的秒数 —— 实测 30s 的握手超时被写成
        // 「请求超时（7307s）」，用户以为还要等两小时。按错误文本判断是哪一段超时，报真实秒数。
        let (phase, seconds) = if lower.contains("connect") {
            ("连接", HANDSHAKE_TIMEOUT.as_secs())
        } else if lower.contains("handshake") || lower.contains("tls") {
            ("握手", HANDSHAKE_TIMEOUT.as_secs())
        } else if lower.contains("response") || lower.contains("header") {
            ("等响应", HANDSHAKE_TIMEOUT.as_secs())
        } else {
            ("读数据", timeout.as_secs())
        };
        format!("请求超时（{phase} {seconds}s）")
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
    read_response(result, timeout)
}

/// 把一次请求的结果收成一个 `Response`（状态码 + 整个 body + oauth scopes）。
fn read_response(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    timeout: Duration,
) -> Result<Response, String> {
    let mut response = result.map_err(|err| friendly(&err.to_string(), timeout))?;
    let status = response.status().as_u16();
    let oauth_scopes = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string());
    let mut buffer = Vec::new();
    response
        .body_mut()
        .as_reader()
        .read_to_end(&mut buffer)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    Ok(Response {
        status,
        body: buffer,
        oauth_scopes,
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
/// `total` 优先取 `Content-Range` 里的远端总长，其次 `Content-Length`，都没有就是 `None`。
/// 中途失败**保留**半截文件 —— 下一次调用会从这里接着下（断点续传）。
pub fn download(
    url: &str,
    dest: &Path,
    size_hint: Option<u64>,
    on_progress: impl FnMut(u64, Option<u64>),
) -> Result<DownloadOutcome, String> {
    download_cancellable(url, dest, size_hint, || false, on_progress)
}

/// `download` 的可取消 + 可续传版本。
///
/// 三件事：
///   1. **断点续传**：`dest` 已有半截就带 `Range` 接着下、以 append 写回去；
///      服务端不认 Range（回 200）时先清空再下，**绝不把两份字节接在一起**。
///   2. **分段**：每段一个 Range 请求（`RANGE_CHUNK`），于是单次请求的收 body 预算
///      是分钟级而不是「5 GB 一整条」的小时级；一段卡住最多浪费一段。
///   3. **可取消**：每读一块前问一次 `is_cancelled`（ureq 没有中断正在等的 socket 的口子）。
///
/// 取消与网络失败一样回 `Err`；半截文件保留，等下一次续传。
pub fn download_cancellable(
    url: &str,
    dest: &Path,
    size_hint: Option<u64>,
    mut is_cancelled: impl FnMut() -> bool,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<DownloadOutcome, String> {
    let mut resumed_from = std::fs::metadata(dest).map(|meta| meta.len()).unwrap_or(0);
    let mut written = resumed_from;
    // 因为「服务端回的区间不对」而重启的次数（M2：最多允许一次）
    let mut restarted: u32 = 0;
    let mut total = size_hint.filter(|size| *size > 0);

    loop {
        if is_cancelled() {
            return Err(CANCELLED.to_string());
        }
        if let Some(total) = total {
            // 本地比远端还长：不可能是合法的半截包（多半是上一次写坏了/被塞了东西）。
            // 丢掉重来，绝不能让「长度够」当成「已经下好了」—— 那正是 0.6.2 的毒缓存成因。
            if written > total {
                let _ = std::fs::remove_file(dest);
                written = 0;
                // 这份本地文件作废了，实际是从 0 开始的（t6 复核残留③：口径要如实）
                resumed_from = 0;
            }
            if written >= total {
                break;
            }
        }

        let start = written;
        let end = start.saturating_add(RANGE_CHUNK - 1);
        let want = end - start + 1;
        // M1（2026-10-28）：服务端**有权不认 Range**（回 200），这一趟就会把整包读进来。
        // 从 0 开始的那一次请求按整包体积给预算；续传段仍按一段给（卡住最多浪费一段）。
        let budget_hint = if start == 0 {
            want.max(size_hint.unwrap_or(0))
        } else {
            want
        };
        let budget = transfer_budget(Some(budget_hint));
        let mut response = transfer_agent(Some(budget_hint))
            .get(url)
            .header("Range", &format!("bytes={start}-{end}"))
            .call()
            .map_err(|err| friendly(&err.to_string(), budget))?;
        let status = response.status().as_u16();
        if status == 416 {
            // 请求范围整段落在远端末尾之外：本地这份已经到头
            break;
        }
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        // 206 = 服务端认了 Range，只给这一段的字节；200 = 它不认（或整包比请求的范围还小）
        let partial = status == 206;

        // M2（2026-10-28）：206 必须回**我们请求的那个起点**。说谎的镜像回一段别处的字节，
        // 拼出来的包 sha256 必然对不上 —— 但那是「运气好被兜住」；这里当场核对，
        // 对不上就丢掉重来一次（仅一次，避免和坏镜像无限互搏）。
        if partial {
            let served_from = response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .and_then(parse_range_start);
            if let Some(served) = served_from {
                if served != start {
                    let _ = std::fs::remove_file(dest);
                    restarted += 1;
                    if restarted > 1 {
                        return Err(format!("服务端回的区间起点是 {served}，不是请求的 {start}"));
                    }
                    written = 0;
                    continue;
                }
            }
        }

        // 远端总长：Content-Range 最准，其次 Content-Length
        let header_total = response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_range_total);
        let content_length = response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());

        let mut file = if partial {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dest)
                .map_err(|err| format!("写不进目标文件：{err}"))?
        } else {
            // 不支持 Range：本文件从零重来（半截那份作废，绝不影响正确性）
            written = 0;
            File::create(dest).map_err(|err| format!("写不进目标文件：{err}"))?
        };

        if let Some(size) = header_total {
            total = Some(size);
        } else if total.is_none() {
            if let Some(len) = content_length {
                total = Some(if partial { written + len } else { len });
            }
        }

        let mut reader = response.body_mut().as_reader();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut got: u64 = 0;
        loop {
            if is_cancelled() {
                return Err(CANCELLED.to_string());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|err| friendly(&err.to_string(), budget))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|err| format!("写盘失败：{err}"))?;
            written += read as u64;
            got += read as u64;
            on_progress(written, total);
            // 段下够了就收手：服务端有可能给得比请求的多（按整包回），多出来的不能算进去
            if partial && got >= want {
                break;
            }
        }
        let _ = file.flush();

        if !partial {
            // 整包（不支持 Range）已经下完
            break;
        }
        if got < want {
            // 服务端这一段没给满 = 到远端末尾了
            break;
        }
    }

    Ok(DownloadOutcome {
        bytes: written,
        resumed_from,
    })
}

/// `Content-Range: bytes 0-16777215/5368709120` → 起点 0；取不到就是 None。
///
/// M2（2026-10-28）用它核对「服务端回的这段是不是我们请求的那段」：
/// 说谎的镜像回一段别处的内容，拼出来的包 sha256 必然对不上，但那是运气好被兜住，
/// 这里当场就能发现。
fn parse_range_start(value: &str) -> Option<u64> {
    let after_unit = value.trim().strip_prefix("bytes").unwrap_or(value.trim());
    let range = after_unit.trim().split('/').next()?;
    let start = range.split('-').next()?;
    start.trim().parse::<u64>().ok()
}

/// `Content-Range: bytes 0-67108863/5368709120` → 总长 5368709120；取不到就是 None。
fn parse_range_total(value: &str) -> Option<u64> {
    value
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|part| *part != "*")
        .and_then(|part| part.parse::<u64>().ok())
}

/// 流式上传一个文件：body 从磁盘按块读，**不把整个文件读进内存**。
///
/// 为什么传 `File` 而不是 `&[u8]`：ureq 对 `File` 走 `LengthDelimited`（自动带上
/// Content-Length、不分块），正是 GitHub 上传发布资产要的口径；换成
/// `SendBody::from_reader` 的话 size 是 None，会退化成 chunked，GitHub 不一定收。
pub fn send_file(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    file: File,
    content_type: &str,
    size_hint: u64,
) -> Result<Response, String> {
    let agent = transfer_agent(Some(size_hint));
    let upper = method.to_ascii_uppercase();
    let result = match upper.as_str() {
        "POST" => with_headers(agent.post(url), headers)
            .header("Content-Type", content_type)
            .send(file),
        "PUT" => with_headers(agent.put(url), headers)
            .header("Content-Type", content_type)
            .send(file),
        _ => return Err(format!("不支持的请求方法：{method}")),
    };
    read_response(result, transfer_budget(Some(size_hint)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_translates_timeouts() {
        // L1 之后文案带阶段名：等响应/握手用 30s 的握手超时，读数据用本次传输预算
        assert_eq!(
            friendly("timed out waiting for response", Duration::from_secs(8)),
            "请求超时（等响应 30s）"
        );
        assert_eq!(
            friendly("Deadline has elapsed", Duration::from_secs(20)),
            "请求超时（读数据 20s）"
        );
        // 其它错误原样透出，方便用户看到 DSN / 证书之类的真实原因
        assert_eq!(
            friendly("connection refused", Duration::from_secs(8)),
            "connection refused"
        );
    }

    /// 传输预算按体积走：小包是分钟级，5 GB 这种大包也不再是「一个 120s 的死数」。
    #[test]
    fn transfer_budget_scales_with_size() {
        // 体积未知 → 地板价 60s
        assert_eq!(transfer_budget(None), Duration::from_secs(60));
        assert_eq!(transfer_budget(Some(0)), Duration::from_secs(60));
        // 一段（RANGE_CHUNK = 16 MiB）按保底速度 64 KiB/s 算 = 256s，加上 60s 底价；
        // 这正是「一段卡住最多浪费这么久」的口径。
        assert_eq!(
            transfer_budget(Some(RANGE_CHUNK)),
            Duration::from_secs(60 + 256)
        );
        // 单调：体积越大预算越宽
        assert!(transfer_budget(Some(512 * 1024 * 1024)) > transfer_budget(Some(RANGE_CHUNK)));
        // 5 GB 整包（不分段时）才是小时级 —— 而分段之后每段只按一段算
        assert!(transfer_budget(Some(5 * 1024 * 1024 * 1024)) > Duration::from_secs(3600));
    }

    /// M2：206 的起点要能核对（说慌的镜像靠它当场识破）
    #[test]
    fn parse_range_start_reads_the_served_offset() {
        assert_eq!(parse_range_start("bytes 0-16777215/5368709120"), Some(0));
        assert_eq!(
            parse_range_start("bytes 8388608-16777215/5368709120"),
            Some(8388608)
        );
        assert_eq!(parse_range_start("bytes */5368709120"), None);
        assert_eq!(parse_range_start("garbage"), None);
    }

    /// L1：超时文案要区分「握手/等响应」与「读数据」，不能一律报传输预算
    #[test]
    fn timeout_message_names_the_phase_that_fired() {
        let body = Duration::from_secs(7307);
        assert_eq!(
            friendly("Network Error: timed out reading response", body),
            "请求超时（等响应 30s）"
        );
        assert_eq!(
            friendly("timeout: connect timed out", body),
            "请求超时（连接 30s）"
        );
        assert_eq!(
            friendly("connection reset by peer", body),
            "connection reset by peer"
        );
    }

    /// H1 回归：本地文件比远端**还长**时，不能因为「长度够」就当成已下好 ——
    /// 必须丢掉重来；否则残包会变成「每次都说成功、校验却永远不过」的毒缓存。
    #[test]
    fn download_truncates_a_local_file_longer_than_remote() {
        let payload: Vec<u8> = (0..3000u32).map(|n| (n % 251) as u8).collect();
        let server = TinyServer::start(payload.clone(), true);
        let dest = temp_dest("too-long");
        let mut bogus = payload.clone();
        bogus.extend_from_slice(b"GARBAGE-GARBAGE-GARBAGE");
        std::fs::write(&dest, &bogus).unwrap();

        let outcome =
            download(&server.url(), &dest, Some(payload.len() as u64), |_, _| {}).unwrap();
        assert_eq!(outcome.bytes, payload.len() as u64, "应当回到远端长度");
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            payload,
            "内容必须是干净重下的"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 远端总长从 Content-Range 里取；取不到（* 或没有斜杠）就是 None
    #[test]
    fn parse_range_total_reads_remote_size() {
        assert_eq!(
            parse_range_total("bytes 0-67108863/5368709120"),
            Some(5368709120)
        );
        assert_eq!(parse_range_total("bytes 0-1/*"), None);
        assert_eq!(parse_range_total("garbage"), None);
    }

    /// 一个只会发文件的最小 HTTP 靶子：支持 / 不支持 Range 两种行为都造得出来。
    /// 只用于测试 —— 真网链路由 `live_https_round_trip`（ignored）冒烟。
    struct TinyServer {
        addr: std::net::SocketAddr,
        ranges: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>>,
    }

    impl TinyServer {
        fn start(payload: Vec<u8>, support_range: bool) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = listener.local_addr().expect("addr");
            let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let records = ranges.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let mut buf = vec![0u8; 4096];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).to_string();
                    let range = head
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("range:"))
                        .map(|line| line.trim().to_string());
                    records.lock().unwrap().push(range.clone());
                    let total = payload.len() as u64;
                    let requested = range.as_deref().and_then(parse_test_range);
                    let (status, start, end) = match (support_range, requested) {
                        (true, Some((from, to))) => {
                            if from >= total {
                                (416u16, 0u64, 0u64)
                            } else {
                                (206, from, to.min(total.saturating_sub(1)))
                            }
                        }
                        _ => (200, 0, total.saturating_sub(1)),
                    };
                    let body: &[u8] = if status == 416 {
                        &[]
                    } else {
                        &payload[start as usize..=end as usize]
                    };
                    let mut head_text = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
                        body.len()
                    );
                    if status == 206 {
                        head_text
                            .push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
                    }
                    head_text.push_str("\r\n");
                    let _ = stream.write_all(head_text.as_bytes());
                    let _ = stream.write_all(body);
                    let _ = stream.flush();
                }
            });
            TinyServer { addr, ranges }
        }

        fn url(&self) -> String {
            format!("http://{}/pkg.zip", self.addr)
        }

        fn ranges(&self) -> Vec<Option<String>> {
            self.ranges.lock().unwrap().clone()
        }
    }

    /// `bytes=1234-67108963` / `bytes=1234-` → (1234, 上界)
    fn parse_test_range(value: &str) -> Option<(u64, u64)> {
        let spec = value.to_ascii_lowercase();
        let spec = spec.trim_start_matches("range:").trim();
        let spec = spec.strip_prefix("bytes=")?;
        let mut parts = spec.splitn(2, '-');
        let from = parts.next()?.trim().parse::<u64>().ok()?;
        let to = parts.next().unwrap_or("").trim();
        let to = if to.is_empty() {
            u64::MAX
        } else {
            to.parse::<u64>().ok()?
        };
        Some((from, to))
    }

    fn temp_dest(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("evejs-net-{tag}-{}.bin", std::process::id()))
    }

    /// 断点续传：本地已有半截 → 带 Range 接着下 → 拼出的整包与源字节一致。
    #[test]
    fn download_resumes_from_a_partial_file() {
        let payload: Vec<u8> = (0..5000u32).map(|n| (n % 251) as u8).collect();
        let server = TinyServer::start(payload.clone(), true);
        let dest = temp_dest("resume");
        std::fs::write(&dest, &payload[..1234]).unwrap();
        let outcome =
            download(&server.url(), &dest, Some(payload.len() as u64), |_, _| {}).unwrap();
        assert_eq!(outcome.resumed_from, 1234);
        assert_eq!(outcome.bytes, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        let ranges = server.ranges();
        let first = ranges
            .first()
            .and_then(|item| item.clone())
            .unwrap_or_default();
        assert!(
            first.contains("bytes=1234-"),
            "第一次请求应当从断点开始：{ranges:?}"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 服务端不认 Range（回 200）时必须**从头重写**，绝不能把旧字节留在前面。
    #[test]
    fn download_restarts_when_range_is_ignored() {
        let payload: Vec<u8> = (0..5000u32).map(|n| (n % 241) as u8).collect();
        let server = TinyServer::start(payload.clone(), false);
        let dest = temp_dest("no-range");
        std::fs::write(&dest, b"stale bytes").unwrap();
        let outcome =
            download(&server.url(), &dest, Some(payload.len() as u64), |_, _| {}).unwrap();
        assert_eq!(outcome.bytes, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        let _ = std::fs::remove_file(&dest);
    }

    /// 本地已经是完整的一份：连请求都不该发（靠 size_hint 判断，省一次流量）。
    #[test]
    fn download_skips_when_local_file_is_complete() {
        let payload: Vec<u8> = (0..2048u32).map(|n| (n % 239) as u8).collect();
        let server = TinyServer::start(payload.clone(), true);
        let dest = temp_dest("complete");
        std::fs::write(&dest, &payload).unwrap();
        let outcome =
            download(&server.url(), &dest, Some(payload.len() as u64), |_, _| {}).unwrap();
        assert_eq!(outcome.bytes, payload.len() as u64);
        assert_eq!(outcome.resumed_from, payload.len() as u64);
        assert!(server.ranges().is_empty(), "已经齐了还发了请求");
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn response_json_is_lenient() {
        let ok = Response {
            status: 200,
            body: br#"{"a":1}"#.to_vec(),
            oauth_scopes: None,
        };
        assert_eq!(ok.json().and_then(|v| v["a"].as_u64()), Some(1));
        let broken = Response {
            status: 200,
            body: b"<html>502</html>".to_vec(),
            oauth_scopes: None,
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
