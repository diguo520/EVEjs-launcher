#!/usr/bin/env node
/**
 * Electron 侧 parity 驱动（S5 / L2 的第二半）。
 *
 * 现役工程是只读的，所以这里**不改它一个字节**：
 *   1. 把它的 dist/ 复制到 .parity-out/electron-harness/，node_modules 用目录联接（junction，不占磁盘）；
 *   2. 放入我们的入口包装 parity-main.js → 劫持 ipcMain 录下处理函数，再 require 现役的 registerIpc()；
 *   3. 用假 event 逐个调用只读通道（白名单取自 Tauri 侧冻结基线，保证两边同一份集合）；
 *   4. 把回包原文写成 .parity-out/electron.json，结构与 driver-tauri.mjs 的产物一致。
 *
 * 用法：
 *   node tests/parity/driver-electron.mjs
 *   node tests/parity/driver-electron.mjs --src "E:/Games/EveJS-v0.12.8/launcher/launcher" --out .parity-out/electron.json
 *   node tests/parity/driver-electron.mjs --repo-root "E:/Games/EveJS-v0.12.8"   # 给两边同一个仓库根目录
 */
import { spawn } from "node:child_process";
import {
  ensureRepoFixture,
  ensureUserDataFixture,
  DEFAULT_FIXTURE,
  DEFAULT_USER_DATA_FIXTURE,
} from "./make-repo-fixture.mjs";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SRC = value("--src", "E:/Games/EveJS-v0.12.8/launcher/launcher");
const OUT = path.resolve(ROOT, value("--out", path.join(".parity-out", "electron.json")));
const REPO_ROOT = value("--repo-root", "") === "" ? ensureRepoFixture({ out: DEFAULT_FIXTURE }).out : path.resolve(value("--repo-root", ""));
const TIMEOUT_MS = Number(value("--timeout", "120")) * 1000;
const SETTLE_MS = value("--settle-ms", "2500");
const HARNESS = path.join(ROOT, ".parity-out", "electron-harness");
const USER_DATA_DIR = DEFAULT_USER_DATA_FIXTURE;
const BASELINE_SET = path.join(ROOT, "tests", "parity", "fixtures", "channels", "tauri-baseline.json");
const CONTRACT = path.join(ROOT, "contract", "ipc-channels.json");

const electronExe = path.join(SRC, "node_modules", "electron", "dist", "electron.exe");
if (!fs.existsSync(electronExe)) {
  console.error(`找不到现役版的 electron：${electronExe}`);
  process.exit(2);
}

/* ---------- 1) 通道清单：白名单来自 Tauri 侧冻结基线，api 名来自契约 ---------- */
const baseline = JSON.parse(fs.readFileSync(BASELINE_SET, "utf8"));
const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
const byName = new Map();
for (const item of contract.invoke ?? []) byName.set(item.channel, { ...item, kind: "invoke" });
for (const item of contract.send ?? []) byName.set(item.channel, { ...item, kind: "send" });
const plan = Object.keys(baseline.channels ?? {}).sort().map((channel) => {
  const entry = byName.get(channel);
  return { channel, api: entry?.api ?? null, kind: entry?.kind ?? "unknown", args: entry?.args ?? [] };
});
const missing = plan.filter((item) => !item.api);
if (missing.length > 0) {
  console.error(`契约里找不到这些通道的 api 名：${missing.map((item) => item.channel).join(", ")}`);
  process.exit(2);
}

