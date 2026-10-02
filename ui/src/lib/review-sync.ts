/**
 * 打开模组详情时，评论该怎么拉。
 *
 * 背景：评论分片在 Rust 侧有 30 分钟本地缓存（`SHARD_TTL_MS`），服务端每 10 分钟才重算一次快照。
 * 只读缓存的话，别人刚写的评论、作者刚发的回复要等到**下次重启启动器**才看得见（2026-10-02 报障）。
 * 口径是「先渲染、再在后台追一次」：
 *   - 内存里没有这个模组的评论：这次必须等，普通拉一次（Rust 侧自己决定读缓存还是走网络）；
 *   - 内存里有：先拿它渲染，再去后台强拉一次；
 *   - 刚打过网络的（回包 `cached === false`）：60 秒内不再强拉，免得反复开关弹窗把接口打满。
 */

/** 同一个模组两次「真联网」评论拉取之间的最小间隔 */
export const REVIEW_SYNC_COOLDOWN_MS = 60_000

export type ReviewLoadPlan =
  /** 内存里没有：普通拉一次，界面等它 */
  | "load"
  /** 内存里有：先用着，后台再强拉一次 */
  | "sync"
  /** 刚拉过：这次什么都不做 */
  | "skip"

export interface ReviewLoadInput {
  /** 内存里有没有这个模组的评论正文 */
  inMemory: boolean
  /** 上一次**真的打了网络**的时刻（epoch ms）；没拉过写 0 */
  fetchedAt: number
  /** 现在的时刻（epoch ms） */
  now: number
  /** 冷却窗口，默认 REVIEW_SYNC_COOLDOWN_MS */
  cooldownMs?: number
}

/**
 * 纯判断，不碰网络也不碰 React —— 好让它有单测（`review-sync.test.ts`）。
 *
 * 冷启动那一支**不看冷却**：内存里没有就必须拉，否则详情弹窗一直是空的。拉失败时界面不写内存、
 * 也不盖时间戳，所以下次打开会立刻重试，不会静默空转 60 秒。
 */
export function planReviewLoad(input: ReviewLoadInput): ReviewLoadPlan {
  if (!input.inMemory) return "load"
  const cooldown = input.cooldownMs ?? REVIEW_SYNC_COOLDOWN_MS
  const last = Number.isFinite(input.fetchedAt) ? input.fetchedAt : 0
  return input.now - last < cooldown ? "skip" : "sync"
}
