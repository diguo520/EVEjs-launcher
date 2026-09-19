import { execFile, execSync, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { resolveRepoRoot } from "./envDetector";
import { readClientConfig, readServerConfig, readSettings, type ClientConfig } from "./configStore";
import { checkTcp } from "./healthChecker";
import * as pty from "./ptyManager";
import { log } from "./logger";
import { launcherRuntimeRoot } from "./runtimePaths";
import { planLoaders } from "./modManager";

/* ------------------------------------------------------------------ */
/* Phase 3-4：真实服务进程管理（状态机 + 端口探活 + 崩溃处理）            */
/* ------------------------------------------------------------------ */

export type ServiceState = "idle" | "checking" | "starting" | "running" | "error" | "stopping";
export type ServiceId = "mainServer" | "marketServer" | "client";

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  state: ServiceState;
  pid?: number;
  message?: string;
}

export interface ServiceActionResult {
  ok: boolean;
  reason: string;
}

const SERVICE_NAME: Record<ServiceId, string> = {
  mainServer: "主服务器",
  marketServer: "市场服务",
  client: "游戏客户端"
};

/** 终端页签：mainServer / market / client / system */
const TAB: Record<ServiceId, string> = { mainServer: "mainServer", marketServer: "market", client: "client" };

interface Runtime {
  info: ServiceInfo;
  ownedPid?: number;
  sessionId?: string;
  child?: ChildProcess;
}

const RUN: Record<ServiceId, Runtime> = {
  mainServer: { info: { id: "mainServer", name: SERVICE_NAME.mainServer, state: "idle" } },
  marketServer: { info: { id: "marketServer", name: SERVICE_NAME.marketServer, state: "idle" } },
  client: { info: { id: "client", name: SERVICE_NAME.client, state: "idle" } }
};

/* ------------------------- 事件订阅 ------------------------- */

type SnapshotListener = (list: ServiceInfo[]) => void;
const snapshotListeners = new Set<SnapshotListener>();
type ProgressListener = (line: string) => void;
const progressListeners = new Set<ProgressListener>();
type OutputListener = (tabId: string, data: string) => void;
const outputListeners = new Set<OutputListener>();

export function getServices(): ServiceInfo[] {
  return (Object.keys(RUN) as ServiceId[]).map((id) => ({ ...RUN[id].info }));
}

export function onServicesChanged(fn: SnapshotListener): () => void {
  snapshotListeners.add(fn);
  return () => snapshotListeners.delete(fn);
}

export function onProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export function onOutput(fn: OutputListener): () => void {
  outputListeners.add(fn);
  return () => outputListeners.delete(fn);
}

function emit(): void {
  const snapshot = getServices();
  snapshotListeners.forEach((fn) => fn(snapshot));
}

function note(line: string): void {
  log("svc", line);
  progressListeners.forEach((fn) => fn(line));
}

function emitOutput(tabId: string, data: string): void {
  outputListeners.forEach((fn) => fn(tabId, data));
}

function setState(id: ServiceId, state: ServiceState, message?: string): void {
  const r = RUN[id];
  r.info.state = state;
  if (message !== undefined) r.info.message = message;
  emit();
}

/* ------------------------- 工具 ------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type WaitResult = "ok" | "timeout" | "aborted";

async function waitPort(
  port: number,
  timeoutMs: number,
  what: string,
  aborted?: () => boolean
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted?.()) return "aborted";
    if (await checkTcp(port)) return "ok";
    await sleep(1000);
  }
  return aborted?.() ? "aborted" : "timeout";
}

function baseEnv(): Record<string, string> {
  const root = resolveRepoRoot();
  const env: Record<string, string> = {
    EVEJS_LOCAL_DATABASE_ROOT: path.join(root, "_local", "gameStore"),
    EVEJS_GAMESTORE_DATA_DIR: path.join(root, "_local", "gameStore", "data"),
    EVEJS_PROXY_LOCAL_INTERCEPT: "1",
    EVEJS_PROXY_UNHANDLED_HOST_POLICY: "block",
    EVEJS_PROXY_URL: "http://127.0.0.1:26002/"
  };
  try {
    const client = readClientConfig(root);
    if (client.caPem && fs.existsSync(client.caPem)) {
      env.SSL_CERT_FILE = client.caPem;
      env.REQUESTS_CA_BUNDLE = client.caPem;
      env.CURL_CA_BUNDLE = client.caPem;
    }
  } catch {
    /* 配置缺失不影响服务启动 */
  }
  return env;
}

