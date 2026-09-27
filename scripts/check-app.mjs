#!/usr/bin/env node
/**
 * S6 应用（ui/ 下的 Vite + React）门禁：类型检查 + 生产打包。
 *
 * 为什么不塞进 `npm run check`：那条链刻意零依赖（CI 注释：package.json 没有运行时依赖，所以不需要 npm ci）。
 * 本脚本需要 ui/node_modules，因此单独一条，供 build.ps1 第 13 步与 CI 使用。
 *
 * 用法：node scripts/check-app.mjs [--build-only]
 *   退出码：0 通过 / 1 失败 / 2 环境未就绪（未安装依赖）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(ROOT, "ui");
const BUILD_ONLY = process.argv.includes("--build-only");

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

if (!fs.existsSync(path.join(APP_DIR, "node_modules"))) {
  console.error(RED + "S6 应用依赖未安装" + RESET + "：先跑 npm run ui:app:install（或 npm --prefix ui install）");
  process.exit(2);
}

/** 优先用 npm 自己给的 npm-cli.js 入口（node 直接跑，不需要 shell）。
 *  Windows 下 npm 是 .cmd，Node 20 起因 CVE-2024-27980 不能直接 spawn；
 *  退路才用 shell: true（会有 DEP0190 警告，仅在拿不到 npm_execpath 时出现）。 */
function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    return spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, stdio: "inherit" });
  }
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
}

// 为什么用 vitest 的 exit code 而不是覆盖率阈值：覆盖率工具（@vitest/coverage-v8）要再装一层，
// 而这层的价值集中在「锁住纯函数的历史缺陷」，先按「全绿」把关；覆盖率登记为债务（见 S5 记录 §7）。
const scripts = BUILD_ONLY ? ["build"] : ["test", "typecheck", "build"];
for (const script of scripts) {
  const started = Date.now();
  const result = runNpm(["--prefix", "ui", "run", script]);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(RED + "S6 应用 " + script + " 无法启动" + RESET + "：" + result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(RED + "S6 应用 " + script + " 失败" + RESET + DIM + "（" + seconds + " s，退出码 " + result.status + "）" + RESET);
    process.exit(1);
  }
  console.log(GREEN + "S6 应用 " + script + " 通过" + RESET + DIM + "（" + seconds + " s）" + RESET);
}

/* ------------------------- 双入口：发布到 ui/dist/react ------------------------- */
/** 为什么是「拷进 ui/dist」而不是再改一次 frontendDist：
 *  G6 的退役条件是「连续 2 个版本无仅 HTML 侧可用的功能」，在那之前 legacy 页面必须**同时**可用。
 *  Tauri 的 frontendDist 是静态配置，两个目录只能二选一 —— 所以让 React 产物以子目录形式
 *  住进同一个 frontendDist（ui/dist/react/），由 Rust 侧按 `--ui=react|legacy` 选择加载哪一页。
 *  代价是 dist 里多一份 React 产物（约 640 KB），换来的是「切换＝改一个启动参数」，
 *  回退 legacy 不需要重新构建。 */
const published = path.join(APP_DIR, "dist", "react");
const source = path.join(APP_DIR, "app-dist");
if (fs.existsSync(source)) {
  fs.rmSync(published, { recursive: true, force: true });
  fs.cpSync(source, published, { recursive: true });
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(source);
const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(
  DIM +
    "产物 ui/app-dist：" + files.length + " 个文件 / " + (bytes / 1024).toFixed(1) + " KB" +
    "（已发布到 ui/dist/react/，用 --ui=react 启动即进新渲染层）" +
    RESET,
);
