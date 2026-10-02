/**
 * Worker 入口（fetch / scheduled）的回归锁。
 *
 * 为什么单开一个文件：`ctx` 只活在 `fetch(request, env, ctx)` 的第三个参数里。少写这一个
 * 参数不是「功能少一点」，而是**所有**请求都 500「ctx is not defined」——健康检查也一样。
 * 2026-10-01 接写路径（写成功要 `ctx.waitUntil` 触发快照重算）时踩过一次，
 * 所以这里既发真请求，也把入口那行签名钉死。
 */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { bytesToBase64, keyIdFromRaw, signDocument, verifyPayload } from "../src/canonical.js"
import worker, { rebuildSnapshots } from "../src/index.js"

const SHA = "a".repeat(64)

/** 只够把请求路径跑起来的最小 env：D1 / KV 桩；签名密钥留空只影响快照，不影响请求路径 */
function fakeEnv() {
  const calls = []
  const prepare = (sql) => {
    const statement = {
      bind: (...args) => {
        calls.push({ sql, args })
        return statement
      },
      first: async () => {
        if (sql.includes("SELECT 1 AS hit")) return { hit: 1 }
        if (sql.includes("SELECT used FROM rate_limits")) return { used: 0 }
        if (sql.includes("FROM reviews")) return { reviews: 0, versions: 0, replies: 0 }
        return null
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }
    return statement
  }
  return { DB: { prepare }, SNAPSHOTS: { get: async () => null, put: async () => {} }, calls }
}

function ctxSpy() {
  const waited = []
  return { waited, waitUntil: (task) => waited.push(task), passThroughOnException() {} }
}

/** 一对真能用的 Ed25519 身份（公钥 base64 / keyId / PKCS8 私钥 base64） */
async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    publicKey: bytesToBase64(raw),
    keyId: await keyIdFromRaw(raw),
    pkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  }
}

test("入口签名把 ctx 接住并往下传", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8")
  assert.match(source, /async fetch\(request, env, ctx\)/)
  assert.match(source, /await handle\(request, env, ctx\)/)
})

test("健康检查走真请求路径：200，且不是「ctx is not defined」", async () => {
  const response = await worker.fetch(
    new Request("https://ping.5318.cm/v1/health"),
    fakeEnv(),
    ctxSpy()
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.service, "evejs-mod-ratings")
  assert.notEqual(body.reason, "ctx is not defined")
})

test("评价：真签名的请求 200 落库，国家码进库，并挂上 ctx.waitUntil", async () => {
  const me = await identity()
  const payload = {
    action: "review.upsert",
    modId: "evejs-autolockfire",
    version: "1.0.10",
    pkgSha256: SHA,
    stars: 5,
    body: "装上就能用",
    reviewId: "rv-test-0001",
    identityId: "au-1234",
    publicKey: me.publicKey,
    createdAt: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const request = new Request("https://ping.5318.cm/v1/reviews", {
    method: "POST",
    body: JSON.stringify(signed),
    headers: { "content-type": "application/json" },
  })
  // Cloudflare 上这个属性由边缘填；Node 的 Request 没有，手动补一个
  Object.defineProperty(request, "cf", { value: { country: "de" } })

  const env = fakeEnv()
  const ctx = ctxSpy()
  const response = await worker.fetch(request, env, ctx)
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.country, "DE")

  // 国家码落在 INSERT 的第 7 个参数上（列序见 upsertReview 的 SQL）
  const insert = env.calls.find((call) => call.sql.includes("INSERT INTO reviews"))
  assert.ok(insert, "应该有一条 INSERT INTO reviews")
  assert.equal(insert.args[6], "DE")

  await Promise.allSettled(ctx.waited)
  assert.equal(ctx.waited.length, 1, "写成功必须挂一次快照重算")
})

test("评价：没签名的请求被带着原因拒掉（不是 500，更不是 200）", async () => {
  const request = new Request("https://ping.5318.cm/v1/reviews", {
    method: "POST",
    body: JSON.stringify({ action: "review.upsert" }),
  })
  const response = await worker.fetch(request, fakeEnv(), ctxSpy())
  assert.equal(response.status, 400)
  assert.equal((await response.json()).ok, false)
})

