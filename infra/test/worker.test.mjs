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

// identity() 收在 ./fixtures.mjs（三个测试文件原本各抄一份）
import { identity } from "./fixtures.mjs"

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

/** 造一个「只有 KV 有分片、D1 没有对应行」的假环境，专测过期分片的清理 */
function shardEnv({ rows = [], stars = [], keys = [], me }) {
  const stored = []
  const deleted = []
  /** KV 桩做成真的键值表：跳过重复写入的逻辑必须先读得到上一轮写进去的东西 */
  const map = new Map()
  return {
    stored,
    deleted,
    env: {
      DB: {
        prepare: (sql) => ({
          all: async () => {
            if (/FROM stars/.test(sql)) return { results: stars }
            if (/FROM reviews r/.test(sql)) return { results: rows.map((row) => projectionRow(sql, row)) }
            return { results: [] }
          },
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      },
      SNAPSHOTS: {
        get: async (key) => map.get(key) ?? null,
        put: async (key, value) => {
          map.set(key, value)
          stored.push({ key, value })
        },
        list: async ({ prefix }) => ({ keys: keys.map((name) => ({ name })).filter((item) => item.name.startsWith(prefix)) }),
        delete: async (name) => {
          map.delete(name)
          deleted.push(name)
        },
      },
      RATINGS_SIGNING_KEY: me.pkcs8,
      RATINGS_KEY_ID: me.keyId,
    },
  }
}

const REVIEW_ROW = {
  id: "rv-1790882024887-29688",
  mod_id: "evejs-a",
  version: "1.0.0",
  stars: 5,
  body: "装上就能用",
  author_name: "",
  corp: "",
  country: "CN",
  key_id: "abcd1234ef",
  created_at: 1790882024887,
  updated_at: 1790882024887,
  edited: 0,
  hidden: 0,
  reply_body: "",
  reply_at: null,
  reply_edited: 0,
}

test("最后一条评价删掉之后，旧分片要跟着消失（否则界面上「删掉的评论还在」）", async () => {
  const me = await identity()
  const { env, stored, deleted } = shardEnv({
    rows: [],
    keys: ["snapshot:reviews:evejs-a", "snapshot:reviews:evejs-gone"],
    me,
  })
  const result = await rebuildSnapshots(env, 1790882060253)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.removed, 2, "两条过期分片都要删")
  assert.deepEqual(deleted.sort(), ["snapshot:reviews:evejs-a", "snapshot:reviews:evejs-gone"])
  assert.equal(
    stored.filter((item) => item.key.startsWith("snapshot:reviews:")).length,
    0,
    "一条评价都没有就不该再写分片"
  )
})

test("有评价的模组分片要重建，别人的过期分片照删", async () => {
  const me = await identity()
  const { env, stored, deleted } = shardEnv({
    rows: [REVIEW_ROW],
    keys: ["snapshot:reviews:evejs-a", "snapshot:reviews:evejs-gone"],
    me,
  })
  const result = await rebuildSnapshots(env, 1790882060253)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.shards, 1)
  assert.equal(result.removed, 1)
  assert.deepEqual(deleted, ["snapshot:reviews:evejs-gone"])
  const shard = stored.find((item) => item.key === "snapshot:reviews:evejs-a")
  assert.ok(shard, "有评价的模组要重新签一份分片")
  assert.equal(JSON.parse(shard.value).reviews[0].country, "CN")
})

