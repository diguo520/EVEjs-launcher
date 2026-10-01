/** 与 Rust 的逐字节对齐：canonical JSON、keyId 派生、签名往返 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  bytesToBase64,
  canonicalJson,
  keyIdFromRaw,
  signDocument,
  verifyPayload,
} from "../src/canonical.js"

const FIXTURE_DIR = path.resolve(import.meta.dirname, "..", "..", "tests", "parity", "fixtures", "ratings")

/** 从固定种子派生一把测试密钥（与 tests/parity/gen-ratings-fixtures.mjs 同一套） */
function fixtureKey(seedText = "evejs-s4-ratings-fixture") {
  const seed = crypto.createHash("sha256").update(seedText, "utf8").digest()
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed])
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  const raw = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
  return { pkcs8, raw, pubkey: raw.toString("base64") }
}

test("规范化：摘掉顶层 signature，递归按 key 升序，紧凑输出", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, signature: { sig: "x" } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}')
})

test("规范化：数组保持原序，不被排序", () => {
  assert.equal(canonicalJson({ list: [3, 1, 2] }), '{"list":[3,1,2]}')
})

test("keyId = sha256(原始公钥).hex()[..12]", async () => {
  const { raw } = fixtureKey()
  const expected = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)
  assert.equal(await keyIdFromRaw(raw), expected)
})

test("签名往返：自己签的自己验得过", async () => {
  const { pkcs8, pubkey } = fixtureKey("evejs-ratings-roundtrip")
  const signed = await signDocument(bytesToBase64(pkcs8), { schemaVersion: 1, mods: {} }, "k1")
  assert.equal(signed.signature.alg, "ed25519")
  assert.equal(signed.signature.keyId, "k1")
  assert.equal(await verifyPayload(pubkey, signed), true)
})

test("签名：改一个字节就验不过", async () => {
  const { pkcs8, pubkey } = fixtureKey("evejs-ratings-tamper")
  const signed = await signDocument(bytesToBase64(pkcs8), { generatedAt: 1 }, "k1")
  assert.equal(await verifyPayload(pubkey, { ...signed, generatedAt: 2 }), false)
})

test("签名：换一把公钥验不过", async () => {
  const signer = fixtureKey("evejs-ratings-a")
  const other = fixtureKey("evejs-ratings-b")
  const signed = await signDocument(bytesToBase64(signer.pkcs8), { generatedAt: 1 }, "k1")
  assert.equal(await verifyPayload(other.pubkey, signed), false)
})

test("签名：缺 signature / 算法不对 / sig 不是 base64 都当验签失败，不抛异常", async () => {
  const { pubkey } = fixtureKey()
  assert.equal(await verifyPayload(pubkey, { generatedAt: 1 }), false)
  assert.equal(await verifyPayload(pubkey, { generatedAt: 1, signature: { alg: "rsa", sig: "AA" } }), false)
  assert.equal(await verifyPayload(pubkey, { generatedAt: 1, signature: { alg: "ed25519", sig: "" } }), false)
  assert.equal(await verifyPayload("not-a-key", { generatedAt: 1, signature: { alg: "ed25519", sig: "AA" } }), false)
})

test("固定向量：冻结的 valid.json 能验过，tampered / bad-signature 必须被拒", async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf8"))
  const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"))
  assert.equal(await verifyPayload(expected.pubkey, read("valid.json")), true)
  assert.equal(await verifyPayload(expected.pubkey, read("tampered.json")), false)
  assert.equal(await verifyPayload(expected.pubkey, read("bad-signature.json")), false)
  // 公钥指纹也要对得上 Rust 用例里写死的那个
  assert.equal(await keyIdFromRaw(Buffer.from(expected.pubkey, "base64")), await keyIdFromRaw(fixtureKey().raw))
})