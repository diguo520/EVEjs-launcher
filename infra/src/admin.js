/**
 * 补给线名单的**管理接口**（只给维护者用）。
 *
 * 为什么要有它：加一个人名不该等于「改代码 → 提交 → 等 CI 部署」。名单本体挪到 KV
 * （键 `source:sponsors`）之后，维护者在 `/admin.html` 上填个名字和金额就算改完，
 * 写完立刻重签快照 —— 启动器那边**一行都不用动**，它读的始终是同一份签名快照。
 *
 * 三层校验各管一段，别互相打架：
 *   1. 这一层（管理接口）：令牌 + 形状，目的是**当场把打错的输入顶回去**，给人看得懂的话；
 *   2. `snapshot.js` 的 `sponsorSnapshot`：归一化 + 去重 + round2，目的是**兜住历史数据**；
 *   3. 启动器 `ui/src/lib/sponsor-source.ts`：渲染前再校一遍，目的是**不信任远端**。
 *
 * 鉴权只有一条路：`Authorization: Bearer <SPONSOR_ADMIN_TOKEN>`。
 *   - 没配这个 secret → 503（**fail closed**：接口默认是关的，配了才开）；
 *   - 令牌不对 / 没带头 → 401。
 * 不收 URL 上的 `?token=`：那东西会进浏览器历史、Referer 和 Cloudflare 日志。
 * 管理路由也**不发 CORS 头** —— 别的站点读不到回包，带自定义头的跨站请求会卡在预检上。
 * 这也是为什么不用 Cookie 鉴权：Cookie 会跟着跨站请求自动发出去。
 */
import { sponsorSnapshot } from "./snapshot.js"
import { SPONSOR_LIST } from "./sponsors.js"

/** KV 键：名单**本体**（未签名）。缺省或空 = 用代码里那份种子名单 */
export const SPONSOR_SOURCE_KEY = "source:sponsors"

/** 名单条数上限：防的是「手一滑塞进一大坨」，正常名单是几十条 */
const MAX_ENTRIES = 500

/** 令牌最短长度：短到能被人猜的令牌等于没锁，宁可在健康检查里直接喊出来 */
const MIN_TOKEN_CHARS = 16

const text = (value) => String(value ?? "").trim()

/** 恒定时间比较：长度对不上直接否（令牌长度不是秘密），但别让比较本身泄露前缀 */
function sameToken(given, expected) {
  if (given.length !== expected.length) return false
  let diff = 0
  for (let index = 0; index < given.length; index += 1) {
    diff |= given.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return diff === 0
}

/** 管理接口的开关状态：没配或配得太短都算没开，返回可直接回给客户端的原因 */
export function adminTokenState(env) {
  const token = text(env?.SPONSOR_ADMIN_TOKEN)
  if (!token) {
    return { ok: false, status: 503, reason: "管理接口未启用：Worker 里没配 SPONSOR_ADMIN_TOKEN" }
  }
  if (token.length < MIN_TOKEN_CHARS) {
    return { ok: false, status: 503, reason: `管理接口未启用：SPONSOR_ADMIN_TOKEN 少于 ${MIN_TOKEN_CHARS} 个字符` }
  }
  return { ok: true, token }
}

/** 过一次鉴权：通过返回 { ok: true }，不通过返回 { ok: false, status, reason } */
export function checkAdminRequest(request, env) {
  const state = adminTokenState(env)
  if (!state.ok) return state
  const header = text(request?.headers?.get("Authorization"))
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
  if (!given || !sameToken(given, state.token)) return { ok: false, status: 401, reason: "管理令牌不对" }
  return { ok: true }
}

/** KV 里那份名单本体：解析不出来（手改过 KV / 写坏了）就当没有，退回种子 */
export function parseSponsorSource(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((row) => row && typeof row === "object" && !Array.isArray(row))
  } catch {
    return null
  }
}

/**
 * 运行时名单：**KV 有就用 KV 的，没有才用代码里那份种子**。
 * 返回 `{ entries, source }`，`source` 是 `"kv"` / `"seed"`，健康检查与日志都显示它 ——
 * 「名单到底是谁在管」这个问题不该靠猜。
 */
export async function loadSponsorSource(env) {
  const stored = parseSponsorSource(await env?.SNAPSHOTS?.get(SPONSOR_SOURCE_KEY))
  if (stored && stored.length) return { entries: stored, source: "kv" }
  return { entries: SPONSOR_LIST, source: "seed" }
}

export async function saveSponsorSource(env, entries) {
  await env.SNAPSHOTS.put(SPONSOR_SOURCE_KEY, JSON.stringify(entries))
}

/**
 * 管理接口收的一条：名字必填、金额必填（不小于 0 的有限数）、币种可选。
 *
 * 比快照那层**严**：快照把认不出的币种悄悄算成 CNY（防的是历史数据），
 * 这里直接拒（防的是刚打完字的人以为自己写对了）。
 */
export function checkSponsorInput(input) {
  const name = text(input?.name)
  if (!name) return { ok: false, reason: "名字不能为空" }

  const raw = input?.amount
  if (typeof raw !== "number" && !text(raw)) return { ok: false, reason: "金额不能为空" }
  const amount = typeof raw === "number" ? raw : Number(text(raw))
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: "金额得是不小于 0 的数字" }

  const currency = text(input?.currency)
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) {
    return { ok: false, reason: "币种得是三位字母（CNY / USD / EUR…），不写就是人民币" }
  }
  return { ok: true, entry: { name, amount, currency: currency ? currency.toUpperCase() : "CNY" } }
}

/**
 * 加或改，**按名字匹配**：
 *   - 同名 → 改金额与币种，**位置不动**（顺序是维护者排的，不该因为改个金额就跳到末尾）；
 *   - 新名字 → 追加到末尾。
 * 名字唯一是这么来的，所以名单里不会出现同一个人两条。
 */
export function upsertSponsor(entries, input) {
  const checked = checkSponsorInput(input)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const list = [...(entries ?? [])]
  const index = list.findIndex((item) => text(item?.name) === checked.entry.name)
  if (index >= 0) {
    list[index] = { ...list[index], ...checked.entry }
    return { ok: true, mode: "updated", entries: list }
  }
  if (list.length >= MAX_ENTRIES) return { ok: false, reason: `名单最多 ${MAX_ENTRIES} 条` }
  list.push(checked.entry)
  return { ok: true, mode: "added", entries: list }
}

/** 删：给了名字就按名字，只给 id 就按 id。找不到不算错（页面会重画列表，看得到结果） */
export function removeSponsor(entries, input) {
  const name = text(input?.name)
  const id = text(input?.id)
  if (!name && !id) return { ok: false, reason: "要删哪一位？给 name 或 id" }
  const list = [...(entries ?? [])]
  const index = name
    ? list.findIndex((item) => text(item?.name) === name)
    : list.findIndex((item) => text(item?.id) === id)
  if (index < 0) return { ok: true, removed: false, entries: list }
  const [removed] = list.splice(index, 1)
  return { ok: true, removed: true, name: text(removed?.name), entries: list }
}

/**
 * 回给管理页 / curl 的名单视图：走一遍快照那层的归一化再给出去，
 * 于是「页面上看到的」与「启动器最终显示出来的」是同一份 —— 不用去猜差在哪。
 */
export function sponsorView(entries) {
  return sponsorSnapshot(entries, 0).sponsors
}
