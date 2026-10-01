/**
 * EveJS 模组市场 · 评价与评分服务（Cloudflare Workers + Static Assets + D1 + KV）
 *
 * 拓扑（细节见 infra/README.md）：
 *   D1  → 权威数据（评价 / 回复 / 版本白名单 / 举报 / 限流）
 *   KV  → 定时任务算出来的只读快照，启动器读的就是它
 *   cron→ 每 10 分钟重算快照；每小时同步版本白名单
 *
 * 另有一个**只给维护者用**的名单管理接口（`/v1/admin/sponsors*`，令牌鉴权，实现在 `admin.js`）：
 * 补给线名单既不进 D1 也不锁在代码里 —— 在网页上填个名字和金额就行，写完立刻重签快照。
 *
 * 读路径是**纯静态快照**（不是按请求查库）：启动器那边是「多镜像 + 本地缓存」的读法，
 * 快照才能被边缘缓存、被镜像、被离线重算，按请求现算的接口三样都做不到。
 *
 * M1 只做读；写接口（POST /v1/reviews 等）在 M2 接上，表结构已经建好。
 */
import {
  SPONSOR_SOURCE_KEY,
  adminTokenState,
  checkAdminRequest,
  loadSponsorSource,
  removeSponsor,
  saveSponsorSource,
  sponsorView,
  upsertSponsor,
} from "./admin.js"
import { keyIdFromRaw, signDocument, verifyPayload } from "./canonical.js"
import {
  SNAPSHOT_SCHEMA_VERSION,
  aggregateReviews,
  reviewShard,
  shardPath,
  sponsorSnapshot,
} from "./snapshot.js"
import {
  MAX_REPORTS_PER_DAY,
  MAX_REVIEWS_PER_DAY,
  MAX_WRITES_PER_IP_PER_HOUR,
  publicKeyMatchesKeyId,
  sanitizeCountry,
  validateReply,
  validateReplyRetract,
  validateReport,
  validateRetract,
  validateReview,
} from "./write.js"

const RATINGS_KEY = "snapshot:ratings"
const REVIEWS_PREFIX = "snapshot:reviews:"
/**
 * 补给线那份名单没有 D1 表，KV 里因此放两样东西（键前缀分开，别混）：
 *   - `snapshot:sponsors`：算好并签名的快照，启动器读的就是它；
 *   - `source:sponsors`（`admin.js` 的 SPONSOR_SOURCE_KEY）：名单**本体**，管理接口写的。
 */
const SPONSORS_KEY = "snapshot:sponsors"

/** 默认索引地址：与启动器 `registry.rs` 的 DEFAULT_INDEX_URLS 同源 */
const DEFAULT_INDEX_URLS = [
  "https://diguo520.github.io/EVEjs-mods/mod-index.json",
  "https://cdn.jsdelivr.net/gh/diguo520/EVEjs-mods@main/docs/mod-index.json",
]

const CACHE_HEADERS = {
  "cache-control": "public, max-age=300, stale-while-revalidate=3600",
  "access-control-allow-origin": "*",
}

/** 写接口的响应一律不进缓存：同一个人连点两下不该看到上一次的读数 */
const NO_STORE = { "cache-control": "no-store" }

const writeEncoder = new TextEncoder()

const dateKey = (now) => new Date(now).toISOString().slice(0, 10)
const hourKey = (now) => new Date(now).toISOString().slice(0, 13)

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  })
}

/* ------------------------------ 快照 ------------------------------ */

/**
 * 签名器。没配私钥就**不发布**（fail closed）：启动器那边是「验签失败即丢弃整份」，
 * 发一份无签名快照只会让所有人读不到评分，不如让健康检查直接把配置问题喊出来。
 */
async function makeSigner(env) {
  const privateKey = String(env?.RATINGS_SIGNING_KEY ?? "").trim()
  const keyId = String(env?.RATINGS_KEY_ID ?? "").trim()
  if (!privateKey || !keyId) return null
  return (payload) => signDocument(privateKey, payload, keyId)
}

