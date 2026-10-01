/**
 * 补给线名单的管理接口：令牌、输入校验、KV 里的名单本体、写完立刻重签。
 *
 * 这个接口是**唯一**能改名单的地方，所以测试盯三件事：
 *   - 没配令牌时必须是关的（fail closed），配了令牌但不对必须拒；
 *   - 打错的输入（空名字 / 「一」当金额 / 币种写成「人民币」）当场顶回去，且**不写 KV**；
 *   - 写进去的东西真的会进快照 —— 而快照是启动器唯一读的东西。
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  SPONSOR_SOURCE_KEY,
  checkSponsorInput,
  parseSponsorSource,
  removeSponsor,
  upsertSponsor,
} from "../src/admin.js"
import { bytesToBase64, keyIdFromRaw, verifyPayload } from "../src/canonical.js"
import worker, { rebuildSnapshots } from "../src/index.js"
import { SPONSOR_LIST } from "../src/sponsors.js"

const TOKEN = "fixture-admin-token-0123456789"

test("输入校验：名字必填、金额是非负有限数、币种要么三位字母要么别写", () => {
  assert.equal(checkSponsorInput({ name: " 星海孤舟 ", amount: "666" }).entry.amount, 666)
  assert.equal(checkSponsorInput({ name: "甲", amount: 0 }).ok, true, "0 是合法金额")
  assert.equal(checkSponsorInput({ name: "甲", amount: "usd" }).ok, false)
  assert.equal(checkSponsorInput({ name: "甲", amount: -1 }).ok, false)
  assert.equal(checkSponsorInput({ name: "甲", amount: "" }).ok, false)
  assert.equal(checkSponsorInput({ name: "  ", amount: 1 }).ok, false)

  // 币种：快照那层会悄悄兜成 CNY，这一层直接拒 —— 打错字的人得当场知道
  assert.equal(checkSponsorInput({ name: "甲", amount: 1, currency: "usd" }).entry.currency, "USD")
  assert.equal(checkSponsorInput({ name: "甲", amount: 1, currency: "" }).entry.currency, "CNY")
  assert.equal(checkSponsorInput({ name: "甲", amount: 1, currency: "人民币" }).ok, false)
  assert.equal(checkSponsorInput({ name: "甲", amount: 1, currency: "USDT" }).ok, false)
})

test("加或改：新名字追加到末尾，同名只改金额且位置不动", () => {
  const added = upsertSponsor([{ name: "甲", amount: 1, currency: "CNY" }], { name: "乙", amount: 2 })
  assert.equal(added.mode, "added")
  assert.deepEqual(added.entries.map((item) => item.name), ["甲", "乙"])

  const updated = upsertSponsor(added.entries, { name: "甲", amount: 99, currency: "USD" })
  assert.equal(updated.mode, "updated")
  assert.deepEqual(updated.entries.map((item) => item.name), ["甲", "乙"], "顺序是维护者排的，改金额不该跳到末尾")
  assert.deepEqual(updated.entries[0], { name: "甲", amount: 99, currency: "USD" })
})

test("删：先按名字、再按 id；删不存在的条目不算错", () => {
  const list = [{ id: "s1", name: "甲", amount: 1, currency: "CNY" }, { id: "s2", name: "乙", amount: 2, currency: "CNY" }]
  assert.deepEqual(removeSponsor(list, { name: "甲" }).entries.map((item) => item.name), ["乙"])
  assert.deepEqual(removeSponsor(list, { id: "s2" }).entries.map((item) => item.name), ["甲"])
  assert.equal(removeSponsor(list, { name: "丙" }).removed, false)
  assert.equal(removeSponsor(list, {}).ok, false, "不说删谁就直接拒")
})

test("KV 里的名单本体：解析不出来就当没有（手改坏了也不会把服务带崩）", () => {
  assert.equal(parseSponsorSource(null), null)
  assert.equal(parseSponsorSource("{ 不是 JSON"), null)
  assert.equal(parseSponsorSource('{"sponsors":[]}'), null)
  assert.deepEqual(parseSponsorSource('[{"name":"甲","amount":1},null,"x"]'), [{ name: "甲", amount: 1 }])
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

/** 够跑管理接口与重算快照的 env：D1 给空结果，KV 用内存 Map，令牌由 options 决定 */
function fakeEnv(me, options = {}) {
  const store = new Map()
  const statement = {
    bind() {
      return statement
    },
    all: async () => ({ results: [] }),
    first: async () => (options.rateLimited ? { used: 999 } : null),
    run: async () => ({ success: true }),
  }
  return {
    store,
    DB: { prepare: () => statement },
    SNAPSHOTS: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
    },
    RATINGS_SIGNING_KEY: me.pkcs8,
    RATINGS_KEY_ID: me.keyId,
    SPONSOR_ADMIN_TOKEN: options.token === null ? undefined : (options.token ?? TOKEN),
  }
}

