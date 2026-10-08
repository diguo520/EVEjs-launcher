import { describe, expect, it } from "vitest"

import type { RawMarketList, RawMarketMod, RawMod, RawModList, RawMyMods, RawSubmissionItem } from "@/lib/ipc"
import {
  applyLocal,
  applyMine,
  buildMods,
  categoriesOf,
  changelogItems,
  fromMarket,
  isoDate,
  latestSubmission,
  localizedReason,
  readmeOf,
  reviewStateOf,
  reviewsOf,
  sourceRepoIds,
  toMB,
} from "@/lib/mod-source"
import { isPublished } from "@/lib/mod-logic"
import type { ModReview } from "@/lib/mock"

function market(list: unknown[]): RawMarketList {
  return { ok: true, source: "cache", cached: true, mods: list } as unknown as RawMarketList
}

function localMods(list: unknown[]): RawModList {
  return { ok: true, exists: true, mods: list } as unknown as RawModList
}

function mine(items: unknown[]): RawMyMods {
  return { ok: true, hidden: 0, items } as unknown as RawMyMods
}

describe("toMB", () => {
  it("按 1024 进制换算，缺失或 0 给 0", () => {
    expect(toMB(0)).toBe(0)
    expect(toMB(null)).toBe(0)
    expect(toMB(undefined)).toBe(0)
    expect(toMB(1024 * 1024)).toBe(1)
    expect(toMB(1536 * 1024)).toBe(1.5)
  })
})

describe("isoDate", () => {
  it("毫秒时间戳转 YYYY-MM-DD，拿不到给空串", () => {
    expect(isoDate(0)).toBe("")
    expect(isoDate(null)).toBe("")
    expect(isoDate(Date.UTC(2026, 8, 27, 3, 0, 0))).toBe("2026-09-27")
  })
})

describe("reviewStateOf", () => {
  it("把后端状态映射到页面状态", () => {
    expect(reviewStateOf("draft")).toBe("draft")
    expect(reviewStateOf("submitted")).toBe("reviewing")
    expect(reviewStateOf("listed")).toBe("approved")
    expect(reviewStateOf("update-pending")).toBe("approved")
    expect(reviewStateOf("delisted")).toBe("delisted")
    expect(reviewStateOf("rejected")).toBe("rejected")
    expect(reviewStateOf("local")).toBe("draft")
  })
})

describe("fromMarket / applyLocal / applyMine", () => {
  const entry = fromMarket({
    id: "demo",
    displayName: "演示模组",
    version: "1.2.0",
    description: "一句话",
    category: "经济",
    tags: ["市场"],
    author: { id: "a", name: "作者", keyId: "k" },
    sizeBytes: 2 * 1024 * 1024,
    downloads: 12,
    publishedAt: "2026-09-01",
    requiresRestart: false,
  } as unknown as RawMarketMod)

  it("市场条目 → 视图模型", () => {
    expect(entry.name).toBe("演示模组")
    expect(entry.cat).toBe("经济")
    expect(entry.sizeMB).toBe(2)
    expect(entry.inMarket).toBe(true)
    expect(entry.needsRestart).toBe(false)
    expect(entry.installed).toBe(false)
  })

  it("本地扫描叠加到市场条目上", () => {
    const merged = applyLocal(entry, {
      id: "demo",
      folder: "demo-folder",
      displayName: "演示模组",
      version: "1.1.0",
      enabled: true,
      sizeBytes: 1024 * 1024,
      updatedAt: Date.UTC(2026, 8, 20),
      activeConflicts: ["other"],
    } as unknown as RawMod)
    expect(merged.installed).toBe(true)
    expect(merged.enabled).toBe(true)
    expect(merged.folder).toBe("demo-folder")
    expect(merged.conflicts).toEqual(["other"])
    expect(merged.sizeMB).toBe(1)
  })

  it("声明的冲突列表优先于运行时子集（不然没启用的关联会消失）", () => {
    const merged = applyLocal(entry, {
      id: "demo",
      folder: "demo-folder",
      version: "1.1.0",
      enabled: true,
      // 清单里声明了三条关联；activeConflicts 只是「当前两边都启用」的那一条
      conflicts: ["installed-on", "not-installed", "disabled-mod"],
      activeConflicts: ["installed-on"],
    } as unknown as RawMod)
    expect(merged.conflicts).toEqual(["installed-on", "not-installed", "disabled-mod"])
  })

  it("我的条目叠加审核状态与驳回原因", () => {
    const merged = applyMine(entry, {
      id: "demo",
      displayName: "演示模组",
      status: "rejected",
      sourceRepo: "me/demo",
      moderationReason: "清单缺少权限声明",
    } as unknown as Record<string, unknown> as never)
    expect(merged.mine).toBe(true)
    expect(merged.review).toBe("rejected")
    expect(merged.reviewNote).toBe("清单缺少权限声明")
  })

  /**
   * 「移除记录」的两个判据要原样落到视图模型上：own=false（换过身份投的）不给入口，
   * recordOnly=true（本地没文件夹、索引里也没这条）才给 —— 少透传一个字段，界面要么
   * 把别人的记录也列出来删，要么永远不出现这个入口（2026-10-01 报障）。
   */
  it("own / recordOnly 原样透传，缺字段按「是我的、不是只剩记录」兜底", () => {
    const ghost = applyMine(entry, {
      id: "demo",
      displayName: "演示模组",
      status: "delisted",
      own: false,
      recordOnly: true,
    } as unknown as Record<string, unknown> as never)
    expect(ghost.own).toBe(false)
    expect(ghost.recordOnly).toBe(true)

    const older = applyMine(entry, {
      id: "demo",
      displayName: "演示模组",
      status: "listed",
    } as unknown as Record<string, unknown> as never)
    // 缺字段（老快照 / 原型演示数据）时按「是我的、不是只剩记录」兜底：不凭空藏掉入口
    expect(older.own).toBe(true)
    expect(older.recordOnly).toBe(false)
  })

  /**
   * 索引里的审核原因是 `{ zh, en }`（控制台填的两栏原样发布）。原先只认字符串，
   * 整个对象被 typeof 判掉 —— 就是报障里「已下架的说明理由没有显示」。
   */
  it("审核原因是 { zh, en } 对象时按当前语言取一份，下架 / 拒绝收录的理由都显示", () => {
    const item = {
      id: "demo",
      displayName: "演示模组",
      status: "delisted",
      sourceRepo: "me/demo",
      moderationReason: { zh: "manifest 字段缺失", en: "manifest field missing" },
    } as unknown as Record<string, unknown> as never
    const chinese = applyMine(entry, item, "zh")
    expect(chinese.review).toBe("delisted")
    expect(chinese.reviewNote).toBe("manifest 字段缺失")
    expect(applyMine(entry, item, "en").reviewNote).toBe("manifest field missing")
  })
})

