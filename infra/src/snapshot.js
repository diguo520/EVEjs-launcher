/**
 * 快照生成：把 D1 里的评价行算成启动器要读的两份 JSON。
 *
 * 两份产物、各管一件事（对齐启动器的读法）：
 *   - `ratings.json`            → 所有模组的聚合分，跟主索引一起进缓存，卡片 / 排序 / 筛选吃它；
 *   - `reviews/<modId>.json`    → 单个模组的评论正文，打开详情弹窗时才按需拉。
 *
 * 这里只放纯函数（行数组进、JSON 出），不碰 D1 / KV / 网络：
 *   - Worker 的定时任务用它算完写 KV；
 *   - `infra/scripts/build-snapshot.mjs` 用它离线重算 GitHub 镜像；
 *   - 单测直接喂行数组，不需要起任何东西。
 */

export const SNAPSHOT_SCHEMA_VERSION = 1

/** epoch 毫秒 → UTC 的 YYYY-MM-DD（界面按 `${date}T00:00:00Z` 解析算「几天前」） */
export function toDateString(epochMs) {
  const value = Number(epochMs)
  if (!Number.isFinite(value) || value <= 0) return ""
  return new Date(value).toISOString().slice(0, 10)
}

/** 两位小数：签名负载里不出现长尾浮点 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 聚合分。口径与界面文案严格一致（`ui/src/lib/mod-logic.ts` 的 `ratingOf`）：
 *   - `count` 是**打过分的人**，含只打分不写评论的；
 *   - `withText` 才是**写了评论的人**，界面那句「玩家评价 · N 条」用它。
 * 两个口径分开是刻意的：打分的人远多于写字的人。
 */
export function aggregateReviews(rows) {
  const totals = new Map()
  for (const row of rows ?? []) {
    if (!row || row.hidden) continue
    const modId = String(row.mod_id ?? "")
    const stars = Number(row.stars)
    if (!modId || !Number.isInteger(stars) || stars < 1 || stars > 5) continue
    let bucket = totals.get(modId)
    if (!bucket) {
      bucket = { sum: 0, count: 0, histogram: [0, 0, 0, 0, 0], withText: 0 }
      totals.set(modId, bucket)
    }
    bucket.sum += stars
    bucket.count += 1
    bucket.histogram[stars - 1] += 1
    if (String(row.body ?? "").trim()) bucket.withText += 1
  }

  const mods = {}
  for (const [modId, bucket] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    mods[modId] = {
      average: round2(bucket.sum / bucket.count),
      count: bucket.count,
      withText: bucket.withText,
      histogram: bucket.histogram,
    }
  }
  return mods
}

/** 评分筛选的分档判据在界面侧是 `>= 4.5 / >= 4.0 / < 4.0`，这里不掺和，只给平均分 */

function shardItem(row) {
  const replyBody = String(row.reply_body ?? "").trim()
  const item = {
    id: String(row.id ?? ""),
    // keyId 给启动器认「哪条是我写的」（本机身份的 keyId 一比就知道）
    keyId: String(row.key_id ?? ""),
    // 名字已经不用了（界面上只显示「来自XX的玩家」），留着这两个字段是为了兼容老快照；
    // 新写的评价 author_name / corp 一律写空。
    author: String(row.author_name ?? "").trim(),
    corp: String(row.corp ?? "").trim(),
    country: String(row.country ?? "").trim().toUpperCase(),
    stars: Number(row.stars),
    version: String(row.version ?? ""),
    date: toDateString(row.updated_at || row.created_at),
    body: String(row.body ?? ""),
    edited: Number(row.edited ?? 0) === 1,
  }
  if (replyBody) {
    item.reply = {
      date: toDateString(row.reply_at),
      body: replyBody,
      edited: Number(row.reply_edited ?? 0) === 1,
    }
  }
  return item
}

/** 单个模组的评论正文，最新的在前 */
export function reviewShard(modId, rows) {
  const reviews = (rows ?? [])
    .filter((row) => row && !row.hidden && String(row.mod_id ?? "") === modId)
    .map(shardItem)
    .sort((a, b) => b.date.localeCompare(a.date))
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, modId, reviews }
}

/**
 * 分片文件名：模组 id 允许小写字母 / 数字 / 短横（创建表单就限这些），
 * 但仍做一次白名单过滤——id 直接进 URL 路径，不能留 `..` 或 `/` 的口子。
 */
export function shardPath(modId) {
  const safe = isSafeModId(modId)
  return safe ? `reviews/${safe}.json` : ""
}

/**
 * 模组 id 的白名单：小写字母 / 数字 / 短横，首字符必须是字母或数字，最长 64。
 * 分片路径（进 URL）与写接口（进 D1）共用这一条，规则只此一份。返回归一化后的 id，
 * 不合格返回空串。
 */
export function isSafeModId(value) {
  const safe = String(value ?? "").toLowerCase()
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(safe) ? safe : ""
}