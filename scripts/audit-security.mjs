#!/usr/bin/env node
/**
 * S3 安全审计门禁（静态部分）：把评审文档 A/B 清单里**能静态判定**的项做成 CI 断言。
 *
 * 覆盖：
 *   A1 更新器只验完整性   —— 打包版不得回落到 launcher.config.json 指定的 manifest；本地 file:// 必须显式开关
 *   A4 渲染隔离           —— 严格 CSP（script-src 无 unsafe-inline/unsafe-eval、无远程源）、withGlobalTauri:false、
 *                            capabilities 最小白名单、Tauri command 注册集合 == 白名单且无孤儿命令
 *   B5 sidecar 不得裸名   —— node 必须绝对路径；密码不得出现在命令行参数里
 *   B6 characterId 校验   —— 拼路径前必须过白名单正则
 *   B7 本机绝对路径       —— 源码/产物不得出现开发机用户目录前缀（Windows 盘符 + Users 目录）
 *
 * 用法：
 *   node scripts/audit-security.mjs
 *   node scripts/audit-security.mjs --require-update-key   # 发布前：内置更新公钥必须已配置
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REQUIRE_UPDATE_KEY = process.argv.includes("--require-update-key");
const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", yellow: "", dim: "", reset: "" };

const failures = [];
const warnings = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) notes.push("  " + COLOR.green + "\u2713" + COLOR.reset + " " + label);
  else failures.push(label + (detail ? " —— " + detail : ""));
}
function warn(label, detail) {
  warnings.push("  " + COLOR.yellow + "!" + COLOR.reset + " " + label + (detail ? " —— " + detail : ""));
}
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/* ---------- 1) 严格 CSP + withGlobalTauri ---------- */
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
check("A4 tauri.conf.json → app.withGlobalTauri === false", conf.app?.withGlobalTauri === false, String(conf.app?.withGlobalTauri));

const csp = String(conf.app?.security?.csp ?? "");
const directives = new Map();
for (const part of csp.split(";")) {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (tokens.length) directives.set(tokens[0].toLowerCase(), tokens.slice(1));
}
/*
 * img-src 例外：军团 / 联盟徽标由本地图片服务（默认 127.0.0.1:26001，端口在配置中心可改）
 * 直接以 <img> 加载，和游戏客户端取图走的是同一套路由。端口可配所以只能给端口通配；
 * 角色头像不走这条路（外壳读文件后内联成 data: URL）。
 * 这里刻意不把 img-src 纳入断言：它允许的是本机服务，不是远程源；
 * 但**动 script-src 之前先看这一条**——script-src 只允许 'self'（下面有断言钉住）。
 */
const remoteSource = (sources) => sources.some((s) => /^(https?:|\*|data:)/i.test(s));
const scriptSrc = directives.get("script-src") ?? directives.get("default-src") ?? [];
check("A4 CSP 有 script-src", directives.has("script-src"));
check("A4 script-src 无 'unsafe-inline'", !scriptSrc.includes("'unsafe-inline'"));
check("A4 script-src 无 'unsafe-eval'", !scriptSrc.includes("'unsafe-eval'"));
check("A4 script-src 只允许 'self'（无远程源）", !remoteSource(scriptSrc), scriptSrc.join(" "));
check("A4 CSP 有 object-src 'none'", (directives.get("object-src") ?? []).includes("'none'"));
check("A4 CSP 有 base-uri（限制 <base> 劫持）", directives.has("base-uri"));
check("A4 CSP default-src 'self'", (directives.get("default-src") ?? []).includes("'self'"));
// 已知债务：legacy 页面内联事件属性 / 内联 style 属性，S6 换 React 时一并清掉
if ((directives.get("script-src-attr") ?? []).includes("'unsafe-inline'")) {
  warn("A4 script-src-attr 仍放行 'unsafe-inline'", "legacy 页面 165 处内联事件属性；S6 换 React 后删除");
}
if ((directives.get("style-src") ?? []).includes("'unsafe-inline'")) {
  warn("A4 style-src 仍放行 'unsafe-inline'", "legacy 页面 200 处内联 style 属性；S6 换 React 后删除");
}
const disabled = conf.app?.security?.dangerousDisableAssetCspModification;
const disablesScriptCsp = disabled === true || (Array.isArray(disabled) && disabled.includes("script-src"));
check("A4 未关闭 Tauri 的 CSP 哈希注入（否则内联脚本白名单失效）", !disablesScriptCsp);

