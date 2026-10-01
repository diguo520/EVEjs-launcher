//! G1 运行时自检：在**真实 WebView** 里把「安全通道」逐条走一遍，
//! 结果写进窗口标题，外部脚本读标题即可判定（`scripts/smoke-ipc.ps1`）。
//!
//! 为什么这么做：G1 要求「82/82 通道有回包」，静态台账只能证明登记齐全，
//! 真正要防的是「某个通道 invoke 后永不返回」——那会让渲染层 await 挂死。
//! 这里用带超时的 Promise.race 在真机上跑一遍。
//!
//! 顺带把 A4（渲染隔离）的几条断言也放在真机里跑：CSP 是否真的禁了 `eval` 与
//! 运行期注入的内联 `<script>`、`withGlobalTauri:false` 是否生效、事件订阅链路
//! （listen + emit）是否通。静态配置只能证明「写对了」，只有真机能证明「拦住了」。
//!
//! 触发方式：`EvEJSLauncher.exe --self-test`（不带参数时本模块逻辑完全不执行）。
use crate::ipc::registry;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};

/// 单个通道的超时（毫秒）：超过即判定「无回包」
const PER_CHANNEL_TIMEOUT_MS: u64 = 8000;
/// 等待 `window.api`（注入 shim）与 `__TAURI_INTERNALS__` 就绪的窗口期
const BRIDGE_READY_TIMEOUT_MS: u64 = 20000;
/// 事件订阅断言用的探针事件：与契约中的只读事件同名，载荷是固定字符串
const PROBE_EVENT: &str = "services:changed";
const PROBE_PAYLOAD: &str = "smoke-event";
/// `--parity-dump` 模式：把每个通道的**回包原文**一并写进自检结果（S3 §5.2 通道级 golden）。
/// 用环境变量而不是命令行开关：命令行只保留 `--self-test` 一个入口，命令白名单的静态断言不用改。
const DUMP_ENV: &str = "EVEJS_SELF_TEST_DUMP";
/// 单通道回包的落盘上限（超了只记长度）：日志类通道可能几十 KB，dump 要能人工看
const DUMP_CAP_BYTES: usize = 256 * 1024;
/// L3 端到端：场景文件路径（JSON）。**只在 --self-test 下**被读取，见 `run()`。
/// 用环境变量而不是命令行开关，理由与 DUMP_ENV 相同：命令行入口只有 `--self-test` 一个。
const SCENARIO_ENV: &str = "EVEJS_E2E_SCENARIO";

/// 是否处于 parity dump 模式（由 tests/parity/driver-tauri.mjs 设置）
fn is_dump_mode() -> bool {
    std::env::var(DUMP_ENV)
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// 只读 / 无副作用的通道（不会启动服务、不会改配置、不会关窗口）。
/// 写通道（window:*、settings:set、config:set*、service:*、engage:*、accounts:create/delete/
/// setPassword/launch、login:start、init:run、database:save/insert/delete/restore/backup）
/// 靠单测 + 人工验证，故意不放进自检，避免自检把服务真的拉起来或改数据。
pub fn safe_channels() -> Vec<&'static str> {
    let mut list: Vec<&'static str> = vec![
        "accounts:checkRunning",
        "accounts:list",
        "accounts:verify",
        "app:info",
        "config:get",
        "database:backups",
        "database:overview",
        "database:table",
        "env:check",
        "health:check",
        "health:ping",
        "init:state",
        "log:read",
        "metrics:get",
        "mods:githubTokenStatus",
        "mods:list",
        "mods:myMods",
        "mods:mySubmissions",
        "mods:plan",
        "mods:templates",
        "services:list",
        "settings:get",
        "shell:openExternal",
        "terminal:input",
        "terminal:resize",
        "update:state",
    ];
    // 待实现通道天然安全：统一回 {ok:false}
    list.extend(registry::PLANNED.iter().map(|item| item.channel));
    list.sort_unstable();
    list
}

/// 事件订阅探针要用的 api 名（从契约反查，避免脚本里手抄通道名）
fn probe_event_api() -> String {
    crate::ipc::channels::CHANNELS
        .iter()
        .find(|item| {
            item.channel == PROBE_EVENT && item.kind == crate::ipc::channels::ChannelKind::Event
        })
        .map(|item| item.api.to_string())
        .unwrap_or_else(|| "onServicesChanged".to_string())
}