/** 评价行（含作者回复，一条评价只取最新的一条回复）——聚合与分片共用这一份 */
async function readReviewRows(env) {
  const reply = `LEFT JOIN replies p ON p.review_id = r.id
     AND p.updated_at = (SELECT MAX(updated_at) FROM replies WHERE review_id = r.id)`
  const statement = env.DB.prepare(
    `SELECT r.id, r.mod_id, r.version, r.stars, r.body, r.author_name, r.corp,
            r.key_id, r.created_at, r.updated_at, r.edited, r.hidden,
            p.body AS reply_body, p.updated_at AS reply_at, p.edited AS reply_edited
       FROM reviews r ${reply}`
  )
  const result = await statement.all()
  return result?.results ?? []
}

/** 重算全部快照：聚合一份 + 每个有评价的模组一份正文分片 */
export async function rebuildSnapshots(env, now = Date.now()) {
  const signer = await makeSigner(env)
  if (!signer) return { ok: false, reason: "缺少 RATINGS_SIGNING_KEY / RATINGS_KEY_ID，未发布快照" }

  const rows = await readReviewRows(env)
  const ratings = await signer({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now,
    mods: aggregateReviews(rows),
  })
  await env.SNAPSHOTS.put(RATINGS_KEY, JSON.stringify(ratings))

  const modIds = [...new Set(rows.filter((row) => !row.hidden).map((row) => String(row.mod_id)))].sort()
  let shards = 0
  for (const modId of modIds) {
    const path = shardPath(modId)
    if (!path) continue
    const shard = await signer({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: now,
      ...reviewShard(modId, rows),
    })
    await env.SNAPSHOTS.put(REVIEWS_PREFIX + modId, JSON.stringify(shard))
    shards += 1
  }
  // 补给线名单：与评价无关，同一次 cron 里一起重签。名单本体在 KV（管理接口写的），
  // 没写过就用代码里那份种子；不依赖 D1，所以即使一条评价都没有也照发。
  const { entries: sponsorEntries, source: sponsorsSource } = await loadSponsorSource(env)
  const sponsors = await signer(sponsorSnapshot(sponsorEntries, now))
  await env.SNAPSHOTS.put(SPONSORS_KEY, JSON.stringify(sponsors))

  return {
    ok: true,
    mods: Object.keys(ratings.mods).length,
    shards,
    rows: rows.length,
    sponsors: sponsors.sponsors.length,
    sponsorsSource,
  }
}

/* ------------------------------ 版本白名单 ------------------------------ */

/**
 * 从市场索引同步「mod → version → sha256」。
 *
 * 索引本身是维护者签名的，这里**不验签**是刻意的：这一步只决定「哪个 sha256 允许评价」，
 * 被中间人塞进来的假 sha256 最多让人给一个自己没装的包打分——而包能不能装、装的是不是
 * 那一份，由启动器验索引签名 + 验包签名管着，轮不到这条链路。赌注不对等就没必要
 * 在这儿再引一把公钥。
 */
export async function syncModVersions(env) {
  const urls = String(env?.MOD_INDEX_URLS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const candidates = urls.length > 0 ? urls : DEFAULT_INDEX_URLS

  const failures = []
  for (const url of candidates) {
    let index
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } })
      if (!response.ok) {
        failures.push(`${url} → HTTP ${response.status}`)
        continue
      }
      index = await response.json()
    } catch (error) {
      failures.push(`${url} → ${error?.message ?? error}`)
      continue
    }
    const mods = Array.isArray(index?.mods) ? index.mods : []
    if (mods.length === 0) {
      failures.push(`${url} → 索引里没有 mods`)
      continue
    }

    const now = Date.now()
    const seen = []
    const statements = []
    for (const mod of mods) {
      const modId = String(mod?.id ?? "").trim()
      const version = String(mod?.version ?? "").trim()
      const sha = String(mod?.sha256 ?? "").trim()
      if (!modId || !version) continue
      const authorKeyId = String(mod?.author?.keyId ?? "").trim()
      seen.push([modId, version])
      statements.push(
        env.DB.prepare(
          `INSERT INTO mod_versions (mod_id, version, sha256, author_key_id, active)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (mod_id, version) DO UPDATE SET
             sha256 = excluded.sha256,
             author_key_id = excluded.author_key_id,
             active = 1`
        ).bind(modId, version, sha, authorKeyId)
      )
    }
    // 索引里已经没有的版本置为失效：老版本的评价不再能提交，但历史评价照旧显示
    statements.push(
      env.DB.prepare(
        `UPDATE mod_versions SET active = 0
          WHERE active = 1 AND (mod_id || '@' || version) NOT IN (${seen
            .map(() => "?")
            .join(", ") || "''"})`
      ).bind(...seen.map(([modId, version]) => `${modId}@${version}`))
    )
    await env.DB.batch(statements)
    return { ok: true, source: url, mods: mods.length, versions: seen.length, at: now }
  }
  return { ok: false, reason: failures.join("；") }
}