/* ---------- 2) capabilities 最小白名单 ---------- */
/**
 * 允许出现在 capabilities 里的权限：多一条就报错，防止 ACL 被悄悄放宽。
 *
 * core:window:allow-start-dragging / allow-internal-toggle-maximize：
 * 窗口是无边框的（src-tauri/src/lib.rs 里 decorations(false)），标题栏拖动与双击最大化
 * 只能靠 Tauri 内置的 data-tauri-drag-region 脚本，它 invoke 的正是这两个核心命令。
 * 两者都只作用于窗口自身的拖动 / 最大化，不碰文件系统、网络与进程。
 */
const CAP_ALLOW = new Set([
  "core:event:default",
  "core:window:allow-start-dragging",
  "core:window:allow-internal-toggle-maximize",
]);
const capDir = path.join(ROOT, "src-tauri/capabilities");
for (const file of fs.readdirSync(capDir).filter((f) => f.endsWith(".json"))) {
  const cap = JSON.parse(fs.readFileSync(path.join(capDir, file), "utf8"));
  const perms = cap.permissions ?? [];
  const extra = perms.filter((p) => !CAP_ALLOW.has(p));
  check(`A4 capabilities/${file} 只放行 ${[...CAP_ALLOW].join(", ")}`, extra.length === 0, "多出 " + extra.join(", "));
}

/* ---------- 3) Tauri command 白名单（注册集合 == 白名单，且无孤儿命令） ---------- */
const COMMAND_WHITELIST = new Set(["launcher_invoke", "self_test_report"]);
const rsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".rs")) rsFiles.push(full);
  }
})(path.join(ROOT, "src-tauri/src"));

const declared = new Set();
for (const file of rsFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/#\[tauri::command\][\s\S]{0,200}?pub (?:async )?fn (\w+)/g)) {
    declared.add(match[1]);
  }
}
const registered = new Set();
for (const file of rsFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/generate_handler!\[([\s\S]*?)\]/g)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split("::").pop();
      if (name) registered.add(name);
    }
  }
}
const declaredMissing = [...declared].filter((name) => !COMMAND_WHITELIST.has(name));
const registeredMissing = [...registered].filter((name) => !COMMAND_WHITELIST.has(name));
const unregistered = [...declared].filter((name) => !registered.has(name));
check("A4 已声明的 #[tauri::command] 全在白名单内", declaredMissing.length === 0, declaredMissing.join(", "));
check("A4 已注册的 command 全在白名单内", registeredMissing.length === 0, registeredMissing.join(", "));
check("A4 没有声明了却没注册的孤儿命令", unregistered.length === 0, unregistered.join(", "));
check("A4 launcher_invoke 是唯一常驻命令（自检命令仅 --self-test 注册）", registered.has("launcher_invoke"));

const libRs = read("src-tauri/src/lib.rs");
check("A4 lib.rs 只在 --self-test 分支注册 self_test_report", /--self-test/.test(libRs) && /self_test_report/.test(libRs));

/* ---------- 4) A1 更新器：只认内置公钥 + https ---------- */
const updaterRs = read("src-tauri/src/updater.rs");
check("A1 更新器使用内置公钥验签入口", /verify_update_manifest/.test(updaterRs));
check("A1 更新器默认只认 https（file:// 需 EVEJS_UPDATE_ALLOW_LOCAL=1）", /EVEJS_UPDATE_ALLOW_LOCAL/.test(updaterRs) && /https/.test(updaterRs));
check("A1 打包版忽略 launcher.config.json 里的 manifest URL", /allow_config_file/.test(updaterRs) && /is_packaged/.test(updaterRs));
const keyId = (updaterRs.match(/pub const UPDATE_KEY_ID: &str = "([^"]*)"/) ?? [])[1] ?? null;
const pubKey = (updaterRs.match(/pub const UPDATE_PUBKEY: &str = "([^"]*)"/) ?? [])[1] ?? null;
check("A1 更新器内置公钥常量存在（空 = 拒绝一切更新，fail closed）", keyId !== null && pubKey !== null);
if (keyId === "" || pubKey === "") {
  const detail = "内置更新公钥未配置 → 更新功能整体 fail closed";
  if (REQUIRE_UPDATE_KEY) failures.push("A1 发布前必须配置 UPDATE_KEY_ID / UPDATE_PUBKEY —— " + detail);
  else warn("A1 " + detail, "发布前用 scripts/gen-update-key.mjs 生成并写入常量");
}