test("星标：真签名的 POST /v1/stars 200 落库，只动 stars 表", async () => {
  const me = await identity()
  const payload = {
    action: "star.add",
    modId: "evejs-autolockfire",
    identityId: "au-1234",
    publicKey: me.publicKey,
    at: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const request = new Request("https://ping.5318.cm/v1/stars", {
    method: "POST",
    body: JSON.stringify(signed),
    headers: { "content-type": "application/json" },
  })
  const env = fakeEnv()
  const ctx = ctxSpy()
  const body = await (await worker.fetch(request, env, ctx)).json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.equal(body.starred, true)
  const insert = env.calls.find((call) => call.sql.includes("INSERT INTO stars"))
  assert.ok(insert, "点星应该写 stars 表")
  assert.equal(insert.args[2], me.keyId, "落库的 keyId 必须是验签得到的那一个")
  assert.ok(
    !env.calls.some((call) => call.sql.includes("INSERT INTO reviews")),
    "点星不该顺手写一条评论"
  )
  await Promise.allSettled(ctx.waited)
  assert.equal(ctx.waited.length, 1, "写成功必须挂一次快照重算")
})

test("星标：取消走 DELETE，回包里 starred=false", async () => {
  const me = await identity()
  const payload = {
    action: "star.remove",
    modId: "evejs-autolockfire",
    identityId: "au-1234",
    publicKey: me.publicKey,
    at: Date.now(),
  }
  const signed = await signDocument(me.pkcs8, payload, me.keyId)
  const request = new Request("https://ping.5318.cm/v1/stars/remove", {
    method: "POST",
    body: JSON.stringify(signed),
    headers: { "content-type": "application/json" },
  })
  const env = fakeEnv()
  const body = await (await worker.fetch(request, env, ctxSpy())).json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.equal(body.starred, false)
  assert.ok(env.calls.some((call) => call.sql.includes("DELETE FROM stars")))
  // 取消不看市场名单：模组下架了也要能把星收回去，所以不该有 mod_versions 的查询
  assert.ok(!env.calls.some((call) => call.sql.includes("FROM mod_versions")))
})

test("星标：0.3.x 那种把 star.add 发到 /v1/reviews 的写法也认（兼容网关）", async () => {
  const me = await identity()
  const payload = {
    action: "star.add",
    modId: "evejs-autolockfire",
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
  const env = fakeEnv()
  const body = await (await worker.fetch(request, env, ctxSpy())).json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.ok(env.calls.some((call) => call.sql.includes("INSERT INTO stars")))
})

test("老客户端打分 = 一颗星：一条 INSERT INTO reviews 之外还要写一颗星", async () => {
  const me = await identity()
  const payload = {
    action: "review.upsert",
    modId: "evejs-autolockfire",
    version: "1.0.10",
    pkgSha256: SHA,
    stars: 3,
    body: "",
    reviewId: "rv-test-0003",
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
  const env = fakeEnv()
  const body = await (await worker.fetch(request, env, ctxSpy())).json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.ok(env.calls.some((call) => call.sql.includes("INSERT INTO stars")), "老客户端的分值要折算成星标")
})

test("只点星没写评论的模组也要出分片（否则新界面上那颗星点不亮）", async () => {
  const me = await identity()
  const now = 1790882060253
  const { env, stored } = shardEnv({
    rows: [],
    stars: [{ mod_id: "evejs-a", key_id: "abcd1234de", created_at: now - 1000 }],
    me,
  })
  const result = await rebuildSnapshots(env, now)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.stars, 1, "job_runs 里要能看出这一轮有多少颗星")

  const ratings = JSON.parse(stored.find((item) => item.key === "snapshot:ratings").value)
  assert.equal(ratings.mods["evejs-a"].stars, 1)
  assert.equal(ratings.mods["evejs-a"].comments, 0)

  const shard = stored.find((item) => item.key === "snapshot:reviews:evejs-a")
  assert.ok(shard, "只有星标也要有分片")
  const payload = JSON.parse(shard.value)
  assert.deepEqual(payload.stars, { count: 1, keys: ["abcd1234de"] })
  assert.deepEqual(payload.reviews, [])
})

test("KV 额度：内容没变就不重复写（每 10 分钟全量重写会撞免费额度）", async () => {
  const me = await identity()
  const { env, stored } = shardEnv({ rows: [REVIEW_ROW], me })

  const first = await rebuildSnapshots(env, 1790882060253)
  assert.equal(first.ok, true, JSON.stringify(first))
  // 首轮：聚合 + 1 份分片 + 赞助人名单 = 3 次写
  assert.equal(first.writes, 3)
  assert.equal(first.skipped, 0)
  assert.equal(stored.length, 3)

  // 同样的数据、只有时间戳不同：内容没变，一个 put 都不该发
  const second = await rebuildSnapshots(env, 1790882069999)
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.writes, 0, "第二轮不该再写 KV")
  assert.equal(second.skipped, 3)
  assert.equal(stored.length, 3, "put 次数必须还是 3")

  // 数据真的变了（多一条评价）→ 只有受影响的那两份重新写：聚合 + 那一份分片
  env.DB.prepare = ((base) => (sql) => {
    const stmt = base(sql)
    if (/FROM reviews r/.test(sql)) {
      return {
        ...stmt,
        all: async () => ({
          results: [
            projectionRow(sql, REVIEW_ROW),
            projectionRow(sql, { ...REVIEW_ROW, id: "rv-2", key_id: "ffff0000aa", body: "第二条" }),
          ],
        }),
      }
    }
    return stmt
  })(env.DB.prepare)
  const third = await rebuildSnapshots(env, 1790882075000)
  assert.equal(third.writes, 2, "只有聚合与改动过的分片要重写")
  assert.equal(third.skipped, 1, "赞助人名单没变，跳过")
})

test("定时任务：KV 写挂了也要留一条失败台账，而不是留着上一次的成功", async () => {
  const me = await identity()
  const recorded = []
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => {
          if (/INSERT INTO job_runs/.test(sql)) recorded.push(args)
          return { run: async () => ({ success: true }) }
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    },
    SNAPSHOTS: {
      get: async () => null,
      // 模拟额度用尽：KV put 直接 429
      put: async () => {
        throw new Error("KV PUT failed: 429 Too Many Requests")
      },
      list: async () => ({ keys: [] }),
      delete: async () => {},
    },
    RATINGS_SIGNING_KEY: me.pkcs8,
    RATINGS_KEY_ID: me.keyId,
  }

  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctxSpy())

  const row = recorded.find((args) => args[0] === "rebuild-snapshots")
  assert.ok(row, "抛异常也必须写一条 job_runs，否则看板显示的是上一次的成功")
  assert.equal(row[2], 0, "ok 必须是 0")
  assert.match(String(row[3]), /429/, "原因里要能看出是额度/限流，而不是一句「失败」")
})
