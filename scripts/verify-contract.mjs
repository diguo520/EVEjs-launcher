#!/usr/bin/env node
/**
 * 契约一致性门禁（G1 的静态部分，不需要编译 Rust 就能跑）。
 *
 * 校验四份产物与 contract/ipc-channels.json 是否严格对齐：
 *   1. ui/src/api-shim.js             注入用纯 JS：语法 + window.api 入口集合
 *   2. ui/src/api-shim.generated.ts   React 侧 shim（S6 使用）
 *   3. src-tauri/src/ipc/channels.rs  Rust 白名单与计数
 *   4. src-tauri/src/ipc/registry.rs  「已实现 ∪ 待实现 == 全部请求通道」（82/82 有回包）
 *
 * 用法：node scripts/verify-contract.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", dim: "", reset: "" };

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const failures = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) notes.push("  " + COLOR.green + "\u2713" + COLOR.reset + " " + label);
  else failures.push(label + (detail ? " —— " + detail : ""));
}

const contract = JSON.parse(read("contract/ipc-channels.json"));
const requests = [...contract.invoke, ...contract.send];
const requestChannels = new Set(requests.map((item) => item.channel));
const eventChannels = new Set(contract.events.map((item) => item.channel));
const apiNames = new Set([...requests, ...contract.events].map((item) => item.api));
const expectedApiTotal = contract.counts.apiTotal;

/* ---------- 1) 注入用纯 JS shim ---------- */
const shimPath = path.join(ROOT, "ui", "src", "api-shim.js");
check("ui/src/api-shim.js 存在", fs.existsSync(shimPath));
if (fs.existsSync(shimPath)) {
  const shim = read("ui/src/api-shim.js");
  const syntax = spawnSync(process.execPath, ["--check", shimPath], { encoding: "utf8" });
  check(
    "ui/src/api-shim.js 语法通过 node --check",
    syntax.status === 0,
    String(syntax.stderr || "").split(/\r?\n/)[0]
  );
  const shimNames = new Set([...shim.matchAll(/^\s{4}(\w+): function \(/gm)].map((match) => match[1]));
  check(
    "shim 入口数量 == 契约 apiTotal(" + expectedApiTotal + ")",
    shimNames.size === expectedApiTotal,
    "实际 " + shimNames.size
  );
  const missing = [...apiNames].filter((name) => !shimNames.has(name));
  check("shim 未漏入口", missing.length === 0, missing.join(", "));
  check("shim 挂载 window.api", /window\.api = api;/.test(shim));
  // A4：withGlobalTauri:false —— shim 只能用官方 @tauri-apps/api 同款传输层，
  // 且只允许 invoke / transformCallback / unregisterListener 三个入口，禁止直接碰 ipc/postMessage。
  check("shim 不依赖全局 window.__TAURI__", !/window\.__TAURI__\b/.test(shim));
  check(
    "shim 使用 __TAURI_INTERNALS__.invoke（与 @tauri-apps/api 同款传输层）",
    /__TAURI_INTERNALS__/.test(shim) && /\.invoke\(DISPATCH,/.test(shim)
  );
  check("shim 未直接使用 __TAURI_INTERNALS__.ipc/postMessage 私有通道", !/__TAURI_INTERNALS__\.(ipc|postMessage|runCallback)\b/.test(shim));
  check(
    "shim 事件订阅走 plugin:event|listen（不依赖全局事件 API）",
    /"plugin:event\|listen"/.test(shim) && /"plugin:event\|unlisten"/.test(shim)
  );
}

/* ---------- 2) TS shim ---------- */
const tsShim = read("ui/src/api-shim.generated.ts");
const tsNames = new Set([...tsShim.matchAll(/^\s{2}(\w+): \(/gm)].map((match) => match[1]));
const tsMissing = [...apiNames].filter((name) => !tsNames.has(name));
check("ui/src/api-shim.generated.ts 未漏入口", tsMissing.length === 0, tsMissing.join(", "));

/* ---------- 3) Rust 白名单 ---------- */
const channelsRs = read("src-tauri/src/ipc/channels.rs");
// 容忍 rustfmt 把条目拆成多行（生成器已加 rustfmt::skip，这里是双保险）
const specs = [...channelsRs.matchAll(/ChannelSpec \{\s*channel: "([^"]+)"/g)].map((match) => match[1]);
check(
  "channels.rs 通道条目 == " + (requestChannels.size + eventChannels.size),
  specs.length === requestChannels.size + eventChannels.size,
  "实际 " + specs.length
);
const requestCount = channelsRs.match(/REQUEST_COUNT: usize = (\d+)/);
const eventCount = channelsRs.match(/EVENT_COUNT: usize = (\d+)/);
check("channels.rs REQUEST_COUNT == " + requestChannels.size, Number(requestCount?.[1]) === requestChannels.size);
check("channels.rs EVENT_COUNT == " + eventChannels.size, Number(eventCount?.[1]) === eventChannels.size);

/* ---------- 4) registry 覆盖（G1：82/82 有回包） ---------- */
const registryRs = read("src-tauri/src/ipc/registry.rs");
const handledBlock = registryRs.match(/pub const HANDLED: &\[&str\] = &\[([\s\S]*?)\];/);
// 空数组（S2 收口后 PLANNED 合法地为空）也得能解析：不要求 `];` 独占一行
const plannedBlock = registryRs.match(/pub const PLANNED: &\[Planned\] = &\[([\s\S]*?)\];/);
check("registry.rs 能解析 HANDLED / PLANNED", Boolean(handledBlock && plannedBlock));

if (handledBlock && plannedBlock) {
  const handled = [...handledBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const planned = [...plannedBlock[1].matchAll(/channel: "([^"]+)"/g)].map((match) => match[1]);
  const handledSet = new Set(handled);
  const plannedSet = new Set(planned);

  check("HANDLED 无重复", handledSet.size === handled.length);
  check("PLANNED 无重复", plannedSet.size === planned.length);
  check(
    "HANDLED 与 PLANNED 不重叠",
    [...handledSet].every((channel) => !plannedSet.has(channel))
  );
  check(
    "G1：已实现 + 待实现 == 全部请求通道（" + requestChannels.size + "）",
    handledSet.size + plannedSet.size === requestChannels.size,
    "实际 " + (handledSet.size + plannedSet.size)
  );
  const unknown = [...handledSet, ...plannedSet].filter((channel) => !requestChannels.has(channel));
  check("台账里没有非请求通道", unknown.length === 0, unknown.join(", "));
  const uncovered = [...requestChannels].filter(
    (channel) => !handledSet.has(channel) && !plannedSet.has(channel)
  );
  check("没有既未实现也未登记的通道", uncovered.length === 0, uncovered.join(", "));

  notes.push(
    "  " + COLOR.dim + "已实现 " + handled.length + " / 待实现 " + planned.length + " / 请求通道 " + requestChannels.size + COLOR.reset
  );
}

console.log("契约校验（" + contract.generatedAt + "）：");
for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.error("");
  console.error(COLOR.red + "契约校验失败：" + COLOR.reset);
  for (const failure of failures) console.error("  \u2717 " + failure);
  process.exit(1);
}
console.log(COLOR.green + "契约校验通过" + COLOR.reset);