async function killOwned(id: ServiceId): Promise<void> {
  const r = RUN[id];
  if (r.ownedPid) {
    try {
      execSync(`taskkill /PID ${r.ownedPid} /T /F`, { stdio: "ignore", timeout: 8000 });
    } catch {
      /* 进程可能已退出 */
    }
  }
  try {
    r.child?.kill();
  } catch {
    /* ignore */
  }
  if (r.sessionId) pty.destroySession(r.sessionId);
  r.ownedPid = undefined;
  r.child = undefined;
  r.sessionId = undefined;
}

/* ------------------------- 状态机事件 ------------------------- */

/** PTY 会话退出 → 崩溃/退出处理（由 ptyManager.onExit 触发，模块加载时注册） */
pty.onExit((tabId, code) => {
  if (tabId === "mainServer") {
    const r = RUN.mainServer;
    if (r.info.state === "running" || r.info.state === "starting") {
      setState("mainServer", "error", `主服务器异常退出（exit ${code}）`);
      note(`[主服务器] 异常退出 exit=${code}`);
    }
    r.ownedPid = undefined;
  } else if (tabId === "market") {
    const r = RUN.marketServer;
    if (r.info.state === "running" || r.info.state === "starting") {
      setState("marketServer", "error", `市场服务异常退出（exit ${code}）`);
      note(`[市场服务] 异常退出 exit=${code}`);
    }
    r.ownedPid = undefined;
  } else if (tabId === "client") {
    const r = RUN.client;
    if (r.info.state === "running" || r.info.state === "starting") {
      setState("client", "error", `客户端已退出（exit ${code}）`);
      note(`[客户端] 已退出 exit=${code}`);
    }
    r.ownedPid = undefined;
  }
});

/* ------------------------- 单个服务启动 ------------------------- */

export interface ClientLoginOpts {
  user: string;
  password: string;
  /** 目标角色 ID（客户端 /autoSelectCharacter: 参数，直达该角色） */
  characterId?: string | number;
}

export async function startService(id: ServiceId, opts?: { login?: ClientLoginOpts }): Promise<ServiceActionResult> {
  const r = RUN[id];
  if (r.info.state === "running" || r.info.state === "starting") {
    return { ok: true, reason: `${SERVICE_NAME[id]} 已在运行` };
  }
  setState(id, "starting", "启动中…");
  switch (id) {
    case "mainServer":
      return startMainServer();
    case "marketServer":
      return startMarketServer();
    case "client":
      return startClient(opts?.login);
  }
}

