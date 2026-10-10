import { describe, expect, it } from "vitest"

import {
  addOffer,
  applyEdits,
  buildFulfillment,
  catalogOf,
  categoriesOf,
  centsPerPlexOf,
  centsToPlex,
  changedRowIDs,
  draftErrorsOf,
  draftOfRow,
  emptyNewOfferDraft,
  fulfillmentKindOf,
  isAsciiOnly,
  isUnpurchasable,
  KIND_DEFAULT_IMAGE,
  legacyPlexPriceOf,
  matchesQuery,
  nextProductID,
  nextShelfOfferID,
  plexToCents,
  rowsOf,
  slugify,
  splitTags,
  summaryOfAuthority,
  uniqueStoreOfferID,
  validateNewOffer,
  withItem,
  withKind,
  type StoreAuthority,
  type StoreItemInfo,
  type StoreLegacyOffer,
  type StorePublicOffer,
} from "@/lib/store-editor-model"

/**
 * 一件游戏内商品在服务端是**两条记录**：货架（stores[4].offers[]，游戏网格读它）
 * 和收银台（publicOffers[]，真正扣 PLEX 读它）。下面的夹具按真实数据抄 ——
 * sunesis_hull 的 fulfillment 两边就是同一个对象。
 */
function legacyOffer(overrides: Partial<StoreLegacyOffer> = {}): StoreLegacyOffer {
  return {
    id: 9200013,
    storeOfferID: "sunesis_hull",
    name: "Sunesis",
    description: "Deliver a Sunesis hull to the active character.",
    tags: ["ship", "hull"],
    imageUrl: "res:/ui/texture/icons/7_64_15.png",
    href: "/store/4/offers/sunesis-hull",
    offerPricings: [{ currency: "PLX", price: 95, basePrice: 95 }],
    products: [{ id: 9100013, quantity: 1, typeId: 42685 }],
    categories: [{ id: 9000007 }],
    fulfillment: { kind: "item", quantity: 1, typeID: 42685 },
    preview: { badge: "HULL", accent: "#81a8ff" },
    canPurchase: true,
    singlePurchase: false,
    label: null,
    ...overrides,
  }
}

function publicOffer(overrides: Partial<StorePublicOffer> = {}): StorePublicOffer {
  return {
    storeOfferID: "sunesis_hull",
    name: "Sunesis",
    description: "Deliver a Sunesis hull to the active character.",
    tags: ["ship", "hull"],
    imageUrl: "res:/ui/texture/icons/7_64_15.png",
    plexPriceInCents: 9500,
    currencyCode: null,
    currencyAmountInCents: null,
    fulfillment: { kind: "item", quantity: 1, typeID: 42685 },
    preview: { badge: "HULL", accent: "#81a8ff" },
    source: { kind: "seeded-local" },
    canPurchase: true,
    ...overrides,
  }
}

function authorityOf(
  legacy: StoreLegacyOffer[],
  publicOffers: Record<string, StorePublicOffer>,
): StoreAuthority {
  return {
    meta: { version: 2, seedProfile: "official-observed-2026-03-26" },
    config: { editorPort: 26008 },
    stores: {
      4: { storeID: 4, name: "New Eden Store", categories: [{ id: 9000000 }], products: [], offers: legacy },
    },
    publicOffers,
    fastCheckout: { offers: [], tokensByID: {} },
  }
}

describe("PLEX 定价换算", () => {
  it("centsPerPlex 缺失或非法时兜底 100", () => {
    expect(centsPerPlexOf(undefined)).toBe(100)
    expect(centsPerPlexOf({})).toBe(100)
    expect(centsPerPlexOf({ centsPerPlex: 0 })).toBe(100)
    expect(centsPerPlexOf({ centsPerPlex: -5 })).toBe(100)
    expect(centsPerPlexOf({ centsPerPlex: 100 })).toBe(100)
  })

  it("分 → PLEX，50000 分 = 500 PLEX", () => {
    expect(centsToPlex(50000, 100)).toBe(500)
    expect(centsToPlex(9500, 100)).toBe(95)
  })

  it("非有限数或负数一律当 0，不显示 NaN", () => {
    expect(centsToPlex(undefined, 100)).toBe(0)
    expect(centsToPlex("abc", 100)).toBe(0)
    expect(centsToPlex(-1, 100)).toBe(0)
  })

  it("PLEX → 分四舍五入到整分，负数归 0", () => {
    expect(plexToCents(95, 100)).toBe(9500)
    expect(plexToCents(1.239, 100)).toBe(124)
    expect(plexToCents(-3, 100)).toBe(0)
  })

  it("往返不丢值", () => {
    for (const cents of [0, 9500, 50000, 12345]) {
      expect(plexToCents(centsToPlex(cents, 100), 100)).toBe(cents)
    }
  })
})

