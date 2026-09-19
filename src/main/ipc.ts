import { ipcMain, BrowserWindow, shell, app } from "electron";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { detectEnv, resolveRepoRoot } from "./envDetector";
import {
  readServerConfig,
  readClientConfig,
  readSettings,
  writeSettings,
  writeClientConfig
} from "./configStore";
import { checkAll } from "./healthChecker";
import { runInit, getInitState, onInitChanged, type InitKey } from "./initManager";
import {
  startService,
  stopService,
  restartService,
  getServices,
  engageStart,
  engageStop
} from "./processManager";
import { listAccounts, createAccount, deleteAccount, checkServerRunning, verifyAccount, changeAccountPassword, launchClientWithLogin } from "./accountManager";
import * as pty from "./ptyManager";
import { log } from "./logger";
import { applyUpdate, cancelUpdateDownload, checkForUpdates, currentUpdateState, downloadUpdate } from "./updater";

const execFileAsync = promisify(execFile);
let previousCpu = os.cpus().map((cpu) => ({ ...cpu.times }));
let previousNetBytes = 0;
let previousNetAt = Date.now();

/** 向指定终端页签推送一行文本（渲染层 xterm 直接写入） */
export function pushTerminalLine(tabId: string, text: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send("terminal:data", tabId, text);
}