async function startMainServer(): Promise<ServiceActionResult> {
  const root = resolveRepoRoot();
  // 外部已启动则直接接管为 running，避免重复拉起
  if (await checkTcp(26000)) {
    setState("mainServer", "running", "端口 26000 已监听（外部已启动）");
    note("[主服务器] 26000 已在监听，视为运行中");
    return { ok: true, reason: "already-running" };
  }
  const serverDir = path.join(root, "server");
  if (!fs.existsSync(path.join(serverDir, "index.js"))) {
    setState("mainServer", "error", "启动失败：server/index.js 不存在");
    note("[主服务器] 启动失败：server/index.js 不存在");
    return { ok: false, reason: "server/index.js 不存在" };
  }
  const env = baseEnv();
  // 模组 loader：通过 NODE_OPTIONS=--require 注入，服务端文件零改动。
  // 注意 NODE_OPTIONS 的解析规则：反斜杠会被当转义符吃掉，且按空格分词，
  // 所以路径必须转成正斜杠并加双引号（已实测验证）。
  const plan = planLoaders(root);
  if (plan.paths.length) {
    const requireArgs = plan.paths.map((p) => `--require "${p}"`).join(" ");
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireArgs].filter(Boolean).join(" ");
    note(`[主服务器] 已注入 ${plan.paths.length} 个模组 loader`);
    for (const loaderPath of plan.paths) note(`[主服务器]   · ${path.basename(path.dirname(loaderPath))}`);
  }
  for (const skipped of plan.skipped) note(`[主服务器] 跳过模组 ${skipped.id}：${skipped.reason}`);
  note("[主服务器] 启动 npm start（server/）…");
  const session = pty.createSession("mainServer", "cmd.exe", ["/c", "npm start"], serverDir, env);
  const r = RUN.mainServer;
  r.sessionId = "mainServer";
  r.ownedPid = session.pid;
  r.info.pid = session.pid;
  emit();

  const ok = await waitPort(26000, 60_000, "主服务器", () => RUN.mainServer.info.state !== "starting");
  if (ok === "ok") {
    setState("mainServer", "running", `运行中（PID ${r.ownedPid}）`);
    note("[主服务器] 26000 端口已监听，启动成功");
    return { ok: true, reason: "ok" };
  }
  // 启动期间进程已退出（onExit 已置 error）：保留崩溃信息，仅清理残留
  if (ok === "aborted") {
    note("[主服务器] 启动过程异常退出，清理残留…");
    await killOwned("mainServer");
    return { ok: false, reason: "主服务器启动后异常退出（详见终端日志）" };
  }
  setState("mainServer", "error", "启动超时：26000 未在 60s 内监听");
  note("[主服务器] 启动超时，正在清理…");
  await killOwned("mainServer");
  return { ok: false, reason: "主服务器 26000 端口 60s 未监听" };
}

async function startMarketServer(): Promise<ServiceActionResult> {
  const root = resolveRepoRoot();
  if (await checkTcp(40110)) {
    setState("marketServer", "running", "端口 40110 已监听（外部已启动）");
    note("[市场服务] 40110 已在监听，视为运行中");
    return { ok: true, reason: "already-running" };
  }
  const exe = path.join(root, "externalservices", "market-server", "target", "release", "market-server.exe");
  if (!fs.existsSync(exe)) {
    setState("marketServer", "error", "release 二进制缺失，请先构建（cargo build --release）");
    note("[市场服务] 启动失败：release 二进制不存在");
    return { ok: false, reason: "market-server.exe 不存在" };
  }
  const cwd = path.join(root, "externalservices", "market-server");
  note("[市场服务] 启动 market-server.exe …");
  // 原生 exe 直接 spawn（不经 cmd，避免引号嵌套问题）
  const session = pty.createSession("market", exe, [], cwd, baseEnv());
  const r = RUN.marketServer;
  r.sessionId = "market";
  r.ownedPid = session.pid;
  r.info.pid = session.pid;
  emit();

  const ok = await waitPort(40110, 30_000, "市场服务", () => RUN.marketServer.info.state !== "starting");
  if (ok === "ok") {
    setState("marketServer", "running", `运行中（PID ${r.ownedPid}）`);
    note("[市场服务] 40110 端口已监听，启动成功");
    return { ok: true, reason: "ok" };
  }
  if (ok === "aborted") {
    note("[市场服务] 启动过程异常退出，清理残留…");
    await killOwned("marketServer");
    return { ok: false, reason: "市场服务启动后异常退出（详见终端日志）" };
  }
  setState("marketServer", "error", "启动超时：40110 未在 30s 内监听");
  note("[市场服务] 启动超时，正在清理…");
  await killOwned("marketServer");
  return { ok: false, reason: "市场服务 40110 端口 30s 未监听" };
}

/* ------------------------------------------------------------------ */
/* 客户端启动：对齐 EveJS-Launcher-V1 方案（直连 exefile + /noconsole）      */
/*   V1 参数组合：/noconsole /login:<账号>:<密码>                          */
/*                /autoSelectCharacter:<角色ID> /port:<游戏端口>            */
/*   创建标志：DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP                 */
/*   → 不分配控制台，且客户端不再自建 [CCP] Vxx.xx client 调试窗口           */
/* ------------------------------------------------------------------ */

const DETACHED_PROCESS = 0x00000008;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const execFileAsync = promisify(execFile);

/** tq 同级的 ResFiles 资源缓存目录（等价 Play.bat 的 :ResolveClientResourceCache） */
function resolveClientResFiles(clientPath: string): string | null {
  try {
    const resFiles = path.join(path.resolve(clientPath, ".."), "ResFiles");
    return fs.existsSync(resFiles) ? resFiles : null;
  } catch {
    return null;
  }
}