async function recordJob(env, job, result) {
  const ok = result?.ok ? 1 : 0
  const detail = ok ? JSON.stringify(result).slice(0, 400) : String(result?.reason ?? "").slice(0, 400)
  await env.DB.prepare(
    `INSERT INTO job_runs (job, ran_at, ok, detail) VALUES (?, ?, ?, ?)
     ON CONFLICT (job) DO UPDATE SET ran_at = excluded.ran_at, ok = excluded.ok, detail = excluded.detail`
  )
    .bind(job, Date.now(), ok, detail)
    .run()
}

/* ------------------------------ HTTP ------------------------------ */

/**
 * 探针：真的拿私钥签一次，而不是只判断「环境变量非空」。
 *
 * 只判非空踩过一次坑：secret 被塞进一段中文标签时，健康检查照样报 true，
 * 而定时任务每次都在 importKey 上炸掉、快照永远不生成 —— 两个症状互相矛盾，
 * 排查时会先怀疑 cron 没触发。这里花一次签名的代价，把「配置坏了」和「任务没跑」分开。
 */
async function signingProbe(env) {
  const signer = await makeSigner(env)
  if (!signer) return { state: "missing", reason: "缺少 RATINGS_SIGNING_KEY / RATINGS_KEY_ID" }
  try {
    await signer({ probe: true })
    return { state: "ok" }
  } catch (error) {
    return { state: "broken", reason: `签名密钥不可用：${String(error?.message ?? error)}` }
  }
}

/** 快照里有多少条赞助人：给运维一眼看出「名单发出去没有」 */
function sponsorCount(text) {
  if (!text) return 0
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.sponsors) ? parsed.sponsors.length : 0
  } catch {
    return 0
  }
}

async function health(env) {
  const [counts, jobs, sponsors, sponsorSource] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM reviews) AS reviews,
              (SELECT COUNT(*) FROM mod_versions WHERE active = 1) AS versions,
              (SELECT COUNT(*) FROM replies) AS replies`
    ).first(),
    env.DB.prepare(`SELECT job, ran_at, ok, detail FROM job_runs`).all(),
    env.SNAPSHOTS.get(SPONSORS_KEY),
    env.SNAPSHOTS.get(SPONSOR_SOURCE_KEY),
  ])
  const signing = await signingProbe(env)
  return {
    ok: signing.state === "ok",
    service: "evejs-mod-ratings",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    signing: signing.state,
    signingReason: signing.reason ?? "",
    counts: { ...(counts ?? {}), sponsors: sponsorCount(sponsors) },
    // 名单归谁管：kv（管理接口写过）/ seed（还在用代码里那份种子）
    sponsorsSource: sponsorSource ? "kv" : "seed",
    // 管理接口开着没：没配令牌就是关的（fail closed）
    sponsorsAdmin: adminTokenState(env).ok ? "on" : "off",
    jobs: jobs?.results ?? [],
  }
}

/** `/v1/reviews/<modId>.json` → modId；形状不对返回空串 */
function reviewIdFromPath(pathname) {
  const match = /^\/v1\/reviews\/([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(pathname)
  return match ? match[1] : ""
}

async function serveSnapshot(env, key) {
  const text = await env.SNAPSHOTS.get(key)
  if (!text) {
    return json(
      { ok: false, reason: "快照还没生成（定时任务未跑过，或缺少签名密钥）" },
      503,
      { "cache-control": "no-store" }
    )
  }
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CACHE_HEADERS },
  })
}

/**
 * 一次性验签。两道都要过：
 *   1) 客户端自称的 keyId 必须真是这把公钥的指纹（否则一把钥匙能冒充任何 keyId，白名单就形同虚设）；
 *   2) 签名覆盖的必须正好是 validate* 给出的那份 payload。
 * 写路径上放过的每一条都会进别人的启动器，所以这里一律「拒掉」而不是「尽力而为」。
 */
async function verifySignedWrite(input, payload) {
  const signature = input?.signature
  if (!signature || signature.alg !== "ed25519" || typeof signature.sig !== "string" || !signature.sig) {
    return { ok: false, reason: "缺少 signature（写操作必须由本机身份签名）" }
  }
  if (!(await publicKeyMatchesKeyId(payload.publicKey, signature.keyId))) {
    return { ok: false, reason: "keyId 与公钥对不上" }
  }
  if (!(await verifyPayload(payload.publicKey, { ...payload, signature }))) {
    return { ok: false, reason: "签名不匹配" }
  }
  return { ok: true, keyId: String(signature.keyId) }
}

/** 计数式限流：bucket 是主键，撞上上限就返回 false。窗口靠 bucket 串里的日期/小时自然后移。 */
async function consumeQuota(env, bucket, limit) {
  if (!bucket) return true
  const row = await env.DB.prepare("SELECT used FROM rate_limits WHERE bucket = ?").bind(bucket).first()
  if (Number(row?.used ?? 0) >= limit) return false
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, used) VALUES (?, 1)
     ON CONFLICT (bucket) DO UPDATE SET used = used + 1`
  )
    .bind(bucket)
    .run()
  return true
}