describe("标签切分", () => {
  it("逗号、中文逗号、空格都是分隔符", () => {
    expect(splitTags("a, b，c d")).toEqual(["a", "b", "c", "d"])
  })
  it("去空、去重、保序", () => {
    expect(splitTags("  ship ,, ship  hull ")).toEqual(["ship", "hull"])
  })
})

describe("货架价与 store 定位", () => {
  it("取 offerPricings 里那条 PLX", () => {
    expect(legacyPlexPriceOf(legacyOffer())).toBe(95)
    expect(legacyPlexPriceOf(legacyOffer({ offerPricings: [{ currency: "PLX", price: 7 }] }))).toBe(7)
    expect(legacyPlexPriceOf(legacyOffer({ offerPricings: [] }))).toBe(0)
  })

  it("优先认 storeID=4 的那个 store", () => {
    const authority = authorityOf([legacyOffer()], {})
    authority.stores["9"] = { storeID: 9, name: "Other" }
    expect(catalogOf(authority)?.key).toBe("4")
  })
})

describe("合成行", () => {
  it("两侧都有 → 游戏内可见", () => {
    const rows = rowsOf(authorityOf([legacyOffer()], { sunesis_hull: publicOffer() }))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("ingame")
    expect(isUnpurchasable(rows[0])).toBe(false)
  })

  it("只有收银台 → 标 checkout", () => {
    const rows = rowsOf(authorityOf([], { cash_plex_100_usd: publicOffer() }))
    expect(rows[0].kind).toBe("checkout")
  })

  it("只有货架 → 游戏内可见但点了买不了", () => {
    const rows = rowsOf(authorityOf([legacyOffer()], {}))
    expect(rows[0].kind).toBe("ingame")
    expect(isUnpurchasable(rows[0])).toBe(true)
  })

  it("游戏内可见的排在仅收银台的前面", () => {
    const rows = rowsOf(
      authorityOf([legacyOffer()], { aaa_cash: publicOffer({ storeOfferID: "aaa_cash" }), sunesis_hull: publicOffer() }),
    )
    expect(rows.map((row) => row.id)).toEqual(["sunesis_hull", "aaa_cash"])
  })

  it("草稿以货架为准（那才是游戏里看到的）", () => {
    const row = rowsOf(authorityOf([legacyOffer()], { sunesis_hull: publicOffer({ plexPriceInCents: 111 }) }))[0]
    const draft = draftOfRow(row, 100)
    expect(draft.plexPrice).toBe(95)
    expect(draft.name).toBe("Sunesis")
    expect(draft.tags).toEqual(["ship", "hull"])
  })

  it("发货类型优先取收银台的", () => {
    const row = rowsOf(authorityOf([legacyOffer({ fulfillment: { kind: "old" } })], { sunesis_hull: publicOffer() }))[0]
    expect(fulfillmentKindOf(row)).toBe("item")
  })
})

describe("草稿与校验", () => {
  it("商品名空 / 价格为负都会报错", () => {
    expect(draftErrorsOf({ name: "  ", description: "", tags: [], plexPrice: 1 }))
      .toEqual(["商品名不能为空"])
    expect(draftErrorsOf({ name: "x", description: "", tags: [], plexPrice: -1 }))
      .toEqual(["PLEX 价格必须是不小于 0 的数字"])
    expect(draftErrorsOf({ name: "x", description: "", tags: [], plexPrice: 0 }))
      .toEqual([])
  })

  it("搜索命中商品名、ID 或标签", () => {
    const row = rowsOf(authorityOf([legacyOffer()], { sunesis_hull: publicOffer() }))[0]
    expect(matchesQuery(row, "")).toBe(true)
    expect(matchesQuery(row, "SUNESIS")).toBe(true)
    expect(matchesQuery(row, "sunesis_hull")).toBe(true)
    expect(matchesQuery(row, "hull")).toBe(true)
    expect(matchesQuery(row, "zzz")).toBe(false)
  })
})

