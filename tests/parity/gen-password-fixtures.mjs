#!/usr/bin/env node
/**
 * 冻结「客户端同款密码哈希」测试向量（S3 §5.2 固定向量第 1 类）。
 *
 * 向量由**现役版**（Electron）的 scripts/account-cli.js 生成并冻结，
 * 之后由 tests/parity/run.mjs 断言**新工程随包的 vendor/cli/account-cli.js** 逐字节一致
 * —— 这样 B5 给 CLI 加 `--password-stdin` 时，不会悄悄改掉哈希语义。
 *
 * 用法：
 *   node tests/parity/gen-password-fixtures.mjs --cli <account-cli.js 路径>
 *   node tests/parity/gen-password-fixtures.mjs --cli vendor/cli/account-cli.js --out /tmp/check.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const CLI = value("--cli");
const OUT = value("--out", path.join(ROOT, "tests", "parity", "fixtures", "password-hash.json"));
if (!CLI) {
  console.error("用法：node tests/parity/gen-password-fixtures.mjs --cli <account-cli.js> [--out <json>]");
  process.exit(2);
}

/** 覆盖：普通、大小写用户名（算法会 lowercase）、非 ASCII、首尾空格、长密码、单字符 */
const CASES = [
  { user: "Alice", password: "P@ssw0rd!2026" },
  { user: "Alice_ADMIN", password: "MixedCase-User-Key" },
  { user: "operator_01", password: "中文密码-🔒-2026" },
  { user: "  spaced_user  ", password: "  leading and trailing  " },
  { user: "long", password: "x".repeat(64) },
  { user: "one", password: "a" },
];

const vectors = CASES.map(({ user, password }) => {
  const hash = execFileSync(process.execPath, [CLI, "hash", user, password], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`CLI 未返回 40 位 hex 哈希：${user} → ${hash}`);
  return { user, password, hash };
});

const fixture = {
  producedBy: path.resolve(CLI).replaceAll("\\", "/"),
  algorithm: "SHA1(pw_utf16le ++ user.trim().toLowerCase()_utf16le) 迭代 1000 次，hex",
  vectors,
};
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`已写入 ${OUT}（${vectors.length} 条向量，来源 ${fixture.producedBy}）`);