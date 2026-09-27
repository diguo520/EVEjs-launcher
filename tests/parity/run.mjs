#!/usr/bin/env node
/**
 * S3 §5.2「双实现一致性」驱动程序（固定向量部分，跑在最前）。
 *
 * 覆盖计划 §5.2 规则 4 的三类固定向量：
 *   A. manifest：valid / tampered / bad-signature 三个 fixture 的判定结果，JS 与 Rust 一致
 *      —— Rust 侧同一份文件见 src-tauri/src/updater.rs::js_signed_manifest_verifies_in_rust；
 *   B. Ed25519 交叉验证：JS 签名 / JS 验签，公钥由固定种子派生（gen-manifest-fixtures.mjs 会校验与 Rust 常量一致）；
 *   C. 密码哈希：fixture 由**现役版** account-cli.js 冻结，这里断言**新工程随包**的
 *      vendor/cli/account-cli.js 逐字节一致（argv 与 --password-stdin 两条路都要一致）。
 *
 * 用法：node tests/parity/run.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANIFEST_DIR = path.join(ROOT, "tests", "parity", "fixtures", "manifest");
const PASSWORD_FIXTURE = path.join(ROOT, "tests", "parity", "fixtures", "password-hash.json");
const VENDOR_CLI = path.join(ROOT, "vendor", "cli", "account-cli.js");
const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", green: "\u001b[32m", yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m" }
  : { red: "", green: "", yellow: "", dim: "", reset: "" };

const failures = [];
const pass = (label) => console.log("  " + COLOR.green + "\u2713" + COLOR.reset + " " + label);
const fail = (label, detail) => {
  failures.push(label + (detail ? " —— " + detail : ""));
  console.log("  " + COLOR.red + "\u2717" + COLOR.reset + " " + label + (detail ? " —— " + detail : ""));
};

/* ---------- A/B) manifest 固定向量 ---------- */

const expected = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, "expected.json"), "utf8"));
const verifyFixture = (file) =>
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "gen-update-key.mjs"),
      "--verify",
      path.join(MANIFEST_DIR, file),
      "--key-id",
      expected.keyId,
      "--pubkey",
      expected.pubkey,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
for (const [file, verdict] of Object.entries(expected.verdicts)) {
  try {
    verifyFixture(file);
    if (verdict) pass(`manifest ${file}：验签通过（期望通过）`);
    else fail(`manifest ${file}：验签意外通过（期望拒绝）`);
  } catch {
    if (verdict) fail(`manifest ${file}：验签失败（期望通过）`);
    else pass(`manifest ${file}：已拒绝（期望拒绝）`);
  }
}

/* ---------- C) 密码哈希固定向量 ---------- */

const fixture = JSON.parse(fs.readFileSync(PASSWORD_FIXTURE, "utf8"));
let hashOk = 0;
for (const vector of fixture.vectors) {
  const argvHash = execFileSync(process.execPath, [VENDOR_CLI, "hash", vector.user, vector.password], {
    encoding: "utf8",
  }).trim();
  const stdinHash = execFileSync(process.execPath, [VENDOR_CLI, "hash", vector.user, "--password-stdin"], {
    encoding: "utf8",
    input: vector.password + "\n",
  }).trim();
  if (argvHash !== vector.hash) fail(`密码向量 ${JSON.stringify(vector.user)}：argv 哈希不一致`, `${argvHash} != ${vector.hash}`);
  else if (stdinHash !== vector.hash) fail(`密码向量 ${JSON.stringify(vector.user)}：stdin 哈希不一致`, `${stdinHash} != ${vector.hash}`);
  else hashOk += 1;
}
if (hashOk === fixture.vectors.length) {
  pass(`密码哈希 ${hashOk}/${fixture.vectors.length} 条向量与现役版冻结值一致（argv + --password-stdin 两条路）`);
}

/* ---------- 汇总 ---------- */

if (failures.length > 0) {
  console.error(COLOR.red + `\nparity 固定向量未通过（${failures.length} 项）：` + COLOR.reset);
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log(
  COLOR.dim + `\nparity 固定向量全部通过（manifest 3 条 + 密码哈希 ${fixture.vectors.length} 条；通道级 golden 见 docs/S3-查重与审核-实施记录.md §7）` + COLOR.reset
);