/// 自检脚本模板。`{}`/`{{` 都不参与格式化：用占位符 replace 注入，避免 JS 大括号转义。
const SCRIPT_TEMPLATE: &str = r#"(async () => {
  const channels = __CHANNELS__;
  const probeApi = "__PROBE_API__";
  const probeEvent = "__PROBE_EVENT__";
  const probePayload = "__PROBE_PAYLOAD__";
  const dumpMode = __DUMP_MODE__;
  const dumpCap = __DUMP_CAP__;
  const internals = () => window.__TAURI_INTERNALS__;
  const ready = () => typeof window.api === "object" && window.api !== null
    && internals() && typeof internals().invoke === "function"
    && typeof internals().transformCallback === "function";
  const bridgeDeadline = Date.now() + __BRIDGE_TIMEOUT__;
  while (Date.now() < bridgeDeadline && !ready()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready()) { document.title = "SMOKE fail=no-tauri-bridge"; return; }

  /* ---- A4 渲染隔离：真机断言 ---- */
  const security = {};
  // 页面自身造成的 CSP 违规：注册必须早于「等渲染层挂载」，否则挂载期与首屏副作用的违规全被漏掉；
  // 又必须在**故意注入探针之前**摘掉监听，否则探针自己那条违规会被算在页面头上。
  // （2026-09-26 修：原来注册在挂载等待之后、摘除在探针之后 —— 两头都错，这条断言实际恒定失败。）
  const pageViolations = [];
  const collectPage = (event) => pageViolations.push(String(event.violatedDirective || ""));
  document.addEventListener("securitypolicyviolation", collectPage, true);
  window.addEventListener("securitypolicyviolation", collectPage, true);

  /* ---- 等渲染层挂载（双入口：legacy 与 React 都要等它真的画出来） ---- */
  const rendererReady = () =>
    (typeof window.t === "function" && typeof window.detectSystemLang === "function") ||
    !!document.querySelector("[data-evejs-renderer='react']");
  const rendererDeadline = Date.now() + 8000;
  while (Date.now() < rendererDeadline && !rendererReady()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // 挂载后再静默 400 ms：首屏的异步副作用（懒加载、订阅回调、懒挂 iframe）大多落在这段窗口里。
  await new Promise((resolve) => setTimeout(resolve, 400));
  security.shimInjected = typeof window.api === "object" && window.api !== null;
  security.noGlobalTauri = typeof window.__TAURI__ === "undefined";
  security.internalBridge = typeof internals().invoke === "function" && typeof internals().transformCallback === "function";
  // CSP 真机证据：运行期注入的内联 <script> 必须既不执行、又触发 script-src 违规事件。
  // 注意这里**不能**用 eval 当探针：自检脚本本身是 Rust 侧 eval 注入的，
  // Chromium 对这类注入脚本不给 CSP 策略，于是 eval 会被放行，测不出真伪。
  // `unsafe-eval` 是否缺失由 scripts/audit-security.mjs 做静态断言。
  // 结算「页面自身」的违规：必须在探针注入**之前**摘监听（探针的违规由下面的 violations 单独收）。
  document.removeEventListener("securitypolicyviolation", collectPage, true);
  window.removeEventListener("securitypolicyviolation", collectPage, true);
  security.pageCspClean = pageViolations.length === 0;

  window.__smokeInline = 0;
  const violations = [];
  const collect = (event) => violations.push(String(event.violatedDirective || ""));
  document.addEventListener("securitypolicyviolation", collect, true);
  window.addEventListener("securitypolicyviolation", collect, true);
  const injected = document.createElement("script");
  injected.textContent = "window.__smokeInline = 1;";
  (document.head || document.documentElement).appendChild(injected);
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.removeEventListener("securitypolicyviolation", collect, true);
  window.removeEventListener("securitypolicyviolation", collect, true);
  security.inlineScriptBlocked = window.__smokeInline === 0;
  security.cspViolationReported = violations.some((directive) => directive.indexOf("script-src") === 0);
  // 构建期内联脚本必须被放行（Tauri 在 codegen 时把它的 sha256 写进 script-src）。
  // 反证：CSP 若漏了这条哈希，页面会白屏，但只走 initialization_script 的 shim 仍然可用，
  // 于是自检会「假绿」——所以这里必须断言 legacy 内联脚本真的跑过（它定义的全局函数存在）。
  // 渲染层识别 + 各自的「挂载」证据：
  //   legacy：构建期内联脚本必须被放行（它定义了 window.t / detectSystemLang）—— CSP 若漏了这条哈希，
  //           页面会白屏，但只走 initialization_script 的 shim 仍然可用，自检会「假绿」，所以必须断言。
  //   react ：#root 里有子树（React 真的渲染了），且全程零 CSP 违规 —— 等价于 legacy 那条的强度，
  //           但不依赖任何 legacy 专属全局（见 docs/S6-UI迁移-实施记录.md §6 债务 #2）。
  const isLegacy = typeof window.t === "function" && typeof window.detectSystemLang === "function";
  const reactRoot = isLegacy ? null : document.querySelector("[data-evejs-renderer='react']");
  const isReact = !!reactRoot && reactRoot.childElementCount > 0;
  security.rendererMounted = isLegacy || isReact;
  if (isLegacy) security.legacyInlineScriptRan = true;
  if (isReact) security.reactMounted = true;
  security.eventRoundTrip = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      window.api[probeApi]((payload) => done(payload === probePayload));
    } catch (error) {
      done("subscribe-error:" + (error && error.message ? error.message : String(error)));
    }
    let attempts = 0;
    const emit = () => {
      if (settled) return;
      internals()
        .invoke("plugin:event|emit", { event: probeEvent, payload: [probePayload] })
        .catch((error) => done("emit-error:" + (error && error.message ? error.message : String(error))));
      if (++attempts < 4) setTimeout(emit, 400);
    };
    setTimeout(emit, 300);
    setTimeout(() => done(false), 6000);
  });

  /* ---- G1：只读通道逐条回包 ---- */
  // 回包快照：深拷贝 + 单通道上限，避免把巨大的日志/列表原样塞进 dump
  const snapshot = (value) => {
    try {
      const text = JSON.stringify(value);
      if (typeof text !== "string") return null;
      if (text.length > dumpCap) return { __truncated: text.length };
      return JSON.parse(text);
    } catch (error) {
      return { __unserializable: String(error && error.message ? error.message : error) };
    }
  };
  let ok = 0;
  const fails = [];
  const dumps = {};
  /* ---- 瞬时态通道先等它落定（只影响 dump）---- */
  // update:state 在启动后会短暂处于 checking（自带 message "正在检查更新…"）：宿主渲染层首屏会主动
  // 触发一次 update:check。dump 若正好采到这一瞬，冻结基线里就写进一个**瞬时值** —— 同一个二进制
  // 两次跑给出不同结果，L2 门禁会随机变红（2026-09-26 实测基线冻结成了 checking，而 Electron 基线
  // 是 idle，diff-cross 的豁免表正是为这个不对称准备的，但同实现自比没有豁免，只能在这里等落定）。
  if (dumpMode) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      let state = null;
      try {
        state = await internals().invoke("launcher_invoke", { channel: "update:state", args: [] });
      } catch (error) {
        break;
      }
      if (!state || state.state !== "checking") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  for (const channel of channels) {
    try {
      const reply = await Promise.race([
        internals().invoke("launcher_invoke", { channel: channel, args: [] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), __CHANNEL_TIMEOUT__))
      ]);
      if (reply === undefined) fails.push(channel + "=undefined");
      else ok += 1;
      if (dumpMode) dumps[channel] = snapshot(reply);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      fails.push(channel + "=" + message);
      if (dumpMode) dumps[channel] = { __error: message };
    }
  }

  const securityFails = Object.keys(security).filter((key) => security[key] !== true);
  const summary = {
    ok: ok,
    total: channels.length,
    fails: fails,
    renderer: isLegacy ? "legacy" : isReact ? "react" : "unknown",
    security: security,
    securityFails: securityFails,
    // 红灯必须自证：只报 pageCspClean=false 而不给指令名，排查只能靠猜（2026-09-26 教训）。
    pageCspViolations: pageViolations.slice(0, 8),
  };
  if (dumpMode) summary.dump = dumps;
  document.title = "SMOKE ok=" + ok + "/" + channels.length +
    (fails.length ? " fails=" + fails.join(",") : " fails=none") +
    " sec=" + (securityFails.length ? "fail:" + securityFails.join(",") : "ok");
  try {
    await internals().invoke("self_test_report", { payload: JSON.stringify(summary) });
  } catch (error) {
    document.title = "SMOKE report-failed " + (error && error.message ? error.message : String(error));
  }
})();"#;