describe("改动比对与整棵写回", () => {
  const base = authorityOf([legacyOffer()], { sunesis_hull: publicOffer() })
  const draftsOf = (patch: Partial<ReturnType<typeof draftOfRow>>) => ({
    sunesis_hull: { ...draftOfRow(rowsOf(base)[0], 100), ...patch },
  })

  it("没改就什么都不算改动", () => {
    expect(changedRowIDs(base, draftsOf({}), 100)).toEqual([])
    expect(applyEdits(base, draftsOf({}), 100)).toBe(base)
  })

  it("五个字段各自都能被识别为改动", () => {
    expect(changedRowIDs(base, draftsOf({ name: "Other" }), 100)).toEqual(["sunesis_hull"])
    expect(changedRowIDs(base, draftsOf({ description: "x" }), 100)).toEqual(["sunesis_hull"])
    expect(changedRowIDs(base, draftsOf({ tags: ["ship"] }), 100)).toEqual(["sunesis_hull"])
    expect(changedRowIDs(base, draftsOf({ plexPrice: 96 }), 100)).toEqual(["sunesis_hull"])
    expect(changedRowIDs(base, draftsOf({ canPurchase: false }), 100)).toEqual(["sunesis_hull"])
  })

  /** 这就是用户踩到的那个坑：只写收银台 = 游戏里看不到任何变化 */
  it("改价同时写货架（PLEX）与收银台（分）", () => {
    const next = applyEdits(base, draftsOf({ plexPrice: 120 }), 100)!
    const legacy = next.stores["4"].offers![0]
    expect(legacyPlexPriceOf(legacy)).toBe(120)
    expect(legacy.offerPricings![0].basePrice).toBe(120)
    expect(next.publicOffers.sunesis_hull.plexPriceInCents).toBe(12000)
  })

  it("改名 / 描述 / 标签 / 上下架也两边一起写", () => {
    const next = applyEdits(
      base,
      draftsOf({ name: "Sunesis Hull", description: "d", tags: ["ship"], canPurchase: false }),
      100,
    )!
    const legacy = next.stores["4"].offers![0]
    expect(legacy.name).toBe("Sunesis Hull")
    expect(legacy.tags).toEqual(["ship"])
    expect(legacy.canPurchase).toBe(false)
    expect(next.publicOffers.sunesis_hull.name).toBe("Sunesis Hull")
    expect(next.publicOffers.sunesis_hull.canPurchase).toBe(false)
  })

  it("只覆盖界面管得着的字段，其余原样带回", () => {
    const next = applyEdits(base, draftsOf({ plexPrice: 120 }), 100)!
    const legacy = next.stores["4"].offers![0]
    expect(legacy.id).toBe(9200013)
    expect(legacy.products).toEqual([{ id: 9100013, quantity: 1, typeId: 42685 }])
    expect(legacy.fulfillment).toEqual({ kind: "item", quantity: 1, typeID: 42685 })
    expect(legacy.preview).toEqual({ badge: "HULL", accent: "#81a8ff" })
    expect(next.publicOffers.sunesis_hull.source).toEqual({ kind: "seeded-local" })
    expect(next.publicOffers.sunesis_hull.fulfillment).toEqual({ kind: "item", quantity: 1, typeID: 42685 })
  })

  it("没有 PLX 定价的货架记录会补上一条", () => {
    const bare = authorityOf([legacyOffer({ offerPricings: [] })], { sunesis_hull: publicOffer() })
    const next = applyEdits(
      bare,
      { sunesis_hull: { ...draftOfRow(rowsOf(bare)[0], 100), plexPrice: 42 } },
      100,
    )!
    expect(legacyPlexPriceOf(next.stores["4"].offers![0])).toBe(42)
  })

  it("只改收银台的条目时，货架一个字节都不动", () => {
    const mixed = authorityOf([legacyOffer()], {
      sunesis_hull: publicOffer(),
      cash_plex_100_usd: publicOffer({ storeOfferID: "cash_plex_100_usd", plexPriceInCents: 1000000 }),
    })
    const next = applyEdits(
      mixed,
      { cash_plex_100_usd: { ...draftOfRow(rowsOf(mixed)[1], 100), plexPrice: 12000 } },
      100,
    )!
    expect(next.stores["4"].offers![0]).toEqual(base.stores["4"].offers![0])
    expect(next.publicOffers.cash_plex_100_usd.plexPriceInCents).toBe(1200000)
  })

  it("不动 meta / fastCheckout，也不改入参", () => {
    const before = JSON.stringify(base)
    const next = applyEdits(base, draftsOf({ canPurchase: false }), 100)!
    expect(next.meta).toEqual(base.meta)
    expect(next.fastCheckout).toEqual(base.fastCheckout)
    expect(JSON.stringify(base)).toBe(before)
    expect(next).not.toBe(base)
  })

  it("读不到权威数据时不假装成功", () => {
    expect(applyEdits(undefined, draftsOf({ name: "x" }), 100)).toBeNull()
  })
})

