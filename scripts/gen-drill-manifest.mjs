#!/usr/bin/env node
/**
 * 本地演练用的**已签名**更新清单（L8 / A1）。
 *
 * 为什么另起一个脚本：真实发布的清单由 CI Secret 里的私钥签（scripts/gen-update-key.mjs --sign），
 * 演练不能碰那把密钥。这里用与 tests/parity/gen-manifest-fixtures.mjs **同一个固定种子**派生密钥
 * （sha256("evejs-s3-parity-fixture") → Ed25519 种子），再配合启动器的
 * `EVEJS_UPDATE_KEY_ID` / `EVEJS_UPDATE_PUBKEY` 覆盖（updater.rs 的 update_signer_from），
 * 就能把「验签 → 取平台资产 → 哈希比对」这条链路完整真跑一遍，
 * 而内置公钥保持不变（未配置 = 拒绝一切更新，fail closed）。
 *
 * 用法：
 *   node scripts/gen-drill-manifest.mjs --payload <exe> --version 0.2.1 --out <manifest.json> [--notes-zh "…"]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const payload = value("--payload");
const version = value("--version");
const out = value("--out");
if (!payload || !fs.existsSync(payload) || !version || !out) {
  console.error("用法：node scripts/gen-drill-manifest.mjs --payload <exe> --version 0.2.1 --out <manifest.json>");
  process.exit(2);
}

/** 与 tests/parity/gen-manifest-fixtures.mjs 同源：固定种子 → Ed25519，公钥必须逐字节一致 */
const SEED_TEXT = "evejs-s3-parity-fixture";
const KEY_ID = "evejs-parity-fixture";
const EXPECTED_PUBKEY = "fDkGYSbWJoAYFSHj/TRjZm3NXx+7Rr4scyJLPN/5mdc=";

const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === "object") {
    const sorted = {};
    for (const key of Object.keys(node).sort()) sorted[key] = canonicalize(node[key]);
    return sorted;
  }
  return node;
};
const canonicalManifestJson = (manifest) => {
  const { signature, ...rest } = manifest;
  void signature;
  return JSON.stringify(canonicalize(rest));
};

const seed = crypto.createHash("sha256").update(SEED_TEXT, "utf8").digest();
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const rawPubkey = crypto
  .createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .subarray(12)
  .toString("base64");
if (rawPubkey !== EXPECTED_PUBKEY) {
  throw new Error(`派生公钥与固定向量不一致：${rawPubkey} != ${EXPECTED_PUBKEY}`);
}

const bytes = fs.readFileSync(payload);
const absolute = path.resolve(payload).replace(/\\/g, "/");
const manifest = {
  version,
  platforms: {
    // key 必须与 updater.rs 的 platform_keys() 一致：先 "win32-x64"
    "win32-x64": {
      url: pathToFileURL(absolute).href,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
  },
  notes: { "zh-CN": value("--notes-zh", `演练载荷 ${version}`) },
  publishedAt: new Date().toISOString(),
};
const signature = crypto.sign(null, Buffer.from(canonicalManifestJson(manifest), "utf8"), privateKey);
const signed = { ...manifest, signature: { alg: "ed25519", keyId: KEY_ID, sig: signature.toString("base64") } };

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(signed, null, 2) + "\n", "utf8");
console.log(`已生成 ${out}`);
console.log(`  version=${version}  size=${bytes.length}  sha256=${manifest.platforms["win32-x64"].sha256}`);
console.log(`  验签公钥（演练用）：EVEJS_UPDATE_KEY_ID=${KEY_ID} EVEJS_UPDATE_PUBKEY=${EXPECTED_PUBKEY}`);