/**
 * 按 IP 限流的桶键。原始 IP **在这一刻就变成 HMAC**，既不落库也不进日志：
 * IPv4 只有 2^32 个，裸 sha256 反查等于明文存 IP；带一把密钥的 HMAC 就没法反查了。
 * 密钥借用签名私钥（一把随机密钥、永不外泄），不再多要一个 secret。
 *
 * `prefix` 让不同用途各用各的桶：评价写用默认的 `i:`，名单管理用 `a:` ——
 * 共用一个桶的话，正常打分会把维护者那点额度吃光。
 */
async function ipBucket(request, env, now, prefix = "i:") {
  const ip = String(request.headers.get("CF-Connecting-IP") ?? "").trim()
  if (!ip) return ""
  const secret = String(env?.RATINGS_SIGNING_KEY ?? "") || "evejs-mod-ratings"
  const key = await crypto.subtle.importKey("raw", writeEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, writeEncoder.encode(ip)))
  const digest = [...mac.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return prefix + digest + ":" + hourKey(now)
}

/** 这十条只喂给 aggregateReviews，字段名与它读的一致 */
const FRESH_REVIEW_SQL = `SELECT mod_id, stars, body, hidden, country FROM reviews WHERE mod_id = ?`

async function reviewAggregate(env, modId) {
  const rows = await env.DB.prepare(FRESH_REVIEW_SQL).bind(modId).all()
  return aggregateReviews(rows?.results ?? [])[modId] ?? { average: 0, count: 0, withText: 0, histogram: [0, 0, 0, 0, 0] }
}

/** 写评价：一人一票（UNIQUE(mod_id, public_key)），改分改字都是覆盖。 */
async function upsertReview(request, env, input, country) {
  const checked = validateReview(input)
  if (!checked.ok) return json({ ok: false, reason: checked.reason }, 400, NO_STORE)
  const payload = checked.payload
  const verified = await verifySignedWrite(input, payload)
  if (!verified.ok) return json({ ok: false, reason: verified.reason }, 403, NO_STORE)

  // 「装过才能评」的唯一凭据：报上来的包 sha256 必须命中白名单里当前有效的版本
  const installed = await env.DB.prepare(
    "SELECT 1 AS hit FROM mod_versions WHERE mod_id = ? AND sha256 = ? AND active = 1"
  )
    .bind(payload.modId, payload.pkgSha256)
    .first()
  if (!installed?.hit) {
    return json({ ok: false, reason: "这个安装包对不上市场记录 —— 装过该版本之后再来评价" }, 403, NO_STORE)
  }

  const now = Date.now()
  if (!(await consumeQuota(env, "k:" + verified.keyId + ":" + dateKey(now), MAX_REVIEWS_PER_DAY))) {
    return json({ ok: false, reason: "今天写的次数用完了，明天再来" }, 429, NO_STORE)
  }
  if (!(await consumeQuota(env, await ipBucket(request, env, now), MAX_WRITES_PER_IP_PER_HOUR))) {
    return json({ ok: false, reason: "这个网络写得太频繁了，过一会儿再试" }, 429, NO_STORE)
  }

  await env.DB.prepare(
    `INSERT INTO reviews (id, mod_id, version, pkg_sha256, stars, body, author_name, corp, country,
                          identity_id, key_id, public_key, sig, created_at, updated_at, edited, hidden, hide_reason)
     VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, 0, 0, '')
     ON CONFLICT (mod_id, public_key) DO UPDATE SET
       version = excluded.version,
       pkg_sha256 = excluded.pkg_sha256,
       stars = excluded.stars,
       body = excluded.body,
       country = excluded.country,
       identity_id = excluded.identity_id,
       key_id = excluded.key_id,
       sig = excluded.sig,
       updated_at = excluded.updated_at,
       edited = 1,
       hidden = 0,
       hide_reason = ''`
  )
    .bind(
      payload.reviewId,
      payload.modId,
      payload.version,
      payload.pkgSha256,
      payload.stars,
      payload.body,
      country,
      payload.identityId,
      verified.keyId,
      payload.publicKey,
      String(input.signature.sig),
      payload.createdAt,
      payload.createdAt
    )
    .run()

  const aggregate = await reviewAggregate(env, payload.modId)
  return json({ ok: true, modId: payload.modId, country, ...aggregate }, 200, NO_STORE)
}