test("没有这个写接口的 POST 是 404，不是崩", async () => {
  const request = new Request("https://ping.5318.cm/v1/nope", {
    method: "POST",
    body: JSON.stringify({}),
  })
  const response = await worker.fetch(request, fakeEnv(), ctxSpy())
  assert.equal(response.status, 404)
})

test("回复发到 /v1/reviews（0.3.0 的写法）也按 action 分派，不再报 version 不合法", async () => {
  const me = await identity()
  const payload = {
    action: "reply.upsert",
    modId: "evejs-autolockfire",
    reviewId: "rv-test-0001",
    body: "谢谢反馈，已经修了",
    identityId: "au-1234",
    publicKey: me.publicKey,
    at: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const request = new Request("https://ping.5318.cm/v1/reviews", {
    method: "POST",
    body: JSON.stringify(signed),
    headers: { "content-type": "application/json" },
  })
  const body = await (await worker.fetch(request, fakeEnv(), ctxSpy())).json()
  // 走到「作者校验」说明已经过了 validateReply + 验签；撞进 validateReview 的话
  // 会是 400「version 不合法」—— 那正是这次要钉死的回归。
  assert.equal(body.reason, "只有这个模组的作者能回复")
})

test("同一个路径上的评价请求仍旧走 validateReview", async () => {
  const request = new Request("https://ping.5318.cm/v1/reviews", {
    method: "POST",
    body: JSON.stringify({ action: "review.upsert", modId: "evejs-autolockfire" }),
    headers: { "content-type": "application/json" },
  })
  const body = await (await worker.fetch(request, fakeEnv(), ctxSpy())).json()
  assert.equal(body.reason, "version 不合法")
})

test("拿不到 request.cf 时用 CF-IPCountry 头兜底", async () => {
  const me = await identity()
  const payload = {
    action: "review.upsert",
    modId: "evejs-autolockfire",
    version: "1.0.10",
    pkgSha256: SHA,
    stars: 4,
    body: "没有 cf 对象也要记到地区",
    reviewId: "rv-test-0002",
    identityId: "au-1234",
    publicKey: me.publicKey,
    createdAt: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const request = new Request("https://ping.5318.cm/v1/reviews", {
    method: "POST",
    body: JSON.stringify(signed),
    headers: { "content-type": "application/json", "CF-IPCountry": "cn" },
  })
  const env = fakeEnv()
  const body = await (await worker.fetch(request, env, ctxSpy())).json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.equal(body.country, "CN")
})

test("健康检查带上边缘诊断（排查「来自未知地区」用）", async () => {
  const request = new Request("https://ping.5318.cm/v1/health", {
    headers: { "CF-IPCountry": "de" },
  })
  Object.defineProperty(request, "cf", { value: { country: "de", colo: "FRA" } })
  const body = await (await worker.fetch(request, fakeEnv(), ctxSpy())).json()
  assert.equal(body.edge.country, "DE")
  assert.equal(body.edge.headerCountry, "DE")
  assert.equal(body.edge.colo, "FRA")
  assert.equal(body.edge.hasCf, true)
})
/**
 * D1 只回 SELECT 里点名的列。少写一列不是「回空值」，是这一列在快照里**根本不存在** ——
 * `shardItem` 老老实实读 `row.country`，读到的永远是 undefined，界面上所有人于是都成了
 * 「来自未知地区的玩家」（2026-10-02 报障）。这里按 D1 的投影语义造桩：只回 SQL 里点到的列，
 * `readReviewRows` 少点一列，这条测试就红。
 */
function projectionRow(sql, row) {
  const flat = sql.replace(/\s+/g, " ")
  const list = flat.slice(flat.indexOf("SELECT ") + 7, flat.indexOf(" FROM ")).trim()
  const out = {}
  for (const raw of list.split(",")) {
    const item = raw.trim()
    if (!item) continue
    const [expression, alias] = item.split(/\s+AS\s+/i)
    const key = (alias ?? expression).trim().replace(/^[a-z]+\./i, "")
    out[key] = row[key]
  }
  return out
}

test("评论分片带着地区码：SELECT 少一列就等于所有人都来自未知地区", async () => {
  const now = 1790882060253
  const me = await identity()
  const row = {
    id: "rv-1790882024887-29688",
    mod_id: "evejs-a",
    version: "1.0.0",
    stars: 5,
    body: "装上就能用",
    author_name: "",
    corp: "",
    country: "CN",
    key_id: "abcd1234ef",
    created_at: now - 5000,
    updated_at: now - 5000,
    edited: 0,
    hidden: 0,
    reply_body: "",
    reply_at: null,
    reply_edited: 0,
  }
  const stored = []
  let selectList = ""
  const env = {
    DB: {
      prepare: (sql) => ({
        all: async () => {
          if (/FROM reviews r/.test(sql)) {
            selectList = sql
            return { results: [projectionRow(sql, row)] }
          }
          return { results: [] }
        },
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    },
    SNAPSHOTS: {
      get: async () => null,
      put: async (key, value) => stored.push({ key, value }),
    },
    RATINGS_SIGNING_KEY: me.pkcs8,
    RATINGS_KEY_ID: me.keyId,
  }

  const result = await rebuildSnapshots(env, now)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(selectList, /r\.country/, "SELECT 里少了 r.country，分片就带不出地区码")

  const shard = stored.find((item) => item.key === "snapshot:reviews:evejs-a")
  assert.ok(shard, "应该写出 evejs-a 的分片")
  const payload = JSON.parse(shard.value)
  assert.equal(payload.reviews.length, 1)
  assert.equal(payload.reviews[0].country, "CN")
})

test("没有评论的模组回一份签名的空分片，而不是 503（503 会让启动器去翻本地旧缓存）", async () => {
  const me = await identity()
  const env = {
    DB: {
      prepare: () => ({
        bind() { return this },
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    },
    SNAPSHOTS: { get: async () => null, put: async () => {} },
    RATINGS_SIGNING_KEY: me.pkcs8,
    RATINGS_KEY_ID: me.keyId,
  }
  const response = await worker.fetch(
    new Request("https://ping.5318.cm/v1/reviews/evejs-a.json"),
    env,
    ctxSpy()
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.modId, "evejs-a")
  assert.deepEqual(body.reviews, [])
  assert.equal(body.signature?.keyId, me.keyId)
  assert.equal(await verifyPayload(me.publicKey, body), true, "空分片也要签名，启动器才肯收")
})

test("撤回评论顺手删掉挂在它上面的回复（不留孤儿）", async () => {
  const me = await identity()
  const reviewId = "rv-1790882024887-29688"
  const payload = {
    action: "review.retract",
    modId: "evejs-autolockfire",
    identityId: "au-1234",
    publicKey: me.publicKey,
    at: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const calls = []
  const env = {
    DB: {
      prepare: (sql) => {
        const statement = {
          bind: (...args) => {
            calls.push({ sql, args })
            return statement
          },
          all: async () =>
            sql.includes("SELECT id FROM reviews") ? { results: [{ id: reviewId }] } : { results: [] },
          first: async () => null,
          run: async () => ({ success: true }),
        }
        return statement
      },
    },
    SNAPSHOTS: { get: async () => null, put: async () => {} },
  }
  const response = await worker.fetch(
    new Request("https://ping.5318.cm/v1/reviews/retract", {
      method: "POST",
      body: JSON.stringify(signed),
      headers: { "content-type": "application/json" },
    }),
    env,
    ctxSpy()
  )
  const body = await response.json()
  assert.equal(body.ok, true, JSON.stringify(body))
  const replies = calls.find((call) => /DELETE FROM replies WHERE review_id IN/.test(call.sql))
  assert.ok(replies, "应该顺手删掉回复，而不是只删评论")
  assert.deepEqual(replies.args, [reviewId])
  assert.ok(
    calls.some((call) => /DELETE FROM reviews WHERE mod_id/.test(call.sql)),
    "评论本身当然也要删"
  )
})
