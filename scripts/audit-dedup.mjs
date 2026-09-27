#!/usr/bin/env node
/**
 * S3 查重门禁（计划 §5.1 / 门禁 G3 的静态部分）。
 *
 * 为什么不用 cargo-machete / cargo-geiger / jscpd 当默认门禁：
 *   它们要么需要联网装一套额外工具链，要么只把结果打在 stdout 里、没法稳定断言。
 *   这里只保留**确定性、零依赖**的检查，覆盖 G3 的三条硬指标：
 *     ① 无未使用依赖（Cargo.toml ↔ 源码引用）
 *     ② 无循环依赖（scripts / ui 的 ESM 导入图；Rust 的 mod 树由编译器保证无环）
 *     ③ 重复块：单一来源断言（同名常量只声明一次、端口与 Win32 标志只在归属文件出现）
 *   完整重复块百分比用 `npm run dup`（npx jscpd，需联网，见 package.json）。
 *
 * 用法：node scripts/audit-dedup.mjs [--verbose]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", yellow: "", dim: "", reset: "" };

const failures = [];
const warnings = [];
const notes = [];
const check = (label, ok, detail) => {
  if (ok) notes.push("  " + COLOR.green + "\u2713" + COLOR.reset + " " + label);
  else failures.push(label + (detail ? " —— " + detail : ""));
};
const warn = (label, detail) =>
  warnings.push("  " + COLOR.yellow + "!" + COLOR.reset + " " + label + (detail ? " —— " + detail : ""));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");
const RUST_FILES = walk(path.join(ROOT, "src-tauri/src")).filter((f) => f.endsWith(".rs"));
const SRC = new Map(RUST_FILES.map((file) => [rel(file), read(rel(file))]));

/* ---------- 1) 单一来源：文件级 const 只声明一次 ---------- */