describe("localizedReason", () => {
  it("中文取 zh、其余语言取 en，缺哪边用另一边兜底", () => {
    const reason = { zh: "仓库不属于作者", en: "repo does not belong to the author" }
    expect(localizedReason(reason, "zh")).toBe("仓库不属于作者")
    expect(localizedReason(reason, "en")).toBe("repo does not belong to the author")
    expect(localizedReason(reason, "ja")).toBe("repo does not belong to the author")
    expect(localizedReason({ zh: "只有中文" }, "en")).toBe("只有中文")
    expect(localizedReason({ en: "english only" }, "zh")).toBe("english only")
    expect(localizedReason("旧数据的纯字符串", "en")).toBe("旧数据的纯字符串")
    expect(localizedReason(null, "zh")).toBe("")
    expect(localizedReason(undefined, "zh")).toBe("")
  })
})

describe("buildMods", () => {
  it("三个来源合并，同 id 后者覆盖，且市场版本不同才挂可更新", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.2.0" }]),
      list: localMods([
        { id: "demo", folder: "demo", version: "1.0.0", enabled: true, displayName: "演示" },
      ]),
      mine: mine([{ id: "demo", displayName: "演示", status: "listed" }]),
    })
    expect(mods).toHaveLength(1)
    expect(mods[0].installed).toBe(true)
    expect(mods[0].version).toBe("1.0.0")
    // 市场那一版单独留一个字段，不随本地扫描覆盖
    expect(mods[0].marketVersion).toBe("1.2.0")
    expect(mods[0].latest).toBe("1.2.0")
    expect(mods[0].mine).toBe(true)
    expect(mods[0].review).toBe("approved")
  })

  it("本地独有的模组标 inMarket=false，未安装时不挂可更新", () => {
    const mods = buildMods({
      market: market([]),
      list: localMods([{ id: "solo", folder: "solo", version: "0.1.0" }]),
    })
    expect(mods[0].inMarket).toBe(false)
    expect(mods[0].latest).toBeUndefined()
  })

  it("空来源给空列表", () => {
    expect(buildMods({})).toEqual([])
  })

  it("在架条目不被「我创建的」草稿状态顶下去（2026-09-28 报障）", () => {
    // 索引里有这条（已上架），本机台账同 id 的状态是 draft（新版本还没提审）：
    // 合并后 review 会变成 draft，但 inMarket 仍是 true，市场页签必须保留这张卡
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.7" }]),
      mine: mine([{ id: "demo", displayName: "演示", status: "draft" }]),
    })
    expect(mods).toHaveLength(1)
    expect(mods[0].inMarket).toBe(true)
    expect(mods[0].review).toBe("draft")
    expect(isPublished(mods[0])).toBe(true)
  })
})

