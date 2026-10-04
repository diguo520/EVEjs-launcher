#!/usr/bin/env node
/**
 * 跨实现比对（S5 / L2 第二半）：**Electron 现役版 ↔ Tauri 新外壳** 逐通道对拍。
 *
 * 与 `diff.mjs`（同一实现 ↔ 自己冻结的基线）的分工：
 *   - 共用同一套降噪口径（`normalize.mjs`：volatile 键、时间戳、绝对路径、按结构比对清单）；
 *   - 追加一张**显式豁免表**：两实现之间「本来就该不同」的键，逐条写明理由；
 *   - 统计哪条豁免这次真的用上了，并打印未被触发的条目（避免豁免腐烂成遮羞布，
 *     也避免「早就修好了」的豁免一直挂在那里白遮）。
 *
 * 用法：
 *   node tests/parity/diff-cross.mjs                    # .parity-out/electron.json ↔ .parity-out/tauri.json
 *   node tests/parity/diff-cross.mjs --update           # 用当前 electron.json 刷新 Electron 冻结基线
 *
 * 新外壳独有的通道（现役版没有 handler，驱动回 `{"__parity":"no-handler"}`）对拍没有可比对象，
 * 因此不参与逐字段比较，但必须在 NO_HANDLER_ROWS 里逐条写明理由：没登记的直接算差异，
 * 登记了却没触发的会在结尾报出来（防止现役版早补上了 handler，登记还挂在原处）。
 *   node tests/parity/diff-cross.mjs --electron a.json --tauri b.json --baseline c.json
 */
import fs from "node:fs";
import path from "node:path";
import { compareChannel, isEmptyPayload, normalizeChannel, readDump } from "./normalize.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const UPDATE = args.includes("--update");
const ELECTRON = path.resolve(ROOT, value("--electron", path.join(".parity-out", "electron.json")));
const TAURI = path.resolve(ROOT, value("--tauri", path.join(".parity-out", "tauri.json")));
const ELECTRON_BASELINE = path.resolve(
  ROOT,
  value("--baseline", path.join("tests", "parity", "fixtures", "channels", "electron-baseline.json"))
);

/**
 * 两实现之间「本来就该不同」的键。规则：
 *   1. 只列**具体键**，不整通道豁免 —— 通道里其余的键仍然照常比；
 *   2. 每条必须写明理由，且理由要能指到代码/时序/测试手段，不能写「已知差异」；
 *   3. 豁免后两侧都退化成空载荷（`{}` / `null`）也算一致（send 通道就是这种）。
 */
const EXEMPTION_ROWS = [
  {
    channel: "app:info",
    keys: ["version", "legacy"],
    reason:
      "version：两实现的版本号本就不同（现役 0.1.x / 新外壳 0.2.0；harness 的 package.json 是 0.0.0），版本一致性由 npm run version:check 单独把关，通道 golden 不承担这件事。" +
      "legacy：新外壳独有的「老数据接管回执」（app:info.legacy，见 docs/S9 §8），现役版没有这个键、也不该有。",
  },
  {
    channel: "log:read",
    keys: ["reason"],
    reason:
      "新外壳多回一个可空 reason（现役版写的是 JS undefined，JSON 序列化后键直接消失）。渲染层只读 ok/exists/size/mtime/lines。",
  },
  {
    channel: "metrics:get",
    keys: ["virtualMemTotalGB", "virtualMemUsedGB"],
    reason:
      "契约是 number|null，取不取得到取决于采样通道：现役版走 PowerShell/CIM（harness 下可能为 null），新外壳直调 GlobalMemoryStatusEx（恒有值）。数值本身属 volatile。",
  },
  {
    channel: "services:list",
    keys: ["cpuPercent", "memMB"],
    reason:
      "新外壳独有的逐进程读数：services:list 的每个元素多回 cpuPercent / memMB（sysinfo 按 pid 采样，见 src-tauri/src/process.rs 的 list_with_stats）。Electron harness 不拉起服务进程、也没有逐进程采样，现役版没有这两项、也不该有；startedAt 走 VOLATILE_KEYS 归一，不需要单列。",
  },
  {
    channel: "terminal:input",
    keys: ["__parity"],
    reason: "send 通道没有回包：驱动占位符在 Electron 侧是字符串 \"undefined\"，Tauri 侧是 null。",
  },
  {
    channel: "terminal:resize",
    keys: ["__parity"],
    reason: "同 terminal:input：send 通道没有回包，占位符形状不同。",
  },
  {
    channel: "update:state",
    keys: ["state", "currentVersion", "message"],
    reason:
      "harness 不对称：Tauri 自检真的加载渲染层（渲染层首屏/聚焦会主动 update:check → checking），Electron harness 不加载渲染层 → 一直 idle；currentVersion 的差异同 app:info.version。",
  },
  {
    channel: "mods:templates",
    keys: ["templates", "fileCount", "sizeBytes"],
    reason:
      "新外壳独有的「骨架体积读数」：`fileCount` = files.length，`sizeBytes` = 用示例 draft 走同一条生成管线量出来的真实字节数，渲染层用它替掉原型里写死的假体积（S9 创建模组对齐改造）。现役版 modsTemplates 没有这两项、也不该有；`templates` 整项豁免是因为新外壳多了一个现役版给不出的案例模板（`bus-patch`「Source Patch via Bus」，教的是注入总线 `__evejsMods.register`，0.1.28 既没有总线也没有这个模板）。共享的那两个模板并非无人看守：它们连同体积一起被 `tests/parity/fixtures/channels/tauri-baseline.json` 逐字段钉住，改坏会先在自家 golden 上红。",
  },
];
const EXEMPTIONS = new Map(EXEMPTION_ROWS.map((row) => [row.channel, { keys: new Set(row.keys), text: row.reason }]));

