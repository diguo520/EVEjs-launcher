#!/usr/bin/env node
/**
 * 体积门禁（G4 的前置检查）：把 Tauri 产物与 Electron 现役版做同口径对比。
 *
 * 口径：只比「可执行文件 + 随包资源」，不含 WebView2 运行时
 * （Evergreen 由系统提供；Electron 侧对应的是随包内置的 Chromium）。
 *
 * 用法：node scripts/size-gate.mjs [--budget-mb 12]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ELECTRON_ROOT = "E:\\Games\\EveJS-v0.12.8\\launcher\\launcher";

const budgetArg = process.argv.indexOf("--budget-mb");
const BUDGET_MB = budgetArg > 0 ? Number(process.argv[budgetArg + 1]) : 12;
// S4：对外真正分发的是便携版 zip（exe + _launcher 资源）。默认只做「存在即卡预算」，
// 传 --require-zip 时缺失也算失败（package.ps1 出包后用它自检）。
const zipBudgetArg = process.argv.indexOf("--zip-budget-mb");
const ZIP_BUDGET_MB = zipBudgetArg > 0 ? Number(process.argv[zipBudgetArg + 1]) : 20;
const REQUIRE_ZIP = process.argv.includes("--require-zip");

const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", yellow: "", dim: "", reset: "" };

function sizeOf(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += sizeOf(path.join(target, entry.name));
    }
    return total;
  } catch {
    return null;
  }
}

const mb = (bytes) => (bytes == null ? null : bytes / 1024 / 1024);
const fmt = (bytes) => (bytes == null ? "缺失" : mb(bytes).toFixed(2) + " MB");

const tauriExe = path.join(ROOT, "src-tauri", "target", "release", "EvEJSLauncher.exe");
const distDir = path.join(ROOT, "ui", "dist");
const shimOnly = path.join(distDir, "api-shim.js");

/** 在 artifacts/ 下按正则找最新产物（取最大者，避免历史版本混入） */
function findArtifact(pattern) {
  try {
    const dir = path.join(ROOT, "artifacts");
    return (
      fs
        .readdirSync(dir)
        .filter((name) => pattern.test(name))
        .map((name) => ({ name, size: sizeOf(path.join(dir, name)) }))
        .filter((item) => item.size != null)
        .sort((a, b) => b.size - a.size)[0] || null
    );
  } catch {
    return null;
  }
}
const portableZip = findArtifact(/^EvEJSLauncher-Tauri-.*-portable\.zip$/);
const setupExe = findArtifact(/^EvEJSLauncher-Tauri-.*-setup\.exe$/);

const rows = [
  ["Tauri 启动器 exe（release）", sizeOf(tauriExe), BUDGET_MB * 1024 * 1024],
  ["便携版 zip（对外分发物）", portableZip ? portableZip.size : null, ZIP_BUDGET_MB * 1024 * 1024],
  ["ui/dist 静态资产", sizeOf(distDir), null],
  ["  ├ ui/web 资产（legacy 渲染层 + 3 个 JSON）", (sizeOf(distDir) ?? 0) - (sizeOf(shimOnly) ?? 0), null],
  ["  └ api-shim.js", sizeOf(shimOnly), null]
];

const electronExe = path.join(ELECTRON_ROOT, "release", "EvEJSLauncher.exe");
const electronUnpacked = path.join(ELECTRON_ROOT, "release", "win-unpacked");
const electronExeSize = sizeOf(electronExe);
const electronTotal = sizeOf(electronUnpacked);

/** 真正对外分发的 Electron 产物是 NSIS 便携版单 exe，优先用它做基线 */
function findPortableBaseline() {
  try {
    const candidates = fs
      .readdirSync(path.join(ELECTRON_ROOT, "release"))
      .filter((name) => /^EvEJS.*便携版.*\.exe$/.test(name))
      .map((name) => ({ name, size: sizeOf(path.join(ELECTRON_ROOT, "release", name)) }))
      .filter((item) => item.size != null);
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0] || null;
  } catch {
    return null;
  }
}
const portableBaseline = findPortableBaseline();

console.log("体积门禁（预算：exe ≤ " + BUDGET_MB + " MB，便携版 zip ≤ " + ZIP_BUDGET_MB + " MB）");
for (const [label, bytes] of rows) {
  console.log("  " + label.padEnd(46, " ") + fmt(bytes));
}
console.log("");
if (electronExeSize != null || electronTotal != null) {
  console.log("Electron 现役版对照：");
  if (electronExeSize != null) {
    console.log("  " + "release/EvEJSLauncher.exe".padEnd(46, " ") + fmt(electronExeSize));
  }
  if (electronTotal != null) {
    console.log("  " + "win-unpacked 目录（含 Chromium）".padEnd(46, " ") + fmt(electronTotal));
  }
  if (portableBaseline) {
    console.log(
      "  " + ("对外分发便携版 " + portableBaseline.name).padEnd(46, " ") + fmt(portableBaseline.size)
    );
  }
}
console.log("");

const failures = [];
if (!fs.existsSync(tauriExe)) {
  failures.push("未找到 release 产物：" + tauriExe + "（先跑 scripts/build.ps1）");
} else {
  const exeSize = fs.statSync(tauriExe).size;
  if (mb(exeSize) > BUDGET_MB) {
    failures.push("exe 体积 " + fmt(exeSize) + " 超出预算 " + BUDGET_MB + " MB");
  }
  if (electronExeSize != null) {
    const ratio = exeSize / electronExeSize;
    const verdict = ratio < 1 ? "小于" : "大于";
    console.log(
      "对比：Tauri exe 是 Electron portable exe 的 " +
        (ratio * 100).toFixed(1) +
        "%（" +
        verdict +
        "现役版）"
    );
  }
  if (portableBaseline?.size) {
    const ratio = exeSize / portableBaseline.size;
    console.log(
      "对比：Tauri exe 是现役对外便携版的 " +
        (ratio * 100).toFixed(1) +
        "%（缩小 " +
        (portableBaseline.size / exeSize).toFixed(1) +
        " 倍）"
    );
  }
}

if (portableZip) {
  if (mb(portableZip.size) > ZIP_BUDGET_MB) {
    failures.push(
      "便携版 zip " + portableZip.name + " 体积 " + fmt(portableZip.size) + " 超出预算 " + ZIP_BUDGET_MB + " MB"
    );
  }
} else if (REQUIRE_ZIP) {
  failures.push("未找到便携版 zip（先跑 pwsh -File scripts/package.ps1）");
} else {
  console.log(COLOR.dim + "提示：artifacts/ 下暂无便携版 zip，跳过 zip 预算断言（打包后加 --require-zip 复检）" + COLOR.reset);
}
if (setupExe) {
  console.log("对照：NSIS 安装包 " + setupExe.name.padEnd(46, " ") + fmt(setupExe.size));
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(COLOR.red + "  \u2717 " + failure + COLOR.reset);
  process.exit(1);
}
console.log(COLOR.green + "体积门禁通过" + COLOR.reset);
