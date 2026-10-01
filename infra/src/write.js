/**
 * 写路径的纯逻辑：入参校验 + 「要签的那份负载」。
 *
 * 这里刻意**不做任何改写**：签名覆盖的就是客户端发过来的原值，服务端拿同一份原值去验签，
 * 验过之后原样落库。理由很实在 —— 一旦服务端「先 trim 再验签」，客户端少做个 trim 就会
 * 变成「签名不匹配」这种看不出所以然的错。所以规则改成：**值必须已经是规范形态**，
 * 不合理就带着原因拒掉（`body 去掉首尾空白再签名`），而不是悄悄替你改。
 *
 * 于是客户端（Rust）那边的义务只有一条：把要发的值原样签名。规范形态见各条校验的注释。
 */
import { base64ToBytes, keyIdFromRaw } from "./canonical.js"
import { isSafeModId } from "./snapshot.js"

export const MAX_REVIEW_BODY = 2000
export const MAX_REPLY_BODY = 1000
export const MAX_REPORT_REASON = 500

/** 一个人一天最多写几条（新增 + 改动一起算）；正常玩家一天用不到 2 条 */
export const MAX_REVIEWS_PER_DAY = 20
/** 一个 IP 一小时最多写几条：挡的是脚本，不是「同一栋楼的玩家」 */
export const MAX_WRITES_PER_IP_PER_HOUR = 60
/** 同一个 IP 一天最多举报几次 */
export const MAX_REPORTS_PER_DAY = 10

const MOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REVIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const PUBLIC_KEY_BYTES = 32
/** 客户端时间戳的可信窗口：超出就说明本机时钟离谱，落库会把排序搞乱 */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

const fail = (reason) => ({ ok: false, reason })
const text = (value) => (typeof value === "string" ? value : "")

/**
 * Cloudflare 给的两字母国家码。只认 `A-Z{2}`：
 *   - `XX` 是「查不到」，`T1` 是 Tor 出口，`A1`/`A2`/`O1` 是 Cloudflare 的匿名网络标记，
 *     这几个都不是真的国家，当没有处理（界面渲染成「未知地区」）。
 * 顺便**不留原始 IP**：这个函数的入参刻意就是国家码，想存 IP 的话得先绕过它。
 */
export function sanitizeCountry(raw) {
  const code = text(raw).trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ""
  if (code === "XX" || code === "T1" || code === "A1" || code === "A2" || code === "O1") return ""
  return code
}

function checkPublicKey(value) {
  const publicKey = text(value)
  if (publicKey.length === 0 || publicKey.length > 64) return null
  try {
    return base64ToBytes(publicKey).length === PUBLIC_KEY_BYTES ? publicKey : null
  } catch {
    return null
  }
}

function checkBody(value, max, label) {
  if (typeof value !== "string") return fail(`${label}必须是字符串`)
  if (value.length > max) return fail(`${label}最多 ${max} 个字符`)
  if (value !== value.trim()) return fail(`${label}去掉首尾空白再签名`)
  if (value.includes("\r")) return fail(`${label}里的换行要统一成 \\n 再签名`)
  return { ok: true, value }
}

function checkClock(value, label) {
  if (!Number.isInteger(value)) return fail(`${label}必须是整数毫秒时间戳`)
  if (Math.abs(Date.now() - value) > CLOCK_SKEW_MS) return fail(`${label}与本机时钟相差超过一天`)
  return { ok: true, value }
}

/**
 * 一条评价（新增或改分都走这里）。返回的 `payload` 就是要签的那份 —— 验签通过后原样落库。
 */
export function validateReview(input) {
  if (!input || typeof input !== "object") return fail("请求体不是对象")
  const modId = text(input.modId)
  if (!MOD_ID_RE.test(modId)) return fail("modId 不合法")
  const version = text(input.version)
  if (!VERSION_RE.test(version)) return fail("version 不合法")
  // 这里**不要**顺手 toLowerCase：它是要签名的字段，服务端一改就等于改了签名负载，
  // 客户端会收到「签名不匹配」这种跟真实原因无关的报错。形状不对就直接拒，并说清要什么。
  const pkgSha256 = text(input.pkgSha256)
  if (!SHA256_RE.test(pkgSha256)) return fail("pkgSha256 必须是 64 位小写十六进制")
  const stars = input.stars
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return fail("stars 只能是 1 到 5")
  const body = checkBody(input.body ?? "", MAX_REVIEW_BODY, "评价正文")
  if (!body.ok) return body
  const reviewId = text(input.reviewId)
  if (!REVIEW_ID_RE.test(reviewId)) return fail("reviewId 不合法")
  const identityId = text(input.identityId)
  if (!IDENTITY_RE.test(identityId)) return fail("identityId 不合法")
  const publicKey = checkPublicKey(input.publicKey)
  if (!publicKey) return fail("publicKey 必须是 32 字节 Ed25519 公钥的 base64")
  const clock = checkClock(input.createdAt, "createdAt")
  if (!clock.ok) return clock

  return {
    ok: true,
    payload: {
      action: "review.upsert",
      modId,
      version,
      pkgSha256,
      stars,
      body: body.value,
      reviewId,
      identityId,
      publicKey,
      createdAt: clock.value,
    },
  }
}

