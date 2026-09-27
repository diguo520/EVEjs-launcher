#!/usr/bin/env node
/**
 * 通道级 golden 比对（S3 §5.2 规则 1/2）：把 `driver-*` 产出的 dump 与冻结基线逐通道比。
 *
 * 规范化（volatile 字段白名单、时间戳、绝对路径）、「按结构比对」的通道清单、单通道比对函数都在
 * `normalize.mjs` 里 —— 驱动只负责「原样搬运回包」，比对口径集中一处，
 * 于是 Electron 侧 dump（S5 / L2）能用同一套规则做**跨实现**比对（见 diff-cross.mjs）。
 *
 * 用法：
 *   node tests/parity/diff.mjs                       # 当前 dump ↔ 冻结基线
 *   node tests/parity/diff.mjs --update              # 把当前 dump 写成新基线（人工 review 后再提交）
 *   node tests/parity/diff.mjs --current a.json --baseline b.json
 */
import fs from "node:fs";
import path from "node:path";
import { SHAPE_ONLY_CHANNELS, compareChannel, normalize, readDump } from "./normalize.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const UPDATE = args.includes("--update");
const CURRENT = value("--current", path.join(ROOT, ".parity-out", "tauri.json"));
const BASELINE = value("--baseline", path.join(ROOT, "tests", "parity", "fixtures", "channels", "tauri-baseline.json"));

if (!fs.existsSync(CURRENT)) {
  console.error(`找不到当前 dump：${CURRENT}（先跑 npm run parity:dump）`);
  process.exit(2);
}

if (UPDATE) {
  const current = readDump(CURRENT, fs);
  const normalized = {};
  for (const channel of Object.keys(current).sort()) normalized[channel] = normalize(current[channel]);
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({ channels: normalized }, null, 2) + "\n", "utf8");
  console.log(`已更新基线：${path.relative(ROOT, BASELINE)}（${Object.keys(normalized).length} 个通道）`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`找不到基线：${BASELINE}（先跑 npm run parity:channels:update）`);
  process.exit(2);
}

const base = readDump(BASELINE, fs);
const current = readDump(CURRENT, fs);
const all = [...new Set([...Object.keys(base), ...Object.keys(current)])].sort();
const problems = [];
for (const channel of all) {
  if (!(channel in base)) problems.push(`${channel}：基线里没有（新增通道？确认后 --update）`);
  else if (!(channel in current)) problems.push(`${channel}：本次 dump 里没有（通道被移除或自检失败）`);
  else {
    const changed = compareChannel(channel, base[channel], current[channel]);
    if (changed) {
      problems.push(
        SHAPE_ONLY_CHANNELS.has(channel)
          ? `${channel}：结构变化（该通道按结构比对）→ ${changed.join(", ")}`
          : `${channel}：字段变化 → ${changed.join(", ")}`
      );
    }
  }
}

const shapeOnly = all.filter((channel) => SHAPE_ONLY_CHANNELS.has(channel));
if (problems.length === 0) {
  console.log(`通道级 golden 一致（${all.length} 个通道，volatile 字段已归一；其中 ${shapeOnly.length} 个按结构比对：${shapeOnly.join(", ")}）`);
  process.exit(0);
}
console.error(`通道级 golden 有 ${problems.length} 项差异：`);
for (const problem of problems) console.error("  - " + problem);
console.error("\n人工确认属于预期变化后，用 `node tests/parity/diff.mjs --update` 刷新基线。");
process.exit(1);