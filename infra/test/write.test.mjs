/**
 * 写路径纯逻辑的单测。
 *
 * 重点不是「能不能通过」，而是**各种恶心输入都被带着原因拒掉**：
 * 写路径上放过的每一条都会进别人的启动器，而这条链路没有人工复核这一环。
 */
import assert from "node:assert/strict"
import test from "node:test"

import { base64ToBytes, keyIdFromRaw } from "../src/canonical.js"
import { isSafeModId } from "../src/snapshot.js"
import {
  MAX_REPLY_BODY,
  MAX_REVIEW_BODY,
  publicKeyMatchesKeyId,
  sanitizeCountry,
  validateReply,
  validateReplyRetract,
  validateReport,
  validateRetract,
  validateReview,
} from "../src/write.js"

/** 32 字节 Ed25519 公钥的 base64（内容无所谓，形状对就行） */
const PUBLIC_KEY = "LLpRDoklrpCAKUwJ781tj9KF9uqKM9HDZ2cfzM8xLlc="
const SHA = "a".repeat(64)
const NOW = Date.now()

const reviewInput = (over = {}) => ({
  modId: "evejs-autolockfire",
  version: "1.0.10",
  pkgSha256: SHA,
  stars: 5,
  body: "装上就能用",
  reviewId: "rv-test-0001",
  identityId: "au-1234",
  publicKey: PUBLIC_KEY,
  createdAt: NOW,
  ...over,
})

test("国家码：只认 Cloudflare 那两字母，未知与匿名网络一律落空", () => {
  assert.equal(sanitizeCountry("de"), "DE")
  assert.equal(sanitizeCountry(" DE "), "DE")
  assert.equal(sanitizeCountry("DEU"), "")
  assert.equal(sanitizeCountry("XX"), "")
  assert.equal(sanitizeCountry("T1"), "")
  assert.equal(sanitizeCountry("A1"), "")
  assert.equal(sanitizeCountry(""), "")
  assert.equal(sanitizeCountry(undefined), "")
  assert.equal(sanitizeCountry(42), "")
})

test("modId 白名单：大写、空格、中文、路径穿越都过不了", () => {
  assert.equal(isSafeModId("evejs-autolockfire"), "evejs-autolockfire")
  assert.equal(isSafeModId("EVEJS-AutoLockFire"), "evejs-autolockfire")
  assert.equal(isSafeModId("../../etc/passwd"), "")
  assert.equal(isSafeModId("-leading"), "")
  assert.equal(isSafeModId("中文模组"), "")
  assert.equal(isSafeModId(""), "")
})

test("评价：正常输入原样进 payload（服务端不改写，签名覆盖的就是这份）", () => {
  const result = validateReview(reviewInput())
  assert.equal(result.ok, true)
  assert.deepEqual(result.payload, {
    action: "review.upsert",
    modId: "evejs-autolockfire",
    version: "1.0.10",
    pkgSha256: SHA,
    stars: 5,
    body: "装上就能用",
    reviewId: "rv-test-0001",
    identityId: "au-1234",
    publicKey: PUBLIC_KEY,
    createdAt: NOW,
  })
})

test("评价：只打分不写字是允许的", () => {
  assert.equal(validateReview(reviewInput({ body: "" })).ok, true)
})

test("评价：正文必须先规范再签名，服务端不替客户端改", () => {
  // 「先 trim 再验签」会让客户端少做一步就报「签名不匹配」，所以这里直接拒并说明
  assert.equal(validateReview(reviewInput({ body: " 前后有空格 " })).ok, false)
  assert.match(validateReview(reviewInput({ body: " 空格 " })).reason, /去掉首尾空白/)
  assert.match(validateReview(reviewInput({ body: "换\r\n行" })).reason, /换行/)
  assert.equal(validateReview(reviewInput({ body: "换\n行" })).ok, true)
  assert.equal(validateReview(reviewInput({ body: "x".repeat(MAX_REVIEW_BODY) })).ok, true)
  assert.equal(validateReview(reviewInput({ body: "x".repeat(MAX_REVIEW_BODY + 1) })).ok, false)
})