/* ---------- 5) B5 sidecar：node 绝对路径 + 密码不走 argv ---------- */
const sidecarRs = read("src-tauri/src/sidecar.rs");
check(
  "B5 sidecar 不再裸名 Command::new(\"node\")",
  !/Command::new\(\s*"node"\s*\)/.test(sidecarRs),
  "必须用解析出的绝对路径"
);
const accountsRs = read("src-tauri/src/accounts.rs");
check(
  "B5 accounts 密码不再拼进命令行参数",
  !/args\s*\(\s*\[[\s\S]{0,200}?password[\s\S]{0,200}?\]\s*\)/.test(accountsRs),
  "密码应走 stdin"
);

/* ---------- 5b) B5 随包 CLI 必须支持 stdin 密码 ---------- */
const accountCli = read("vendor/cli/account-cli.js");
check(
  "B5 随包 account-cli.js 支持 --password-stdin",
  accountCli.includes("--password-stdin") && /readFileSync\(0/.test(accountCli)
);
const sidecarForSlot = read("src-tauri/src/sidecar.rs");
check("B5 密码占位符机制存在（PASSWORD_SLOT）", /PASSWORD_SLOT/.test(sidecarForSlot));

/* ---------- 5c) B1 组件级包含判定（startsWith 前缀绕过） ---------- */
const modsMod = read("src-tauri/src/mods/mod.rs");
check("B1 存在 contains_path（组件级，不是字符串前缀）", /pub fn contains_path\(/.test(modsMod));
check("B1 存在 join_within（拼路径 + 包含断言）", /pub fn join_within\(/.test(modsMod));
const RAW_MOD_JOINS = [
  "src-tauri/src/mods/plan.rs",
  "src-tauri/src/mods/pkg.rs",
  "src-tauri/src/mods/registry.rs",
  "src-tauri/src/mods/desktop.rs",
  "src-tauri/src/mods/submit.rs",
  "src-tauri/src/mods/scaffold.rs",
];
const rawJoins = RAW_MOD_JOINS.filter((file) =>
  /mods_root\([^)]*\)\.join\(|mods_dir\.join\(&?(folder|actual_folder)|root\.join\(&id\)/.test(read(file))
);
check("B1 模组目录拼路径统一走 join_within", rawJoins.length === 0, rawJoins.join(", "));

/* ---------- 5d) B4 终端输入不得有日志出口 ---------- */
const LOG_MACRO = /(?:^|[^\w])(?:eprintln!|println!|dbg!|log::(?:info|warn|error|debug|trace)!)/;
// 单元测试模块（`#[cfg(test)]` + `mod tests`，本仓库每个文件至多一处、且都在文件尾）
// 不会被编进发布二进制，所以它里面的 println! 不构成日志出口：L4 终端压测需要在
// --nocapture 下打印统计行给 scripts/stress-terminal.ps1 解析。只截断到测试模块起点，
// 生产代码一个字都不放过。
const stripTestModule = (source) => {
  const at = source.search(/#\[cfg\(test\)\]\s*\r?\n\s*mod\s+tests\b/);
  return at === -1 ? source : source.slice(0, at);
};
const logHits = [];
for (const file of rsFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  if (rel.endsWith("src-tauri/src/ipc/smoke.rs")) continue;
  // 先剥掉行注释：文档里举例说明「不要打印输入」不算日志出口
  const code = stripTestModule(fs.readFileSync(file, "utf8")).replace(/\/\/[^\n]*/g, "");
  if (LOG_MACRO.test(code)) logHits.push(rel);
}
check("B4 除自检模块外没有 println!/eprintln!（终端输入没有日志出口）", logHits.length === 0, logHits.join(", "));
const ptyRs = read("src-tauri/src/pty.rs");
check("B4 终端输入经 TerminalInput 包装（Debug/Display 脱敏）", /pub struct TerminalInput/.test(ptyRs) && /<redacted:/.test(ptyRs));
check("B4 pty.write 只接受 TerminalInput（结构上拿不到明文）", /pub fn write\(&self, id: &str, input: TerminalInput<'_>\)/.test(ptyRs));

/* ---------- 6) B6 characterId 校验 ---------- */
check(
  "B6 characterId 拼路径前有白名单校验",
  /is_safe_character_id/.test(accountsRs),
  "缺少 is_safe_character_id 之类的前置校验"
);

/* ---------- 7) B7 本机绝对路径 ---------- */
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "gen"]);
const SKIP_EXT = new Set([".md", ".exe", ".dll", ".ico", ".png", ".jpg", ".woff", ".woff2", ".ttf"]);
// 反向构造「盘符 + Users 目录」模式：脚本自身不出现该字面量，否则会自命中
const SEP = path.sep === "\\" ? "\\\\" : "/";
const LOCAL_PATH = new RegExp("[A-Za-z]:" + SEP + "{1,2}" + "Users" + SEP + "{1,2}", "i");
const hits = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      if (rel.startsWith("docs/") || rel.startsWith("contract/")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (LOCAL_PATH.test(text)) hits.push(rel);
    }
  }
})(ROOT);
check("B7 源码/产物内无开发机用户目录路径", hits.length === 0, hits.join(", "));

/* ---------- 8) A6 S6 新渲染层不得引入危险模式 ---------- */
// CSP 是 script-src self + 无 unsafe-inline；一旦新渲染层用了 eval/Function/innerHTML 这类逃逸手段，
// CSP 承诺就形同虚设。规则只覆盖 ui/src（S6 的 React 应用源码）；legacy ui/web 是待退役页面，
// 历史上大量 innerHTML，不纳入（换掉它才是本阶段的终点，见计划 §8 G6）。
const RENDER_DANGER = [
  ["eval(", /\beval\s*\(/],
  ["new Function(", /\bnew\s+Function\s*\(/],
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML= ", /\.innerHTML\s*=/],
  ["document.write(", /document\.write\s*\(/],
  ["window.__TAURI__", /window\.__TAURI__\b/],
  ["__TAURI_INTERNALS__ 私有通道", /__TAURI_INTERNALS__\.(ipc|postMessage|runCallback)\b/],
];
const renderHits = [];
(function walkRender(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRender(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".generated.ts")) continue; // 生成物由 verify-contract.mjs 单独把关
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [name, pattern] of RENDER_DANGER) {
        if (pattern.test(line)) renderHits.push(rel + ":" + (index + 1) + " " + name);
      }
    });
  }
})(path.join(ROOT, "ui", "src"));
check("A6 S6 新渲染层（ui/src）无 eval / new Function / innerHTML / 全局 Tauri 入口", renderHits.length === 0, renderHits.slice(0, 6).join("; "));
notes.push("  " + COLOR.dim + "A6 扫描范围：ui/src/**/*.{ts,tsx}（legacy ui/web 不纳入：待退役页面）" + COLOR.reset);

/* ---------- 输出 ---------- */
console.log("安全审计（A1/A4/B5/B6/B7 静态部分）：");
for (const line of notes) console.log(line);
for (const line of warnings) console.log(line);
if (failures.length) {
  console.log("");
  console.log(COLOR.red + "阻断项：" + COLOR.reset);
  for (const line of failures) console.log("  " + COLOR.red + "\u2717" + COLOR.reset + " " + line);
  console.log("");
  console.log(COLOR.red + "安全审计未通过（" + failures.length + " 项）" + COLOR.reset);
  process.exit(1);
}
console.log("");
console.log(
  COLOR.green +
    "安全审计通过" +
    COLOR.reset +
    "（" +
    notes.length +
    " 项通过" +
    (warnings.length ? "，" + warnings.length + " 项已知债务待 S6 关闭" : "") +
    "）"
);