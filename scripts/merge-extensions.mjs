#!/usr/bin/env node
/**
 * 把 `contract/extensions.json` 里的新增通道并进 `contract/ipc-channels.json`，
 * **不需要现役 Electron 参考源码**。
 *
 * 为什么需要它：正规链路是 `extract-contract.mjs`（重抽现役版 preload/ipc.ts 并顺带合并
 * 扩展清单）→ `gen-contract.mjs`（生成 channels.rs / api-shim / ipc-contract.md）。
 * 但重抽要求 `EVEJS_REFERENCE_ROOT`（默认 `E:\Games\EveJS-v0.12.8\launcher\launcher`）
 * 存在，参考源码不在的机器上（以及 CI）这一步是**跳过**的 —— 于是新增通道无处落地。
 *
 * 本脚本只做提取器里那一段「合并扩展清单」的搬运，语义与之逐行对齐：
 *   · 只**追加** extensions 里 ipc-channels.json 还没有的通道（按 channel 判重）；
 *   · 追加后按 api 名排序，与提取器一致；
 *   · 重算 counts.invoke / send / events / requests / apiTotal，并刷新 extensions 台账；
 *   · 不动 `registeredNotExposed` / `exposedNotRegistered` / `dynamicRegistrations`
 *     与 `registered` —— 那些要么依赖参考源码，要么本来就把扩展通道排除在外。
 *   · 幂等：已经并过的通道不会重复追加，重复跑是空操作。
 *
 * 用法：node scripts/merge-extensions.mjs            # 合并并写回
 *       node scripts/merge-extensions.mjs --check    # 只报告缺哪些，不写回
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT = path.join(ROOT, "contract", "ipc-channels.json");
const EXTENSIONS = path.join(ROOT, "contract", "extensions.json");
const CHECK_ONLY = process.argv.includes("--check");

const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
const extensions = JSON.parse(fs.readFileSync(EXTENSIONS, "utf8"));

const KINDS = [
  { key: "invoke", label: "扩展通道" },
  { key: "send", label: "扩展通道" },
  { key: "events", label: "扩展事件" },
];

let added = 0;
const notices = [];

for (const { key, label } of KINDS) {
  const list = contract[key] ?? [];
  const existing = new Set(list.map((entry) => entry.channel));
  for (const item of extensions[key] ?? []) {
    if (existing.has(item.channel)) {
      continue;
    }
    existing.add(item.channel);
    const entry = { api: item.api, channel: item.channel };
    if (key !== "events") {
      entry.kind = key === "send" ? "send" : "invoke";
      entry.signature = item.signature ?? "";
      entry.params = item.params ?? [];
    }
    list.push(entry);
    added += 1;
    notices.push(`${label} + ${item.channel}`);
  }
  contract[key] = list.sort((a, b) => a.api.localeCompare(b.api));
}

if (added === 0) {
  console.log("  契约台账已经是最新，没有需要并回的扩展通道。");
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error("  ✗ 契约台账缺少下列扩展通道（跑 `node scripts/merge-extensions.mjs` 补）：");
  for (const line of notices) {
    console.error("    - " + line);
  }
  process.exit(1);
}

contract.counts = {
  ...contract.counts,
  invoke: contract.invoke.length,
  send: (contract.send ?? []).length,
  events: (contract.events ?? []).length,
  requests: contract.invoke.length + (contract.send ?? []).length,
  // apiTotal 是「参考版通道 ∪ 扩展通道」的总数：参考源码不在时只能按新增量累加
  apiTotal: (contract.counts?.apiTotal ?? 0) + added,
};
// 台账单列：diff 时一眼看出哪些不是现役版有的
contract.extensions = {
  invoke: (extensions.invoke ?? []).map((item) => item.channel).sort(),
  send: (extensions.send ?? []).map((item) => item.channel).sort(),
  events: (extensions.events ?? []).map((item) => item.channel).sort(),
};

fs.writeFileSync(CONTRACT, JSON.stringify(contract, null, 2) + "\n", "utf8");
console.log(`  已并回 ${added} 条扩展通道：`);
for (const line of notices) {
  console.log("    - " + line);
}
console.log(`  invoke=${contract.counts.invoke}  send=${contract.counts.send}  events=${contract.counts.events}  window.api 通道总数=${contract.counts.apiTotal}`);
console.log("  注意：这是「合并班车」，不是重抽；generatedFrom / generatedAt / 注册台账保持原样。");
