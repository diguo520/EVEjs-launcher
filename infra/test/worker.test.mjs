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

import { bytesToBase64, keyIdFromRaw, signDocument } from "../src/canonical.js"
import worker from "../src/index.js"

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