/** 撤回自己那条评价：删就删，不留隐藏位（隐藏是给举报用的） */
async function retractReview(env, input) {
  const checked = validateRetract(input)
  if (!checked.ok) return json({ ok: false, reason: checked.reason }, 400, NO_STORE)
  const payload = checked.payload
  const verified = await verifySignedWrite(input, payload)
  if (!verified.ok) return json({ ok: false, reason: verified.reason }, 403, NO_STORE)
  await env.DB.prepare("DELETE FROM reviews WHERE mod_id = ? AND public_key = ?")
    .bind(payload.modId, payload.publicKey)
    .run()
  const aggregate = await reviewAggregate(env, payload.modId)
  return json({ ok: true, modId: payload.modId, retracted: true, ...aggregate }, 200, NO_STORE)
}

/** 作者回复：服务端必须自己核对「签名的人就是这个模组的作者」，光靠客户端自称不算数 */
async function upsertReply(env, input) {
  const checked = validateReply(input)
  if (!checked.ok) return json({ ok: false, reason: checked.reason }, 400, NO_STORE)
  const payload = checked.payload
  const verified = await verifySignedWrite(input, payload)
  if (!verified.ok) return json({ ok: false, reason: verified.reason }, 403, NO_STORE)

  const authors = await env.DB.prepare("SELECT DISTINCT author_key_id FROM mod_versions WHERE mod_id = ? AND author_key_id <> ''")
    .bind(payload.modId)
    .all()
  const allowed = (authors?.results ?? []).map((row) => String(row.author_key_id))
  if (!allowed.includes(verified.keyId)) {
    return json({ ok: false, reason: "只有这个模组的作者能回复" }, 403, NO_STORE)
  }

  const review = await env.DB.prepare("SELECT 1 AS hit FROM reviews WHERE id = ? AND mod_id = ?")
    .bind(payload.reviewId, payload.modId)
    .first()
  if (!review?.hit) return json({ ok: false, reason: "这条评价已经不在了" }, 404, NO_STORE)

  await env.DB.prepare(
    `INSERT INTO replies (review_id, body, key_id, public_key, sig, updated_at, edited)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (review_id, key_id) DO UPDATE SET
       body = excluded.body,
       sig = excluded.sig,
       updated_at = excluded.updated_at,
       edited = 1`
  )
    .bind(payload.reviewId, payload.body, verified.keyId, payload.publicKey, String(input.signature.sig), payload.at)
    .run()
  return json({ ok: true, reviewId: payload.reviewId, modId: payload.modId }, 200, NO_STORE)
}

async function retractReply(env, input) {
  const checked = validateReplyRetract(input)
  if (!checked.ok) return json({ ok: false, reason: checked.reason }, 400, NO_STORE)
  const payload = checked.payload
  const verified = await verifySignedWrite(input, payload)
  if (!verified.ok) return json({ ok: false, reason: verified.reason }, 403, NO_STORE)
  await env.DB.prepare("DELETE FROM replies WHERE review_id = ? AND key_id = ?")
    .bind(payload.reviewId, verified.keyId)
    .run()
  return json({ ok: true, reviewId: payload.reviewId, modId: payload.modId, retracted: true }, 200, NO_STORE)
}