/** 复刻 Play.bat 的 :ApplyClientNetworkPolicy（代理 / Darkly 屏蔽 / Sentry 关闭 / 本地 CA） */
function applyClientNetworkPolicy(env: NodeJS.ProcessEnv, proxyUrl: string, caPem: string): void {
  const proxy = proxyUrl && proxyUrl.trim() ? proxyUrl.trim() : "http://127.0.0.1:26002/";
  const darklyHosts = [
    "launchdarkly.com",
    ".launchdarkly.com",
    "clientstream.launchdarkly.com",
    "events.launchdarkly.com",
    "mobile.launchdarkly.com",
    "app.launchdarkly.com",
    "sdk.launchdarkly.com",
    "stream.launchdarkly.com",
    "launchdarkly.us",
    ".launchdarkly.us",
    "launchdarkly.eu",
    ".launchdarkly.eu"
  ].join(",");
  env.EVEJS_PROXY_URL = proxy;
  env.EVEJS_PROXY_LOCAL_INTERCEPT = "1";
  env.EVEJS_PROXY_UNHANDLED_HOST_POLICY = "block";
  env.EVEJS_PROXY_BLOCKED_HOSTS =
    "api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com," + darklyHosts;
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    env[key] = proxy;
  }
  env.EVEJS_NO_PROXY = "127.0.0.1,localhost,::1";
  env.no_proxy = env.EVEJS_NO_PROXY;
  env.NO_PROXY = env.EVEJS_NO_PROXY;
  env.EVE_CLIENT_SENTRY_DSN = "";
  env.SSL_CERT_DIR = "";
  env.LD_OFFLINE = "true";
  env.LAUNCHDARKLY_OFFLINE = "true";
  env.LAUNCHDARKLY_SEND_EVENTS = "false";
  env.LD_SEND_EVENTS = "false";
  if (caPem && fs.existsSync(caPem)) {
    env.SSL_CERT_FILE = caPem;
    env.REQUESTS_CA_BUNDLE = caPem;
    env.CURL_CA_BUNDLE = caPem;
  }
}

/** Play.bat 每次启动都会跑 Install-EvEJSCerts.ps1；直连客户端时要自己补上（失败不阻塞） */
async function prepareClientCertificateTrust(root: string, clientPath: string): Promise<void> {
  const script = path.join(root, "tools", "ClientSETUP", "scripts", "Install-EvEJSCerts.ps1");
  if (!fs.existsSync(script)) return;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ClientPath", clientPath],
      { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    note("[客户端] 已准备 EveJS 证书信任");
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    note(`[客户端] 证书准备未成功（继续启动）：${raw.split(/\r?\n/)[0]}`);
  }
}

/** EvEJSConfig.bat 里的 on/off 开关判定 */
function isSwitchOn(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * 运行 tools\ClientSETUP\scripts\PrepareClientSettings.ps1，
 * 等价 Play.bat 的 :EnsureClientDisplaySafety / :EnsureClientGraphicsSafety。
 * 脚本自身会检查 EVEJS_CLIENT_SAFE_* 开关，关闭时直接返回。
 */
async function execPrepareClientSettings(
  root: string,
  clientPath: string,
  mode: "Display" | "Graphics",
  switches: { safeWindowed: string; safeGraphics: string }
): Promise<{ ok: boolean; output: string }> {
  const script = path.join(root, "tools", "ClientSETUP", "scripts", "PrepareClientSettings.ps1");
  if (!fs.existsSync(script)) return { ok: false, output: "未找到 PrepareClientSettings.ps1" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVEJS_CLIENT_PATH: clientPath,
    EVEJS_CLIENT_SAFE_WINDOWED: switches.safeWindowed,
    EVEJS_CLIENT_SAFE_GRAPHICS: switches.safeGraphics
  };
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", mode],
      { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env }
    );
    return { ok: true, output: String(stdout || "").trim() };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, output: raw.split(/\r?\n/)[0] };
  }
}

