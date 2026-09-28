import { describe, expect, it } from "vitest"

import {
  PUBLISH_INTERVAL_MS,
  SUBMIT_COOLDOWN_MS,
  cooldownText,
  isPublished,
  intervalText,
  publishBlockers,
  publishIntervalRemaining,
  reviewPrStateLabel,
  submitCooldownRemaining,
  type PublishCredential,
} from "@/lib/mod-logic"
import type { ModEntry } from "@/lib/mock"

const NOW = 1_770_000_000_000
const liveCredential = { token: "ghp_x", savedAt: NOW - 60_000, expiresAt: NOW + 3_600_000 } as unknown as PublishCredential

describe("submitCooldownRemaining（30 分钟提交间隔）", () => {
  it("没提交过（没有 submittedAt）就不挡", () => {
    expect(submitCooldownRemaining(undefined, NOW)).toBe(0)
    expect(submitCooldownRemaining({}, NOW)).toBe(0)
    // 只有 createdAt（打包/推仓库成功、PR 没开出来）不算数：失败重试不该被自己挡住
    expect(submitCooldownRemaining({ createdAt: NOW - 1000 } as never, NOW)).toBe(0)
  })

  it("刚提交过就按 30 分钟倒计时，且不会超过 30 分钟", () => {
    const justNow = submitCooldownRemaining({ submittedAt: NOW }, NOW)
    expect(justNow).toBe(SUBMIT_COOLDOWN_MS)
    expect(submitCooldownRemaining({ submittedAt: NOW - 60_000 }, NOW)).toBe(SUBMIT_COOLDOWN_MS - 60_000)
  })

  it("满 30 分钟（含超过）就放行", () => {
    expect(submitCooldownRemaining({ submittedAt: NOW - SUBMIT_COOLDOWN_MS }, NOW)).toBe(0)
    expect(submitCooldownRemaining({ submittedAt: NOW - SUBMIT_COOLDOWN_MS - 1 }, NOW)).toBe(0)
  })

  it("系统时间被往回调也不会算出负的等待时间", () => {
    expect(submitCooldownRemaining({ submittedAt: NOW + 60_000 }, NOW)).toBe(SUBMIT_COOLDOWN_MS)
  })
})

describe("cooldownText", () => {
  it("往上取整成分钟，最少 1 分钟", () => {
    expect(cooldownText(SUBMIT_COOLDOWN_MS)).toBe("还剩约 30 分钟")
    expect(cooldownText(61_000)).toBe("还剩约 2 分钟")
    expect(cooldownText(1)).toBe("还剩约 1 分钟")
  })
})

describe("publishIntervalRemaining（两次发布之间的 60 秒）", () => {
  it("没发布过（0/空）就不挡", () => {
    expect(publishIntervalRemaining(undefined, NOW)).toBe(0)
    expect(publishIntervalRemaining(null, NOW)).toBe(0)
    expect(publishIntervalRemaining(0, NOW)).toBe(0)
  })

  it("刚发布完就按 60 秒倒计时", () => {
    expect(publishIntervalRemaining(NOW, NOW)).toBe(PUBLISH_INTERVAL_MS)
    expect(publishIntervalRemaining(NOW - 20_000, NOW)).toBe(PUBLISH_INTERVAL_MS - 20_000)
  })

  it("满 60 秒（含超过）就放行", () => {
    expect(publishIntervalRemaining(NOW - PUBLISH_INTERVAL_MS, NOW)).toBe(0)
    expect(publishIntervalRemaining(NOW - PUBLISH_INTERVAL_MS - 1, NOW)).toBe(0)
  })

  it("系统时间被往回调也不会算出负的等待时间", () => {
    expect(publishIntervalRemaining(NOW + 60_000, NOW)).toBe(PUBLISH_INTERVAL_MS)
  })
})

describe("intervalText", () => {
  it("按秒往上取整，最少 1 秒（60 秒用分钟会说成「还剩约 1 分钟」）", () => {
    expect(intervalText(PUBLISH_INTERVAL_MS)).toBe("还剩 60 秒")
    expect(intervalText(41_200)).toBe("还剩 42 秒")
    expect(intervalText(1)).toBe("还剩 1 秒")
  })
})

describe("reviewPrStateLabel", () => {
  it("把后端复查回来的 PR 状态说成人话", () => {
    expect(reviewPrStateLabel("open")).toBe("审核中")
    expect(reviewPrStateLabel("merged")).toBe("已合并")
    expect(reviewPrStateLabel("closed")).toBe("PR 已关闭")
    expect(reviewPrStateLabel(undefined)).toBe("状态未确认")
  })
})

describe("publishBlockers 的冷却门槛", () => {
  it("署名与凭据都就绪、但刚提交过时，只挡「提交间隔」", () => {
    const blockers = publishBlockers({
      credential: liveCredential,
      name: "波坤太叔",
      now: NOW,
      cooldownMs: 5 * 60_000,
    })
    expect(blockers.map((item) => item.id)).toEqual(["cooldown"])
    expect(blockers[0]?.hint).toContain("30 分钟")
    expect(blockers[0]?.hint).toContain("5 分钟")
  })

  it("冷却结束（或没传）时不产生额外门槛", () => {
    expect(
      publishBlockers({ credential: liveCredential, name: "波坤太叔", now: NOW, cooldownMs: 0 })
    ).toEqual([])
    expect(publishBlockers({ credential: liveCredential, name: "波坤太叔", now: NOW })).toEqual([])
  })

  it("两次发布之间的 60 秒也挡发布：不同模组一样算", () => {
    const blockers = publishBlockers({
      credential: liveCredential,
      name: "波坤太叔",
      now: NOW,
      intervalMs: 30_000,
    })
    expect(blockers.map((item) => item.id)).toEqual(["interval"])
    expect(blockers[0]?.hint).toContain("60 秒")
    expect(blockers[0]?.hint).toContain("30 秒")
  })
})

describe("isPublished（市场页签准入）", () => {
  const entry = (mod: Record<string, unknown>) => mod as unknown as ModEntry

  it("索引里在架就认，本地那份草稿状态压不下去", () => {
    // 2026-09-28 报障：在架的旧版 + 本机新版本的 draft 台账 → 市场页签少一张卡
    expect(isPublished(entry({ id: "demo", inMarket: true, review: "draft" }))).toBe(true)
    expect(isPublished(entry({ id: "demo", inMarket: true, review: "approved" }))).toBe(true)
  })

  it("索引里没有就不进市场页签", () => {
    expect(isPublished(entry({ id: "demo", inMarket: false, review: "approved" }))).toBe(false)
    expect(isPublished(entry({ id: "demo", inMarket: false, review: "draft" }))).toBe(false)
  })

  it("没有市场来源信息时退回旧的 review 语义", () => {
    expect(isPublished(entry({ id: "demo", review: "approved" }))).toBe(true)
    expect(isPublished(entry({ id: "demo", review: "draft" }))).toBe(false)
    expect(isPublished(entry({ id: "demo" }))).toBe(true)
  })
})