export function registerIpc(): void {
  /* ---------- 窗口控制 ---------- */
  ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on("window:toggleMaximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

  /* ---------- 应用信息 / 环境自检 / 健康检查 ---------- */
  ipcMain.handle("app:info", () => ({
    name: "EvEJS 启动器",
    version: app.getVersion(),
    repoRoot: resolveRepoRoot(),
    platform: process.platform,
    phase: "3-4"
  }));

  // 打开外部链接（仅放行 http/https，用于「官网安装」跳转）
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle("env:check", () => detectEnv());
  ipcMain.handle("health:check", () => checkAll());
  ipcMain.handle("metrics:get", async () => {
    const cpus = os.cpus();
    let idleDelta = 0;
    let totalDelta = 0;
    cpus.forEach((cpu, index) => {
      const previous = previousCpu[index] || cpu.times;
      const idle = cpu.times.idle - previous.idle;
      const total =
        (cpu.times.user - previous.user) +
        (cpu.times.nice - previous.nice) +
        (cpu.times.sys - previous.sys) +
        (cpu.times.idle - previous.idle) +
        (cpu.times.irq - previous.irq);
      idleDelta += idle;
      totalDelta += total;
    });
    previousCpu = cpus.map((cpu) => ({ ...cpu.times }));
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    let diskTotal = 0;
    let diskFree = 0;
    try {
      const stat = fs.statfsSync(resolveRepoRoot());
      diskTotal = Number(stat.blocks) * Number(stat.bsize);
      diskFree = Number(stat.bavail) * Number(stat.bsize);
    } catch { /* ignore */ }
    let netBytes = 0;
    try {
      if (process.platform === "win32") {
        const command = "Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum | ConvertTo-Json -Compress";
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 1500, windowsHide: true });
        const parsed = JSON.parse(stdout);
        const sum = parsed?.Sum;
        if (Array.isArray(sum)) netBytes = sum.reduce((total, value) => total + Number(value || 0), 0);
        else netBytes = Number(sum || 0);
      }
    } catch { /* network counters unavailable */ }
    const now = Date.now();
    const elapsed = Math.max(0.1, (now - previousNetAt) / 1000);
    const netRate = netBytes >= previousNetBytes && previousNetBytes > 0 ? (netBytes - previousNetBytes) / elapsed : 0;
    previousNetBytes = netBytes;
    previousNetAt = now;
    return {
      cpuPercent,
      memUsedGB: memUsed / 1024 ** 3,
      memTotalGB: memTotal / 1024 ** 3,
      diskUsedGB: (diskTotal - diskFree) / 1024 ** 3,
      diskTotalGB: diskTotal / 1024 ** 3,
      netBytesPerSec: netRate
    };
  });

  /* ---------- 环境初始化（首次启动引导，Phase 补充） ---------- */
  ipcMain.handle("init:run", (_e, key: InitKey) => runInit(key));
  ipcMain.handle("init:state", () => getInitState());
  onInitChanged((s) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) win.webContents.send("init:changed", s);
  });

  /* ---------- 任务视图：服务器日志 ---------- */
  // 日志路径解析（便携版放在服务端根目录运行时，日志 = <exe 实际所在目录>\server\logs\server.log）：
  // 1) PORTABLE_EXECUTABLE_DIR：electron-builder 便携版专用，exe 真实放置目录
  //    （portable 运行时 cwd 与 app.getPath("exe") 都是 %TEMP% 解压目录，不可用作定位）
  // 2) 打包后 exe 所在目录（NSIS 安装版 / win-unpacked 直跑等非 portable 场景）
  // 3) 当前工作目录
  // 4) resolveRepoRoot() 兜底（dev 从 launcher 目录运行等场景）
  const serverLogPath = (): string => {
    const candidates: string[] = [];
    if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, "server", "logs", "server.log"));
    if (app.isPackaged) candidates.push(path.join(path.dirname(app.getPath("exe")), "server", "logs", "server.log"));
    candidates.push(path.join(process.cwd(), "server", "logs", "server.log"));
    candidates.push(path.join(resolveRepoRoot(), "server", "logs", "server.log"));
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* 不存在则试下一个候选 */
      }
    }
    return candidates[0];
  };

  ipcMain.handle("log:read", () => {
    const logFile = serverLogPath();
    try {
      const stat = fs.statSync(logFile);
      const raw = fs.readFileSync(logFile, "utf8");
      const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
      return {
        ok: true,
        path: logFile,
        exists: true,
        size: stat.size,
        mtime: stat.mtimeMs,
        lines: lines.slice(-5000)
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, path: logFile, exists: false, size: 0, mtime: 0, lines: [] };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err), path: logFile, exists: false, size: 0, mtime: 0, lines: [] };
    }
  });

  /* ---------- 配置 ---------- */
  ipcMain.handle("config:get", () => {
    const root = resolveRepoRoot();
    return { server: readServerConfig(root), client: readClientConfig(root) };
  });
  ipcMain.handle("config:setRepoRoot", (_e, repoRoot: string) => {
    const nextRoot = path.resolve(String(repoRoot || ""));
    try {
      if (!fs.existsSync(path.join(nextRoot, "server", "autostart.js"))) {
        return { ok: false, reason: "目录中未找到 server/autostart.js" };
      }
      const base = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath("exe")) : process.cwd());
      const configPath = path.join(base, "launcher.config.json");
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch { /* new file */ }
      const next = { ...current, repoRoot: nextRoot };
      fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
      return { ok: true, path: configPath, repoRoot: nextRoot };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("config:setClient", (_e, patch: Parameters<typeof writeClientConfig>[1]) => {
    try {
      return { ok: true, client: writeClientConfig(resolveRepoRoot(), patch ?? {}) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_e, patch: Record<string, unknown>) => writeSettings(patch));

  /* ---------- 启动器更新 ---------- */
  ipcMain.handle("update:check", () => checkForUpdates());
  ipcMain.handle("update:state", () => currentUpdateState());
  ipcMain.handle("update:download", () => downloadUpdate());
  ipcMain.handle("update:apply", () => applyUpdate());
  ipcMain.on("update:cancel", () => cancelUpdateDownload());

  /* ---------- 服务控制（Phase 3-4 真实启停） ---------- */
  ipcMain.handle("service:start", (_e, id) => startService(id));
  ipcMain.handle("service:stop", (_e, id) => stopService(id));
  ipcMain.handle("service:restart", (_e, id) => restartService(id));
  ipcMain.handle("services:list", () => getServices());
  ipcMain.handle("engage:start", () => engageStart());
  ipcMain.handle("engage:stop", () => engageStop());

  /* ---------- 账号管理 ---------- */
  ipcMain.handle("accounts:list", () => listAccounts());
  ipcMain.handle("accounts:create", (_e, user: string, password: string, isGM: boolean) =>
    createAccount(user, password, isGM)
  );
  ipcMain.handle("accounts:delete", (_e, target: string, apply: boolean) =>
    deleteAccount(String(target ?? ""), !!apply)
  );
  ipcMain.handle("accounts:checkRunning", () => checkServerRunning());
  ipcMain.handle("accounts:verify", (_e, user: string, password: string) =>
    verifyAccount(String(user ?? ""), String(password ?? ""))
  );
  ipcMain.handle("accounts:setPassword", (_e, user: string, oldPw: string, newPw: string) =>
    changeAccountPassword(String(user ?? ""), String(oldPw ?? ""), String(newPw ?? ""))
  );
  ipcMain.handle("login:start", (_e, user: string, password: string) =>
    launchClientWithLogin(String(user ?? ""), String(password ?? ""))
  );

  /* ---------- 终端输入回传 / 尺寸同步 ---------- */
  ipcMain.on("terminal:input", (_e, tabId: string, data: string) => {
    const s = pty.getSession(tabId);
    if (s) s.write(data);
    else log("terminal", `[${tabId}] 输入(壳阶段未连接PTY): ${JSON.stringify(data)}`);
  });
  ipcMain.on("terminal:resize", (_e, tabId: string, cols: number, rows: number) => {
    pty.getSession(tabId)?.resize(cols, rows);
  });

  log("ipc", "IPC handlers registered");
}
