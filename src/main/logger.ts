import * as fs from "fs";
import * as path from "path";
import { resolveRepoRoot } from "./envDetector";

let logFile: string | null = null;

/** 初始化日志落盘：<repoRoot>/server/logs/launcher.log（与服务端 server.log 同目录） */
export function initLogger(): void {
  try {
    const dir = path.join(resolveRepoRoot(), "server", "logs");
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, "launcher.log");
  } catch {
    logFile = null;
  }
}

export function log(scope: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${msg}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      /* 落盘失败不阻断 */
    }
  }
  // eslint-disable-next-line no-console
  console.log(line);
}
