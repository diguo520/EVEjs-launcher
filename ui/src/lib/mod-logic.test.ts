import { describe, expect, it } from "vitest"

import {
  PUBLISH_INTERVAL_MS,
  SAFE_DESC_LENGTH,
  SUBMIT_COOLDOWN_MS,
  clampDesc,
  cooldownText,
  compareVersions,
  hasUpdate,
  isPublished,
  isSemverLike,
  intervalText,
  marketVersionDiff,
  publishBlockers,
  publishIntervalRemaining,
  ratingFromReviews,
  reviewPrStateLabel,
  submitCooldownRemaining,
  type PublishCredential,
} from "@/lib/mod-logic"
import type { ModEntry, ModReview } from "@/lib/mock"

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

describe("clampDesc（发布清单里只占一行的简介）", () => {
  it("不超过 60 字就原样返回（去掉首尾空白）", () => {
    expect(clampDesc("自动锁定、自动集火")).toBe("自动锁定、自动集火")
    expect(clampDesc("  采矿  ")).toBe("采矿")
    const exact = "阿".repeat(SAFE_DESC_LENGTH)
    expect(clampDesc(exact)).toBe(exact)
  })

  it("超过 60 字截断并补省略号", () => {
    const long = "阿".repeat(SAFE_DESC_LENGTH + 10)
    const clamped = clampDesc(long)
    expect(clamped).toBe("阿".repeat(SAFE_DESC_LENGTH) + "…")
    expect(clamped).toHaveLength(SAFE_DESC_LENGTH + 1)
  })

  it("空值不会炸，返回空串", () => {
    expect(clampDesc(undefined)).toBe("")
    expect(clampDesc(null)).toBe("")
    expect(clampDesc("   ")).toBe("")
  })

  it("可以按调用方给的上限截断", () => {
    expect(clampDesc("abcdef", 3)).toBe("abc…")
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

describe("compareVersions", () => {
  it("逐段比数字，短的一侧补 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("v1.2.0", "1.1.9")).toBe(1)
    expect(compareVersions("1.0", "1.0.1")).toBe(-1)
    // 字符串排序会把 1.0.10 排在 1.0.9 前面，这里必须按数字段比
    expect(compareVersions("1.0.9", "1.0.10")).toBe(-1)
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1)
  })

  it("预发布小于正式版，预发布之间按字符串比（与外壳 compare_version 同口径）", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1)
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1)
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(1)
  })

  it("非数字段取前缀数字，整段没数字按 0", () => {
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0)
    expect(compareVersions("", "0.0.0")).toBe(0)
  })
})

describe("isSemverLike（与外壳 is_semver_like 同一组向量）", () => {
  it("点分数字段 + 可选预发布/构建尾巴", () => {
    for (const good of ["1", "1.0.0", "0.1", "10.20.30", "1.0.0-beta.1", "1.0.0+build-7"]) {
      expect(isSemverLike(good), good).toBe(true)
    }
    for (const bad of ["", "v1.0.0", "1.0.0-", "1.0.0+", "1.0.0_beta", "1..0"]) {
      expect(isSemverLike(bad), bad).toBe(false)
    }
  })
})

describe("hasUpdate（市场版本严格更高才算）", () => {
  const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })

  it("市场更高就是可更新", () => {
    expect(hasUpdate(mod({ installed: true, version: "1.0.0", latest: "1.1.0" }))).toBe(true)
    expect(hasUpdate(mod({ installed: true, version: "1.0.9", latest: "1.0.10" }))).toBe(true)
  })

  it("本地比市场新时不算可更新（2026-09-30 报障：1.0.5 被提示更新到 1.0.4）", () => {
    expect(hasUpdate(mod({ installed: true, version: "1.0.5", latest: "1.0.4" }))).toBe(false)
  })

  it("版本一样不算，未安装不算，市场没有这条也不算", () => {
    expect(hasUpdate(mod({ installed: true, version: "1.0.0", latest: "1.0.0" }))).toBe(false)
    expect(hasUpdate(mod({ installed: false, version: "1.0.0", latest: "2.0.0" }))).toBe(false)
    expect(hasUpdate(mod({ installed: true, version: "1.0.0" }))).toBe(false)
  })
})

describe("marketVersionDiff（本地与市场不一致时并列显示）", () => {
  const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })

  it("本地更高：市场停在那一版照样给出来（2026-09-30 报障：作者看不出市场收没收到）", () => {
    expect(
      marketVersionDiff(mod({ installed: true, version: "1.0.10", marketVersion: "1.0.7" }))
    ).toBe("1.0.7")
  })

  it("市场更高：也给出来（详情页两行并列，卡片另有「可更新」提示条）", () => {
    expect(
      marketVersionDiff(mod({ installed: true, version: "1.0.0", marketVersion: "1.1.0" }))
    ).toBe("1.1.0")
  })

  it("版本写不一样但等价（1.0 vs 1.0.0）不算不一致", () => {
    expect(
      marketVersionDiff(mod({ installed: true, version: "1.0", marketVersion: "1.0.0" }))
    ).toBeUndefined()
  })

  it("没装 / 市场没这条 / 本地版本空：都不给", () => {
    expect(
      marketVersionDiff(mod({ installed: false, version: "1.0.0", marketVersion: "1.1.0" }))
    ).toBeUndefined()
    expect(marketVersionDiff(mod({ installed: true, version: "1.0.0" }))).toBeUndefined()
    expect(
      marketVersionDiff(mod({ installed: true, version: "", marketVersion: "1.0.0" }))
    ).toBeUndefined()
  })
})

describe("ratingFromReviews（拿评论分片算聚合分）", () => {
  const review = (stars: number): ModReview => ({
    id: "rv",
    author: "",
    corp: "",
    stars,
    date: "2026-10-01",
    version: "1.0.0",
    body: "",
  })

  it("平均分与服务端同口径（两位四舍五入），分档五格", () => {
    const result = ratingFromReviews([review(5), review(4), review(4)])
    expect(result.ratingCount).toBe(3)
    expect(result.ratingAvg).toBe(4.33)
    // 下标 0 是 1 星：两个 4 星（下标 3）+ 一个 5 星（下标 4）
    expect(result.ratingHistogram).toEqual([0, 0, 0, 2, 1])
  })

  it("一条都没有时是 0 / 0（界面据此显示「暂无评分」）", () => {
    expect(ratingFromReviews([])).toEqual({
      ratingAvg: 0,
      ratingCount: 0,
      ratingHistogram: [0, 0, 0, 0, 0],
    })
  })

  it("越界的星级跳过，不把脏数据算进平均分", () => {
    const result = ratingFromReviews([review(5), review(9), review(0)])
    expect(result.ratingCount).toBe(1)
    expect(result.ratingAvg).toBe(5)
  })

  it("分片就是全部评价：只打分不写字的也算一票", () => {
    const scoreOnly: ModReview = { ...review(3), body: "" }
    expect(ratingFromReviews([scoreOnly]).ratingCount).toBe(1)
  })
})