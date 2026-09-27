#!/usr/bin/env node
/**
 * 现役版（Electron）**只读**可达性分析：给 S3 查重产出「零风险删除清单」。
 *
 * 为什么不直接用 knip：knip 依赖入口声明（我们无权往只读的现役版仓库里加 knip.json），
 * 裸跑会把 `src/main/index.ts` 这种真入口也报成「未使用文件」（116 条噪音）。
 * 这里用「生产实际加载的入口 + 相对导入图」做一次确定性遍历，只报真正到不了的文件，
 * 并顺带算出「只被死文件引用的依赖」（depcheck 看不到这一层）。
 *
 * 用法：
 *   node scripts/audit-legacy-reachability.mjs --src "E:/Games/EveJS-v0.12.8/launcher/launcher"
 *   node scripts/audit-legacy-reachability.mjs --src <path> --json
 *
 * 注意：只读。脚本只读现役版，不写任何文件（报告由调用方重定向）。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function value(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const SRC = value("--src");
const AS_JSON = args.includes("--json");
if (!SRC) {
  console.error("用法：node scripts/audit-legacy-reachability.mjs --src <现役版 launcher 目录> [--json]");
  process.exit(2);
}
const ROOT = path.resolve(SRC);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".css", ".html"]);
const REPORT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html"]);

/** 生产入口：主进程、preload，以及渲染层真正加载的页面（public/ 下的 HTML）。 */
function entryPoints() {
  const entries = [
    path.join(ROOT, "src/main/index.ts"),
    path.join(ROOT, "src/preload/index.ts"),
  ];
  const publicDir = path.join(ROOT, "src/renderer/public");
  if (fs.existsSync(publicDir)) {
    for (const name of fs.readdirSync(publicDir)) {
      if (name.endsWith(".html")) entries.push(path.join(publicDir, name));
    }
  }
  return entries.filter((file) => fs.existsSync(file));
}

const SPECIFIER_PATTERNS = {
  ".ts": [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  ".tsx": [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  ".js": [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  ".mjs": [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm],
  ".css": [/@import\s+["']([^"']+)["']/g, /url\(\s*["']?([^"')]+)["']?\s*\)/g],
  ".html": [/\b(?:src|href)\s*=\s*["']([^"']+)["']/g],
};

function specifiersOf(file) {
  const ext = path.extname(file).toLowerCase();
  const patterns = SPECIFIER_PATTERNS[ext] ?? [];
  const text = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}

function resolveSpecifier(from, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // 裸包名交给依赖统计
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [base];
  const ext = path.extname(base);
  if (CODE_EXT.has(ext)) candidates.push(...[...CODE_EXT].map((e) => base + e));
  else candidates.push(...[...CODE_EXT].map((e) => base + e), ...[...CODE_EXT].map((e) => path.join(base, "index" + e)));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const entries = entryPoints();
const reachable = new Set();
const bareImports = new Map(); // 包名 → 引用它的可达文件数
const queue = [...entries];
while (queue.length > 0) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const spec of specifiersOf(file)) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved) queue.push(resolved);
    else if (!spec.startsWith(".") && !spec.startsWith("/")) {
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      bareImports.set(pkg, (bareImports.get(pkg) ?? 0) + 1);
    }
  }
}

const scopes = ["src", "scripts"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const allFiles = scopes.flatMap((d) => walk(d));
const unreachable = allFiles
  .filter((file) => REPORT_EXT.has(path.extname(file).toLowerCase()))
  .filter((file) => !reachable.has(file))
  .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
  .sort();

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const declared = [...Object.keys(pkgJson.dependencies ?? {}), ...Object.keys(pkgJson.devDependencies ?? {})];
const unusedDeps = declared.filter((name) => !bareImports.has(name)).sort();

/* 由字符串/CLI 在运行期或构建期调用，静态导入图看不到 —— 不是死代码 */
const RUNTIME_ALLOWLIST = new Set([
  "scripts/account-cli.js",      // Rust sidecar 拉起（accounts:*）
  "scripts/database-cli.js",     // Rust sidecar 拉起（database:*）
  "scripts/check-renderer.js",   // package.json 的 build:renderer 前置
  "scripts/release-notes-body.mjs", // .github workflow 直接调用
  "src/renderer/public/manual/manual.html", // 指令手册：运行期按路径打开的静态页
]);
/* 由 npm script / CI 直接调用的构建期依赖（不在导入图里） */
const BUILD_ONLY_DEPS = new Set([
  "@types/node", "concurrently", "electron-builder", "typescript", "vite", "wait-on",
]);
const deletableFiles = unreachable.filter((file) => !RUNTIME_ALLOWLIST.has(file));
const runtimeKept = unreachable.filter((file) => RUNTIME_ALLOWLIST.has(file));
const deadDeps = unusedDeps.filter((name) => !BUILD_ONLY_DEPS.has(name));
const buildKept = unusedDeps.filter((name) => BUILD_ONLY_DEPS.has(name));

if (AS_JSON) {
  console.log(JSON.stringify({ entries: entries.map((f) => path.relative(ROOT, f).replaceAll("\\", "/")), unreachable, deletableFiles, runtimeKept, unusedDeps, deadDeps, buildKept, reachableCount: reachable.size, scanned: allFiles.length }, null, 2));
} else {
  console.log("可达性分析（生产入口 → 相对导入图）");
  console.log("  入口：" + entries.map((f) => path.relative(ROOT, f).replaceAll("\\", "/")).join(", "));
  console.log(`  可达 ${reachable.size} 个文件 / 扫描 ${allFiles.length} 个文件`);
  console.log(`\n① 零风险删除候选：文件（${deletableFiles.length}）`);
  for (const file of deletableFiles) console.log("  - " + file);
  console.log(`\n② 零风险删除候选：依赖（${deadDeps.length}）`);
  for (const name of deadDeps) console.log("  - " + name);
  console.log(`\n③ 运行期/构建期引用，必须保留（${runtimeKept.length + buildKept.length}）`);
  for (const file of runtimeKept) console.log("  - 文件 " + file);
  for (const name of buildKept) console.log("  - 依赖 " + name);
  console.log("\n提示：① 是最保守的可删集合，落地前仍需人工确认（运行期字符串引用不在图里）。");
}