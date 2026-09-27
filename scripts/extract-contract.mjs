#!/usr/bin/env node
/**
 * 从现役 Electron 工程抽取 IPC 契约，产出 contract/ipc-channels.json（唯一事实来源）。
 *
 * 用法：node scripts/extract-contract.mjs [源工程根目录]
 * 默认：E:\Games\EveJS-v0.12.8\launcher\launcher
 *
 * 说明：
 *   - 渲染层只通过 window.api 访问主进程，所以 src/preload/index.ts 是契约主来源；
 *   - src/main/ipc.ts 用于交叉校验（「注册未暴露」「暴露未注册」）；
 *   - 生成物不要手改，源工程变更后重跑本脚本。
 * 输出字段：
 *   invoke[]: { api, channel, signature, params[] }
 *   send[]:   同 invoke（无回包）
 *   events[]: { api, channel }   —— 主进程 -> 渲染层，载荷统一为数组（shim 会展开）
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SRC = "E:\\Games\\EveJS-v0.12.8\\launcher\\launcher";
const SRC_ROOT = path.resolve(process.argv[2] || DEFAULT_SRC);
const OUT_FILE = path.resolve("contract", "ipc-channels.json");

const preloadPath = path.join(SRC_ROOT, "src", "preload", "index.ts");
const ipcPath = path.join(SRC_ROOT, "src", "main", "ipc.ts");

for (const file of [preloadPath, ipcPath]) {
  if (!fs.existsSync(file)) {
    console.error("找不到源文件: " + file);
    process.exit(1);
  }
}

function flatten(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ");
}

const preload = flatten(fs.readFileSync(preloadPath, "utf8"));
const ipc = flatten(fs.readFileSync(ipcPath, "utf8"));

/**
 * 按顶层分隔符切分：忽略 <>, {}, [], () 内部的逗号，避免
 * `patch: Record<string, string>` 被误切成两个参数（V1 缺陷）。
 */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<{[(".includes(char)) depth += 1;
    else if (">}])".includes(char)) depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** 顶层字符首次出现的位置；嵌套在 <> {} [] () 内的一律忽略。 */
function topLevelIndex(text, char) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if ("<{[(".includes(c)) depth += 1;
    else if (">}])".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

/** 参数名：兼容 `name: Type` 与 `name = 默认值` 两种写法；无名时兜底为 argN。 */
function paramName(part, index) {
  const colon = topLevelIndex(part, ":");
  const name = (colon >= 0 ? part.slice(0, colon) : part)
    .replace("?", "")
    .replace(/=.*$/, "")
    .trim();
  return name || "arg" + index;
}

/* ---------- 1) invoke / send 通道 ---------- */
const calls = [];
const callRe = /([A-Za-z0-9_]+)\s*:\s*(\([^();]*\))?\s*=>\s*ipcRenderer\.(invoke|send)\(\s*"([^"]+)"/g;
let m;
while ((m = callRe.exec(preload)) !== null) {
  const signature = (m[2] || "()").replace(/^\(|\)$/g, "");
  calls.push({
    api: m[1],
    channel: m[4],
    kind: m[3],
    signature: signature.trim(),
    params: splitTopLevel(signature, ",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(paramName)
  });
}

/* ---------- 2) 事件订阅通道 ---------- */
const events = [];
const eventStarts = [];
const eventEntryRe = /([A-Za-z0-9_]+)\s*:\s*\(\s*cb/g;
while ((m = eventEntryRe.exec(preload)) !== null) {
  eventStarts.push({ api: m[1], index: m.index });
}
for (let i = 0; i < eventStarts.length; i += 1) {
  const end = i + 1 < eventStarts.length ? eventStarts[i + 1].index : preload.length;
  const slice = preload.slice(eventStarts[i].index, end);
  const on = slice.match(/ipcRenderer\.on\(\s*"([^"]+)"/);
  if (on) events.push({ api: eventStarts[i].api, channel: on[1] });
}

/* ---------- 3) ipc.ts 注册通道（交叉校验） ---------- */
const registered = new Set();
const regRe = /ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g;
while ((m = regRe.exec(ipc)) !== null) registered.add(m[1]);
const dynamicRegistrations = (
  ipc.match(/ipcMain\.(?:handle|on)\(\s*(?!")[A-Za-z_$][A-Za-z0-9_$.]*/g) || []
).length;

const apiChannels = new Set([...calls.map((c) => c.channel), ...events.map((e) => e.channel)]);

const contract = {
  generatedFrom: SRC_ROOT,
  generatedAt: new Date().toISOString(),
  counts: {
    invoke: calls.filter((c) => c.kind === "invoke").length,
    send: calls.filter((c) => c.kind === "send").length,
    events: events.length,
    requests: calls.length,
    registered: registered.size,
    apiTotal: apiChannels.size
  },
  invoke: calls.filter((c) => c.kind === "invoke").sort((a, b) => a.api.localeCompare(b.api)),
  send: calls.filter((c) => c.kind === "send").sort((a, b) => a.api.localeCompare(b.api)),
  events: events.sort((a, b) => a.api.localeCompare(b.api)),
  registeredNotExposed: [...registered].filter((c) => !apiChannels.has(c)).sort(),
  exposedNotRegistered: [...apiChannels].filter((c) => !registered.has(c)).sort(),
  dynamicRegistrations
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(contract, null, 2) + "\n", "utf8");

console.log("契约已写出: " + path.relative(process.cwd(), OUT_FILE));
console.log(
  "  invoke=" + contract.counts.invoke +
  "  send=" + contract.counts.send +
  "  events=" + contract.counts.events +
  "  请求通道=" + contract.counts.requests +
  "  window.api 通道总数=" + contract.counts.apiTotal +
  "  ipc.ts 注册=" + contract.counts.registered
);
console.log("  注册未暴露: " + (contract.registeredNotExposed.join(", ") || "无"));
console.log("  暴露未注册: " + (contract.exposedNotRegistered.join(", ") || "无"));
console.log("  动态注册点(需人工核对): " + dynamicRegistrations);
