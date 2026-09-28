import { describe, expect, it } from "vitest"

import {
  SUBMIT_COOLDOWN_MS,
  cooldownText,
  publishBlockers,
  reviewPrStateLabel,
  submitCooldownRemaining,
  type PublishCredential,
} from "@/lib/mod-logic"

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
})