/** 启动前按配置决定是否重置显示设置（开关默认 off，此时完全不启动 PowerShell） */
async function prepareClientDisplaySafety(root: string, client: ClientConfig): Promise<void> {
  const switches = {
    safeWindowed: client.safeWindowed || "off",
    safeGraphics: client.safeGraphics || "off"
  };
  if (isSwitchOn(switches.safeWindowed)) {
    const r = await execPrepareClientSettings(root, client.clientPath, "Display", switches);
    const line = r.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    note(r.ok ? `[客户端] ${line || "已应用安全窗口模式"}` : `[客户端] 显示设置重置失败（继续启动）：${line}`);
  }
  if (isSwitchOn(switches.safeGraphics)) {
    const r = await execPrepareClientSettings(root, client.clientPath, "Graphics", switches);
    const line = r.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    note(r.ok ? `[客户端] ${line || "已应用低配画质预设"}` : `[客户端] 画质预设应用失败（继续启动）：${line}`);
  }
}

/**
 * 配置中心「修复游戏窗口」：一次性把客户端显示设置重置为
 * 「当前主屏 + 窗口模式 + 左上角」，解决窗口跑到屏幕外 / 全屏黑屏只有声音。
 * 不修改 EvEJSConfig.bat 的常驻开关，因此不会每次启动都覆盖玩家设置。
 */
export async function repairClientDisplay(): Promise<ServiceActionResult> {
  const root = resolveRepoRoot();
  let client: ClientConfig;
  try {
    client = readClientConfig(root);
  } catch {
    return { ok: false, reason: "客户端配置读取失败" };
  }
  if (!client.clientPath || !fs.existsSync(client.clientPath)) {
    return { ok: false, reason: "客户端路径无效，请先在配置中心设置" };
  }
  const r = await execPrepareClientSettings(root, client.clientPath, "Display", {
    safeWindowed: "on",
    safeGraphics: "off"
  });
  if (!r.ok) return { ok: false, reason: r.output || "显示设置重置失败" };
  const line = r.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  note("[客户端] 已重置游戏窗口显示设置");
  return { ok: true, reason: line || "已重置为窗口模式" };
}

/** 客户端 stdout/stderr 由 /stdout= /stderr= 落到 _launcher/logs/client，再增量喂给终端页签 */
function startClientLogTail(file: string, tabId: string): () => void {
  let offset = 0;
  let pending = Buffer.alloc(0);
  const pump = (): void => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, "r");
      const length = size - offset;
      chunk = Buffer.alloc(length);
      const read = fs.readSync(fd, chunk, 0, length, offset);
      fs.closeSync(fd);
      chunk = chunk.subarray(0, read);
      offset += read;
    } catch {
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.lastIndexOf(0x0a);
    if (newline >= 0) {
      emitOutput(tabId, pending.subarray(0, newline + 1).toString("utf8"));
      pending = pending.subarray(newline + 1);
    } else if (pending.length >= 65536) {
      emitOutput(tabId, pending.toString("utf8"));
      pending = Buffer.alloc(0);
    }
  };
  const timer = setInterval(pump, 350);
  pump();
  return () => {
    clearInterval(timer);
    pump();
  };
}

