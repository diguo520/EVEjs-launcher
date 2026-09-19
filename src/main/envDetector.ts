import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app } from "electron";
import { readClientConfig, type ClientConfig } from "./configStore";

/**
 * 解析仓库根目录：
 * 1) PORTABLE_EXECUTABLE_DIR（electron-builder 便携版专用：exe 实际放置目录；
 *    portable 运行时 cwd 与 app.getPath("exe") 都指向 %TEMP% 解压目录，必须用它定位真实位置）
 * 2) launcher.config.json（放在便携版 exe 旁 / 当前目录，可覆盖 repoRoot）
 * 3) 从 cwd 向上逐级寻找包含 server/autostart.js 的目录
 * 4) 兜底：便携版目录 > exe 所在目录（排除 %TEMP% 解压目录）> cwd，
 *    绝不允许在探测失败时把日志/设置写到任意当前目录（曾导致日志落在 AppData 下）
 */
export function resolveRepoRoot(): string {
  const candidates: string[] = [];
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;

  // 1) 便携版：exe 实际目录及其上级（exe 放在服务端根目录或 启动器/ 子目录均可命中）
  if (portableDir) {
    candidates.push(portableDir);
    let up = portableDir;
    for (let i = 0; i < 3; i++) {
      up = path.dirname(up);
      candidates.push(up);
    }
  }

  // 2) launcher.config.json：便携版读 exe 旁，dev 读当前目录
  const cfgBases: string[] = [];
  if (portableDir) cfgBases.push(portableDir);
  cfgBases.push(process.cwd());
  for (const base of [...new Set(cfgBases)]) {
    try {
      const cfgPath = path.join(base, "launcher.config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (cfg && typeof cfg.repoRoot === "string" && cfg.repoRoot) candidates.push(cfg.repoRoot);
      }
    } catch {
      /* 配置损坏时忽略，继续自动探测 */
    }
  }

  // 3) cwd 及上级
  candidates.push(process.cwd());
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    cur = path.dirname(cur);
    candidates.push(cur);
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "server", "autostart.js"))) return c;
    } catch {
      /* 跳过不可读目录 */
    }
  }

  // 4) 兜底：便携版目录 > exe 所在目录（排除 %TEMP% 解压目录）> cwd
  if (portableDir) return portableDir;
  try {
    const exeDir = path.dirname(app.getPath("exe"));
    const low = exeDir.toLowerCase();
    if (exeDir && !low.includes("\\temp\\") && !low.startsWith(process.env.TEMP?.toLowerCase() || "\0")) {
      return exeDir;
    }
  } catch {
    /* 忽略，继续兜底 */
  }
  return process.cwd();
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  warn?: boolean;
  message: string;
  hint?: string;
  /** 未通过时「官网安装」按钮跳转地址（仅 http/https） */
  installUrl?: string;
}

export interface EnvReport {
  repoRoot: string;
  node: { version: string; ok: boolean };
  checks: CheckItem[];
  passCount: number;
  totalCount: number;
  /** 系统资源统计（内存 / CPU 线程），独立于门禁检查 */
  sys: SysResource;
}

export interface SysResource {
  /** 内存（GB，1 位小数，按实际值判定） */
  memRaw: number;
  /** 内存（GB，向下取整，展示用） */
  memGB: number;
  /** CPU 逻辑线程数 */
  cpuThreads: number;
  /** 绿灯：>8GB 且 >8 线程；黄灯：恰为 8GB / 8 线程（或一项恰等一项更大）；红灯：任一小于 8 */
  level: "ok" | "warn" | "fail";
  message: string;
}

/**
 * 定位 Visual Studio C++ 构建工具安装目录：
 * 1) vswhere（VS 官方探测工具）按 VC.Tools.x86.x64 组件查询
 * 2) 兜底：常见安装根目录下存在 VC\Tools\MSVC 即视为已安装
 */
