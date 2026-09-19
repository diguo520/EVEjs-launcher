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
import { listAccounts, createAccount, deleteAccount, checkServerRunning, verifyAccount, changeAccountPassword, launchClientWithLogin, launchStoredAccount } from "./accountManager";
import * as pty from "./ptyManager";
import { log } from "./logger";
import { applyUpdate, cancelUpdateDownload, checkForUpdates, currentUpdateState, downloadUpdate } from "./updater";
import { databaseOverview, databaseTable, databaseSaveRow, databaseInsertRow, databaseDeleteRow, databaseCreateBackup, databaseBackups, databaseRestoreBackup } from "./databaseManager";

const execFileAsync = promisify(execFile);
let previousCpu = os.cpus().map((cpu) => ({ ...cpu.times }));
let previousNetBytes: number | null = null;
let previousNetAt = Date.now();

interface GpuMetrics {
  gpuPercent: number | null;
  gpuDedicatedUsedGB: number | null;
  gpuDedicatedTotalGB: number | null;
  gpuSharedUsedGB: number | null;
  gpuMemoryUsedGB: number | null;
  gpuMemoryTotalGB: number | null;
  virtualMemUsedGB: number | null;
  virtualMemTotalGB: number | null;
}

const EMPTY_GPU_METRICS: GpuMetrics = {
  gpuPercent: null,
  gpuDedicatedUsedGB: null,
  gpuDedicatedTotalGB: null,
  gpuSharedUsedGB: null,
  gpuMemoryUsedGB: null,
  gpuMemoryTotalGB: null,
  virtualMemUsedGB: null,
  virtualMemTotalGB: null
};

let gpuMetricsCache: { at: number; value: GpuMetrics; refreshing: boolean } = {
  at: 0,
  value: EMPTY_GPU_METRICS,
  refreshing: false
};

function toNullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bytesToGB(value: number | null): number | null {
  return value == null ? null : value / 1024 ** 3;
}