/** 举报先只入库：自动处置的规则还没定，宁可攒着人工看，也不要随手机器审掉一条正常评价 */
async function createReport(request, env, input) {
  const checked = validateReport(input)
  if (!checked.ok) return json({ ok: false, reason: checked.reason }, 400, NO_STORE)
  const payload = checked.payload
  const verified = await verifySignedWrite(input, payload)
  if (!verified.ok) return json({ ok: false, reason: verified.reason }, 403, NO_STORE)

  const now = Date.now()
  if (!(await consumeQuota(env, "r:" + verified.keyId + ":" + dateKey(now), MAX_REPORTS_PER_DAY))) {
    return json({ ok: false, reason: "今天举报的次数用完了" }, 429, NO_STORE)
  }
  const id = "rp-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")
  await env.DB.prepare(
    "INSERT OR REPLACE INTO reports (id, review_id, reason, reporter, created_at, handled) VALUES (?, ?, ?, ?, ?, 0)"
  )
    .bind(id, payload.reviewId, payload.reason, verified.keyId, now)
    .run()
  return json({ ok: true, reportId: id }, 200, NO_STORE)
}

/* ------------------------------ 补给线名单管理（只给维护者） ------------------------------ */

/** 管理接口的限流：猜令牌也该有个上限。一小时 60 次，正常维护碰不到 */
const MAX_ADMIN_PER_HOUR = 60

/** GET /v1/admin/sponsors：把当前名单回给管理页 —— 归一化后的视图，看到的就是启动器最终显示的 */
async function listSponsors(request, env) {
  const auth = checkAdminRequest(request, env)
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.status, NO_STORE)
  const { entries, source } = await loadSponsorSource(env)
  return json({ ok: true, source, sponsors: sponsorView(entries) }, 200, NO_STORE)
}

/**
 * POST /v1/admin/sponsors        { name, amount, currency? }  加或改（同名改金额，位置不动）
 * POST /v1/admin/sponsors/remove { name } 或 { id }           删
 * POST /v1/admin/sponsors/reset  {}                           清掉 KV 那份，退回代码里的种子
 *
 * 成功的写由 handleWrite 统一触发一次重算快照，所以启动器那边最多再等它自己的 10 分钟缓存。
 */
async function handleAdminWrite(pathname, request, env, input) {
  const auth = checkAdminRequest(request, env)
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.status, NO_STORE)

  const now = Date.now()
  if (!(await consumeQuota(env, await ipBucket(request, env, now, "a:"), MAX_ADMIN_PER_HOUR))) {
    return json({ ok: false, reason: "这个网络一小时内改得太频繁了" }, 429, NO_STORE)
  }

  const { entries } = await loadSponsorSource(env)

  if (pathname === "/v1/admin/sponsors/reset") {
    await env.SNAPSHOTS.delete(SPONSOR_SOURCE_KEY)
    const restored = await loadSponsorSource(env)
    return json(
      { ok: true, action: "reset", source: restored.source, sponsors: sponsorView(restored.entries) },
      200,
      NO_STORE
    )
  }

  if (pathname === "/v1/admin/sponsors/remove") {
    const result = removeSponsor(entries, input)
    if (!result.ok) return json({ ok: false, reason: result.reason }, 400, NO_STORE)
    if (result.removed) await saveSponsorSource(env, result.entries)
    return json(
      // source 直接给 "kv"：只要这条路径写成功，名单本体就一定在 KV 里了（管理页据此显示「线上」）
      { ok: true, action: "remove", source: "kv", removed: result.removed, sponsors: sponsorView(result.entries) },
      200,
      NO_STORE
    )
  }

  if (pathname === "/v1/admin/sponsors") {
    const result = upsertSponsor(entries, input)
    if (!result.ok) return json({ ok: false, reason: result.reason }, 400, NO_STORE)
    await saveSponsorSource(env, result.entries)
    return json(
      { ok: true, action: result.mode, source: "kv", sponsors: sponsorView(result.entries) },
      200,
      NO_STORE
    )
  }

  return json({ ok: false, reason: "没有这个管理接口" }, 404, NO_STORE)
}

