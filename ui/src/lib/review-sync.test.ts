import { describe, expect, it } from "vitest"

import { REVIEW_SYNC_COOLDOWN_MS, planReviewLoad } from "@/lib/review-sync"

const T0 = 1_800_000_000_000

describe("planReviewLoad", () => {
  it("内存里没有就普通拉一次，界面等它", () => {
    expect(planReviewLoad({ inMemory: false, fetchedAt: 0, now: T0 })).toBe("load")
    expect(planReviewLoad({ inMemory: false, fetchedAt: T0 - 1, now: T0 })).toBe("load")
  })

  it("内存里有、从没打过网络：先用着，后台强拉一次", () => {
    expect(planReviewLoad({ inMemory: true, fetchedAt: 0, now: T0 })).toBe("sync")
  })

  it("60 秒内刚拉过就不重复拉（反复开关弹窗不该打接口）", () => {
    expect(planReviewLoad({ inMemory: true, fetchedAt: T0 - 1_000, now: T0 })).toBe("skip")
    expect(
      planReviewLoad({ inMemory: true, fetchedAt: T0 - REVIEW_SYNC_COOLDOWN_MS + 1, now: T0 })
    ).toBe("skip")
  })

  it("过了冷却窗口就再拉一次", () => {
    expect(
      planReviewLoad({ inMemory: true, fetchedAt: T0 - REVIEW_SYNC_COOLDOWN_MS, now: T0 })
    ).toBe("sync")
    expect(
      planReviewLoad({ inMemory: true, fetchedAt: T0 - 10 * REVIEW_SYNC_COOLDOWN_MS, now: T0 })
    ).toBe("sync")
  })

  it("时钟脏值（NaN / 负数）当没拉过处理，不炸", () => {
    expect(planReviewLoad({ inMemory: true, fetchedAt: Number.NaN, now: T0 })).toBe("sync")
    expect(planReviewLoad({ inMemory: true, fetchedAt: -1, now: T0 })).toBe("sync")
  })

  it("冷却窗口可覆盖", () => {
    expect(
      planReviewLoad({ inMemory: true, fetchedAt: T0 - 5_000, now: T0, cooldownMs: 1_000 })
    ).toBe("sync")
  })
})