/** 撤回自己那条评价（人走了想删掉，不该被拒绝） */
export function validateRetract(input) {
  if (!input || typeof input !== "object") return fail("请求体不是对象")
  const modId = text(input.modId)
  if (!MOD_ID_RE.test(modId)) return fail("modId 不合法")
  const identityId = text(input.identityId)
  if (!IDENTITY_RE.test(identityId)) return fail("identityId 不合法")
  const publicKey = checkPublicKey(input.publicKey)
  if (!publicKey) return fail("publicKey 必须是 32 字节 Ed25519 公钥的 base64")
  const clock = checkClock(input.at, "at")
  if (!clock.ok) return clock
  return { ok: true, payload: { action: "review.retract", modId, identityId, publicKey, at: clock.value } }
}

/** 作者回复 / 改回复 */
export function validateReply(input) {
  if (!input || typeof input !== "object") return fail("请求体不是对象")
  const modId = text(input.modId)
  if (!MOD_ID_RE.test(modId)) return fail("modId 不合法")
  const reviewId = text(input.reviewId)
  if (!REVIEW_ID_RE.test(reviewId)) return fail("reviewId 不合法")
  const body = checkBody(input.body ?? "", MAX_REPLY_BODY, "回复正文")
  if (!body.ok) return body
  if (body.value.length === 0) return fail("回复不能是空的")
  const identityId = text(input.identityId)
  if (!IDENTITY_RE.test(identityId)) return fail("identityId 不合法")
  const publicKey = checkPublicKey(input.publicKey)
  if (!publicKey) return fail("publicKey 必须是 32 字节 Ed25519 公钥的 base64")
  const clock = checkClock(input.at, "at")
  if (!clock.ok) return clock
  return {
    ok: true,
    payload: {
      action: "reply.upsert",
      modId,
      reviewId,
      body: body.value,
      identityId,
      publicKey,
      at: clock.value,
    },
  }
}

/** 删掉自己的回复 */
export function validateReplyRetract(input) {
  const checked = validateRetract(input)
  if (!checked.ok) return checked
  const reviewId = text(input.reviewId)
  if (!REVIEW_ID_RE.test(reviewId)) return fail("reviewId 不合法")
  return {
    ok: true,
    payload: {
      action: "reply.retract",
      modId: checked.payload.modId,
      reviewId,
      identityId: checked.payload.identityId,
      publicKey: checked.payload.publicKey,
      at: checked.payload.at,
    },
  }
}

/** 举报：只入库、自动隐藏交给人工与后续规则，先不做自动处置 */
export function validateReport(input) {
  if (!input || typeof input !== "object") return fail("请求体不是对象")
  const modId = text(input.modId)
  if (!MOD_ID_RE.test(modId)) return fail("modId 不合法")
  const reviewId = text(input.reviewId)
  if (!REVIEW_ID_RE.test(reviewId)) return fail("reviewId 不合法")
  const reason = checkBody(input.reason ?? "", MAX_REPORT_REASON, "举报理由")
  if (!reason.ok) return reason
  const identityId = text(input.identityId)
  if (!IDENTITY_RE.test(identityId)) return fail("identityId 不合法")
  const publicKey = checkPublicKey(input.publicKey)
  if (!publicKey) return fail("publicKey 必须是 32 字节 Ed25519 公钥的 base64")
  const clock = checkClock(input.at, "at")
  if (!clock.ok) return clock
  return {
    ok: true,
    payload: {
      action: "report.create",
      modId,
      reviewId,
      reason: reason.value,
      identityId,
      publicKey,
      at: clock.value,
    },
  }
}

/**
 * 客户端自称的 keyId 必须真的是这把公钥的指纹，否则一把钥匙能挑任意 keyId ——
 * 「作者才能回复」那条鉴权就是拿 keyId 比对的，能冒充就等于谁都能以作者身份回复。
 * 注意 `keyIdFromRaw` 吃的是**裸 32 字节**，不是 base64。
 */
export async function publicKeyMatchesKeyId(publicKey, keyId) {
  let raw
  try {
    raw = base64ToBytes(publicKey)
  } catch {
    return false
  }
  if (raw.length !== PUBLIC_KEY_BYTES) return false
  const expected = await keyIdFromRaw(raw)
  return expected.length > 0 && expected === text(keyId)
}