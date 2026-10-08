import { describe, expect, it } from "vitest"

import {
  AUTHOR_NAME_PLACEHOLDER,
  DEFAULT_SIGNATURE_PUBLISH_HINT,
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
  ALL_CATEGORY,
  filterMods,
  modByFolderOrId,
  overlapFlag,
  overlapReport,
  parseIdList,
  parseTags,
  ratingFromReviews,
  reviewPrStateLabel,
  submitCooldownRemaining,
  type PublishCredential,
} from "@/lib/mod-logic"
import type { RawModPreflightMod, RawModPreflightReport } from "@/lib/ipc"
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

describe("parseTags（标签输入）", () => {
  it("逗号、中文逗号和空白都能分隔，并去空去重", () => {
    expect(parseTags("AI, 陪玩 新手，AI\n经济")).toEqual(["AI", "陪玩", "新手", "经济"])
    expect(parseTags("  alpha   beta\tgamma  ")).toEqual(["alpha", "beta", "gamma"])
    expect(parseTags("聊天,聊天，，  聊天")).toEqual(["聊天"])
  })

  it("最多保留 5 个", () => {
    expect(parseTags("1 2 3 4 5 6")).toEqual(["1", "2", "3", "4", "5"])
  })
})

describe("parseIdList（关联模组 id）", () => {
  it("逗号、中文逗号和空白都能分隔，并去空去重", () => {
    expect(parseIdList("alpha beta,gamma，delta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ])
    expect(parseIdList("  evejs-a   evejs-b\t evejs-c\n")).toEqual([
      "evejs-a",
      "evejs-b",
      "evejs-c",
    ])
    expect(parseIdList("alpha alpha beta")).toEqual(["alpha", "beta"])
  })

  it("不设数量上限（关联本来就该照实写全）", () => {
    expect(parseIdList("1 2 3 4 5 6 7")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ])
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

  it("默认的「指挥官」署名只供本地测试，发布前必须改掉", () => {
    const blockers = publishBlockers({
      credential: liveCredential,
      name: AUTHOR_NAME_PLACEHOLDER,
      now: NOW,
    })
    expect(blockers.map((item) => item.id)).toEqual(["signature"])
    expect(blockers[0]?.hint).toBe(DEFAULT_SIGNATURE_PUBLISH_HINT)
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

describe("overlapReport（疑似重叠：改同一份服务端文件 / 撞同一个注入标记）", () => {
  const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })
  const ref = (folder: string, id: string): RawModPreflightMod => ({
    folder,
    id,
    enabled: true,
    verdict: "ok",
    declaredFingerprints: 1,
  })
  const report = (over: Partial<RawModPreflightReport>): RawModPreflightReport => ({
    ...({} as RawModPreflightReport),
    ok: true,
    dryRun: false,
    ignored: [],
    targets: [],
    summary: { ignored: 0, targets: 0, shared: 0, stale: 0, scannedMods: 0 },
    ...over,
  })

  it("同文件 + 同标记才算真冲突，并且能定位到具体模组", () => {
    const result = overlapReport(
      report({
        markerConflicts: [
          {
            target: "src/network/tcp/handshake.js",
            marker: "// evejs-inject:login-reward",
            mods: [ref("案例A-采矿助手", "demo-a"), ref("案例B-锁定助手", "demo-b")],
          },
        ],
        targets: [{ file: "src/network/tcp/handshake.js", shared: true, mods: [] }],
      })
    )
    expect(result.markers).toHaveLength(1)
    expect(result.markers[0].marker).toBe("// evejs-inject:login-reward")
    expect(result.markers[0].mods.map((item) => item.id)).toEqual(["demo-a", "demo-b"])
    // 卷进真冲突的模组要在卡片上打红标（按 mods/ 目录名认）
    expect(result.conflictKeys).toEqual(["案例A-采矿助手", "案例B-锁定助手"])
    // 已经被标记冲突覆盖的文件不再计入「只是重叠」，免得同一份文件报两遍
    expect(result.sharedOnly).toBe(0)
  })

  it("只是改同一份文件（标记不同）：只算重叠计数，模组列进 sharedKeys", () => {
    const result = overlapReport(
      report({
        targets: [
          { file: "src/services/chat/sessionChatSync.js", shared: true, mods: [ref("重叠C", "demo-c"), ref("重叠D", "demo-d")] },
          { file: "src/space/runtime.js", shared: true, mods: [ref("重叠C", "demo-c"), ref("别的", "other")] },
          { file: "src/services/market/marketService.js", shared: false, mods: [ref("单个", "solo")] },
        ],
      })
    )
    expect(result.markers).toHaveLength(0)
    expect(result.sharedOnly).toBe(2)
    // 去重：demo-c 改了两份文件，只出现一次
    expect(result.sharedKeys).toEqual(["重叠C", "重叠D", "别的"])
    expect(result.conflictKeys).toEqual([])
  })

  it("预检标记冲突的模组不再进 sharedKeys（红标压过黄标）", () => {
    const result = overlapReport(
      report({
        markerConflicts: [{ target: "src/a.js", marker: "// m:patch", mods: [ref("A", "a"), ref("B", "b")] }],
        targets: [{ file: "src/a.js", shared: true, mods: [ref("A", "a"), ref("B", "b")] }],
      })
    )
    expect(result.conflictKeys).toEqual(["A", "B"])
    expect(result.sharedKeys).toEqual([])
    expect(result.sharedOnly).toBe(0)
  })

  it("没跑过预检、或一条只有单个模组引用时不报", () => {
    expect(overlapReport(null)).toEqual({
      markers: [],
      sharedOnly: 0,
      conflictKeys: [],
      sharedKeys: [],
    })
    const result = overlapReport(
      report({
        markerConflicts: [{ target: "a.js", marker: "// x", mods: [ref("only", "only")] }],
      })
    )
    expect(result.markers).toHaveLength(0)
    expect(result.conflictKeys).toEqual([])
  })

  it("modByFolderOrId 先按目录名找，再退回 id；找不到给 null（调用方据此不给按钮）", () => {
    const mods = [mod({ id: "demo-a", folder: "案例A-采矿助手" })]
    expect(modByFolderOrId(mods, { folder: "案例A-采矿助手", id: "demo-a" })?.id).toBe("demo-a")
    expect(modByFolderOrId(mods, { folder: "改过名", id: "demo-a" })?.id).toBe("demo-a")
    expect(modByFolderOrId(mods, { folder: "nope", id: "nope" })).toBeNull()
  })

  it("overlapFlag 给卡片挑标：真冲突 > 只是重叠 > 不打标", () => {
    const result = overlapReport(
      report({
        markerConflicts: [{ target: "src/a.js", marker: "// m:patch", mods: [ref("案例A", "demo-a"), ref("案例B", "demo-b")] }],
        targets: [{ file: "src/b.js", shared: true, mods: [ref("案例C", "demo-c"), ref("案例D", "demo-d")] }],
      })
    )
    expect(overlapFlag(result, mod({ id: "demo-a", folder: "案例A" }))).toBe("conflict")
    expect(overlapFlag(result, mod({ id: "demo-c", folder: "案例C" }))).toBe("shared")
    expect(overlapFlag(result, mod({ id: "demo-e", folder: "案例E" }))).toBeNull()
  })

  it("没有 folder 的模组按 id 认（原型数据 / 市场条目）", () => {
    const result = overlapReport(report({ markerConflicts: [{ target: "src/a.js", marker: "// m:patch", mods: [ref("", "demo-x"), ref("", "demo-y")] }] }))
    expect(result.conflictKeys).toEqual(["demo-x", "demo-y"])
    expect(overlapFlag(result, mod({ id: "demo-x" }))).toBe("conflict")
  })

  it("「启动预检」页签不参与模组清单筛选（内容是面板，不是卡片）", () => {
    const mods = [mod({ id: "demo-a", installed: true }), mod({ id: "demo-b", mine: true })]
    const pool = filterMods({
      mods,
      tab: "preflight",
      marketFilter: "all",
      query: "",
      category: ALL_CATEGORY,
    })
    expect(pool).toEqual([])
  })
})
