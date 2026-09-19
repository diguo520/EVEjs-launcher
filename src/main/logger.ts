import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

let logFile: string | null = null;

/** 初始化日志落盘：<launcherDir>/_launcher/logs/launcher.log */
export function initLogger(): void {
  try {
    const dir = app.getPath("logs");
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