/// L3 端到端场景脚本模板。
///
/// 与只读自检的差别只有一处：通道与参数**由场景文件给定**，按顺序真打（会改文件、会改名、会卸载），
/// 因此只在 `--self-test` + `EVEJS_E2E_SCENARIO` 同时成立时才注入（见 `run()`）。
/// 断言不放在这里：这里只负责「按顺序调、把回包原样带回来」，判定交给 Node 侧编排脚本 ——
/// 因为真正有说服力的证据是「回包 + 落地后的文件系统」两边对上，而文件系统只有跑完才看得到。
const SCENARIO_TEMPLATE: &str = r#"(async () => {
  const scenario = __SCENARIO__;
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const dumpCap = __DUMP_CAP__;
  const internals = () => window.__TAURI_INTERNALS__;
  const ready = () => typeof window.api === "object" && window.api !== null
    && internals() && typeof internals().invoke === "function"
    && typeof internals().transformCallback === "function";
  const bridgeDeadline = Date.now() + __BRIDGE_TIMEOUT__;
  while (Date.now() < bridgeDeadline && !ready()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready()) { document.title = "E2E fail=no-tauri-bridge"; return; }

  const snapshot = (value) => {
    try {
      const text = JSON.stringify(value);
      if (typeof text !== "string") return null;
      if (text.length > dumpCap) return { __truncated: text.length };
      return JSON.parse(text);
    } catch (error) {
      return { __unserializable: String(error && error.message ? error.message : error) };
    }
  };

  const results = [];
  let ok = 0;
  const fails = [];
  for (const step of steps) {
    const started = Date.now();
    try {
      const reply = await Promise.race([
        internals().invoke("launcher_invoke", { channel: step.channel, args: Array.isArray(step.args) ? step.args : [] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), __CHANNEL_TIMEOUT__))
      ]);
      const ms = Date.now() - started;
      if (reply === undefined) fails.push(step.id + "=undefined");
      else ok += 1;
      results.push({ id: step.id, channel: step.channel, status: "ok", ms: ms, reply: snapshot(reply) });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      fails.push(step.id + "=" + message);
      results.push({ id: step.id, channel: step.channel, status: "error", error: message });
    }
  }

  const summary = {
    mode: "e2e",
    scenario: scenario.name || "",
    ok: ok,
    total: steps.length,
    fails: fails,
    results: results,
  };
  document.title = "E2E ok=" + ok + "/" + steps.length +
    (fails.length ? " fails=" + fails.join(",") : " fails=none");
  try {
    await internals().invoke("self_test_report", { payload: JSON.stringify(summary) });
  } catch (error) {
    document.title = "E2E report-failed " + (error && error.message ? error.message : String(error));
  }
})();"#;

