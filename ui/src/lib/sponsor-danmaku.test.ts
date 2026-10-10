import { describe, expect, it } from "vitest"

import {
  SPONSOR_DANMAKU_TARGET_VISIBLE,
  SPONSOR_DANMAKU_TOP_MAX,
  SPONSOR_DANMAKU_TOP_MIN,
  sponsorDanmakuCycleSeconds,
  sponsorDanmakuSchedule,
} from "@/lib/sponsor-danmaku"

describe("赞助人弹幕调度", () => {
  it("空名单不生成弹幕", () => {
    expect(sponsorDanmakuSchedule(0)).toEqual([])
  })

  it("名单越长周期越长，目标同时可见数保持稳定", () => {
    const shortCycle = sponsorDanmakuCycleSeconds(14)
    const longCycle = sponsorDanmakuCycleSeconds(400)
    expect(longCycle).toBeGreaterThan(shortCycle)

    const bullets = sponsorDanmakuSchedule(14)
    const averageTravel =
      bullets.reduce((sum, item) => sum + item.travelSeconds, 0) / bullets.length
    const averageVisible =
      (bullets.length * averageTravel) / sponsorDanmakuCycleSeconds(bullets.length)
    expect(averageVisible).toBeGreaterThanOrEqual(SPONSOR_DANMAKU_TARGET_VISIBLE - 0.5)
    expect(averageVisible).toBeLessThanOrEqual(SPONSOR_DANMAKU_TARGET_VISIBLE + 0.5)
  })

  it("弹幕均匀错峰，既不断档也不挤在同一时刻", () => {
    const bullets = sponsorDanmakuSchedule(14)
    const sorted = bullets.map((item) => item.delaySeconds).sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((value, index) => value - sorted[index])
    expect(Math.min(...gaps)).toBeGreaterThan(0)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.0001)
  })

  it("纵向位置不规则但有界，并带轻微漂移和旋转", () => {
    const bullets = sponsorDanmakuSchedule(20)
    const tops = bullets.map((item) => item.topPercent)
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(SPONSOR_DANMAKU_TOP_MIN)
    expect(Math.max(...tops)).toBeLessThanOrEqual(SPONSOR_DANMAKU_TOP_MAX)
    expect(new Set(tops.map((top) => top.toFixed(2))).size).toBeGreaterThan(15)
    expect(bullets.every((item) => Math.abs(item.driftY) <= 14)).toBe(true)
    expect(bullets.every((item) => Math.abs(item.rotateDeg) <= 1.3)).toBe(true)
  })

  it("同一份名单的调度结果稳定可复现", () => {
    expect(sponsorDanmakuSchedule(30)).toEqual(sponsorDanmakuSchedule(30))
  })
})
