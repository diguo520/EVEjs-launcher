#!/usr/bin/env node
/**
 * 版本单一来源（S4）：`package.json` 是唯一手改的地方，另外两处由本脚本同步。
 *
 *   package.json            "version": "0.2.0"   ← 只改这里
 *   src-tauri/tauri.conf.json  "version": "0.2.0"
 *   src-tauri/Cargo.toml       version = "0.2.0"（[package] 段）
 *
 * 用法：
 *   node scripts/sync-version.mjs            # 同步
 *   node scripts/sync-version.mjs --check     # 门禁：三处必须一致（不一致退出码 1）
 *   node scripts/sync-version.mjs --set 0.3.0 # 先改 package.json 再同步
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PKG = path.join(ROOT, "package.json");
const CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");
const CARGO = path.join(ROOT, "src-tauri", "Cargo.toml");
const CHECK = process.argv.includes("--check");
const setIndex = process.argv.indexOf("--set");
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
if (setIndex >= 0) {
  const next = process.argv[setIndex + 1];
  if (!next || !VERSION_RE.test(next)) {
    console.error("--set 需要一个 x.y.z 版本号");
    process.exit(2);
  }
  pkg.version = next;
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`package.json → ${next}`);
}
const version = pkg.version;
if (!VERSION_RE.test(version)) {
  console.error(`package.json 的 version 不是 x.y.z：${version}`);
  process.exit(2);
}

/* ---------- tauri.conf.json ---------- */
const confRaw = fs.readFileSync(CONF, "utf8");
const conf = JSON.parse(confRaw);
const cargoRaw = fs.readFileSync(CARGO, "utf8");
const cargoMatch = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoRaw);
if (!cargoMatch) {
  console.error("Cargo.toml 里找不到 [package] 段的 version");
  process.exit(2);
}

if (CHECK) {
  const problems = [];
  if (conf.version !== version) problems.push(`tauri.conf.json 是 ${conf.version}`);
  if (cargoMatch[1] !== version) problems.push(`Cargo.toml 是 ${cargoMatch[1]}`);
  if (problems.length > 0) {
    console.error(`版本不一致（以 package.json 的 ${version} 为准）：${problems.join("；")}`);
    console.error("跑 `node scripts/sync-version.mjs` 同步。");
    process.exit(1);
  }
  console.log(`版本单一来源一致：${version}`);
  process.exit(0);
}

const nextConf = confRaw.replace(`"version": "${conf.version}"`, `"version": "${version}"`);
if (nextConf !== confRaw) fs.writeFileSync(CONF, nextConf, "utf8");
const nextCargo = cargoRaw.replace(
  /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
  `$1${version}$2`
);
if (nextCargo !== cargoRaw) fs.writeFileSync(CARGO, nextCargo, "utf8");
console.log(`版本已同步为 ${version}：tauri.conf.json / Cargo.toml`);