/// 读取场景文件原文（仅在 `--self-test` 下调用）。取不到时返回 None 并打印原因 ——
/// 调用方会退回只读自检，编排脚本凭 summary.mode 立刻发现「拿到的不是 e2e 结果」。
pub fn scenario_payload() -> Option<String> {
    let path = std::env::var(SCENARIO_ENV).ok()?;
    if path.trim().is_empty() {
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(_) => Some(text),
            Err(err) => {
                eprintln!("[e2e] 场景 JSON 解析失败（{path}）：{err}");
                None
            }
        },
        Err(err) => {
            eprintln!("[e2e] 读不到场景文件（{path}）：{err}");
            None
        }
    }
}

/// 生成场景脚本：把场景 JSON 原样嵌进去（占位符 replace，避免 JS 大括号转义）。
pub fn scenario_script(scenario_json: &str) -> String {
    SCENARIO_TEMPLATE
        .replace("__SCENARIO__", scenario_json)
        .replace("__DUMP_CAP__", &DUMP_CAP_BYTES.to_string())
        .replace("__BRIDGE_TIMEOUT__", &BRIDGE_READY_TIMEOUT_MS.to_string())
        .replace("__CHANNEL_TIMEOUT__", &PER_CHANNEL_TIMEOUT_MS.to_string())
}

