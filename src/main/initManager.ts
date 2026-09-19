import { BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveRepoRoot, findVsInstallPath } from "./envDetector";
import { readClientConfig, writeClientConfig } from "./configStore";
import { launcherTempDir } from "./runtimePaths";

/** 初始化任务键：deps=主服务器依赖 / db=本地数据库 / market=市场服务二进制 / client=客户端路径 / ca=CA 证书 */
export type InitKey = "deps" | "db" | "market" | "client" | "ca";

/** 客户端路径探测候选（EVE 常见安装位置，含 exefile.exe 判定） */
const CLIENT_PATH_CANDIDATES = [
  "F:\\EVE Online - 3396210\\tq",
  "D:\\EVE Online - 3396210\\tq",
  "E:\\EVE Online - 3396210\\tq",
  "C:\\EVE Online - 3396210\\tq",
  "C:\\Program Files (x86)\\EVE Online\\tq",
  "C:\\Games\\EVE Online - 3396210\\tq",
  "D:\\Games\\EVE Online - 3396210\\tq",
  "E:\\Games\\EVE Online - 3396210\\tq"
];

function clientPathLooksValid(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    return (
      fs.existsSync(path.join(p, "exefile.exe")) ||
      fs.existsSync(path.join(p, "bin64", "exefile.exe"))
    );
  } catch {
    return false;
  }
}

/** 自动探测 EVE 客户端安装路径（已配置且有效 → 直接沿用） */
function detectClientPath(root: string): string | null {
  try {
    const cfg = readClientConfig(root);
    if (cfg.clientPath && clientPathLooksValid(cfg.clientPath)) return cfg.clientPath;
  } catch {
    /* 配置不可读时继续探测 */
  }
  for (const cand of CLIENT_PATH_CANDIDATES) {
    if (clientPathLooksValid(cand)) return cand;
  }
  return null;
}

interface InitTaskDef {
  key: InitKey;
  label: string;
  /** bat 任务：返回临时 bat 内容（ASCII + chcp 65001；中文提示由主进程推送）。返回 null 表示缺少前置条件 */
  buildBat?(root: string): string | null;
  /** 直连任务：在主进程直接执行（快速、无需子进程）。返回成功与否 */
  runDirect?(root: string, note: (text: string) => void): { ok: boolean; reason?: string };
  /** 任务启动时额外推送到终端的中文提示（如 GUI 向导操作说明） */
  preNote?: string;
}

const TASKS: Record<InitKey, InitTaskDef> = {
  deps: {
    key: "deps",
    label: "主服务器依赖",
    buildBat: (root) =>
      [
        "@echo off",
        "chcp 65001 >nul 2>&1",
        `cd /d "${path.join(root, "server")}"`,
        "call npm ci --no-audit --no-fund",
        "exit /b %errorlevel%"
      ].join("\r\n")
  },
  db: {
    key: "db",
    label: "本地数据库",
    buildBat: (root) =>
      [
        "@echo off",
        "chcp 65001 >nul 2>&1",
        ":: 数据库初始化 = 强制重建：CreateDatabase.bat 默认只检查 manifest.json 是否存在，",
        ":: 若 sqlite 缺失但 manifest 在（拷贝遗漏/构建中断）会被误跳过；/force 保证真正补全",
        `call "${path.join(root, "tools", "DatabaseCreator", "CreateDatabase.bat")}" /force`,
        "exit /b %errorlevel%"
      ].join("\r\n")
  },
  market: {
    key: "market",
    label: "市场服务二进制",
    buildBat: (root) => {
      const vsPath = findVsInstallPath();
      const vcvars = vsPath ? path.join(vsPath, "VC", "Auxiliary", "Build", "vcvars64.bat") : null;
      if (!vcvars || !fs.existsSync(vcvars)) return null;
      return [
        "@echo off",
        "chcp 65001 >nul 2>&1",
        `call "${vcvars}" >nul 2>&1`,
        "if errorlevel 1 (echo MSVC env init failed & exit /b 1)",
        `cd /d "${path.join(root, "externalservices", "market-server")}"`,
        "call cargo build --release",
        "exit /b %errorlevel%"
      ].join("\r\n");
    }
  },
  client: {
    key: "client",
    label: "客户端路径",
    runDirect: (root, note) => {
      const found = detectClientPath(root);
      if (!found) {
        note("未在常见位置找到 EVE 客户端（exefile.exe），请在配置面板中手动填写路径");
        return { ok: false, reason: "未找到客户端安装" };
      }
      try {
        writeClientConfig(root, { clientPath: found });
        note(`已写入客户端路径：${found}`);
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `写入配置失败：${msg}` };
      }
    }
  },
  ca: {
    key: "ca",
    label: "客户端证书 CA",
    // 用户指定：CA 证书初始化 = 启动 ClientSETUP 向导（WPF GUI，装证书/写配置/patch dll）
    buildBat: (root) => {
      const setupBat = path.join(root, "tools", "ClientSETUP", "StartClientSetup.bat");
      if (!fs.existsSync(setupBat)) return null;
      return [
        "@echo off",
        "chcp 65001 >nul 2>&1",
        `call "${setupBat}"`,
        "exit /b %errorlevel%"
      ].join("\r\n");
    },
    preNote:
      "已打开 EvEJS 客户端配置向导窗口：请按向导完成「选择客户端 → 安装证书 → 补丁 → start.ini」；向导关闭后本任务结束，如向导报错请在下方终端按任意键继续"
  }
};