test("评价：stars 只收 1..5 的整数", () => {
  for (const stars of [0, 6, 2.5, "5", null]) {
    assert.equal(validateReview(reviewInput({ stars })).ok, false, `stars=${stars} 应该被拒`)
  }
  for (const stars of [1, 2, 3, 4, 5]) {
    assert.equal(validateReview(reviewInput({ stars })).ok, true, `stars=${stars} 应该收`)
  }
})

test("评价：pkgSha256 必须是 64 位小写十六进制（大写会被静默拒）", () => {
  // 大写不能「帮你转小写」：它是签名覆盖的字段，服务端一改，报出来的就是「签名不匹配」
  assert.match(validateReview(reviewInput({ pkgSha256: SHA.toUpperCase() })).reason, /小写/)
  assert.equal(validateReview(reviewInput({ pkgSha256: "abc" })).ok, false)
})

test("评价：modId / reviewId / 公钥 / 时钟都要合规", () => {
  assert.equal(validateReview(reviewInput({ modId: "EVEJS-AutoLockFire" })).ok, false)
  assert.equal(validateReview(reviewInput({ reviewId: "x" })).ok, false)
  assert.equal(validateReview(reviewInput({ publicKey: "AAAA" })).ok, false)
  assert.equal(validateReview(reviewInput({ publicKey: "!!!not base64!!!" })).ok, false)
  assert.equal(validateReview(reviewInput({ createdAt: NOW - 25 * 60 * 60 * 1000 })).ok, false)
  assert.equal(validateReview(reviewInput({ createdAt: "now" })).ok, false)
  assert.equal(validateReview(null).ok, false)
})

test("回复：空的、超长的、缺 reviewId 的都拒", () => {
  const reply = (over = {}) => ({
    modId: "evejs-autolockfire",
    reviewId: "rv-test-0001",
    body: "谢谢反馈",
    identityId: "au-1234",
    publicKey: PUBLIC_KEY,
    at: NOW,
    ...over,
  })
  assert.equal(validateReply(reply()).ok, true)
  assert.equal(validateReply(reply()).payload.action, "reply.upsert")
  assert.match(validateReply(reply({ body: "" })).reason, /不能是空的/)
  assert.equal(validateReply(reply({ body: "x".repeat(MAX_REPLY_BODY + 1) })).ok, false)
  assert.equal(validateReply(reply({ reviewId: "!!" })).ok, false)
})

test("撤回：评价与回复各走一条，动作名不能混", () => {
  const base = { modId: "evejs-autolockfire", identityId: "au-1234", publicKey: PUBLIC_KEY, at: NOW }
  assert.equal(validateRetract(base).payload.action, "review.retract")
  const replyRetract = validateReplyRetract({ ...base, reviewId: "rv-test-0001" })
  assert.equal(replyRetract.ok, true)
  assert.equal(replyRetract.payload.action, "reply.retract")
  assert.equal(validateReplyRetract(base).ok, false, "缺 reviewId 的回复撤回必须拒")
})

test("举报：理由可以留空，但身份与时间戳仍要合规", () => {
  const report = { modId: "evejs-autolockfire", reviewId: "rv-test-0001", reason: "广告", identityId: "au-1", publicKey: PUBLIC_KEY, at: NOW }
  assert.equal(validateReport(report).ok, true)
  assert.equal(validateReport({ ...report, reason: "" }).ok, true)
  assert.equal(validateReport({ ...report, at: NOW + 48 * 60 * 60 * 1000 }).ok, false)
})

test("keyId 必须真的是这把公钥的指纹", async () => {
  const keyId = await keyIdFromRaw(base64ToBytes(PUBLIC_KEY))
  assert.equal(await publicKeyMatchesKeyId(PUBLIC_KEY, keyId), true)
  assert.equal(await publicKeyMatchesKeyId(PUBLIC_KEY, "deadbeef0000"), false)
  assert.equal(await publicKeyMatchesKeyId(PUBLIC_KEY, ""), false)
})