/// 生成自检脚本。`dump = true` 时额外把每个通道的回包原文带回 Rust（parity 基线用）。
pub fn script(dump: bool) -> String {
    let channels = serde_json::to_string(&safe_channels()).unwrap_or_else(|_| "[]".to_string());
    SCRIPT_TEMPLATE
        .replace("__CHANNELS__", &channels)
        .replace("__PROBE_API__", &probe_event_api())
        .replace("__PROBE_EVENT__", PROBE_EVENT)
        .replace("__PROBE_PAYLOAD__", PROBE_PAYLOAD)
        .replace("__DUMP_MODE__", if dump { "true" } else { "false" })
        .replace("__DUMP_CAP__", &DUMP_CAP_BYTES.to_string())
        .replace("__BRIDGE_TIMEOUT__", &BRIDGE_READY_TIMEOUT_MS.to_string())
        .replace("__CHANNEL_TIMEOUT__", &PER_CHANNEL_TIMEOUT_MS.to_string())
}

/// 自检结果落盘（仅自检模式调用）：写完即退出进程，外部脚本读文件判定。
#[tauri::command]
pub fn self_test_report(app: AppHandle, payload: String) {
    let file = std::env::var("EVEJS_SELF_TEST_OUT").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("evejs-self-test.json")
            .to_string_lossy()
            .to_string()
    });
    let normalized: Value =
        serde_json::from_str(&payload).unwrap_or_else(|_| json!({ "raw": payload }));
    let _ = std::fs::write(
        &file,
        serde_json::to_string_pretty(&normalized).unwrap_or_default(),
    );
    eprintln!("[self-test] 结果已写入 {file}");
    app.exit(0);
}