describe("摘要", () => {
  it("分开统计游戏内可见 / 仅收银台 / 缺收银台", () => {
    const summary = summaryOfAuthority(
      authorityOf([legacyOffer(), legacyOffer({ storeOfferID: "drake_hull" })], {
        sunesis_hull: publicOffer(),
        cash_plex_100_usd: publicOffer({ storeOfferID: "cash_plex_100_usd" }),
      }),
    )
    expect(summary.ingameOffers).toBe(2)
    expect(summary.publicOffers).toBe(2)
    expect(summary.legacyOffers).toBe(2)
    expect(summary.unpurchasable).toBe(1)
  })
})


/* ============================ 上架新商品 ============================ */

const RICK = "res:/UI/Texture/Icons/Inventory/skillInjectorAlpha.png"
const itemInfo = (over: Partial<StoreItemInfo> = {}): StoreItemInfo => ({
  typeID: 46375,
  known: true,
  name: "Daily Alpha Injector",
  groupName: "Skill Injector",
  iconID: 21835,
  imageUrl: RICK,
  ...over,
})

describe("上架的 id 与 slug", () => {
  it("货架 id / 商品 id 都从现有最大值 +1", () => {
    const authority = authorityOf([legacyOffer({ id: 9200015 })], {})
    ;(authority.stores["4"].products as unknown[]) = [{ id: 9100015, name: "x" }]
    expect(nextShelfOfferID(authority)).toBe(9200016)
    expect(nextProductID(authority)).toBe(9100016)
  })

  it("空的权威数据也能从基线起算", () => {
    const authority = authorityOf([], {})
    expect(nextShelfOfferID(authority)).toBe(9200001)
    expect(nextProductID(authority)).toBe(9100001)
  })

  it("slug 只留小写字母数字下划线，中文名兜底 offer", () => {
    expect(slugify("Daily Alpha Injector!")).toBe("daily_alpha_injector")
    expect(slugify("旭日级")).toBe("offer")
  })

  it("slug 与已有 storeOfferID 撞车时自动加后缀", () => {
    const authority = authorityOf([legacyOffer({ storeOfferID: "sunesis_hull" })], {})
    expect(uniqueStoreOfferID(authority, "sunesis_hull")).toBe("sunesis_hull_2")
    expect(uniqueStoreOfferID(authority, "brand_new")).toBe("brand_new")
  })

  it("分类下拉来自现有分类", () => {
    const authority = authorityOf([], {})
    ;(authority.stores["4"].categories as unknown[]) = [{ id: 9000007, name: "Ships" }]
    expect(categoriesOf(authority)).toEqual([{ id: 9000007, name: "Ships" }])
  })
})

describe("发货方式", () => {
  it("四种各写各的字段", () => {
    const base = emptyNewOfferDraft(9000007)
    expect(buildFulfillment({ ...base, kind: "item", typeID: 46375, quantity: 3 })).toEqual({
      kind: "item",
      quantity: 3,
      typeID: 46375,
    })
    expect(buildFulfillment({ ...base, kind: "omega", durationDays: 90 })).toEqual({
      kind: "omega",
      durationDays: 90,
    })
    expect(buildFulfillment({ ...base, kind: "mct", durationDays: 30, slotCount: 2 })).toEqual({
      kind: "mct",
      durationDays: 30,
      slotCount: 2,
    })
    expect(buildFulfillment({ ...base, kind: "grant_plex", plexAmount: 500 })).toEqual({
      kind: "grant_plex",
      plexAmount: 500,
    })
  })

  it("换成非物品类时自动补该类固定图，换回物品时清空", () => {
    const item = emptyNewOfferDraft(9000007)
    const omega = withKind(item, "omega")
    expect(omega.imageUrl).toBe(KIND_DEFAULT_IMAGE.omega)
    const back = withKind(omega, "item")
    expect(back.imageUrl).toBe("")
    expect(back.typeID).toBe(0)
  })

  it("选中物品后按它的图标填 imageUrl，并默认带上物品名", () => {
    const next = withItem(emptyNewOfferDraft(9000007), itemInfo())
    expect(next.typeID).toBe(46375)
    expect(next.imageUrl).toBe(RICK)
    expect(next.name).toBe("Daily Alpha Injector")
  })

  it("已经填过名字就不覆盖", () => {
    const draft = { ...emptyNewOfferDraft(9000007), name: "我自己的名字" }
    expect(withItem(draft, itemInfo()).name).toBe("我自己的名字")
  })
})

