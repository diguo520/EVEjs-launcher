#!/usr/bin/env node
/**
 * 渲染层构建期语法校验（移植自现役版 scripts/check-renderer.js，目标目录改为 ui/web）。
 *
 * 背景：ui/web 下的 HTML 内联脚本与 launcher-bridge.js 不经过任何打包器的语法检查。
 * 一旦内联脚本出现语法错误，整段 <script> 都不会执行，表现为「点任何按钮都没反应」。
 * 这里在打包前跑一遍，有语法错误就直接失败。
 *
 * 用法：node scripts/check-renderer.mjs [目录，默认 ui/web]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET_DIR = path.resolve(ROOT, process.argv[2] || path.join("ui", "web"));

const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", yellow: "", green: "", dim: "", reset: "" };

function collect(dir, extensions, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, extensions, out);
    else if (extensions.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function parseCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) return null;
  const output = String(result.stderr || result.stdout || "");
  const match = output.match(/:(\d+)\r?\n/);
  const messageLine = output
    .split(/\r?\n/)
    .find((line) => /^(SyntaxError|RangeError|ReferenceError|TypeError)/.test(line.trim()));
  return {
    line: match ? Number(match[1]) : null,
    message: (messageLine || output.split(/\r?\n/)[0] || "parse failed").trim()
  };
}

/** 针对现役版踩过的坑给出定向提示 */
function hintFor(message, code) {
  if (/Unexpected identifier|Invalid or unexpected token|Unterminated string/i.test(message)) {
    if (/font-family:'/.test(code) || /style="[^"]*'/.test(code)) {
      return "内联样式里的单引号会提前结束 JS 字符串，改成不带引号，例如 font-family:Cascadia Mono,Consolas,monospace";
    }
    return "通常是引号不配对（例如在单引号字符串里又写了单引号）";
  }
  return null;
}

const problems = [];
const tmpFiles = [];
let checked = 0;

for (const htmlFile of collect(TARGET_DIR, [".html"])) {
  const html = fs.readFileSync(htmlFile, "utf8");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = re.exec(html)) !== null) {
    index += 1;
    if (/\bsrc\s*=/.test(match[1])) continue;
    const code = match[2];
    if (!code.trim()) continue;
    const contentOffset = match.index + match[0].indexOf(code);
    const startLine = html.slice(0, contentOffset).split(/\r?\n/).length;
    const tmp = path.join(os.tmpdir(), "evejs-check-" + process.pid + "-" + checked + ".js");
    fs.writeFileSync(tmp, code, "utf8");
    tmpFiles.push(tmp);
    checked += 1;
    const failure = parseCheck(tmp);
    if (failure) {
      problems.push({
        file: path.relative(ROOT, htmlFile),
        scriptIndex: index,
        line: failure.line ? startLine + failure.line - 1 : startLine,
        message: failure.message,
        hint: hintFor(failure.message, code)
      });
    }
  }
}

for (const jsFile of collect(TARGET_DIR, [".js"])) {
  checked += 1;
  const failure = parseCheck(jsFile);
  if (failure) {
    problems.push({
      file: path.relative(ROOT, jsFile),
      scriptIndex: 0,
      line: failure.line,
      message: failure.message,
      hint: hintFor(failure.message, fs.readFileSync(jsFile, "utf8"))
    });
  }
}

for (const tmp of tmpFiles) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* 忽略清理失败 */
  }
}

if (problems.length === 0) {
  console.log(COLOR.green + "renderer syntax OK" + COLOR.reset + COLOR.dim + " (" + checked + " scripts checked)" + COLOR.reset);
  process.exit(0);
}

console.error(COLOR.red + "渲染层语法检查失败：" + COLOR.reset);
for (const problem of problems) {
  const where = problem.scriptIndex
    ? problem.file + " 第 " + problem.line + " 行（第 " + problem.scriptIndex + " 个内联 script）"
    : problem.file + " 第 " + problem.line + " 行";
  console.error("  " + COLOR.red + "\u2717" + COLOR.reset + " " + where);
  console.error("    " + problem.message);
  if (problem.hint) console.error("    " + COLOR.yellow + "提示：" + problem.hint + COLOR.reset);
}
console.error("");
console.error("这类错误会让整个内联脚本无法执行，表现为「点任何按钮都没反应」。");
process.exit(1);
