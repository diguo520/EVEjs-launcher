/** 补给线名单快照：校验、去重、币种归一化 —— 与启动器侧 sponsor-source.ts 同一套口径 */
import assert from "node:assert/strict"
import test from "node:test"

import { bytesToBase64, keyIdFromRaw, verifyPayload } from "../src/canonical.js"
import worker, { rebuildSnapshots } from "../src/index.js"
import { SNAPSHOT_SCHEMA_VERSION, normalizeCurrency, sponsorSnapshot } from "../src/snapshot.js"
import { SPONSOR_LIST } from "../src/sponsors.js"

const entry = (over = {}) => ({ name: "星海孤舟", amount: 666, currency: "CNY", ...over })

test("快照：按原顺序保留，字段就是启动器要的四个", () => {
  const snapshot = sponsorSnapshot([entry(), entry({ name: "星轨拾荒者", amount: 500 })], 1234)
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
  assert.equal(snapshot.generatedAt, 1234)
  assert.deepEqual(snapshot.sponsors, [
    { id: "sponsor-01", name: "星海孤舟", amount: 666, currency: "CNY" },
    { id: "sponsor-02", name: "星轨拾荒者", amount: 500, currency: "CNY" },
  ])
})

test("快照：名字空、金额缺失 / 非数 / 负数都丢掉", () => {
  const snapshot = sponsorSnapshot([
    entry({ name: "  " }),
    entry({ name: "无金额", amount: undefined }),
    entry({ name: "空串金额", amount: "" }),
    entry({ name: "乱写金额", amount: "一" }),
    entry({ name: "负数", amount: -5 }),
    entry({ name: "甲", amount: 1 }),
  ])
  assert.deepEqual(snapshot.sponsors.map((item) => item.name), ["甲"])
})

test("快照：同名只留第一条，金额保留两位小数", () => {
  const snapshot = sponsorSnapshot([
    entry({ name: "星海孤舟", amount: 666 }),
    entry({ name: "星海孤舟", amount: 128 }),
    entry({ name: "星尘补给", amount: 32.666 }),
  ])
  assert.deepEqual(snapshot.sponsors.map((item) => [item.name, item.amount]), [
    ["星海孤舟", 666],
    ["星尘补给", 32.67],
  ])
})

test("快照：id 撞车时退回按顺序生成的稳定 id（启动器拿它当 key）", () => {
  const snapshot = sponsorSnapshot([
    entry({ id: "same", name: "甲" }),
    entry({ id: "same", name: "乙" }),
  ])
  assert.deepEqual(snapshot.sponsors.map((item) => item.id), ["same", "sponsor-02"])
  assert.equal(new Set(snapshot.sponsors.map((item) => item.id)).size, 2)
})

test("币种：三位字母照收并转大写，其余一律退回 CNY", () => {
  assert.equal(normalizeCurrency("usd"), "USD")
  assert.equal(normalizeCurrency(" EUR "), "EUR")
  assert.equal(normalizeCurrency("rmb"), "RMB", "三个字母就照收：宁可原样显示，也不猜它想表达什么")
  assert.equal(normalizeCurrency("人民币"), "CNY")
  assert.equal(normalizeCurrency(undefined), "CNY")
  assert.equal(normalizeCurrency("US"), "CNY")
  assert.equal(normalizeCurrency("USDT"), "CNY")
})

/** 一对真能用的 Ed25519 身份：私钥进 env、公钥拿来验签 */
async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    publicKey: bytesToBase64(raw),
    keyId: await keyIdFromRaw(raw),
    pkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  }
}

/** 只够把重建快照这条路径跑起来的 env：D1 给空结果，KV 用内存 Map */
function fakeEnv(me) {
  const store = new Map()
  const statement = {
    bind() {
      return statement
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  }
  return {
    store,
    DB: { prepare: () => statement },
    SNAPSHOTS: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => void store.set(key, value),
    },
    RATINGS_SIGNING_KEY: me.pkcs8,
    RATINGS_KEY_ID: me.keyId,
  }
}

test("重建快照：名单一起签出来，/v1/sponsors.json 取到的就是它，且验签通过", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const result = await rebuildSnapshots(env, 1759_000_000_000)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.sponsors, SPONSOR_LIST.length)

  const response = await worker.fetch(
    new Request("https://ping.5318.cm/v1/sponsors.json"),
    env,
    { waitUntil() {}, passThroughOnException() {} }
  )
  assert.equal(response.status, 200)
  const snapshot = await response.json()
  assert.equal(snapshot.generatedAt, 1759_000_000_000)
  assert.equal(snapshot.sponsors.length, SPONSOR_LIST.length)
  assert.ok(await verifyPayload(me.publicKey, snapshot), "快照必须能被内置公钥验过")
  // 改一个字节就验不过 —— 这是「多镜像 + 缓存」敢用的前提
  const tampered = { ...snapshot, sponsors: [...snapshot.sponsors, { id: "x", name: "假", amount: 1, currency: "CNY" }] }
  assert.equal(await verifyPayload(me.publicKey, tampered), false)
})

test("重建快照：没配签名密钥就不发布（fail closed）", async () => {
  const result = await rebuildSnapshots({ SNAPSHOTS: { put: async () => {} } }, 1)
  assert.equal(result.ok, false)
  assert.match(result.reason, /RATINGS_SIGNING_KEY/)
})

test("随包的名单本身是合法的：非空、id 与名字都不重复、金额都是数字", () => {
  const snapshot = sponsorSnapshot(SPONSOR_LIST, 0)
  assert.ok(snapshot.sponsors.length >= 2, "名单不该是空的")
  assert.equal(snapshot.sponsors.length, SPONSOR_LIST.length, "随包名单里不该有被丢掉的条目")
  assert.equal(new Set(snapshot.sponsors.map((item) => item.id)).size, snapshot.sponsors.length)
  assert.equal(new Set(snapshot.sponsors.map((item) => item.name)).size, snapshot.sponsors.length)
  for (const item of snapshot.sponsors) {
    assert.ok(Number.isFinite(item.amount) && item.amount >= 0, item.name)
    assert.match(item.currency, /^[A-Z]{3}$/)
  }
  // 用户明确说过「赞助人也有国外的，不全是人民币」——这条钉住美元那条路径
  assert.ok(snapshot.sponsors.some((item) => item.currency !== "CNY"), "名单里应有非人民币币种")
})
