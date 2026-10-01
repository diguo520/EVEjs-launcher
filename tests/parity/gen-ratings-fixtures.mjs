#!/usr/bin/env node
/**
 * 冻结评价快照的测试向量：合法 / 篡改 / 坏签名。
 *
 * 与 `gen-manifest-fixtures.mjs` 同一个套路，但**签名用的是服务端那份实现**
 * （`infra/src/canonical.js`，WebCrypto），不是 Node 自家的 `crypto.sign`：
 * 真正在 Cloudflare 上签名的是它，而验签的是 Rust —— 两边必须逐字节对齐，
 * 这条向量就是那个「逐字节」的锁。
 *
 * 私钥由固定种子派生（sha256("evejs-s4-ratings-fixture")），可重新生成，不涉及发布密钥。
 *
 * 用法：node tests/parity/gen-ratings-fixtures.mjs
 *
 * 生成后两边共同读取：
 *   - Rust：src-tauri/src/mods/ratings.rs 的 parity 用例（include_str! 同一份文件）
 *   - Node：infra/test/canonical.test.mjs
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { bytesToBase64, signDocument, verifyPayload } from "../../infra/src/canonical.js"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const OUT_DIR = path.join(ROOT, "tests", "parity", "fixtures", "ratings")
const SEED_TEXT = "evejs-s4-ratings-fixture"
const KEY_ID = "evejs-ratings-parity-fixture"
/** 与 src-tauri/src/mods/ratings.rs 的 parity 用例保持一致；派生结果不一致就 fail */
const EXPECTED_PUBKEY = "P5Ff2fawc4t4PhYpYq2m2aBu2CQvwC5T7D4T3uO/A0Y="

const seed = crypto.createHash("sha256").update(SEED_TEXT, "utf8").digest()
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed])
const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
const rawPubkey = crypto
  .createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .subarray(12)
  .toString("base64")

const payload = {
  schemaVersion: 1,
  generatedAt: 1790842714426,
  mods: {
    "evejs-autolockfire": { average: 4.62, count: 13, withText: 4, histogram: [0, 1, 1, 3, 8] },
    "evejs-automining": { average: 4.0, count: 3, withText: 1, histogram: [0, 1, 0, 1, 1] },
    "中文文本修复": { average: 5.0, count: 1, withText: 1, histogram: [0, 0, 0, 0, 1] },
  },
}

const valid = await signDocument(bytesToBase64(pkcs8), payload, KEY_ID)
const tampered = { ...valid, generatedAt: valid.generatedAt + 1 }
const badSig = JSON.parse(JSON.stringify(valid))
const bytes = Buffer.from(badSig.signature.sig, "base64")
bytes[0] ^= 0xff
badSig.signature.sig = bytes.toString("base64")

// 自检：JS 侧自己签的自己得验得过，否则向量本身就是坏的
if (!(await verifyPayload(rawPubkey, valid))) throw new Error("自检失败：valid 验不过")
if (await verifyPayload(rawPubkey, tampered)) throw new Error("自检失败：tampered 竟然验过了")

fs.mkdirSync(OUT_DIR, { recursive: true })
const write = (name, value) =>
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2) + "\n", "utf8")
write("valid.json", valid)
write("tampered.json", tampered)
write("bad-signature.json", badSig)
write("expected.json", {
  keyId: KEY_ID,
  pubkey: rawPubkey,
  seedSha256Of: SEED_TEXT,
  verdicts: { "valid.json": true, "tampered.json": false, "bad-signature.json": false },
})
console.log(`已写入 ${OUT_DIR}`)
console.log(`公钥（base64 raw）：${rawPubkey}`)
if (EXPECTED_PUBKEY !== "REPLACE_PUBKEY" && EXPECTED_PUBKEY !== rawPubkey) {
  throw new Error(`派生公钥与 Rust 固定向量不一致：${rawPubkey} != ${EXPECTED_PUBKEY}`)
}