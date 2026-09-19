import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

/**
 * PTY 终端管理器（技术方案 5.1，多 Tab）。
 * Phase 1-2 壳阶段：
 *  - 优先加载 node-pty（Windows ConPTY，VS Code 同款）；
 *  - 若原生模块不可用，降级为 child_process.spawn 管道（仅透传，无 PTY 交互）。
 * Phase 3 将在此之上接入真实服务日志流。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
let ptyApi: any = null;
try {
  ptyApi = require("node-pty");
} catch {
  ptyApi = null;
}

export interface PtySession {
  id: string;
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type DataCb = (tabId: string, data: string) => void;
type ExitCb = (tabId: string, exitCode: number) => void;

const sessions = new Map<string, PtySession>();
let dataCb: DataCb | null = null;
let exitCb: ExitCb | null = null;
const exitListeners = new Set<ExitCb>();

export function setCallbacks(onData: DataCb, onExit: ExitCb): void {
  dataCb = onData;
  exitCb = onExit;
}

/** 额外退出监听（进程管理器用于崩溃处理） */
export function onExit(cb: ExitCb): () => void {
  exitListeners.add(cb);
  return () => exitListeners.delete(cb);
}

function fireExit(tabId: string, code: number): void {
  exitCb?.(tabId, code);
  exitListeners.forEach((fn) => fn(tabId, code));
}

export function createSession(
  tabId: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): PtySession {
  const mergedEnv = { ...process.env, ...env };

  if (ptyApi) {
    const term = ptyApi.spawn(command, args, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd,
      env: mergedEnv,
      useConpty: process.platform === "win32"
    });
    term.onData((d: string) => dataCb?.(tabId, d));
    term.onExit(({ exitCode }: { exitCode: number }) => fireExit(tabId, exitCode));
    const session: PtySession = {
      id: tabId,
      pid: term.pid,
      write: (d) => term.write(d),
      resize: (cols, rows) => term.resize(cols, rows),
      kill: () => term.kill()
    };
    sessions.set(tabId, session);
    return session;
  }

  // 降级：spawn 管道（无 PTY）
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd,
    env: mergedEnv,
    shell: true,
    windowsHide: false
  });
  child.stdout.on("data", (d) => dataCb?.(tabId, d.toString()));
  child.stderr.on("data", (d) => dataCb?.(tabId, d.toString()));
  child.on("exit", (code) => fireExit(tabId, code ?? -1));
  const session: PtySession = {
    id: tabId,
    pid: child.pid,
    write: (d) => child.stdin.write(d),
    resize: () => undefined,
    kill: () => child.kill()
  };
  sessions.set(tabId, session);
  return session;
}

export function getSession(tabId: string): PtySession | undefined {
  return sessions.get(tabId);
}

export function destroySession(tabId: string): void {
  const s = sessions.get(tabId);
  if (s) {
    try {
      s.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.delete(tabId);
}