/// 等页面首帧之后再注入自检脚本（真实使用场景是「页面已连上桥」），
/// 并从 Rust 侧补发探针事件（事件方向必须双向都真：只有 Rust 发出的才代表真实推送链路）
pub fn run<R: Runtime>(window: WebviewWindow<R>) {
    // L3：给了场景就走场景驱动（会真写盘），否则走只读自检。两条路都只在 --self-test 下可达。
    let scenario = scenario_payload();
    let emit_probe = scenario.is_none();
    let script = match &scenario {
        Some(payload) => scenario_script(payload),
        None => script(is_dump_mode()),
    };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1_500));
        if let Err(err) = window.eval(&script) {
            eprintln!("[self-test] 注入失败: {err}");
        }
        if !emit_probe {
            return;
        }
        // 探针补发：脚本内的 emit 走的是页面→Rust→页面；这里再走一遍 Rust 原生 emit
        for _ in 0..4 {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let _ = window.emit(PROBE_EVENT, json!([PROBE_PAYLOAD]));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::channels;
    use std::collections::HashSet;

    #[test]
    fn safe_channels_are_real_request_channels() {
        for channel in safe_channels() {
            assert!(channels::is_request(channel), "{channel} 不是请求通道");
        }
    }

    #[test]
    fn safe_channels_exclude_all_side_effecting_handlers() {
        let safe: HashSet<&str> = safe_channels().into_iter().collect();
        for channel in [
            "window:minimize",
            "window:toggleMaximize",
            "window:close",
            "settings:set",
            "config:setRepoRoot",
            "config:setClient",
            "config:repairClientDisplay",
            "service:start",
            "service:stop",
            "service:restart",
            "engage:start",
            "engage:stop",
            // 模组写通道：会改文件系统 / 排序文件，只靠单测覆盖
            "mods:createFolder",
            "mods:setEnabled",
            "mods:setOrder",
            "mods:sign",
            "mods:uninstall",
            "mods:revealSubmissionZip",
            // 市场 / 提交 / 令牌写通道：会联网、上传文件或改凭据，只靠单测覆盖
            "mods:marketList",
            "mods:reviews",
        "mods:reviewSubmit",
        "mods:reviewRetract",
        "mods:replySubmit",
        "mods:replyRetract",
        "mods:reportReview",
            "mods:marketInstall",
            "mods:submitPrepare",
            "mods:submitGithub",
            "mods:publishOwnRepo",
            "mods:registerSource",
            "mods:githubTokenSave",
            "mods:githubTokenClear",
            // 更新通道：检查 / 下载 / 替换会出网或换 exe，只靠单测覆盖
            "update:check",
            "update:download",
            "update:apply",
            "update:cancel",
        ] {
            assert!(!safe.contains(channel), "{channel} 有副作用，不应进自检");
        }
        // 23 个只读 + 全部待实现通道（待实现通道统一回 {ok:false}，天然安全）
        assert_eq!(safe.len(), 26 + registry::PLANNED.len());
    }

    #[test]
    fn script_embeds_every_safe_channel() {
        let script = script(false);
        for channel in safe_channels() {
            assert!(script.contains(channel), "自检脚本漏了 {channel}");
        }
    }

    #[test]
    fn script_uses_internal_bridge_not_global_tauri() {
        let script = script(false);
        assert!(
            script.contains("window.__TAURI_INTERNALS__"),
            "A4：自检脚本应走 __TAURI_INTERNALS__ 传输层"
        );
        assert!(
            !script.contains("window.__TAURI__."),
            "A4：withGlobalTauri:false 后不得再引用全局 __TAURI__"
        );
    }

    #[test]
    fn script_asserts_strict_csp_and_event_round_trip() {
        let script = script(false);
        for key in [
            "noGlobalTauri",
            "legacyInlineScriptRan",
            "inlineScriptBlocked",
            "cspViolationReported",
            "eventRoundTrip",
        ] {
            assert!(script.contains(key), "A4 断言缺失：{key}");
        }
        // 探针事件必须取自契约（通道名 + api 名都不能手抄错）
        assert!(script.contains(PROBE_EVENT));
        assert!(script.contains(&probe_event_api()));
        assert!(script.contains("\"plugin:event|emit\""));
    }

    #[test]
    fn probe_event_is_a_contract_event_channel() {
        let spec = channels::spec(PROBE_EVENT).expect("探针事件必须在契约里");
        assert_eq!(spec.kind, channels::ChannelKind::Event);
        assert!(script(false).contains(&probe_event_api()));
    }

    /// parity dump：只有在 dump 模式下才采集回包原文，默认自检保持「只报 ok/fail」的轻量形状
    #[test]
    fn dump_mode_collects_reply_snapshots() {
        let plain = script(false);
        assert!(plain.contains("const dumpMode = false;"));
        assert!(plain.contains("summary.dump = dumps;"));
        let dumped = script(true);
        assert!(dumped.contains("const dumpMode = true;"));
        assert!(dumped.contains("const dumpCap = 262144;"));
        // 回包快照必须带单通道上限，避免日志类通道把 dump 撑爆
        assert!(dumped.contains("__truncated"));
    }

    /// L3：场景脚本要把通道与参数原样嵌进去，且所有占位符都替换干净
    #[test]
    fn scenario_script_embeds_steps_and_replaces_every_placeholder() {
        let script = scenario_script(
            r#"{"name":"demo","steps":[{"id":"s1","channel":"mods:list","args":[]}]}"#,
        );
        assert!(script.contains(r#""channel":"mods:list""#));
        assert!(script.contains(r#"mode: "e2e""#));
        assert!(script.contains("self_test_report"));
        for placeholder in [
            "__SCENARIO__",
            "__DUMP_CAP__",
            "__BRIDGE_TIMEOUT__",
            "__CHANNEL_TIMEOUT__",
        ] {
            assert!(!script.contains(placeholder), "占位符没替换：{placeholder}");
        }
    }

    /// 场景驱动与只读自检必须是两条独立脚本：场景里不能混进 A4 那段只读自检逻辑，
    /// 否则「写通道只在显式场景下才跑」这条边界会被悄悄抹掉。
    #[test]
    fn scenario_script_is_not_the_smoke_script() {
        let script = scenario_script(r#"{"name":"x","steps":[]}"#);
        assert!(!script.contains("security.shimInjected"));
        assert!(script.contains("const steps = Array.isArray(scenario.steps)"));
    }
}