function http(env) {
  return (path, init = {}) =>
    worker.fetch(new Request("https://ping.5318.cm" + path, init), env, {
      waitUntil() {},
      passThroughOnException() {},
    })
}

const post = (call, path, body, token = TOKEN) =>
  call(path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const get = (call, path, token = TOKEN) => call(path, { headers: { Authorization: "Bearer " + token } })

test("令牌：没配就是关的，配得太短也是关的，配了但不带 / 不对一律 401", async () => {
  const me = await identity()

  const off = fakeEnv(me, { token: null })
  const offCall = http(off)
  assert.equal((await get(offCall, "/v1/admin/sponsors")).status, 503, "没配 secret 时接口必须是关的")
  assert.equal((await post(offCall, "/v1/admin/sponsors", { name: "甲", amount: 1 })).status, 503)

  const tooShort = fakeEnv(me, { token: "short" })
  assert.equal((await get(http(tooShort), "/v1/admin/sponsors")).status, 503)

  const env = fakeEnv(me)
  const call = http(env)
  assert.equal((await call("/v1/admin/sponsors")).status, 401, "没带 Authorization")
  assert.equal((await get(call, "/v1/admin/sponsors", "wrong-token-0000000000")).status, 401, "令牌不对")
  assert.equal((await post(call, "/v1/admin/sponsors", { name: "甲", amount: 1 }, "wrong-token-0000000000")).status, 401)
  assert.equal(env.store.has(SPONSOR_SOURCE_KEY), false, "鉴权没过时一个字都不该写进 KV")
})

test("名单默认来自代码里的种子；回包不发 CORS 头（跨站读不到）", async () => {
  const me = await identity()
  const call = http(fakeEnv(me))
  const response = await get(call, "/v1/admin/sponsors")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("access-control-allow-origin"), null)
  const body = await response.json()
  assert.equal(body.source, "seed")
  assert.deepEqual(body.sponsors.map((item) => item.name), SPONSOR_LIST.map((item) => item.name))
})

test("加一个人：写进 KV、回包是归一化视图，重算后快照里有他且验签通过", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const call = http(env)

  // 刻意用一个种子里没有的名字：同名会被判成「改」（那条另有测试）
  const response = await post(call, "/v1/admin/sponsors", { name: "Cmdr. Nova Prime", amount: "50", currency: "usd" })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.action, "added")
  const added = body.sponsors.at(-1)
  assert.deepEqual([added.name, added.amount, added.currency], ["Cmdr. Nova Prime", 50, "USD"])
  assert.ok(added.id, "回包里的条目都带 id（启动器拿它当 key）")

  assert.ok(env.store.has(SPONSOR_SOURCE_KEY), "名单本体要落 KV，不能只活在这一次请求里")
  assert.equal(JSON.parse(env.store.get(SPONSOR_SOURCE_KEY)).length, SPONSOR_LIST.length + 1)

  const rebuilt = await rebuildSnapshots(env, 1759_000_000_000)
  assert.equal(rebuilt.ok, true, rebuilt.reason)
  assert.equal(rebuilt.sponsors, SPONSOR_LIST.length + 1)
  assert.equal(rebuilt.sponsorsSource, "kv")

  const snapshot = await (await call("/v1/sponsors.json")).json()
  assert.ok(await verifyPayload(me.publicKey, snapshot), "启动器要能验过这份快照")
  assert.ok(snapshot.sponsors.some((item) => item.name === "Cmdr. Nova Prime" && item.currency === "USD"))
})