describe("上架前校验", () => {
  const authority = authorityOf([], {})
  const good = {
    ...emptyNewOfferDraft(9000007),
    name: "Alpha Pack",
    plexPrice: 250,
    typeID: 46375,
    imageUrl: RICK,
  }

  it("齐全时没有错误", () => {
    expect(validateNewOffer(authority, good, [itemInfo()]).errors).toEqual([])
  })

  it("没选物品 / 服务端不认识 / 数量非法都会报错", () => {
    expect(validateNewOffer(authority, good, []).errors).toContain("请先选择要上架的物品")
    expect(validateNewOffer(authority, good, [itemInfo({ known: false })]).errors).toContain(
      "这个物品不在服务端物品库里，上架后买了拿不到货",
    )
    expect(validateNewOffer(authority, { ...good, quantity: 0 }, [itemInfo()]).errors).toContain(
      "数量必须是不小于 1 的整数",
    )
  })

  it("天数 / 槽位 / PLEX 数量各按发货方式校验", () => {
    expect(validateNewOffer(authority, { ...good, kind: "omega", durationDays: 0 }, []).errors)
      .toContain("天数必须是不小于 1 的整数")
    expect(
      validateNewOffer(authority, { ...good, kind: "mct", durationDays: 30, slotCount: 0 }, []).errors,
    ).toContain("槽位数必须是不小于 1 的整数")
    expect(validateNewOffer(authority, { ...good, kind: "grant_plex", plexAmount: 0 }, []).errors)
      .toContain("发放的 PLEX 数量必须是不小于 1 的整数")
  })

  it("没选分类会报错", () => {
    expect(validateNewOffer(authority, { ...good, categoryID: 0 }, [itemInfo()]).errors).toContain(
      "请选择一个分类",
    )
  })

  /**
   * 物品没图标是物品本身的问题（矿石/舰船在客户端里就没有），所以只是提示；
   * 但**图片本身必填** —— 不给替代图，游戏里就只剩一张灰色占位图。
   */
  it("物品没有图标时提示另选图片，并且图片必填会拦住", () => {
    const result = validateNewOffer(authority, { ...good, imageUrl: "" }, [
      itemInfo({ iconID: null, imageUrl: "" }),
    ])
    expect(result.warnings).toContain("这个物品在客户端里没有图标，请另选一张图片")
    expect(result.errors).toContain("请为这件商品选一个图片，否则游戏里只会显示占位图")
  })

  it("挑了一张替代图之后就不再报错", () => {
    const result = validateNewOffer(authority, good, [itemInfo({ iconID: null, imageUrl: "" })])
    expect(result.errors).toEqual([])
  })

  /** 客户端按 Latin-1 解字段，中文进商城一定乱码，所以模型层直接拦 */
  it("商品名 / 描述 / 标签里的中文都会被拦住", () => {
    expect(validateNewOffer(authority, { ...good, name: "旭日级" }, [itemInfo()]).errors).toContain(
      "商品名只能用英文：客户端显示不了中文，会变成乱码",
    )
    expect(
      validateNewOffer(authority, { ...good, description: "交付一艘旭日级" }, [itemInfo()]).errors,
    ).toContain("描述只能用英文：客户端显示不了中文，会变成乱码")
    expect(
      validateNewOffer(authority, { ...good, tags: ["舰船"] }, [itemInfo()]).errors,
    ).toContain("标签只能用英文：客户端显示不了中文，会变成乱码")
  })

  it("纯英文的文本通过", () => {
    expect(isAsciiOnly("Sunesis Hull")).toBe(true)
    expect(isAsciiOnly("旭日级")).toBe(false)
    expect(isAsciiOnly("line1\nline2")).toBe(true)
    expect(isAsciiOnly("café")).toBe(false)
  })

  it("读不到商店目录时拒绝上架", () => {
    expect(validateNewOffer(undefined, good, [itemInfo()]).errors).toContain(
      "读不到游戏内商店目录，无法上架",
    )
  })
})