export interface InitState {
  busy: boolean;
  key: InitKey | null;
  label: string;
  progress: number | null;
}

let current: { key: InitKey; proc: ChildProcess | null; progress: number | null } | null = null;
let listeners: Array<(s: InitState) => void> = [];

function emit(): void {
  const s: InitState = current
    ? { busy: true, key: current.key, label: TASKS[current.key].label, progress: current.progress }
    : { busy: false, key: null, label: "", progress: null };
  for (const l of listeners) l(s);
}

function setProgress(p: number): void {
  if (current) {
    current.progress = p;
    emit();
  }
}

export function onInitChanged(cb: (s: InitState) => void): void {
  listeners.push(cb);
}

export function getInitState(): InitState {
  return current
    ? { busy: true, key: current.key, label: TASKS[current.key].label, progress: current.progress }
    : { busy: false, key: null, label: "", progress: null };
}

/** 向启动器终端推送一行（避免与 ipc.ts 循环依赖，内联实现） */
function pushLine(tabId: string, text: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send("terminal:data", tabId, text);
}

function push(text: string): void {
  pushLine("system", text.replace(/\r?\n/g, "\r\n") + "\r\n");
}

/** 启动一项环境初始化（单任务串行；正在运行时拒绝新任务） */
export function runInit(key: InitKey): { ok: boolean; reason?: string } {
  const fail = (reason: string): { ok: false; reason: string } => {
    push(`\x1b[31m[初始化] ${reason}\x1b[0m`);
    return { ok: false, reason };
  };
  if (current) return fail(`正在执行「${TASKS[current.key].label}」初始化，请等待完成`);
  const def = TASKS[key];
  if (!def) return fail(`未知初始化项: ${key}`);

  const root = resolveRepoRoot();
  push(`\r\n\x1b[33m════ [初始化] ${def.label} 开始 ════\x1b[0m`);
  if (def.preNote) push(`\x1b[36m[初始化] ${def.preNote}\x1b[0m`);

  // 直连任务：主进程直接执行（进度 0 → 100；短暂保持 busy 让进度条可见）
  if (def.runDirect) {
    current = { key, proc: null, progress: 0 };
    emit();
    const res = def.runDirect(root, (text) => push(`\x1b[36m[初始化] ${text}\x1b[0m`));
    setProgress(100);
    // 快任务至少保持 600ms 的完成态展示（进度条满格 → 消失），避免一闪而过
    setTimeout(() => {
      push(
        res.ok
          ? `\x1b[32m════ [初始化] ${def.label} 完成 ✓\x1b[0m`
          : `\x1b[31m════ [初始化] ${def.label} 结束 —— ${res.reason ?? "未完成"}\x1b[0m`
      );
      current = null;
      emit();
    }, 600);
    return { ok: true };
  }

  // bat 任务：临时 bat 写入 _local\launcher-init\
  const bat = def.buildBat ? def.buildBat(root) : null;
  if (!bat) return fail("缺少初始化前置条件（如 MSVC 构建工具），请先安装");

  const initDir = path.join(launcherTempDir(), "launcher-init");
  try {
    fs.mkdirSync(initDir, { recursive: true });
  } catch {
    /* 目录创建失败时沿用 cwd 临时目录 */
  }
  const batFile = path.join(initDir, `init-${key}-${Date.now()}.bat`);
  fs.writeFileSync(batFile, bat, "utf8");

  // 注意：不能用 /s 并手动包引号（cmd 会把带引号字符串当命令名）。
  // cmd /d /c call <path> 对含空格路径的引号处理最稳。
  const proc = spawn("cmd.exe", ["/d", "/c", "call", batFile], {
    cwd: root,
    windowsHide: true
  });
  current = { key, proc, progress: 5 };
  emit();

  let dataEvents = 0;
  const onData = (d: Buffer) => {
    push(String(d));
    dataEvents += 1;
    if (current && current.key === key) {
      setProgress(Math.min(90, 5 + dataEvents * 2));
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", (err) => {
    push(`\x1b[31m[初始化] 启动失败：${err.message}\x1b[0m`);
    current = null;
    emit();
  });
  proc.on("close", (code) => {
    const failed = code !== 0;
    push(
      failed
        ? `\x1b[31m════ [初始化] ${def.label} 结束（exit ${code}）—— 未完成，请查看上方日志\x1b[0m`
        : `\x1b[32m════ [初始化] ${def.label} 完成 ✓\x1b[0m`
    );
    try {
      fs.unlinkSync(batFile);
    } catch {
      /* 忽略清理失败 */
    }
    current = null;
    emit();
  });
  return { ok: true };
}
