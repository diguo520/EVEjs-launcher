#!/usr/bin/env node
/**
 * 桥调用名门禁：渲染层里 `call / callOr / subscribe / act` 的第一个字符串参数，
 * 必须是 `ui/src/api-shim.js` 真正暴露的入口名。
 *
 * 背景（2026-10-01 报障）：关于面板的 GitHub 图标点了没反应，数据库页的「新增行 / 删除行」
 * 也一直失败。根因相同 —— 把**通道名**当成了**入口名**写：桥上的键是契约里的 api 名
 * （`openExternal`），写成通道名（`shellOpenExternal`）时 `api[name]` 是 undefined，
 * `call()` 直接抛错，调用方多数只弹一句 toast。静态检查看不见，只有用户点下去才知道。
 *
 * 用法：node scripts/check-bridge-calls.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHIM = path.join(ROOT, "ui", "src", "api-shim.js");
const SRC = path.join(ROOT, "ui", "src");

const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", dim: "", reset: "" };

if (!fs.existsSync(SHIM)) {
  console.error(COLOR.red + "找不到 UI 桥：" + COLOR.reset + path.relative(ROOT, SHIM));
  process.exit(2);
}

/** 桥暴露的入口名（`window.api` 的键） */
const exposed = new Set();
for (const line of fs.readFileSync(SHIM, "utf8").split(/\r?\n/)) {
  const match = /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*function\b/.exec(line);
  if (match) exposed.add(match[1]);
}
if (exposed.size === 0) {
  console.error(COLOR.red + "没能从 ui/src/api-shim.js 里解析出任何入口 —— 生成格式变了？" + COLOR.reset);
  process.exit(2);
}

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** 调用点：call / callOr / subscribe / act 的第一个字符串参数 */
const CALL = /\b(call|callOr|subscribe|act)(?:<[^>]*>)?\(\s*"([^"]+)"/g;

const problems = [];
let checked = 0;
for (const file of collect(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(CALL)) {
    checked += 1;
    if (exposed.has(match[2])) continue;
    problems.push({
      file: path.relative(ROOT, file),
      line: text.slice(0, match.index).split(/\r?\n/).length,
      call: match[1],
      name: match[2],
    });
  }
}

if (problems.length === 0) {
  console.log(
    COLOR.green + "bridge calls OK" + COLOR.reset + COLOR.dim + " (" + checked + " 处调用 / " + exposed.size + " 个入口)" + COLOR.reset,
  );
  process.exit(0);
}

console.error(COLOR.red + "桥调用名检查失败：" + COLOR.reset);
for (const problem of problems) {
  console.error("  " + COLOR.red + "\u2717" + COLOR.reset + " " + problem.file + " 第 " + problem.line + " 行");
  console.error("    " + problem.call + '("' + problem.name + '") 这个入口在 ui/src/api-shim.js 里不存在');
}
console.error("");
console.error("桥上的键是契约里的 api 名（ui/src/api-shim.generated.ts 同一份），不是通道名。");
console.error("例：通道 shell:openExternal 对应入口 openExternal。");
process.exit(1);