describe("上架写全四处", () => {
  const draft = {
    ...emptyNewOfferDraft(9000007),
    name: "Alpha Pack",
    description: "10 injectors",
    tags: ["injector"],
    plexPrice: 250,
    quantity: 10,
    typeID: 46375,
  }

  function freshBase() {
    const authority = authorityOf([legacyOffer({ id: 9200015 })], { sunesis_hull: publicOffer() })
    ;(authority.stores["4"].products as unknown[]) = [{ id: 9100015, name: "Sunesis" }]
    return authority
  }

  it("货架 / 商品目录 / offer 内嵌 products / 收银台 全都写了", () => {
    const next = addOffer(freshBase(), draft, 100)!
    const offers = next.stores["4"].offers!
    const shelf = offers[offers.length - 1]
    const products = next.stores["4"].products as { id: number; name: string; href: string }[]
    const added = next.publicOffers.alpha_pack

    expect(shelf.id).toBe(9200016)
    expect(shelf.storeOfferID).toBe("alpha_pack")
    expect(shelf.href).toBe("/store/4/offers/alpha-pack")
    expect(legacyPlexPriceOf(shelf)).toBe(250)
    expect(shelf.fulfillment).toEqual({ kind: "item", quantity: 10, typeID: 46375 })
    expect((shelf.products as { id: number }[])[0].id).toBe(9100016)

    expect(products[products.length - 1]).toEqual({
      id: 9100016,
      name: "Alpha Pack",
      href: "/store/4/products/alpha-pack",
    })

    expect(added.plexPriceInCents).toBe(25000)
    expect(added.fulfillment).toEqual({ kind: "item", quantity: 10, typeID: 46375 })
    expect(added.name).toBe("Alpha Pack")
  })

  it("上架后立刻是「游戏内可见且能买」的行", () => {
    const next = addOffer(freshBase(), draft, 100)!
    const row = rowsOf(next).find((item) => item.id === "alpha_pack")!
    expect(row.kind).toBe("ingame")
    expect(isUnpurchasable(row)).toBe(false)
    expect(summaryOfAuthority(next).unpurchasable).toBe(0)
  })

  it("卡片预览与图片照抄草稿", () => {
    const next = addOffer(freshBase(), { ...draft, imageUrl: RICK }, 100)!
    const offers = next.stores["4"].offers!
    const shelf = offers[offers.length - 1]
    expect(shelf.imageUrl).toBe(RICK)
    const preview = shelf.preview as { title: string; badge: string }
    expect(preview.title).toBe("Alpha Pack")
    expect(preview.badge).toBe("ITEM")
  })

  it("不动入参，也不碰 meta / fastCheckout", () => {
    const base = freshBase()
    const before = JSON.stringify(base)
    const next = addOffer(base, draft, 100)!
    expect(JSON.stringify(base)).toBe(before)
    expect(next.meta).toEqual(base.meta)
    expect(next.fastCheckout).toEqual(base.fastCheckout)
    expect(next.stores["4"].offers!.length).toBe(base.stores["4"].offers!.length + 1)
  })

  it("读不到权威数据时返回 null", () => {
    expect(addOffer(undefined, draft, 100)).toBeNull()
  })
})

describe("不改动界面没让改的字段", () => {
  /** cash_* 这类只收 USD 的礼包，plexPriceInCents 是 null（= 不走 PLEX 定价），
   *  保存时不能把它归成 0，也不能凭空补 canPurchase 键。 */
  it("null 的 PLEX 定价不会被归成 0，缺省的 canPurchase 也不会被补上", () => {
    const cash = publicOffer({
      storeOfferID: "cash_alpha_combo",
      plexPriceInCents: null as unknown as number,
    })
    // JSON 里就是「没有这个键」，而不是值为 undefined
    delete (cash as Record<string, unknown>).canPurchase
    const base = authorityOf([], { cash_alpha_combo: cash })
    const next = applyEdits(base, { cash_alpha_combo: { ...draftOfRow(rowsOf(base)[0], 100), name: "Alpha Combo" } }, 100)!
    const after = next.publicOffers.cash_alpha_combo
    expect(after.name).toBe("Alpha Combo")
    expect(after.plexPriceInCents).toBeNull()
    expect("canPurchase" in after).toBe(false)
  })

  it("用户真的填了价才写回数字", () => {
    const cash = publicOffer({
      storeOfferID: "cash_alpha_combo",
      plexPriceInCents: null as unknown as number,
    })
    const base = authorityOf([], { cash_alpha_combo: cash })
    const next = applyEdits(base, { cash_alpha_combo: { ...draftOfRow(rowsOf(base)[0], 100), plexPrice: 250 } }, 100)!
    expect(next.publicOffers.cash_alpha_combo.plexPriceInCents).toBe(25000)
  })
})