export function findVsInstallPath(): string | null {
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const vswhereCandidates = [
    path.join(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    path.join(pf, "Microsoft Visual Studio", "Installer", "vswhere.exe")
  ];
  for (const vswhere of vswhereCandidates) {
    if (!fs.existsSync(vswhere)) continue;
    try {
      const out = execSync(
        `"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
        { encoding: "utf8", timeout: 10000 }
      )
        .trim()
        .split(/\r?\n/)[0];
      if (out) return out;
    } catch {
      /* 查询失败则继续兜底 */
    }
  }
  const vsRoots = [path.join(pf86, "Microsoft Visual Studio"), path.join(pf, "Microsoft Visual Studio")];
  for (const vsRoot of vsRoots) {
    if (!fs.existsSync(vsRoot)) continue;
    try {
      for (const ver of fs.readdirSync(vsRoot)) {
        const msvc = path.join(vsRoot, ver, "VC", "Tools", "MSVC");
        if (fs.existsSync(msvc) && fs.readdirSync(msvc).length > 0) return path.join(vsRoot, ver);
      }
    } catch {
      /* 跳过不可读目录 */
    }
  }
  return null;
}

export function detectEnv(): EnvReport {
  const root = resolveRepoRoot();
  const checks: CheckItem[] = [];

  // 1) Node.js 运行时（≥ 24）
  let nodeVer = "未知";
  let nodeOk = false;
  try {
    const out = execSync("node -v", { encoding: "utf8", timeout: 10000 }).trim();
    nodeVer = out.replace(/^v/, "");
    nodeOk = parseInt(nodeVer.split(".")[0], 10) >= 24;
  } catch {
    nodeOk = false;
  }
  checks.push({
    key: "node",
    label: "Node.js 运行时",
    ok: nodeOk,
    message: nodeOk ? `Node v${nodeVer}（满足 ≥24）` : `未检测到可用 Node（当前: ${nodeVer}）`,
    hint: nodeOk ? undefined : "请手动安装 Node.js 24+（LTS 版本即可）",
    installUrl: nodeOk ? undefined : "https://nodejs.org"
  });

  // 1.5) Rust / Cargo 工具链（市场服务 cargo build 依赖）
  let rustcVer = "";
  let cargoVer = "";
  try {
    rustcVer = execSync("rustc --version", { encoding: "utf8", timeout: 10000 })
      .trim()
      .replace(/^rustc\s+/, "");
  } catch {
    /* 未安装 */
  }
  try {
    cargoVer = execSync("cargo --version", { encoding: "utf8", timeout: 10000 })
      .trim()
      .replace(/^cargo\s+/, "");
  } catch {
    /* 未安装 */
  }
  const rustOk = !!rustcVer && !!cargoVer;
  const rustPartial = !!rustcVer !== !!cargoVer;
  checks.push({
    key: "rust",
    label: "Rust / Cargo 工具链",
    ok: rustOk,
    warn: rustPartial,
    message: rustOk
      ? `rustc ${rustcVer} · cargo ${cargoVer}`
      : rustPartial
        ? `工具链不完整（仅检测到 ${rustcVer ? "rustc" : "cargo"}）`
        : "未检测到 Rust 工具链（rustc / cargo）",
    hint: rustOk ? undefined : "请手动安装 Rust（官方 rustup 方式）",
    installUrl: rustOk ? undefined : "https://www.rust-lang.org/tools/install"
  });

  // 1.6) VS C++ 构建工具（市场服务 MSVC 编译环境）
  const vsPath = findVsInstallPath();
  checks.push({
    key: "vsBuildTools",
    label: "VS C++ 构建工具",
    ok: !!vsPath,
    message: vsPath
      ? `已安装：${vsPath}`
      : "未检测到 VS Build Tools（vswhere 未找到 / VC\\Tools\\MSVC 缺失）",
    hint: vsPath ? undefined : "安装时勾选「使用 C++ 的桌面开发」工作负载",
    installUrl: vsPath ? undefined : "https://visualstudio.microsoft.com/zh-hans/downloads/#build-tools-for-visual-studio-2022"
  });

  // 2) 主服务器依赖
  const expressPkg = path.join(root, "server", "node_modules", "express", "package.json");
  const depsOk = fs.existsSync(expressPkg);
  checks.push({
    key: "serverDeps",
    label: "主服务器依赖",
    ok: depsOk,
    message: depsOk ? "server/node_modules 已就绪" : "缺少 server/node_modules（express 未安装）",
    hint: depsOk ? undefined : "在 server 目录执行 npm ci 安装依赖"
  });

  // 3) 本地数据库
  const manifest = path.join(root, "_local", "gameStore", "manifest.json");
  const sqlite = path.join(root, "_local", "gameStore", "gamestore.sqlite");
  const dbOk = fs.existsSync(manifest) && fs.existsSync(sqlite);
  checks.push({
    key: "localDb",
    label: "本地数据库",
    ok: dbOk,
    message: dbOk ? "_local/gameStore 已初始化" : "本地数据库缺失（manifest/sqlite 不存在）",
    hint: dbOk ? undefined : "运行 tools\\DatabaseCreator\\CreateDatabase.bat 初始化数据库"
  });

  // 4) 市场服务二进制
  const marketExe = path.join(root, "externalservices", "market-server", "target", "release", "market-server.exe");
  const mktOk = fs.existsSync(marketExe);
  checks.push({
    key: "market",
    label: "市场服务二进制",
    ok: mktOk,
    message: mktOk ? "release 二进制已构建" : "未找到 target/release/market-server.exe",
    hint: mktOk ? undefined : "按 StartMarketServer.bat 使用 VS Build Tools 构建一次（cargo build --release）"
  });

  // 5) 客户端配置（路径 / 证书）
  let client: ClientConfig | null = null;
  try {
    client = readClientConfig(root);
  } catch {
    client = null;
  }
  const clientPathOk = !!client?.clientPath && fs.existsSync(client.clientPath);
  const caOk = !!client?.caPem && fs.existsSync(client.caPem);
  checks.push({
    key: "clientPath",
    label: "客户端路径",
    ok: clientPathOk,
    warn: !clientPathOk,
    message: client?.clientPath
      ? clientPathOk
        ? `客户端: ${client.clientPath}`
        : `路径不存在: ${client.clientPath}`
      : "未配置 EVEJS_CLIENT_PATH",
    hint: clientPathOk ? undefined : "在 EvEJSConfig.bat / 配置面板中填写客户端安装路径"
  });
  checks.push({
    key: "caCert",
    label: "客户端证书 CA",
    ok: caOk,
    warn: !caOk,
    message: caOk ? "CA 证书就绪" : "CA 证书缺失",
    hint: caOk ? undefined : "运行 SetupEveJS.bat 或检查 EVEJS_CA_PEM 指向"
  });

  // 演示/验证模式（EVEJS_INIT_DEMO=1）：强制模拟"首次启动未初始化"界面（仅用于 UI 验证，不影响真实检测）
  if (process.env.EVEJS_INIT_DEMO === "1") {
    for (const c of checks) {
      if (c.key === "localDb" || c.key === "market" || c.key === "clientPath" || c.key === "caCert") {
        c.ok = false;
        c.warn = true;
      }
    }
  }

  const passCount = checks.filter((c) => c.ok).length;

  // 系统资源统计：内存 / CPU 线程（阈值 8 GB / 8 线程）
  const memRaw = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const cpuThreads = os.cpus().length;
  let sysLevel: SysResource["level"];
  if (memRaw < 8 || cpuThreads < 8) sysLevel = "fail";
  else if (memRaw > 8 && cpuThreads > 8) sysLevel = "ok";
  else sysLevel = "warn";
  const sys: SysResource = {
    memRaw,
    memGB: Math.floor(memRaw),
    cpuThreads,
    level: sysLevel,
    message: `内存 ${memRaw} GB · CPU ${cpuThreads} 线程（阈值 8 GB / 8 线程）`
  };

  return {
    repoRoot: root,
    node: { version: nodeVer, ok: nodeOk },
    checks,
    passCount,
    totalCount: checks.length,
    sys
  };
}