/**
 * 现役版**没有 handler** 的通道：新外壳独有的能力，Electron 驱动只能回占位符 `{"__parity":"no-handler"}`。
 * 口径与豁免表一致 —— 只放行登记在册的通道，理由要能指到代码，不能写「已知差异」。
 */
const NO_HANDLER_ROWS = [
  {
    channel: "market:overview",
    reason:
      "物品市场（新外壳独有）：直读服务端活库（vendor/cli/market-cli.js + src-tauri/src/market.rs）。现役 Electron 0.1.28 既没有这个页面、也没有对应 handler，对拍没有可比对象。",
  },
  {
    channel: "market:catalog",
    reason: "同 market:overview：市场分类树 + 全量物品清单，现役版没有这项能力。",
  },
  {
    channel: "market:book",
    reason: "同 market:overview：单件物品的盘口明细，现役版没有这项能力。",
  },
  {
    channel: "market:trades",
    reason: "同 market:overview：最近成交回执，现役版没有这项能力。",
  },
];
const NO_HANDLER = new Map(NO_HANDLER_ROWS.map((row) => [row.channel, row.reason]));

/** 驱动对「本实现没有这条通道」的占位回包：单键对象 `{__parity: "no-handler"}` */
function isNoHandler(node) {
  return (
    !!node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    Object.keys(node).length === 1 &&
    node.__parity === "no-handler"
  );
}

/** 递归剔除豁免键（数组元素也过一遍），返回新对象，不改原 dump */
function dropKeys(node, keys) {
  if (Array.isArray(node)) return node.map((item) => dropKeys(item, keys));
  if (node && typeof node === "object") {
    const out = {};
    for (const name of Object.keys(node)) {
      if (keys.has(name)) continue;
      out[name] = dropKeys(node[name], keys);
    }
    return out;
  }
  return node;
}

if (!fs.existsSync(ELECTRON)) {
  console.error(`找不到 Electron dump：${ELECTRON}（先跑 npm run parity:electron）`);
  process.exit(2);
}

/* ---------- --update：把当前 Electron dump 冻成基线 ---------- */

if (UPDATE) {
  const raw = readDump(ELECTRON, fs);
  const normalized = {};
  for (const channel of Object.keys(raw).sort()) normalized[channel] = normalizeChannel(channel, raw[channel]);
  fs.mkdirSync(path.dirname(ELECTRON_BASELINE), { recursive: true });
  fs.writeFileSync(ELECTRON_BASELINE, JSON.stringify({ channels: normalized }, null, 2) + "\n", "utf8");
  console.log(`已更新 Electron 基线：${path.relative(ROOT, ELECTRON_BASELINE)}（${Object.keys(normalized).length} 个通道）`);
  process.exit(0);
}