/** 文件级常量声明（缩进 0）：排除 test 模块里的局部常量 */
const DECL = /^(?:pub(?:\(crate\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*([^;=]+)=\s*(.+?);\s*$/;
const declarations = new Map();
for (const [file, text] of SRC) {
  for (const line of text.split("\n")) {
    const match = DECL.exec(line);
    if (!match) continue;
    const [, name, type, value] = match;
    if (!declarations.has(name)) declarations.set(name, []);
    declarations.get(name).push({ file, type: type.trim(), value: value.trim() });
  }
}

const duplicatedNames = [...declarations.entries()].filter(([, sites]) => sites.length > 1);
check(
  "单一来源：文件级 const 名称无重复声明",
  duplicatedNames.length === 0,
  duplicatedNames.map(([name, sites]) => `${name}（${sites.map((s) => s.file).join(", ")}）`).join("；")
);

const WIN32_OWNER = "src-tauri/src/win32.rs";
for (const name of ["CREATE_NO_WINDOW", "DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP"]) {
  const sites = declarations.get(name) ?? [];
  check(
    `单一来源：${name} 只在 win32.rs 声明`,
    sites.length === 1 && sites[0].file === WIN32_OWNER,
    sites.map((s) => s.file).join(", ") || "未找到声明"
  );
}

/* 同一字面量被多个不同名字的常量声明（提示，人工确认） */
const byValue = new Map();
for (const [name, sites] of declarations) {
  for (const site of sites) {
    const key = site.type + " = " + site.value;
    if (!byValue.has(key)) byValue.set(key, new Set());
    byValue.get(key).add(name);
  }
}
const valueClashes = [...byValue.entries()].filter(([, names]) => names.size > 1);
if (valueClashes.length > 0) {
  warn(
    "同一字面量被多个常量声明（确认是否可合并）",
    valueClashes.map(([key, names]) => `${[...names].join(" / ")} = ${key}`).join("；")
  );
}

/* ---------- 2) 单一来源：端口默认值 ---------- */

const CONFIG_RS = "src-tauri/src/config.rs";
const PORTS = [
  ["DEFAULT_GAME_PORT", "26000"],
  ["DEFAULT_IMAGES_PORT", "26001"],
  ["DEFAULT_GATEWAY_PORT", "26002"],
  ["DEFAULT_MARKET_PORT", "40110"],
];
for (const [name, value] of PORTS) {
  check(
    `单一来源：config.rs 声明 ${name} = ${value}`,
    new RegExp(`${name}: u16 = ${value}`).test(SRC.get(CONFIG_RS) ?? "")
  );
}
const PORT_CALL_SITES = [
  ["src-tauri/src/health.rs", "tcp_alive(DEFAULT_GAME_PORT)", "tcp_alive(26000)"],
  ["src-tauri/src/health.rs", "tcp_alive(DEFAULT_MARKET_PORT)", "tcp_alive(40110)"],
  ["src-tauri/src/ipc/mod.rs", "config::DEFAULT_GAME_PORT", "else { 26000 }"],
  ["src-tauri/src/metrics.rs", "crate::config::DEFAULT_GAME_PORT", "else { 26000 }"],
];
for (const [file, expected, forbidden] of PORT_CALL_SITES) {
  const text = SRC.get(file) ?? "";
  const usesConst = text.replaceAll(/\s+/g, " ").includes(expected);
  const usesLiteral = text.replaceAll(/\s+/g, " ").includes(forbidden);
  check(`单一来源：${file} 使用 ${expected}（不写字面量）`, usesConst && !usesLiteral);
}
/* 端口字面量的全局清点（仅提示：测试夹具里出现是正常的） */
const literalPortHits = [];
for (const [file, text] of SRC) {
  if (file === CONFIG_RS) continue;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return;
    if (/\b(26000|26001|26002|40110)\b/.test(line)) literalPortHits.push(`${file}:${index + 1}`);
  });
}
if (literalPortHits.length > 0) {
  warn(`config.rs 之外仍有 ${literalPortHits.length} 处端口字面量（多为测试夹具/文档注释，需人工确认）`, literalPortHits.slice(0, 8).join(", "));
}

/* ---------- 3) 未使用依赖（Cargo.toml ↔ 源码） ---------- */

const cargoToml = read("src-tauri/Cargo.toml");
const sections = new Map();
let currentSection = null;
for (const line of cargoToml.split("\n")) {
  const head = /^\[(.+)\]\s*$/.exec(line.trim());
  if (head) {
    currentSection = head[1];
    sections.set(currentSection, []);
    continue;
  }
  if (!currentSection || !line.trim() || line.trim().startsWith("#")) continue;
  const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
  if (key) sections.get(currentSection).push(key[1]);
}
const depKeys = [...(sections.get("dependencies") ?? []), ...(sections.get("build-dependencies") ?? [])];
const duplicateDepKeys = [...sections.entries()]
  .map(([section, keys]) => [section, keys.filter((key, index) => keys.indexOf(key) !== index)])
  .filter(([, keys]) => keys.length > 0);
check(
  "Cargo.toml 内无重复依赖声明",
  duplicateDepKeys.length === 0,
  duplicateDepKeys.map(([section, keys]) => `[${section}] ${keys.join(", ")}`).join("；")
);

const buildRs = path.join(ROOT, "src-tauri/build.rs");
const codeText = [...SRC.values(), fs.existsSync(buildRs) ? fs.readFileSync(buildRs, "utf8") : ""].join("\n");
const unusedDeps = depKeys.filter((name) => {
  const ident = name.replaceAll("-", "_");
  return !new RegExp(`\\b${ident}\\b`).test(codeText);
});
check(
  "无未使用依赖（声明了却在 src/build.rs 里找不到引用）",
  unusedDeps.length === 0,
  unusedDeps.join(", ")
);

/* ---------- 4) unsafe 面（等价 cargo-geiger 的粗粒度断言） ---------- */

/** 允许出现 unsafe 的文件：都是手写 Win32/DPAPI FFI，且每个块都有 SAFETY 说明 */
const UNSAFE_ALLOWED = new Set([
  "src-tauri/src/secrets.rs",
  "src-tauri/src/shell.rs",
  "src-tauri/src/dialog.rs",
  "src-tauri/src/webview2.rs", // WebView2 运行时预检（RegGetValueW / MessageBoxW）
  "src-tauri/src/oscrypt.rs", // Chromium OSCrypt：BCrypt CNG + DPAPI（加解密与密钥解包）
  "src-tauri/src/win32.rs" // 系统内存探针（GlobalMemoryStatusEx）
]);
const unsafeSites = [];
for (const [file, text] of SRC) {
  text.split("\n").forEach((line, index) => {
    if (!/\bunsafe\s*(\{|fn\b)/.test(line)) return;
    if (line.trim().startsWith("//")) return;
    unsafeSites.push({ file, line: index + 1 });
  });
}
const unsafeOffenders = unsafeSites.filter((site) => !UNSAFE_ALLOWED.has(site.file));
check(
  "unsafe 只出现在 FFI 白名单文件（secrets/shell/dialog/webview2/win32/oscrypt）",
  unsafeOffenders.length === 0,
  unsafeOffenders.map((site) => `${site.file}:${site.line}`).join(", ")
);
const unsafeFiles = [...new Set(unsafeSites.map((site) => site.file))].sort();
notes.push(
  "  " + COLOR.dim + `unsafe 块 ${unsafeSites.length} 个，集中在 ${unsafeFiles.length} 个文件：${unsafeFiles.map((f) => f.split("/").pop()).join(", ")}` + COLOR.reset
);

/* ---------- 5) 循环依赖（ESM 导入图） ---------- */

const JS_FILES = [...walk(path.join(ROOT, "scripts")), ...walk(path.join(ROOT, "ui/src"))].filter((file) =>
  /\.(mjs|js|ts)$/.test(file)
);
const graph = new Map();
for (const file of JS_FILES) {
  const text = fs.readFileSync(file, "utf8");
  const deps = new Set();
  for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      for (const candidate of [base, base + ".mjs", base + ".js", base + ".ts", path.join(base, "index.mjs"), path.join(base, "index.js")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          deps.add(candidate);
          break;
        }
      }
    }
  }
  graph.set(file, [...deps]);
}
const cycles = [];
const state = new Map();
function visit(node, trail) {
  const color = state.get(node) ?? 0;
  if (color === 1) {
    const start = trail.indexOf(node);
    cycles.push(trail.slice(start).concat(node).map(rel));
    return;
  }
  if (color === 2) return;
  state.set(node, 1);
  for (const next of graph.get(node) ?? []) visit(next, trail.concat(node));
  state.set(node, 2);
}
for (const node of graph.keys()) visit(node, []);
check("JS/ESM 导入图无循环依赖", cycles.length === 0, cycles.slice(0, 3).map((cycle) => cycle.join(" → ")).join("；"));