async function startClient(login?: ClientLoginOpts): Promise<ServiceActionResult> {
  const root = resolveRepoRoot();
  let client: ClientConfig;
  try {
    client = readClientConfig(root);
  } catch {
    setState("client", "error", "客户端配置读取失败");
    return { ok: false, reason: "客户端配置读取失败" };
  }
  if (!client.clientPath || !fs.existsSync(client.clientPath)) {
    setState("client", "error", "客户端路径无效，请先在配置面板设置");
    note("[客户端] 未启动：客户端路径无效");
    return { ok: false, reason: "客户端路径无效" };
  }
  const bin64 = path.join(client.clientPath, "bin64", "exefile.exe");
  const bin = path.join(client.clientPath, "bin", "exefile.exe");
  const exe =
    client.clientExe && fs.existsSync(client.clientExe) ? client.clientExe : fs.existsSync(bin64) ? bin64 : bin;
  if (!fs.existsSync(exe)) {
    setState("client", "error", `客户端程序不存在：${exe}`);
    note(`[客户端] 未启动：${exe} 不存在`);
    return { ok: false, reason: `exefile 不存在：${exe}` };
  }

  /* ---- 自动登录参数（V1 同款三件套） ---- */
  const args: string[] = ["/noconsole"];
  const account = (login?.user ?? "").trim();
  const password = login?.password ?? "";
  const characterId =
    login?.characterId === undefined || login?.characterId === null ? "" : String(login.characterId).trim();
  if (password.includes(":")) {
    setState("client", "error", "自动登录失败：密码不能包含冒号（客户端 /login: 参数限制）");
    return { ok: false, reason: "密码不能包含冒号" };
  }
  if (account && password) args.push(`/login:${account}:${password}`);
  if (/^\d+$/.test(characterId) && Number(characterId) > 0) {
    args.push(`/autoSelectCharacter:${characterId}`);
  } else if (characterId) {
    note(`[客户端] 角色 ID 非法，已忽略自动选角：${characterId}`);
  }

  /* ---- 游戏端口 ---- */
  let gamePort = 26000;
  try {
    const parsed = readServerConfig(root).ports.game;
    if (Number.isFinite(parsed) && parsed > 0) gamePort = parsed;
  } catch {
    /* 读取失败时沿用默认端口 */
  }
  args.push(`/port:${gamePort}`);

  /* ---- 客户端输出落盘到 _launcher/logs/client（目录与文件名全部 ASCII） ---- */
  const clientLogDir = path.join(launcherRuntimeRoot(), "logs", "client");
  try {
    fs.mkdirSync(clientLogDir, { recursive: true });
  } catch {
    /* 落盘失败不阻塞启动 */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutLog = path.join(clientLogDir, `client-${stamp}-${process.pid}.out.log`);
  const stderrLog = path.join(clientLogDir, `client-${stamp}-${process.pid}.err.log`);
  args.push(`/stdout=${stdoutLog}`, `/stderr=${stderrLog}`);

  /* ---- 环境（等价 Play.bat 的 ApplyClientNetworkPolicy + ResFiles） ---- */
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyClientNetworkPolicy(env, client.proxyUrl || "http://127.0.0.1:26002/", client.caPem);
  const resFiles = resolveClientResFiles(client.clientPath);
  if (resFiles) env.EO_REMOTEFILECACHEFOLDER = resFiles;

  note("[客户端] 直连启动 exefile（/noconsole，不再产生 CCP 控制台窗口）…");
  if (account && password) {
    note(
      `[客户端] 自动登录：account=${account} · ${
        characterId ? `characterId=${characterId}` : "未指定角色（停在角色选择）"
      }`
    );
  }
  if (!resFiles) note("[客户端] 未找到 tq 同级的 ResFiles 资源缓存，如报资源错误请检查客户端安装");
  note(`[客户端] 输出日志：${stdoutLog}`);

  await prepareClientCertificateTrust(root, client.clientPath);

  await prepareClientDisplaySafety(root, client);

  let child: ChildProcess;
  try {
    // 注意：这里绝对不要传 windowsHide —— Node 会因此设置
    // STARTF_USESHOWWINDOW + SW_HIDE，Windows 会把这个 SW_HIDE 应用到
    // exefile.exe（GUI 子系统）第一次显示窗口上，导致游戏窗口被创建成隐藏：
    // 进程在跑、有声音、能进游戏，但桌面上看不到任何窗口。
    // 控制台窗口由 DETACHED_PROCESS（不分配控制台）+ 客户端 /noconsole 负责，
    // 与 windowsHide 无关。
    child = spawn(exe, args, {
      cwd: client.clientPath,
      env,
      stdio: "ignore",
      creationFlags: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    } as SpawnOptions);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    setState("client", "error", `客户端启动失败：${reason}`);
    return { ok: false, reason };
  }

  const r = RUN.client;
  r.child = child;
  r.ownedPid = child.pid;
  r.info.pid = child.pid;
  setState("client", "starting", `客户端启动中（PID ${child.pid}）`);
  emit();

  const stopOut = startClientLogTail(stdoutLog, "client");
  const stopErr = startClientLogTail(stderrLog, "client");
  const stopTails = (): void => {
    stopOut();
    stopErr();
  };

  child.on("error", (err) => {
    stopTails();
    if (RUN.client.info.state === "running" || RUN.client.info.state === "starting") {
      setState("client", "error", `客户端启动失败：${err.message}`);
    }
    note(`[客户端] 启动失败：${err.message}`);
    r.ownedPid = undefined;
    r.child = undefined;
    emit();
  });

  child.on("exit", (code) => {
    stopTails();
    if (RUN.client.info.state === "running" || RUN.client.info.state === "starting") {
      setState("client", "error", `客户端已退出（exit ${code ?? "?"}）`);
      note(`[客户端] 已退出 exit=${code ?? "?"}`);
    }
    r.ownedPid = undefined;
    r.child = undefined;
    emit();
  });

  /* 直连启动后短暂观察：早期崩溃（配置 / 证书 / 资源错误）立刻反馈给 UI */
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || RUN.client.info.state !== "starting") {
      return { ok: false, reason: RUN.client.info.message || `客户端已退出（exit ${child.exitCode ?? "?"}）` };
    }
    await sleep(400);
  }

  setState("client", "running", `客户端已启动（PID ${child.pid}）`);
  note(`[客户端] 已启动${characterId ? `并请求直达角色（characterId=${characterId}）` : ""}`);
  return { ok: true, reason: "ok" };
}
/* ------------------------- 停止 / 重启 ------------------------- */