test("同名再存一次是「改」，不是再来一条", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const call = http(env)

  await post(call, "/v1/admin/sponsors", { name: "星海孤舟", amount: 888 })
  const response = await post(call, "/v1/admin/sponsors", { name: "星海孤舟", amount: 999 })
  const body = await response.json()
  assert.equal(body.action, "updated")
  assert.equal(body.sponsors.length, SPONSOR_LIST.length, "总数不该变")
  assert.equal(body.sponsors[0].name, "星海孤舟")
  assert.equal(body.sponsors[0].amount, 999)
  assert.equal(JSON.parse(env.store.get(SPONSOR_SOURCE_KEY)).length, SPONSOR_LIST.length)
})

test("打错的输入当场拒，且不污染 KV", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const call = http(env)
  for (const bad of [{ name: "  ", amount: 1 }, { name: "甲", amount: "一" }, { name: "甲", amount: -1 }, { name: "甲", amount: 1, currency: "人民币" }]) {
    const response = await post(call, "/v1/admin/sponsors", bad)
    assert.equal(response.status, 400, JSON.stringify(bad))
    assert.equal((await response.json()).ok, false)
  }
  assert.equal(env.store.has(SPONSOR_SOURCE_KEY), false)
})

test("删人：删掉了就落 KV；删不存在的只是 removed:false，KV 不动", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const call = http(env)

  await post(call, "/v1/admin/sponsors", { name: "临时的人", amount: 1 })
  const removed = await post(call, "/v1/admin/sponsors/remove", { name: "临时的人" })
  const body = await removed.json()
  assert.equal(body.removed, true)
  assert.equal(body.sponsors.some((item) => item.name === "临时的人"), false)
  assert.equal(JSON.parse(env.store.get(SPONSOR_SOURCE_KEY)).length, SPONSOR_LIST.length)

  const before = env.store.get(SPONSOR_SOURCE_KEY)
  const missing = await post(call, "/v1/admin/sponsors/remove", { name: "根本没这人" })
  assert.equal((await missing.json()).removed, false)
  assert.equal(env.store.get(SPONSOR_SOURCE_KEY), before, "没删到就不该重写 KV")
})

test("重置：清掉 KV 那份，回到代码里的种子", async () => {
  const me = await identity()
  const env = fakeEnv(me)
  const call = http(env)

  await post(call, "/v1/admin/sponsors", { name: "临时的人", amount: 1 })
  assert.ok(env.store.has(SPONSOR_SOURCE_KEY))

  const response = await post(call, "/v1/admin/sponsors/reset", {})
  const body = await response.json()
  assert.equal(body.source, "seed")
  assert.equal(env.store.has(SPONSOR_SOURCE_KEY), false)
  assert.deepEqual(body.sponsors.map((item) => item.name), SPONSOR_LIST.map((item) => item.name))
})

test("没这个管理接口就是 404（写路径不会漏到别的分支）", async () => {
  const me = await identity()
  const call = http(fakeEnv(me))
  const response = await post(call, "/v1/admin/whatever", {})
  assert.equal(response.status, 404)
})

test("限流：同一个网络一小时改太多次就 429", async () => {
  const me = await identity()
  const call = http(fakeEnv(me, { rateLimited: true }))
  const response = await post(call, "/v1/admin/sponsors", { name: "甲", amount: 1 }, TOKEN)
  // 没有 CF-Connecting-IP 时不算桶（本地与测试都走这条），所以这里自己造一个头
  const realCall = http(fakeEnv(me, { rateLimited: true }))
  const limited = await realCall("/v1/admin/sponsors", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify({ name: "甲", amount: 1 }),
  })
  assert.equal(response.status, 200, "没有 IP 头时不限流（本地调试与测试）")
  assert.equal(limited.status, 429)
})