async function queryWindowsGpuMetrics(): Promise<GpuMetrics> {
  const command = [
    '$ErrorActionPreference = "SilentlyContinue";',
    '$eng = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object { [double]$_.UtilizationPercentage });',
    '$mem = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory);',
    '$vc = @(Get-CimInstance Win32_VideoController);',
    '$os = Get-CimInstance Win32_OperatingSystem;',
    '$gpuPercent = $null; if ($eng.Count -gt 0) { $gpuPercent = ($eng | Measure-Object -Maximum).Maximum };',
    '$dedicatedUsedBytes = ($mem | Measure-Object -Property DedicatedUsage -Sum).Sum;',
    '$sharedUsedBytes = ($mem | Measure-Object -Property SharedUsage -Sum).Sum;',
    '$committedUsedBytes = ($mem | Measure-Object -Property TotalCommitted -Sum).Sum;',
    '$dedicatedTotalBytes = ($vc | Measure-Object -Property AdapterRAM -Sum).Sum;',
    '$virtualTotalBytes = $null; if ($os -and $os.TotalVirtualMemorySize) { $virtualTotalBytes = [double]$os.TotalVirtualMemorySize * 1024 };',
    '$virtualFreeBytes = $null; if ($os -and $os.FreeVirtualMemory) { $virtualFreeBytes = [double]$os.FreeVirtualMemory * 1024 };',
    '[pscustomobject]@{ gpuPercent=$gpuPercent; dedicatedUsedBytes=$dedicatedUsedBytes; dedicatedTotalBytes=$dedicatedTotalBytes; sharedUsedBytes=$sharedUsedBytes; committedUsedBytes=$committedUsedBytes; virtualTotalBytes=$virtualTotalBytes; virtualFreeBytes=$virtualFreeBytes } | ConvertTo-Json -Compress'
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const dedicatedUsed = toNullableNumber(data.dedicatedUsedBytes);
  const dedicatedTotal = toNullableNumber(data.dedicatedTotalBytes);
  const committedUsed = toNullableNumber(data.committedUsedBytes);
  const virtualTotal = toNullableNumber(data.virtualTotalBytes);
  const virtualFree = toNullableNumber(data.virtualFreeBytes);
  return {
    gpuPercent: toNullableNumber(data.gpuPercent),
    gpuDedicatedUsedGB: bytesToGB(dedicatedUsed),
    gpuDedicatedTotalGB: bytesToGB(dedicatedTotal),
    gpuSharedUsedGB: bytesToGB(toNullableNumber(data.sharedUsedBytes)),
    gpuMemoryUsedGB: bytesToGB(committedUsed),
    gpuMemoryTotalGB: bytesToGB(dedicatedTotal),
    virtualMemUsedGB: virtualTotal != null && virtualFree != null ? bytesToGB(Math.max(0, virtualTotal - virtualFree)) : null,
    virtualMemTotalGB: bytesToGB(virtualTotal)
  };
}

async function queryNvidiaSmiMetrics(): Promise<GpuMetrics> {
  const { stdout } = await execFileAsync(
    "nvidia-smi",
    ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
    { timeout: 2500, windowsHide: true }
  );
  const rows = stdout.trim().split(/\r?\n/).map((line) => line.split(",").map((part) => Number(part.trim()))).filter((row) => row.length >= 3 && row.every(Number.isFinite));
  if (!rows.length) return EMPTY_GPU_METRICS;
  const used = rows.reduce((sum, row) => sum + row[1] * 1024 ** 2, 0);
  const total = rows.reduce((sum, row) => sum + row[2] * 1024 ** 2, 0);
  return {
    ...EMPTY_GPU_METRICS,
    gpuPercent: Math.min(100, Math.max(...rows.map((row) => row[0]))),
    gpuDedicatedUsedGB: bytesToGB(used),
    gpuDedicatedTotalGB: bytesToGB(total),
    gpuMemoryUsedGB: bytesToGB(used),
    gpuMemoryTotalGB: bytesToGB(total)
  };
}

function getGpuMetrics(): GpuMetrics {
  const now = Date.now();
  if (!gpuMetricsCache.refreshing && now - gpuMetricsCache.at > 5000) {
    gpuMetricsCache.refreshing = true;
    const windowsQuery = process.platform === "win32" ? queryWindowsGpuMetrics().catch(() => EMPTY_GPU_METRICS) : Promise.resolve(EMPTY_GPU_METRICS);
    windowsQuery.then(async (windowsMetrics) => {
      if (windowsMetrics.gpuPercent != null || windowsMetrics.gpuDedicatedUsedGB != null) {
        gpuMetricsCache = { at: Date.now(), value: windowsMetrics, refreshing: false };
        return;
      }
      const nvidiaMetrics = await queryNvidiaSmiMetrics().catch(() => EMPTY_GPU_METRICS);
      gpuMetricsCache = { at: Date.now(), value: nvidiaMetrics, refreshing: false };
    }).catch(() => {
      gpuMetricsCache = { at: Date.now(), value: EMPTY_GPU_METRICS, refreshing: false };
    });
  }
  return gpuMetricsCache.value;
}

async function readNetworkBytes(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("netstat", ["-e"], { timeout: 2500, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const numbers = line.trim().match(/\d+/g);
      if (numbers && numbers.length === 2) return Number(numbers[0]) + Number(numbers[1]);
    }
  } catch { /* counters unavailable */ }
  return null;
}

interface DiskVolumeMetrics {
  root: string;
  totalGB: number;
  usedGB: number;
  freeGB: number;
  percent: number;
}

function volumeFromStat(root: string, stat: fs.StatsFs): DiskVolumeMetrics | null {
  const blockSize = Number(stat.bsize);
  const total = Number(stat.blocks) * blockSize;
  const free = Number(stat.bavail) * blockSize;
  if (!Number.isFinite(total) || total <= 0) return null;
  const used = Math.max(0, total - free);
  return {
    root: root.replace(/[\\/]+$/, ""),
    totalGB: total / 1024 ** 3,
    usedGB: used / 1024 ** 3,
    freeGB: free / 1024 ** 3,
    percent: total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0
  };
}

async function readDiskVolumes(): Promise<DiskVolumeMetrics[]> {
  if (process.platform === "win32") {
    const volumes: DiskVolumeMetrics[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:`;
      try {
        const volume = volumeFromStat(root, fs.statfsSync(`${root}\\`));
        if (volume) volumes.push(volume);
      } catch {
        /* drive letter not mounted or not ready */
      }
    }
    return volumes.sort((left, right) => left.root.localeCompare(right.root));
  }
  try {
    const { stdout } = await execFileAsync("df", ["-kP"], { timeout: 2500, windowsHide: true });
    return stdout.split(/\r?\n/).slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const free = Number(parts[3]) * 1024;
      if (!Number.isFinite(total) || total <= 0) return null;
      return {
        root: parts.slice(5).join(" "),
        totalGB: total / 1024 ** 3,
        usedGB: used / 1024 ** 3,
        freeGB: free / 1024 ** 3,
        percent: total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0
      } satisfies DiskVolumeMetrics;
    }).filter((volume): volume is DiskVolumeMetrics => volume !== null);
  } catch {
    return [];
  }
}

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
    const repoRoot = resolveRepoRoot();
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
    const volumes = await readDiskVolumes();
    const repoRootDrive = path.parse(repoRoot).root.replace(/[\\/]+$/, "").toUpperCase();
    const currentVolume = volumes.find((volume) => volume.root.toUpperCase() === repoRootDrive) || volumes[0] || null;
    const netBytes = await readNetworkBytes();
    const now = Date.now();
    const elapsed = Math.max(0.1, (now - previousNetAt) / 1000);
    const netRate = netBytes != null && previousNetBytes != null && netBytes >= previousNetBytes
      ? (netBytes - previousNetBytes) / elapsed
      : 0;
    if (netBytes != null) previousNetBytes = netBytes;
    previousNetAt = now;
    const gpu = getGpuMetrics();
    return {
      cpuPercent,
      memUsedGB: memUsed / 1024 ** 3,
      memTotalGB: memTotal / 1024 ** 3,
      diskUsedGB: currentVolume?.usedGB || 0,
      diskTotalGB: currentVolume?.totalGB || 0,
      diskRoot: currentVolume?.root || path.parse(repoRoot).root,
      volumes,
      netBytesPerSec: netRate,
      gpuPercent: gpu.gpuPercent,
      gpuDedicatedUsedGB: gpu.gpuDedicatedUsedGB,
      gpuDedicatedTotalGB: gpu.gpuDedicatedTotalGB,
      gpuSharedUsedGB: gpu.gpuSharedUsedGB,
      gpuMemoryUsedGB: gpu.gpuMemoryUsedGB,
      gpuMemoryTotalGB: gpu.gpuMemoryTotalGB,
      virtualMemUsedGB: gpu.virtualMemUsedGB,
      virtualMemTotalGB: gpu.virtualMemTotalGB
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

  /* ---------- 数据库管理 ---------- */
  ipcMain.handle("database:overview", () => databaseOverview());
  ipcMain.handle("database:table", (_e, table: string, limit?: number, offset?: number) =>
    databaseTable(String(table ?? ""), Number(limit) || 100, Number(offset) || 0)
  );
  ipcMain.handle("database:save", (_e, table: string, values: Record<string, unknown>) =>
    databaseSaveRow(String(table ?? ""), values ?? {})
  );
  ipcMain.handle("database:insert", (_e, table: string, values: Record<string, unknown>) =>
    databaseInsertRow(String(table ?? ""), values ?? {})
  );
  ipcMain.handle("database:delete", (_e, table: string, values: Record<string, unknown>) =>
    databaseDeleteRow(String(table ?? ""), values ?? {})
  );
  ipcMain.handle("database:backup", () => databaseCreateBackup());
  ipcMain.handle("database:backups", () => databaseBackups());
  ipcMain.handle("database:restore", (_e, name: string) => databaseRestoreBackup(String(name ?? "")));

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
  ipcMain.handle("accounts:launch", (_e, user: string, characterId?: string | number) =>
    launchStoredAccount(String(user ?? ""), characterId)
  );
  ipcMain.handle(
    "login:start",
    (_e, user: string, password: string, remember: boolean, characterId?: string | number) =>
      launchClientWithLogin(String(user ?? ""), String(password ?? ""), !!remember, characterId)
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
