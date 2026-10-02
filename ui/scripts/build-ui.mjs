#!/usr/bin/env node
/**
 * legacy 渲染层「构建」：其实只是把 ui/web 的静态资产同步到 ui/dist（frontendDist）。
 *
 * 为什么不用打包器：S1 阶段复用现役版 eve-launcher.html + launcher-bridge.js，
 * 它们本来就是原样加载的静态资源；唯一需要「生成」的是 window.api shim，
 * 而那份 shim 由 scripts/gen-contract.mjs 直接产出纯 JS（零依赖）。
 * 等到 S6 接 shadcn/React 时再引入 Vite，那时 dist 才需要真正的打包步骤。
 *
 * 用法：node ui/scripts/build-ui.mjs [--check]
 *   --check  只比对不写入，用于 CI/G0 门禁（有差异则退出码 1）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WEB_DIR = path.join(ROOT, "ui", "web");
const DIST_DIR = path.join(ROOT, "ui", "dist");
/** 生成的 shim 随源码进仓（ui/src），由本脚本拷进 ui/dist */
const SHIM_SRC = path.join(ROOT, "ui", "src", "api-shim.js");
const SHIM = "api-shim.js";
const MANIFEST = ".build-manifest.json";
const CHECK_ONLY = process.argv.includes("--check");

/** gen-contract.mjs 的产物，不允许被本脚本删除 */
const KEEP = new Set([SHIM, MANIFEST]);

/**
 * 只供构建期使用、**不进包**的资产。
 *
 * `manual/manual.html` 是「EVE.js 全指令手册」的单文件快照，`ui/scripts/build-manual-data.mjs`
 * 从它抽出 `ui/src/data/` 下的结构化数据。现役版是用 iframe 内嵌这一页
 * （`src/renderer/components/ManualPanel.tsx`），移植后 legacy 与 React 两层渲染层都自己画手册，
 * 运行期没有任何地方会去取这个文件 —— 随包只会白占 5.4 MB（还要被嵌进 exe）。
 */
const BUILD_ONLY_PREFIXES = ["manual/"];
const isBuildOnly = (relative) =>
  BUILD_ONLY_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(prefix));

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

if (!fs.existsSync(WEB_DIR)) {
  console.error("找不到 legacy 资产目录：" + WEB_DIR);
  process.exit(1);
}
if (!fs.existsSync(SHIM_SRC)) {
  console.error("缺少 " + SHIM_SRC + "，请先运行：node scripts/gen-contract.mjs");
  process.exit(1);
}

const sources = [...walk(WEB_DIR).filter((relative) => !isBuildOnly(relative)), SHIM];
const previous = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIST_DIR, MANIFEST), "utf8"));
  } catch {
    return { files: [] };
  }
})();

const copied = [];
const updated = [];
let bytes = 0;

for (const relative of sources) {
  const from = relative === SHIM ? SHIM_SRC : path.join(WEB_DIR, relative);
  const to = path.join(DIST_DIR, relative);
  const source = fs.statSync(from);
  let needsCopy = true;
  if (fs.existsSync(to)) {
    const current = fs.statSync(to);
    needsCopy = current.size !== source.size;
  }
  if (needsCopy) {
    if (!CHECK_ONLY) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    updated.push(relative);
  }
  copied.push(relative);
  bytes += source.size;
}

/* 清理上一轮存在、这一轮已删除的资产（例如手册改名） */
const stale = (previous.files || []).filter(
  (relative) => !copied.includes(relative) && !KEEP.has(relative)
);
if (!CHECK_ONLY) {
  for (const relative of stale) {
    try {
      fs.unlinkSync(path.join(DIST_DIR, relative));
    } catch {
      /* 忽略清理失败 */
    }
  }
  fs.writeFileSync(
    path.join(DIST_DIR, MANIFEST),
    JSON.stringify({ generatedAt: new Date().toISOString(), files: copied }, null, 2),
    "utf8"
  );
}

const mb = (bytes / 1024 / 1024).toFixed(2);
if (CHECK_ONLY && updated.length > 0) {
  console.error("ui/dist 与 ui/web 不同步：" + updated.join(", "));
  process.exit(1);
}
console.log(
  (CHECK_ONLY ? "[check] " : "") +
    "ui/dist 同步完成：" +
    copied.length +
    " 个资产 / " +
    mb +
    " MB" +
    (updated.length ? "（本次更新 " + updated.length + " 个）" : "（全部最新）") +
    (stale.length ? "，清理 " + stale.length + " 个陈旧文件" : "")
);
