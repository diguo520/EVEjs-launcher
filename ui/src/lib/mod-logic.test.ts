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
  effectiveDownloads,
  hasUpdate,
  isPublished,
  isSemverLike,
  localFolderOf,
  intervalText,
  marketCounts,
  featuredMods,
  featuredScore,
  FEATURED_SLOTS,
  MOD_CATEGORIES,
  normalizeModCategory,
  marketVersionDiff,
  publishBlockers,
  publishIntervalRemaining,
  ALL_CATEGORY,
  filterMods,
  modByFolderOrId,
  overlapFlag,
  overlapReport,
  groupByEnabled,
  mergeEnabledOrder,
  moveWithin,
  parseIdList,
  parseTags,
  ratingFromStarCount,
  sortMods,
  MOD_SORT_ORDER,
  formatCount,
  formatBytes,
  serverSupportOf,
  bumpVersion,
  reviewPrStateLabel,
  submitCooldownRemaining,
  type PublishCredential,
} from "@/lib/mod-logic"
import type { RawModPreflightMod, RawModPreflightReport } from "@/lib/ipc"
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

describe("加载顺序（已安装页）", () => {
  const mod = (id: string, enabled: boolean) => ({ id, enabled }) as unknown as ModEntry

  it("启用的排前面、停用的排后面，两段内部保持原序", () => {
    const list = groupByEnabled([
      mod("a", false),
      mod("b", true),
      mod("c", false),
      mod("d", true),
    ])
    expect(list.map((item) => item.id)).toEqual(["b", "d", "a", "c"])
  })

  it("拖到某个卡片前面 / 后面", () => {
    expect(moveWithin(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"])
    expect(moveWithin(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"])
    // 拖到自己身上、或目标不存在：原样返回
    expect(moveWithin(["a", "b"], "a", "a", true)).toEqual(["a", "b"])
    expect(moveWithin(["a", "b"], "a", "ghost", true)).toEqual(["a", "b"])
  })

  it("合并回完整顺序：停用的条目留在原位，启用段按新顺序填回槽位", () => {
    // 完整顺序 a b c d，其中 b/d 启用；把 d 拖到 b 前面
    const merged = mergeEnabledOrder(["a", "b", "c", "d"], ["b", "d"], ["d", "b"])
    expect(merged).toEqual(["a", "d", "c", "b"])
    // 停用的 a / c 没有被挤到末尾，也没有换位
    expect(merged[0]).toBe("a")
    expect(merged[2]).toBe("c")
  })

  it("关掉再打开回到原来的位置：只要不动顺序文件，槽位就还在", () => {
    const saved = ["a", "b", "c", "d"]
    // b 被停用：展示分组把它挪到后面，但顺序文件不动
    expect(groupByEnabled(saved.map((id) => mod(id, id !== "b"))).map((m) => m.id)).toEqual([
      "a",
      "c",
      "d",
      "b",
    ])
    // 重新启用：展示顺序回到 a b c d
    expect(groupByEnabled(saved.map((id) => mod(id, true))).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })

  it("长度对不上（调用方的启用列表已过期）就不动", () => {
    expect(mergeEnabledOrder(["a", "b", "c"], ["a", "b"], ["b"])).toEqual(["a", "b", "c"])
    expect(mergeEnabledOrder(["a", "b"], [], [])).toEqual(["a", "b"])
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

describe("bumpVersion（提交弹窗预填的下一版）", () => {
  it("补丁号 +1：每交一版只往前走一个号", () => {
    expect(bumpVersion("1.0.14")).toBe("1.0.15")
    expect(bumpVersion("0.9.9")).toBe("0.9.10")
    expect(bumpVersion("2.3.0")).toBe("2.3.1")
  })

  it("不是三段数字就原样返回，交给弹窗的格式校验去拦", () => {
    expect(bumpVersion("1.0")).toBe("1.0")
    expect(bumpVersion("1.0.0-rc.1")).toBe("1.0.0-rc.1")
  })
})

describe("serverSupportOf（模组声明的服务端版本）", () => {
  it("日期版本号：同一天的所有构建算同一代", () => {
    // 服务端 0.5.0 起是「日期.构建号」：261018.1 = 2026-10-18 的第 1 次构建
    expect(serverSupportOf(["261018.x"], "261018.1")).toBe("supported")
    expect(serverSupportOf(["261018.x"], "261018.9")).toBe("supported")
    expect(serverSupportOf(["261018.1"], "261018.2")).toBe("supported")
    expect(serverSupportOf(["261018.1"], "261019.1")).toBe("unsupported")
  })

  it("老版本号：补丁向上兼容，minor / major 仍然拦住", () => {
    expect(serverSupportOf(["0.12.8"], "0.12.9")).toBe("supported")
    expect(serverSupportOf(["0.12.x"], "0.12.9")).toBe("supported")
    expect(serverSupportOf(["0.12.8"], "0.12.7")).toBe("unsupported")
    expect(serverSupportOf(["0.12.9"], "261018.1")).toBe("unsupported")
  })

  it("没声明 / 当前版本未知 → unknown（画「未声明」，不画「不兼容」）", () => {
    expect(serverSupportOf([], "261018.1")).toBe("unknown")
    expect(serverSupportOf(undefined, "261018.1")).toBe("unknown")
    expect(serverSupportOf(["261018.x"], "")).toBe("unknown")
  })

  it("当前版本带 v 前缀也能对上（状态栏显示值曾把通配判错）", () => {
    // 2026-10-19 报障：卡片拿到的是 `v261018.1`，`261018.x` 的前缀通配直接对不上，
    // 新建的模组被误判成「不支持当前服务端版本」
    expect(serverSupportOf(["261018.x"], "v261018.1")).toBe("supported")
    expect(serverSupportOf(["0.12.x"], "v0.12.9")).toBe("supported")
    expect(serverSupportOf(["261018.1"], "V261018.2")).toBe("supported")
  })
})

describe("localFolderOf（「打开所在目录」的目标目录）", () => {
  const entry = (mod: Record<string, unknown>) => mod as unknown as ModEntry

  it("有 folder 就用 folder：手写目录可以和清单 id 不同名", () => {
    expect(
      localFolderOf(entry({ id: "my-mod", folder: "My Handmade Mod", installed: true }))
    ).toBe("My Handmade Mod")
  })

  it("只有 installed、没有 folder 时回落到 id", () => {
    expect(localFolderOf(entry({ id: "demo", installed: true }))).toBe("demo")
  })

  it("市场里还没装的条目没有本地目录，返回 null（详情页据此不画那个按钮）", () => {
    // 2026-10-17 报障的那条路：市场条目上点「打开所在目录」只会得到「目录不存在」
    expect(localFolderOf(entry({ id: "demo", inMarket: true, installed: false }))).toBeNull()
    expect(localFolderOf(entry({ id: "demo" }))).toBeNull()
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

describe("ratingFromStarCount（星标数就是唯一口径）", () => {
  it("星标数原样进汇总，遗留均分只有 0 与 5", () => {
    const result = ratingFromStarCount(5)
    expect(result.ratingCount).toBe(5)
    expect(result.ratingAvg).toBe(5)
    expect(result.ratingHistogram).toEqual([0, 0, 0, 0, 5])
  })

  it("没人点星时是 0 / 0（界面据此显示「0」而不是空白）", () => {
    expect(ratingFromStarCount(0)).toEqual({
      ratingAvg: 0,
      ratingCount: 0,
      ratingHistogram: [0, 0, 0, 0, 0],
    })
  })

  it("脏数据（负数 / NaN / 小数）不进界面", () => {
    expect(ratingFromStarCount(-3).ratingCount).toBe(0)
    expect(ratingFromStarCount(Number.NaN).ratingCount).toBe(0)
    expect(ratingFromStarCount(2.7).ratingCount).toBe(2)
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

  it("市场统计与筛选支持已安装 / 可更新 / 未安装 / 我收藏的", () => {
    const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })
    const pool = [
      mod({ id: "installed", installed: true, version: "1.0.0" }),
      mod({ id: "updated", installed: true, version: "1.0.0", latest: "1.1.0" }),
      mod({ id: "available", installed: false }),
      mod({ id: "favorite", installed: false }),
    ]
    const favoriteOf = (id: string) => id === "favorite"
    expect(marketCounts(pool, favoriteOf)).toEqual({
      all: 4,
      installed: 2,
      updatable: 1,
      available: 2,
      favorite: 1,
    })

    const ids = (filter: "installed" | "updatable" | "available" | "favorite") =>
      filterMods({
        mods: pool,
        tab: "market",
        marketFilter: filter,
        query: "",
        category: ALL_CATEGORY,
        favoriteOf,
      }).map((item) => item.id)
    expect(ids("installed")).toEqual(["installed", "updated"])
    expect(ids("updatable")).toEqual(["updated"])
    expect(ids("available")).toEqual(["available", "favorite"])
    expect(ids("favorite")).toEqual(["favorite"])
  })

  it("星星排序只看获得的星标数，不再看平均分", () => {
    const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })
    const pool = [
      mod({ id: "few", ratingCount: 3, ratingAvg: 5, downloads: 100 }),
      mod({ id: "many", ratingCount: 30, ratingAvg: 0, downloads: 1 }),
    ]
    expect(sortMods(pool, "stars").map((item) => item.id)).toEqual(["many", "few"])
  })

  it("当前版本排序按市场版本号从高到低，同版本看下载量", () => {
    const mod = (over: Partial<ModEntry>): ModEntry => ({ ...({} as ModEntry), ...over })
    const pool = [
      mod({ id: "old", version: "1.2.9", marketVersion: "1.2.9", downloads: 999 }),
      mod({ id: "new", version: "1.10.0", marketVersion: "1.10.0", downloads: 10 }),
      mod({ id: "mid-a", version: "1.9.1", marketVersion: "1.9.1", downloads: 20 }),
      mod({ id: "mid-b", version: "1.9.1", marketVersion: "1.9.1", downloads: 80 }),
      // 已安装条目：本地比市场新时，排序仍看市场那一版（version 已被本地扫描覆盖）
      mod({
        id: "local-newer",
        installed: true,
        version: "2.0.0",
        marketVersion: "1.9.2",
        downloads: 1,
      }),
    ]
    expect(sortMods(pool, "version").map((item) => item.id)).toEqual([
      "new",
      "local-newer",
      "mid-b",
      "mid-a",
      "old",
    ])
    expect(MOD_SORT_ORDER).toContain("version")
  })
})

describe("模组分类", () => {
  it("旧「画面」统一归到「界面」，空分类落到玩法", () => {
    expect(normalizeModCategory("画面")).toBe("界面")
    expect(normalizeModCategory(" 界面 ")).toBe("界面")
    expect(normalizeModCategory("")).toBe("玩法")
    expect(normalizeModCategory("舰船")).toBe("舰船")
  })

  it("新增的舰船 / 装备 / 皮肤 / 界面 / 动画 / 声音都在白名单里", () => {
    for (const category of ["舰船", "装备", "皮肤", "界面", "动画", "声音"]) {
      expect(MOD_CATEGORIES).toContain(category)
    }
    expect(MOD_CATEGORIES).not.toContain("画面")
  })
})

describe("formatBytes（体积读数）", () => {
  it("按量级换单位", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(10240)).toBe("10.0 KB")
    expect(formatBytes(1024 * 200)).toBe("200 KB")
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB")
  })

  it("真拿不到才画破折号", () => {
    expect(formatBytes(Number.NaN)).toBe("—")
    expect(formatBytes(-1)).toBe("—")
  })
})

describe("formatCount（星标数按国际单位缩写）", () => {
  it("不足一千原样显示，千以上缩一位小数并去掉多余的 .0", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(999)).toBe("999")
    expect(formatCount(1000)).toBe("1K")
    expect(formatCount(1234)).toBe("1.2K")
    expect(formatCount(999_949)).toBe("999.9K")
    expect(formatCount(1_200_000)).toBe("1.2M")
    expect(formatCount(2_500_000_000)).toBe("2.5B")
    expect(formatCount(Number.NaN)).toBe("0")
  })
})

describe("下载量缺失的兜底（effectiveDownloads）", () => {
  it("downloads 是 0、但 cdnHits 有值 → 用 cdnHits", () => {
    // 索引逐仓抓 GitHub 失败时会**写成 0 而不是报错**，这正是那批"下载量没了"的模组
    expect(effectiveDownloads({ downloads: 0, cdnHits: 554 })).toBe(554)
  })

  it("downloads 有值就用它，不看 cdnHits", () => {
    // 实测：中文文本修复 索引 609 / GitHub 求和 609，完全一致 —— 这种不该被改动
    expect(effectiveDownloads({ downloads: 609, cdnHits: 55 })).toBe(609)
  })

  it("两个都是 0 就照实留 0，不编数字", () => {
    // 新模组真没下载 vs 两个计数都没取到，这里分不出来 —— 宁可显示「暂无」也不猜
    expect(effectiveDownloads({ downloads: 0, cdnHits: 0 })).toBe(0)
    expect(effectiveDownloads({})).toBe(0)
  })

  it("负数 / NaN / 缺失一律按 0 处理", () => {
    expect(effectiveDownloads({ downloads: -5, cdnHits: 0 })).toBe(0)
    expect(effectiveDownloads({ downloads: NaN, cdnHits: 12 })).toBe(12)
    expect(effectiveDownloads({ downloads: undefined, cdnHits: 120 })).toBe(120)
  })
})

describe("精选位（下载量 + 星星综合分）", () => {
  const mod = (id: string, downloads: number, ratingCount = 0) =>
    ({ id, name: id, downloads, ratingCount, ratingAvg: ratingCount > 0 ? 5 : 0 }) as unknown as ModEntry

  it("综合分 = 下载量 + 星标人数", () => {
    expect(featuredScore(mod("a", 100, 5))).toBe(105)
    expect(featuredScore(mod("b", 0, 0))).toBe(0)
  })

  it("取综合分最高的 3 个", () => {
    const mods = [mod("low", 10, 0), mod("top", 500, 9), mod("mid", 200, 3), mod("tiny", 1, 0)]
    const picked = featuredMods(mods)
    expect(picked.map((m) => m.id)).toEqual(["top", "mid", "low"])
  })

  it("候选只有 3 个（不多给）", () => {
    const mods = Array.from({ length: 10 }, (_, i) => mod("m" + i, 100 - i, 0))
    expect(featuredMods(mods)).toHaveLength(FEATURED_SLOTS)
    expect(FEATURED_SLOTS).toBe(3)
  })

  it("总分相等时下载量多者优先", () => {
    // 100+10 与 105+5 都是 110，但后者下载更多
    const mods = [mod("moreStars", 100, 10), mod("moreDownloads", 105, 5)]
    expect(featuredMods(mods).map((m) => m.id)).toEqual(["moreDownloads", "moreStars"])
  })

  it("完全并列时按 id 字典序，顺序稳定", () => {
    const mods = [mod("z", 50, 5), mod("a", 50, 5), mod("m", 50, 5)]
    expect(featuredMods(mods).map((m) => m.id)).toEqual(["a", "m", "z"])
    // 多次调用结果一致
    expect(featuredMods(mods).map((m) => m.id)).toEqual(featuredMods(mods).map((m) => m.id))
  })

  it("星标全为 0 时退化成按下载量排，不会乱序", () => {
    const mods = [mod("a", 10, 0), mod("b", 300, 0), mod("c", 50, 0), mod("d", 1, 0)]
    expect(featuredMods(mods).map((m) => m.id)).toEqual(["b", "c", "a"])
  })

  it("模组不足 3 个就少给，不拿占位符凑数", () => {
    expect(featuredMods([mod("only", 5)])).toHaveLength(1)
    expect(featuredMods([])).toHaveLength(0)
  })

  it("不就地修改入参", () => {
    const mods = [mod("a", 1), mod("b", 9), mod("c", 5)]
    const before = mods.map((m) => m.id)
    featuredMods(mods)
    expect(mods.map((m) => m.id)).toEqual(before)
  })

  it("异常数值不会污染排序（NaN / 负数按 0 算）", () => {
    const bad = { id: "bad", name: "bad", downloads: NaN, ratingCount: -3 } as unknown as ModEntry
    expect(featuredScore(bad)).toBe(0)
    const mods = [bad, mod("good", 10, 1)]
    expect(featuredMods(mods).map((m) => m.id)).toEqual(["good", "bad"])
  })
})