/** 请求体上限：2000 字的正文加上签名和各种 id，16KB 绰绰有余 */
const MAX_WRITE_BODY_BYTES = 16 * 1024

async function handleWrite(pathname, request, env, ctx) {
  const raw = await request.text()
  if (raw.length > MAX_WRITE_BODY_BYTES) {
    return json({ ok: false, reason: "请求体太大" }, 413, NO_STORE)
  }
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return json({ ok: false, reason: "请求体不是合法 JSON" }, 400, NO_STORE)
  }
  const country = sanitizeCountry(request.cf?.country)
  const respond = pathname.startsWith("/v1/admin/")
    ? await handleAdminWrite(pathname, request, env, input)
    : pathname === "/v1/reviews"
      ? await upsertReview(request, env, input, country)
      : pathname === "/v1/reviews/retract"
        ? await retractReview(env, input)
        : pathname === "/v1/replies"
          ? await upsertReply(env, input)
          : pathname === "/v1/replies/retract"
            ? await retractReply(env, input)
            : pathname === "/v1/reports"
              ? await createReport(request, env, input)
              : json({ ok: false, reason: "没有这个写接口" }, 404, NO_STORE)
  // 写成功就顺手把快照重算一遍：读路径是静态快照，不重算的话作者自己都要等下一个 cron 才看得到
  if (respond?.status === 200) ctx?.waitUntil?.(rebuildSnapshots(env))
  return respond
}

async function handle(request, env, ctx) {
  const { pathname } = new URL(request.url)

  // 写路径一律 POST + JSON + 本机身份签名；返回体不进缓存（同一个人连点两下不该看到上一次的读数）
  if (request.method === "POST") {
    if (!pathname.startsWith("/v1/")) {
      return json({ ok: false, reason: "没有这个路径" }, 404, NO_STORE)
    }
    return handleWrite(pathname, request, env, ctx)
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, reason: "写接口只收 POST，读接口只收 GET" }, 405, {
      allow: "GET, HEAD, POST",
      ...NO_STORE,
    })
  }

  if (pathname === "/v1/health") {
    return json(await health(env), 200, { "cache-control": "no-store" })
  }
  // 管理接口：带令牌才给回包，**不发 CORS 头**（别的站点读不到），也不进缓存
  if (pathname === "/v1/admin/sponsors") {
    return listSponsors(request, env)
  }
  if (pathname === "/v1/ratings.json") {
    return serveSnapshot(env, RATINGS_KEY)
  }
  if (pathname === "/v1/sponsors.json") {
    return serveSnapshot(env, SPONSORS_KEY)
  }
  const modId = reviewIdFromPath(pathname)
  if (modId) {
    return serveSnapshot(env, REVIEWS_PREFIX + modId)
  }
  if (env.ASSETS) return env.ASSETS.fetch(request)
  return json({ ok: false, reason: "没有这个路径" }, 404, { "cache-control": "no-store" })
}

export default {
  /**
   * ctx 是第三个参数，一定要接住再往下传：写路径要靠它挂 `waitUntil` 重算快照。
   * 少写这个参数不是「功能少一点」，而是**所有请求**都 500「ctx is not defined」
   * —— 包括健康检查（2026-10-01 接写路径时踩过，infra/test/worker.test.mjs 钉住了）。
   */
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx)
    } catch (error) {
      return json({ ok: false, reason: String(error?.message ?? error) }, 500, {
        "cache-control": "no-store",
      })
    }
  },

  async scheduled(event, env, ctx) {
    const cron = String(event?.cron ?? "").trim()
    // 每小时整点同步白名单，其余（每 10 分钟那档）重算快照
    const job = cron === "0 * * * *" ? "sync-versions" : "rebuild-snapshots"
    const result =
      job === "sync-versions" ? await syncModVersions(env) : await rebuildSnapshots(env)
    await recordJob(env, job, result)
    ctx?.waitUntil?.(Promise.resolve())
    if (!result?.ok) console.error(job, result?.reason)
  },
}

/** 单测与本地脚本复用：不经过 Worker 入口也能单独跑这两个作业 */
export const __internals = { makeSigner, readReviewRows, reviewIdFromPath, keyIdFromRaw }