export async function stopService(id: ServiceId): Promise<ServiceActionResult> {
  const r = RUN[id];
  if (r.info.state === "idle") return { ok: true, reason: `${SERVICE_NAME[id]} 未运行` };
  if (r.info.state === "stopping") return { ok: true, reason: `${SERVICE_NAME[id]} 正在停止` };

  // 外部启动的进程：不接管停止
  if (r.info.state === "running" && !r.ownedPid && !r.child) {
    setState(id, "idle", "外部进程，未接管停止");
    note(`[${SERVICE_NAME[id]}] 外部进程，跳过停止`);
    return { ok: true, reason: "external, not owned" };
  }

  setState(id, "stopping", "停止中…");
  note(`[${SERVICE_NAME[id]}] 停止中…`);

  // PTY 会话先发 Ctrl+C 优雅退出（方案 7：等 3s 后仍存活则强杀）
  if (r.sessionId) {
    try {
      pty.getSession(r.sessionId)?.write("\x03");
    } catch {
      /* ignore */
    }
    await sleep(3000);
  }
  await killOwned(id);

  r.info.pid = undefined;
  setState(id, "idle", "已停止");
  note(`[${SERVICE_NAME[id]}] 已停止`);
  return { ok: true, reason: "ok" };
}

export async function restartService(id: ServiceId): Promise<ServiceActionResult> {
  await stopService(id);
  return startService(id);
}

/* ------------------------- 一键启停 ------------------------- */

export async function engageStart(): Promise<ServiceActionResult> {
  const settings = readSettings();
  note("[ENGAGE] 一键启动序列开始");
  const main = await startService("mainServer");
  if (!main.ok) {
    note(`[ENGAGE] 主服务器失败，序列中止：${main.reason}`);
    return main;
  }
  if (settings.startMarket !== false) {
    await startService("marketServer");
  } else {
    setState("marketServer", "idle", "已跳过（启动选项关闭）");
    note("[市场服务] 已跳过（启动选项关闭）");
  }
  setState("client", "idle", "客户端由登录入口单独启动");
  note("[客户端] 一键启动不拉起客户端，请使用登录入口启动");
  note("[ENGAGE] 启动序列完成");
  return { ok: true, reason: "启动序列完成" };
}

export async function engageStop(): Promise<ServiceActionResult> {
  note("[STOP] 停止全部服务");
  await Promise.all([stopService("mainServer"), stopService("marketServer"), stopService("client")]);
  note("[STOP] 全部服务已停止");
  return { ok: true, reason: "已全部停止" };
}

/** 退出清理：仅终止本启动器拉起的进程，不触碰外部进程 */
export function cleanupAll(): void {
  (Object.keys(RUN) as ServiceId[]).forEach((id) => {
    const r = RUN[id];
    if (r.ownedPid || r.child) {
      try {
        void killOwned(id);
      } catch {
        /* ignore */
      }
    }
  });
}
