import { execSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveRepoRoot } from "./envDetector";
import { readClientConfig, readSettings, type ClientConfig } from "./configStore";
import { checkTcp } from "./healthChecker";
import * as pty from "./ptyManager";
import { log } from "./logger";

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
  child?: ChildProcessWithoutNullStreams;
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

function emit(): void {
  const snapshot = getServices();
  snapshotListeners.forEach((fn) => fn(snapshot));
}

function note(line: string): void {
  log("svc", line);
  progressListeners.forEach((fn) => fn(line));
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
  note("[主服务器] 启动 npm start（server/）…");
  const session = pty.createSession("mainServer", "cmd.exe", ["/c", "npm start"], serverDir, baseEnv());
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
  const exe = client.clientExe || (fs.existsSync(bin64) ? bin64 : bin);
  if (!fs.existsSync(exe)) {
    setState("client", "error", `客户端程序不存在：${exe}`);
    note(`[客户端] 未启动：${exe} 不存在`);
    return { ok: false, reason: `exefile 不存在：${exe}` };
  }
  note("[客户端] 启动 exefile.exe …");
  // 自动登录（客户端原生 /login:<user>:<password> 参数 → GetLoginCredentials → TryAutomaticLogin）
  const loginArg = login && login.user && login.password ? `${login.user}:${login.password}` : "";
  if (login && login.password.includes(":")) {
    setState("client", "error", "自动登录失败：密码不能包含冒号（客户端 /login: 参数限制）");
    return { ok: false, reason: "密码不能包含冒号" };
  }
  if (loginArg) note(`[客户端] 自动登录参数已注入（user=${login?.user}）`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVEJS_PROXY_URL: client.proxyUrl || "http://127.0.0.1:26002/",
    EVEJS_PROXY_LOCAL_INTERCEPT: "1",
    EVEJS_PROXY_UNHANDLED_HOST_POLICY: "block"
  };
  if (client.caPem && fs.existsSync(client.caPem)) {
    env.SSL_CERT_FILE = client.caPem;
    env.REQUESTS_CA_BUNDLE = client.caPem;
    env.CURL_CA_BUNDLE = client.caPem;
  }
  if (loginArg) env.EVEJS_AUTO_LOGIN = loginArg;

  // 优先走官方 Play.bat（完整校验：start.ini / blue.dll / ResFiles / 证书信任 / 服务器就绪 +
  // 网络策略），PTY 会话让启动器终端显示全部输出。
  // 自动登录通过 EVEJS_AUTO_LOGIN 环境变量交给 Play.bat 补丁拼接 /login: 参数。
  // 兼容：Play.bat 缺失或为原版（无补丁）时，回退直连 exefile + /login: 参数，自动登录仍生效。
  const playBat = path.join(root, "Play.bat");
  let playPatched = false;
  if (fs.existsSync(playBat)) {
    try {
      playPatched = fs.readFileSync(playBat, "utf8").includes("EVEJS_AUTO_LOGIN");
    } catch {
      /* 读取失败按未打补丁处理 */
    }
  }
  if (fs.existsSync(playBat) && playPatched) {
    note("[客户端] 通过 Play.bat 启动（完整校验 + 终端输出）…");
    const session = pty.createSession("client", "cmd.exe", ["/c", playBat], root, env);
    const r = RUN.client;
    r.sessionId = "client";
    r.ownedPid = session.pid;
    r.info.pid = session.pid;
    setState("client", "starting", `客户端启动中（PID ${session.pid}）`);
    emit();
    const up = await waitClientUp(90_000);
    if (RUN.client.info.state !== "starting") {
      // Play.bat 校验失败/客户端已退出（onExit 已置 error）
      return { ok: false, reason: RUN.client.info.message || "客户端启动失败" };
    }
    if (!up) {
      setState("client", "error", "客户端 exefile 未在 90s 内出现（详见终端）");
      note("[客户端] 未检测到 exefile 进程，详见终端输出");
      return { ok: false, reason: "客户端未启动（详见终端）" };
    }
    setState("client", "running", `客户端已启动（PID ${session.pid}）`);
    note(`[客户端] Play.bat 已拉起客户端`);
    return { ok: true, reason: "ok" };
  }

  if (fs.existsSync(playBat) && !playPatched) {
    note("[客户端] Play.bat 为原版（无自动登录补丁），已回退直连 exefile + /login: 参数");
  }
  const args: string[] = [];
  if (loginArg) args.push(`/login:${loginArg}`);
  const child = spawn(exe, args, { cwd: client.clientPath, env, windowsHide: false });
  const r = RUN.client;
  r.child = child;
  r.ownedPid = child.pid;
  r.info.pid = child.pid;
  setState("client", "running", `客户端已启动（PID ${child.pid}）`);
  note(`[客户端] PID ${child.pid} 已启动`);

  child.on("exit", (code) => {
    if (RUN.client.info.state === "running" || RUN.client.info.state === "starting") {
      setState("client", "error", `客户端已退出（exit ${code ?? "?"}）`);
      note(`[客户端] 已退出 exit=${code}`);
    }
    r.ownedPid = undefined;
    emit();
  });
  return { ok: true, reason: "ok" };
}

/** 轮询 exefile.exe 进程是否出现（Play.bat 校验完成后客户端拉起） */
async function waitClientUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq exefile.exe" /FO CSV /NH', { encoding: "utf8", timeout: 5000 });
      if (out.trim() && /exefile\.exe/i.test(out)) return true;
    } catch {
      /* tasklist 失败继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
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
