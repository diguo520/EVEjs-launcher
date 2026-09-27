import { describe, expect, it } from "vitest"

import type { RawMarketList, RawMarketMod, RawMod, RawModList, RawMyMods, RawSubmissionItem } from "@/lib/ipc"
import {
  applyLocal,
  applyMine,
  buildMods,
  categoriesOf,
  fromMarket,
  isoDate,
  latestSubmission,
  reviewStateOf,
  sourceRepoIds,
  toMB,
} from "@/lib/mod-source"

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