if (!fs.existsSync(TAURI)) {
  console.error(`找不到 Tauri dump：${TAURI}（先跑 npm run parity:dump）`);
  process.exit(2);
}
if (!fs.existsSync(ELECTRON_BASELINE)) {
  console.error(`找不到 Electron 基线：${path.relative(ROOT, ELECTRON_BASELINE)}（先跑 npm run parity:electron:update）`);
  process.exit(2);
}

/* ---------- 前置：先确认「参考实现」自身没漂移 ---------- */

const electron = readDump(ELECTRON, fs);
const tauri = readDump(TAURI, fs);
const electronBaseline = readDump(ELECTRON_BASELINE, fs);
const drift = [];
for (const channel of [...new Set([...Object.keys(electronBaseline), ...Object.keys(electron)])].sort()) {
  if (!(channel in electronBaseline)) drift.push(`${channel}：Electron 新增通道（确认后 --update）`);
  else if (!(channel in electron)) drift.push(`${channel}：Electron 本次没产出（自检失败？）`);
  else {
    const changed = compareChannel(channel, electronBaseline[channel], electron[channel]);
    if (changed) drift.push(`${channel}：${changed.join(", ")}`);
  }
}

/* ---------- 主体：Electron ↔ Tauri ---------- */

const problems = [];
const used = new Set();
const noHandlerUsed = new Set();
const all = [...new Set([...Object.keys(electron), ...Object.keys(tauri)])].sort();
for (const channel of all) {
  if (!(channel in electron)) {
    problems.push(`${channel}：Electron 侧没有该通道`);
    continue;
  }
  if (!(channel in tauri)) {
    problems.push(`${channel}：Tauri 侧没有该通道`);
    continue;
  }
  if (isNoHandler(electron[channel])) {
    if (!NO_HANDLER.has(channel)) {
      problems.push(`${channel}：现役版没有 handler，且未在 NO_HANDLER_ROWS 里登记理由`);
    } else {
      noHandlerUsed.add(channel);
    }
    continue;
  }

  const exemption = EXEMPTIONS.get(channel);
  const before = compareChannel(channel, electron[channel], tauri[channel]);
  if (!before) continue;

  if (!exemption) {
    problems.push(`${channel}：字段变化 → ${before.join(", ")}`);
    continue;
  }
  const left = dropKeys(electron[channel], exemption.keys);
  const right = dropKeys(tauri[channel], exemption.keys);
  let leftover = compareChannel(channel, left, right);
  if (leftover && isEmptyPayload(left) && isEmptyPayload(right)) leftover = null; // 两侧都空 = 一致
  if (leftover) problems.push(`${channel}：扣除豁免后仍有差异 → ${leftover.join(", ")}`);
  else used.add(channel);
}

const unused = [...EXEMPTIONS.keys()].filter((channel) => !used.has(channel));

/* ---------- 输出 ---------- */

if (drift.length > 0) {
  console.error(`Electron 参考实现相对冻结基线有 ${drift.length} 项漂移：`);
  for (const item of drift) console.error("  - " + item);
  console.error("\n说明：跨实现比对的前提是「参考实现不变」。确认现役版升级属预期后跑 `node tests/parity/diff-cross.mjs --update`。");
  process.exit(1);
}
if (problems.length > 0) {
  console.error(`跨实现比对有 ${problems.length} 项差异：`);
  for (const item of problems) console.error("  - " + item);
  console.error("\n人工确认属预期后，在 diff-cross.mjs 的 EXEMPTION_ROWS 里补一条**写明理由**的豁免；真有实现差异则改代码。");
  process.exit(1);
}

console.log(`跨实现比对一致（${all.length} 个通道；豁免命中 ${used.size}/${EXEMPTIONS.size} 条）`);
for (const [channel, exemption] of EXEMPTIONS) {
  if (used.has(channel)) console.log(`  · ${channel} → 豁免 ${[...exemption.keys].join(", ")}（这次确实不同，已按理由放行）`);
}
if (unused.length > 0) {
  console.log(`  · 未被触发的豁免（两侧当前一致，复核后可从 EXEMPTION_ROWS 删掉）：${unused.join(", ")}`);
}
const unusedNoHandler = [...NO_HANDLER.keys()].filter((channel) => !noHandlerUsed.has(channel));
if (unusedNoHandler.length > 0) {
  console.log(`  · 未被触发的 no-handler 登记（现役版这次有 handler 了，复核后可从 NO_HANDLER_ROWS 删掉）：${unusedNoHandler.join(", ")}`);
}