describe("sourceRepoIds / latestSubmission", () => {
  const submission = (id: string, createdAt: number, sourceRepo: string): RawSubmissionItem =>
    ({ id, createdAt, sourceRepo } as unknown as RawSubmissionItem)

  it("只收有源码仓库的模组 id", () => {
    const ids = sourceRepoIds(
      mine([{ id: "a", sourceRepo: "me/a" }, { id: "b" }]),
      [submission("c", 1, "me/c")]
    )
    expect(ids.sort()).toEqual(["a", "c"])
  })

  it("取该模组最近一次提交", () => {
    const items = [submission("a", 10, "me/a"), submission("a", 30, "me/a"), submission("b", 99, "me/b")]
    expect(latestSubmission(items, "a")?.createdAt).toBe(30)
    expect(latestSubmission(items, "zzz")).toBeNull()
  })
})

describe("categoriesOf", () => {
  it("按出现顺序去重", () => {
    const mods = buildMods({
      market: market([
        { id: "a", displayName: "A", category: "经济" },
        { id: "b", displayName: "B", category: "玩法" },
        { id: "c", displayName: "C", category: "经济" },
      ]),
    })
    expect(categoriesOf(mods)).toEqual(["经济", "玩法"])
  })
})

/**
 * 2026-09-29 报障：详情页「功能说明 / 版本历史」永远是空的，
 * 作者改完模组信息回详情也看不到。这两块的数据来源在这里钉住。
 */
describe("readmeOf / 版本历史", () => {
  it("正文 + 功能要点合成详情页读的段落", () => {
    expect(readmeOf(["第一段", "第二段"], ["要点一", "要点二"])).toEqual([
      "第一段",
      "第二段",
      "功能要点",
      "· 要点一",
      "· 要点二",
    ])
    expect(readmeOf(undefined, undefined)).toEqual([])
  })

  it("已经带「功能要点」标题的段落原样使用，不重复加", () => {
    const paragraphs = ["第一段", "功能要点", "· 要点一"]
    expect(readmeOf(paragraphs, ["要点一"])).toEqual(paragraphs)
  })

  it("版本说明按行拆，去掉 Markdown 列表符号", () => {
    expect(changelogItems("- 修复 A\n* 修复 B\n· 修复 C\n\n")).toEqual([
      "修复 A",
      "修复 B",
      "修复 C",
    ])
    expect(changelogItems(undefined)).toEqual([])
  })

  it("市场条目带出当前版本与更早的 history（最新的在前）", () => {
    const entry = fromMarket({
      id: "demo",
      version: "1.2.0",
      publishedAt: "2026-09-20",
      changelog: "修复 A",
      history: [
        { version: "1.1.0", changelog: "老版本说明", at: Date.UTC(2026, 7, 1) },
      ],
    } as unknown as RawMarketMod)
    expect(entry.changelog).toEqual([
      { version: "1.2.0", date: "2026-09-20", items: ["修复 A"] },
      { version: "1.1.0", date: "2026-08-01", items: ["老版本说明"] },
    ])
  })

  it("本地扫描的正文覆盖索引那份（作者改完立刻可见）", () => {
    const entry = fromMarket({
      id: "demo",
      version: "1.0.0",
      readme: ["旧正文"],
      highlights: ["旧要点"],
    } as unknown as RawMarketMod)
    const merged = applyLocal(entry, {
      id: "demo",
      folder: "demo",
      readme: ["新正文"],
      highlights: ["新要点"],
    } as unknown as RawMod)
    expect(merged.readme).toEqual(["新正文", "功能要点", "· 新要点"])
    // 本地没读到 README 时保留索引那份，别把正文抹掉
    const kept = applyLocal(entry, { id: "demo", folder: "demo" } as unknown as RawMod)
    expect(kept.readme).toEqual(["旧正文", "功能要点", "· 旧要点"])
  })

  it("提交台账补出版本历史：同版本只留最新一条，最新的在前", () => {
    const mods = buildMods({
      mine: mine([{ id: "demo", displayName: "演示", status: "listed" }]),
      submissions: [
        {
          id: "demo",
          version: "1.0.0",
          changelog: "首个版本",
          createdAt: Date.UTC(2026, 7, 1),
        },
        {
          id: "demo",
          version: "1.1.0",
          changelog: "修复 A",
          createdAt: Date.UTC(2026, 8, 1),
        },
        { id: "other", version: "9.9.9", changelog: "别的模组", createdAt: Date.UTC(2026, 8, 2) },
      ] as unknown as RawSubmissionItem[],
    })
    expect(mods[0].changelog).toEqual([
      { version: "1.1.0", date: "2026-09-01", items: ["修复 A"] },
      { version: "1.0.0", date: "2026-08-01", items: ["首个版本"] },
    ])
  })

  it("台账里没有的条目退回索引带的版本历史", () => {
    const mods = buildMods({
      market: market([
        {
          id: "demo",
          version: "2.0.0",
          publishedAt: "2026-09-10",
          changelog: "市场版说明",
        },
      ]),
      submissions: [],
    })
    expect(mods[0].changelog).toEqual([
      { version: "2.0.0", date: "2026-09-10", items: ["市场版说明"] },
    ])
  })
})