/* ---------- 6) Cargo.lock 传递依赖重复版本（提示） ---------- */

let lockDuplicates = [];
try {
  const lock = read("src-tauri/Cargo.lock");
  const versions = new Map();
  let name = null;
  for (const line of lock.split("\n")) {
    const nameMatch = /^name = "(.+)"$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }
    const versionMatch = /^version = "(.+)"$/.exec(line);
    if (nameMatch || !versionMatch || !name) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(versionMatch[1]);
    name = null;
  }
  lockDuplicates = [...versions.entries()].filter(([, set]) => set.size > 1).map(([key, set]) => `${key}(${[...set].join("|")})`);
} catch {
  /* 没有 Cargo.lock 时跳过 */
}
if (lockDuplicates.length > 0) {
  warn(
    `Cargo.lock 里有 ${lockDuplicates.length} 个 crate 存在多版本（传递依赖，属正常但值得归档）`,
    lockDuplicates.slice(0, 6).join(", ")
  );
}

/* ---------- 输出 ---------- */

for (const line of notes) console.log(line);
for (const line of warnings) console.log(line);
if (failures.length > 0) {
  console.error(COLOR.red + "\n查重门禁未通过：" + COLOR.reset);
  for (const failure of failures) console.error("  \u2717 " + failure);
  process.exit(1);
}
console.log(COLOR.dim + `\n查重门禁通过（${notes.length} 项通过，${warnings.length} 项提示）` + COLOR.reset);