/* ---------- 2) 准备 harness 目录（复制现役产物 + 目录联接 node_modules） ---------- */
function latestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    newest = Math.max(newest, entry.isDirectory() ? latestMtime(full) : stat.mtimeMs);
  }
  return newest;
}
fs.mkdirSync(HARNESS, { recursive: true });
ensureUserDataFixture({ out: USER_DATA_DIR });
const harnessDist = path.join(HARNESS, "dist");
const srcDist = path.join(SRC, "dist");
const needCopy = !fs.existsSync(harnessDist) || latestMtime(harnessDist) < latestMtime(srcDist);
if (needCopy) {
  fs.rmSync(harnessDist, { recursive: true, force: true });
  fs.cpSync(srcDist, harnessDist, { recursive: true });
}
const harnessModules = path.join(HARNESS, "node_modules");
if (!fs.existsSync(harnessModules)) {
  fs.symlinkSync(path.join(SRC, "node_modules"), harnessModules, "junction");
}
// 现役版的 accountManager/databaseManager 在 dev 态把 CLI 解析成 <appPath>/scripts/*.cli.js
// （见现役 src/main/accountManager.ts::cliPath），所以 harness 必须把 scripts/ 一起镜像，
// 否则 accounts:*/database:* 会退化成「CLI 不存在」，比对就测不出实现差异。
const harnessScripts = path.join(HARNESS, "scripts");
const srcScripts = path.join(SRC, "scripts");
if (!fs.existsSync(harnessScripts) || latestMtime(harnessScripts) < latestMtime(srcScripts)) {
  fs.rmSync(harnessScripts, { recursive: true, force: true });
  fs.cpSync(srcScripts, harnessScripts, { recursive: true });
}
for (const file of ["parity-capture.js", "parity-main.js"]) {
  fs.copyFileSync(path.join(ROOT, "tests", "parity", "electron-harness", file), path.join(HARNESS, file));
}
fs.writeFileSync(
  path.join(HARNESS, "package.json"),
  JSON.stringify({ name: "evejs-parity-harness", version: "0.0.0", private: true, main: "parity-main.js" }, null, 2) + "\n",
  "utf8"
);
const configFile = path.join(HARNESS, "launcher.config.json");
if (REPO_ROOT) fs.writeFileSync(configFile, JSON.stringify({ repoRoot: REPO_ROOT }, null, 2) + "\n", "utf8");
else if (fs.existsSync(configFile)) fs.rmSync(configFile);
const channelsFile = path.join(HARNESS, "channels.json");
fs.writeFileSync(channelsFile, JSON.stringify(plan, null, 2) + "\n", "utf8");

/* ---------- 3) 起 Electron，等 dump ---------- */
const rawFile = path.join(ROOT, ".parity-out", `electron-raw.json`);
if (fs.existsSync(rawFile)) fs.rmSync(rawFile);

console.log(`现役工程：${SRC}`);
console.log(`harness：${path.relative(ROOT, HARNESS)}${needCopy ? "（已重新复制 dist）" : "（复用已有 dist）"}`);
console.log(`通道：${plan.length}${REPO_ROOT ? `；仓库根目录：${REPO_ROOT}` : ""}`);

const child = spawn(electronExe, [HARNESS], {
  cwd: HARNESS,
  env: {
    ...process.env,
    EVEJS_SELF_TEST_OUT: rawFile,
    EVEJS_PARITY_CHANNELS: channelsFile,
    EVEJS_PARITY_SETTLE_MS: String(SETTLE_MS),
    // 两边共用同一份运行时数据目录（该环境变量的语义在 Rust 侧是逐行照搬的），
    // 否则 settings:get / mods:githubTokenStatus 这类通道比的只是「各自的默认值」。
    EVEJS_USER_DATA_DIR: USER_DATA_DIR,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let log = "";
child.stdout.on("data", (chunk) => (log += chunk.toString()));
child.stderr.on("data", (chunk) => (log += chunk.toString()));

const deadline = Date.now() + TIMEOUT_MS;
let summary = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (fs.existsSync(rawFile)) {
    try {
      summary = JSON.parse(fs.readFileSync(rawFile, "utf8"));
      break;
    } catch {
      summary = null;
    }
  }
  if (child.exitCode !== null && !summary) break;
}
try {
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
} catch {
  /* 已经退出 */
}

if (!summary?.dump) {
  console.error(`未在 ${TIMEOUT_MS / 1000}s 内拿到 Electron 侧 dump`);
  if (log.trim()) console.error(log.trim().split("\n").slice(-10).join("\n"));
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({ channels: summary.dump, meta: { ok: summary.ok, total: summary.total, fails: summary.fails ?? [], electron: summary.meta?.electron } }, null, 2) + "\n",
  "utf8"
);
console.log(`parity dump 已写入 ${path.relative(ROOT, OUT)}`);
console.log(`  通道 ${Object.keys(summary.dump).length} 个；回包 ok ${summary.ok}/${summary.total}`);
if (summary.fails?.length) console.log(`  失败：${summary.fails.join(", ")}`);