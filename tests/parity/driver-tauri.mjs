#!/usr/bin/env node
/**
 * Tauri 侧 parity 驱动（S3 §5.2 L2 的第一半）。
 *
 * 做三件事：
 *   1. 用 `--self-test` + `EVEJS_SELF_TEST_DUMP=1` 起真机（真实 WebView）；
 *   2. 等自检把自己写的 JSON 落盘（含每个只读通道的**回包原文**）；
 *   3. 抽出 `dump` 写成 `.parity-out/tauri.json`，交给 diff.mjs 与基线比对。
 *
 * 为什么复用 --self-test 而不是另加 `--parity-dump` 开关：
 *   命令白名单的静态断言（A4）是「生产只注册 launcher_invoke，自检命令仅 --self-test 注册」，
 *   用环境变量开 dump 可以让这条断言原样成立。
 *
 * 用法：
 *   node tests/parity/driver-tauri.mjs                    # 默认 release 产物
 *   node tests/parity/driver-tauri.mjs --debug            # 用 debug 产物
 *   node tests/parity/driver-tauri.mjs --exe <路径> --out <json> --timeout 180
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRepoFixture,
  ensureUserDataFixture,
  DEFAULT_FIXTURE,
  DEFAULT_USER_DATA_FIXTURE,
} from "./make-repo-fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const profile = args.includes("--debug") ? "debug" : "release";
const EXE = value("--exe", path.join(ROOT, "src-tauri", "target", profile, "EvEJSLauncher.exe"));
const OUT = value("--out", path.join(ROOT, ".parity-out", "tauri.json"));
const TIMEOUT_MS = Number(value("--timeout", "180")) * 1000;
// 与 Electron 侧共用同一个仓库根 fixture（跨实现比对的先决条件，见 make-repo-fixture.mjs）。
// cwd 单独放一个空目录：启动器按 cwd 找 launcher.config.json，写在这里不会污染仓库根。
const CWD = path.resolve(ROOT, value("--cwd", path.join(".parity-out", "parity-run")));
// 与 Electron 侧共用运行时数据目录，保证 settings:get 之类的默认值来源一致。
// 每次跑前重置成「全新用户」：data/ 有状态（身份 / 台账 / 令牌），留着上一次的会让 golden 漂。
const USER_DATA_DIR = DEFAULT_USER_DATA_FIXTURE;
const REPO_ROOT =
  value("--repo-root", "") === ""
    ? ensureRepoFixture({ out: DEFAULT_FIXTURE }).out
    : path.resolve(value("--repo-root", ""));

if (!fs.existsSync(EXE)) {
  console.error(`找不到产物：${EXE}（先跑 pwsh -File scripts/build.ps1）`);
  process.exit(2);
}

const rawFile = path.join(os.tmpdir(), `evejs-parity-${process.pid}.json`);
if (fs.existsSync(rawFile)) fs.rmSync(rawFile);

fs.mkdirSync(CWD, { recursive: true });
ensureUserDataFixture({ out: USER_DATA_DIR });
fs.writeFileSync(path.join(CWD, "launcher.config.json"), JSON.stringify({ repoRoot: REPO_ROOT }, null, 2) + "\n", "utf8");

const child = spawn(EXE, ["--self-test"], {
  cwd: CWD,
  env: {
    ...process.env,
    EVEJS_SELF_TEST_OUT: rawFile,
    EVEJS_SELF_TEST_DUMP: "1",
    EVEJS_USER_DATA_DIR: USER_DATA_DIR,
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const deadline = Date.now() + TIMEOUT_MS;
let summary = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (fs.existsSync(rawFile)) {
    try {
      summary = JSON.parse(fs.readFileSync(rawFile, "utf8"));
      break;
    } catch {
      summary = null; // 还在写，下一轮再读
    }
  }
  if (child.exitCode !== null && !summary) break;
}
try {
  child.kill();
} catch {
  /* 进程可能已经自退 */
}

if (!summary) {
  console.error(`未在 ${TIMEOUT_MS / 1000}s 内拿到自检结果（${rawFile}）`);
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-5).join("\n"));
  process.exit(1);
}
if (!summary.dump) {
  console.error("自检结果里没有 dump 字段：确认 EVEJS_SELF_TEST_DUMP=1 且产物是含 dump 模式的新构建");
  process.exit(1);
}

const channels = Object.keys(summary.dump).sort();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ channels: summary.dump, meta: { ok: summary.ok, total: summary.total, fails: summary.fails ?? [] } }, null, 2) + "\n", "utf8");

console.log(`仓库根 fixture：${REPO_ROOT}`);
console.log(`parity dump 已写入 ${path.relative(ROOT, OUT)}`);
console.log(`  通道 ${channels.length} 个；回包 ok ${summary.ok}/${summary.total}${(summary.fails ?? []).length ? "；失败：" + summary.fails.join(", ") : ""}`);
if (summary.fails?.length) process.exit(1);