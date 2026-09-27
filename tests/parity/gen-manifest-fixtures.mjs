#!/usr/bin/env node
/**
 * 冻结 manifest 测试向量（S3 §5.2 固定向量第 2/3 类）：合法 / 篡改 / 坏签名。
 *
 * 私钥由固定种子派生（sha256("evejs-s3-parity-fixture") → Ed25519 种子），
 * 所以向量可重新生成、且不涉及任何真实发布密钥。
 * 规范化规则与 Rust `canonical_manifest_json` 逐字节一致（见 scripts/gen-update-key.mjs）。
 *
 * 用法：node tests/parity/gen-manifest-fixtures.mjs
 *
 * 生成后由两边共同读取：
 *   - Rust：src-tauri/src/updater.rs 的 parity 用例（include_str! 同一份文件）
 *   - Node：tests/parity/run.mjs（调 scripts/gen-update-key.mjs --verify）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "tests", "parity", "fixtures", "manifest");
const SEED_TEXT = "evejs-s3-parity-fixture";
const KEY_ID = "evejs-parity-fixture";
/** 与 src-tauri/src/updater.rs 的 parity 用例保持一致；派生结果不一致就 fail */
const EXPECTED_PUBKEY = "fDkGYSbWJoAYFSHj/TRjZm3NXx+7Rr4scyJLPN/5mdc=";

function canonicalize(node) {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
}
const canonicalManifestJson = (manifest) => {
  const { signature, ...rest } = manifest;
  void signature;
  return JSON.stringify(canonicalize(rest));
};

const seed = crypto.createHash("sha256").update(SEED_TEXT, "utf8").digest();
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const publicKey = crypto.createPublicKey(privateKey);
const rawPubkey = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
if (rawPubkey !== EXPECTED_PUBKEY) {
  throw new Error(`派生公钥与 Rust 固定向量不一致：${rawPubkey} != ${EXPECTED_PUBKEY}`);
}

const base = {
  version: "0.3.0",
  platforms: {
    "windows-x86_64": {
      url: "https://example.com/evejs-launcher.zip",
      sha256: "a".repeat(64),
      sizeBytes: 12345,
    },
    "windows-i686": {
      url: "https://example.com/evejs-launcher-x86.zip",
      sha256: "b".repeat(64),
      sizeBytes: 23456,
    },
  },
  notes: { "zh-CN": "新版本" },
  publishedAt: "2026-09-26T00:00:00.000Z",
};
const sign = (payload) => {
  const signature = crypto.sign(null, Buffer.from(canonicalManifestJson(payload), "utf8"), privateKey);
  return { ...payload, signature: { alg: "ed25519", keyId: KEY_ID, sig: signature.toString("base64") } };
};

const valid = sign(base);
const tampered = { ...valid, version: "9.9.9" };
const badSig = JSON.parse(JSON.stringify(valid));
badSig.signature.sig = Buffer.from(badSig.signature.sig, "base64");
badSig.signature.sig[0] ^= 0xff;
badSig.signature.sig = badSig.signature.sig.toString("base64");

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8");
write("valid.json", valid);
write("tampered.json", tampered);
write("bad-signature.json", badSig);
write("expected.json", {
  keyId: KEY_ID,
  pubkey: EXPECTED_PUBKEY,
  seedSha256Of: SEED_TEXT,
  verdicts: { "valid.json": true, "tampered.json": false, "bad-signature.json": false },
});
console.log(`已写入 ${OUT_DIR}（valid / tampered / bad-signature / expected，公钥 ${rawPubkey}）`);