describe("buildMods 的可更新判定", () => {
  it("本地版本比市场新时不挂可更新（不把降级当升级）", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.4" }]),
      list: localMods([
        { id: "demo", folder: "demo", version: "1.0.5", enabled: true, displayName: "演示" },
      ]),
      mine: mine([{ id: "demo", displayName: "演示", status: "listed" }]),
    })
    expect(mods[0].version).toBe("1.0.5")
    expect(mods[0].latest).toBeUndefined()
  })

  it("市场版本更高才挂可更新", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.10" }]),
      list: localMods([
        { id: "demo", folder: "demo", version: "1.0.9", enabled: true, displayName: "演示" },
      ]),
    })
    expect(mods[0].latest).toBe("1.0.10")
  })

  it("本地更高时 marketVersion 留住市场那一版（2026-09-30 报障：两边看不出差别）", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.7" }]),
      list: localMods([
        { id: "demo", folder: "demo", version: "1.0.10", enabled: true, displayName: "演示" },
      ]),
    })
    // version 是本地那一版、marketVersion 是市场登记的那一版，互不覆盖
    expect(mods[0].version).toBe("1.0.10")
    expect(mods[0].marketVersion).toBe("1.0.7")
    expect(mods[0].latest).toBeUndefined()
  })

  it("只装了本地草稿（市场没这条）时不给 marketVersion", () => {
    const mods = buildMods({
      market: market([]),
      list: localMods([{ id: "solo", folder: "solo", version: "0.1.0" }]),
    })
    expect(mods[0].marketVersion).toBeUndefined()
  })

  it("版本字面不同但等价（1.0 vs 1.0.0）不算可更新", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.0" }]),
      list: localMods([
        { id: "demo", folder: "demo", version: "1.0", enabled: true, displayName: "演示" },
      ]),
    })
    expect(mods[0].latest).toBeUndefined()
  })
})

describe("评价写路径要的数据（指纹与聚合分）", () => {
  const review = (over: Partial<ModReview>): ModReview => ({
    id: "rv",
    author: "",
    corp: "",
    stars: 5,
    date: "2026-10-01",
    version: "1.0.0",
    body: "",
    ...over,
  })

  it("安装包指纹从市场索引带过来，并统一成小写（评价服务靠它确认「真的装过」）", () => {
    const sha = "a".repeat(64)
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.0", sha256: sha.toUpperCase() }]),
    })
    expect(mods[0].pkgSha256).toBe(sha)
  })

  it("索引里没有指纹就不编一个", () => {
    const mods = buildMods({
      market: market([{ id: "demo", displayName: "演示", version: "1.0.0" }]),
    })
    expect(mods[0].pkgSha256).toBeUndefined()
  })

  it("评论拉回来之后聚合分改由分片算（刚投的那一票立刻进汇总行）", () => {
    const mods = buildMods({
      market: market([
        { id: "demo", displayName: "演示", version: "1.0.0", ratingAvg: 2, ratingCount: 1 },
      ]),
      reviews: { demo: [review({ id: "rv-1", stars: 5 }), review({ id: "rv-2", stars: 4 })] },
    })
    expect(mods[0].ratingCount).toBe(2)
    expect(mods[0].ratingAvg).toBe(4.5)
    expect(mods[0].reviews).toHaveLength(2)
  })

  it("没拉过评论的模组照旧用索引里的聚合分", () => {
    const mods = buildMods({
      market: market([
        { id: "demo", displayName: "演示", version: "1.0.0", ratingAvg: 3.5, ratingCount: 8 },
      ]),
    })
    expect(mods[0].ratingCount).toBe(8)
    expect(mods[0].ratingAvg).toBe(3.5)
  })

  it("评论里的地区码原样透传；旧快照没有这个字段就是空串，不伪造", () => {
    const entries = reviewsOf([
      { id: "rv-1", stars: 5, country: "DE" },
      { id: "rv-2", stars: 4 },
    ] as unknown as Parameters<typeof reviewsOf>[0])
    expect(entries[0].country).toBe("DE")
    expect(entries[1].country).toBe("")
  })
})
