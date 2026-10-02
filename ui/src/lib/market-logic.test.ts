import { describe, expect, it } from "vitest"

import type {
  RawMarketCatalog,
  RawMarketHistoryPoint,
  RawMarketStockRow,
  RawMarketTypeRow,
} from "@/lib/ipc"
import {
  EMPTY_CATALOG,
  filterTypeRows,
  formatDay,
  formatIsk,
  formatIskShort,
  formatQty,
  formatStamp,
  historyChart,
  namePair,
  nodePath,
  sortStockByPrice,
  sortTypeRows,
  toCatalog,
  touchedStockRows,
} from "@/lib/market-logic"

/**
 * fixture 按 2026-10-02 真机探针的原始形状写：
 * catalog 的类型行是**紧凑数组**（见 ipc.ts 的列序注释），不是对象。
 */
function row(
  typeId: number,
  mgId: number,
  groupId: number,
  catId: number,
  name: string,
  basePrice: number,
  volume: number,
  portionSize: number,
  bestAsk: number,
  askQty: number,
  askStation: number,
  bestBid: number,
  bidQty: number,
  bidStation: number
): RawMarketTypeRow {
  return [
    typeId,
    mgId,
    groupId,
    catId,
    name,
    basePrice,
    volume,
    portionSize,
    bestAsk,
    askQty,
    askStation,
    bestBid,
    bidQty,
    bidStation,
  ]
}

const RAW: RawMarketCatalog = {
  ok: true,
  path: "E:/Games/EveJS-v0.12.9/externalservices/market-server/data/generated/market.sqlite",
  region: { id: 10000002, name: "The Forge" },
  sde: true,
  stations: [
    {
      station_id: 60003760,
      station_name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
      solar_system_id: 30000142,
      solar_system_name: "Jita",
      security: 0.945913,
    },
    {
      station_id: 60000361,
      station_name: "Jita IV - Moon 6 - Ytiri Storage",
      solar_system_id: 30000142,
      solar_system_name: "Jita",
      security: 0.945913,
    },
  ],
  // 4 舰船 → 5 标准护卫舰；150 技能（根）
  tree: [
    [4, -1, "舰船", "Ships"],
    [5, 4, "标准护卫舰", "Standard Frigates"],
    [150, -1, "技能", "Skills"],
  ],
  groups: [[25, "护卫舰", "Frigate"]],
  categories: [[6, "舰船", "Ship"]],
  types: [
    // 斜长岩：挂在 5 下面，有卖有买
    row(18, 5, 25, 6, "Plagioclase", 12800, 0.35, 100, 13688.77, 999, 60000361, 11908.93, 500, 60003760),
    // 三钛合金：同样挂 5
    row(34, 5, 25, 6, "Tritanium", 5, 0.01, 1, 6.02, 20000000, 60003760, 5.5, 100, 60000361),
    // 技能书：挂 150
    row(2333, 150, 25, 6, "Mining Survey Chipset II", 0, 5, 1, 33264.12, 12, 60003760, 0, 0, 0),
  ],
}

describe("market-logic", () => {
  it("紧凑数组按列序装进列式表，不丢精度", () => {
    const catalog = toCatalog(RAW)
    expect(catalog.types.length).toBe(3)
    expect(catalog.region.name).toBe("The Forge")
    expect(catalog.stations.length).toBe(2)
    expect(catalog.stationName.get(60000361)).toContain("Ytiri Storage")

    expect(Array.from(catalog.types.typeId)).toEqual([18, 34, 2333])
    expect(Array.from(catalog.types.mgId)).toEqual([5, 5, 150])
    expect(catalog.types.name[2]).toBe("Mining Survey Chipset II")
    // 带小数的价格必须原样保留（浮点列，不是整数列）
    expect(catalog.types.bestAsk[0]).toBeCloseTo(13688.77, 2)
    expect(catalog.types.askQty[1]).toBe(20000000)
    expect(catalog.types.askStation[0]).toBe(60000361)
  })

  it("分类树：物品数累加到祖先，descendants 展开到后代", () => {
    const catalog = toCatalog(RAW)
    const ships = catalog.nodeById.get(4)
    const frigs = catalog.nodeById.get(5)
    expect(ships?.count).toBe(2)
    expect(frigs?.count).toBe(2)
    expect(catalog.nodeById.get(150)?.count).toBe(1)
    // 根节点按物品数排，舰船(2) 在 技能(1) 前面
    expect(catalog.roots.map((node) => node.id)).toEqual([4, 150])
    expect(catalog.idsUnder.get(4)).toEqual([4, 5])
    expect(catalog.idsUnder.get(5)).toEqual([5])
  })

  it("面包屑是从根到该节点的路径", () => {
    const catalog = toCatalog(RAW)
    expect(nodePath(catalog, 5).map((node) => node.nameZh)).toEqual(["舰船", "标准护卫舰"])
    expect(nodePath(catalog, 150).map((node) => node.nameZh)).toEqual(["技能"])
    expect(nodePath(catalog, 9999)).toEqual([])
  })

  it("按分类筛选含全部后代；按名称 / 中文名 / typeID 都能搜到", () => {
    const catalog = toCatalog(RAW)
    // 选中「舰船」：下面的两个矿都进来，技能书不进来
    expect(filterTypeRows(catalog, { nodeId: 4, query: "" })).toEqual([0, 1])
    expect(filterTypeRows(catalog, { nodeId: 150, query: "" })).toEqual([2])
    // 全选：三行都在
    expect(filterTypeRows(catalog, { nodeId: null, query: "" })).toEqual([0, 1, 2])

    expect(filterTypeRows(catalog, { nodeId: null, query: "plagio" })).toEqual([0])
    expect(filterTypeRows(catalog, { nodeId: null, query: "2333" })).toEqual([2])
    // 中文名走 items.json 的映射，没给映射就搜不到中文
    const cnNames = new Map([
      [18, "斜长岩"],
      [34, "三钛合金"],
    ])
    expect(filterTypeRows(catalog, { nodeId: null, query: "三钛", cnNames })).toEqual([1])
    expect(filterTypeRows(catalog, { nodeId: null, query: "三钛" })).toEqual([])
  })

  it("排序：名称默认中文优先，卖价 / 库存按数值，方向可反转", () => {
    const catalog = toCatalog(RAW)
    const all = [0, 1, 2]
    // 名称排序用英文名（ASCII，跨平台稳定）：Mining / Plagioclase / Tritanium
    expect(sortTypeRows(catalog, all, "name", false)).toEqual([2, 0, 1])
    expect(sortTypeRows(catalog, all, "name", true)).toEqual([1, 0, 2])
    // 有中文名时中文名优先于英文名（用 ASCII 值避开各平台 ICU 对汉字的排序差异）
    const cnNames = new Map([
      [18, "BBB"],
      [34, "AAA"],
      [2333, "CCC"],
    ])
    expect(sortTypeRows(catalog, all, "name", false, cnNames)).toEqual([1, 0, 2])
    expect(sortTypeRows(catalog, all, "name", false, cnNames).map((i) => catalog.types.typeId[i])).toEqual([
      34, 18, 2333,
    ])
    // 卖价升序：6.02 / 13688.77 / 33264.12
    expect(sortTypeRows(catalog, all, "ask", false)).toEqual([1, 0, 2])
    expect(sortTypeRows(catalog, all, "ask", true)).toEqual([2, 0, 1])
    // 库存降序：20,000,000 / 999 / 12
    expect(sortTypeRows(catalog, all, "qty", true)).toEqual([1, 0, 2])
  })

  it("SDE 缺失时分类树为空，但物品照常筛得出来（退化成平铺），不会抛错", () => {
    const catalog = toCatalog({ ...RAW, sde: false, tree: [] })
    expect(catalog.sde).toBe(false)
    expect(catalog.roots).toEqual([])
    expect(catalog.types.length).toBe(3)
    expect(filterTypeRows(catalog, { nodeId: null, query: "trit" })).toEqual([1])
    // 点了不存在的节点 = 空结果，而不是「全部」
    expect(filterTypeRows(catalog, { nodeId: 4, query: "" })).toEqual([])
  })

  it("后端失败时回空模型，页面拿它画提示而不是白屏", () => {
    expect(toCatalog(null).types.length).toBe(0)
    expect(toCatalog({ ok: false, reason: "未找到市场数据库" }).types.length).toBe(0)
    expect(EMPTY_CATALOG.types.length).toBe(0)
  })

  it("名称按界面语言排两行：中文界面中文名在上，其它语言英文名在上，同名不重复", () => {
    expect(namePair("斜长岩", "Plagioclase", "zh")).toEqual({
      main: "斜长岩",
      sub: "Plagioclase",
    })
    expect(namePair("斜长岩", "Plagioclase", "en")).toEqual({
      main: "Plagioclase",
      sub: "斜长岩",
    })
    expect(namePair("斜长岩", "Plagioclase", "ja")).toEqual({
      main: "Plagioclase",
      sub: "斜长岩",
    })
    // 没有中文名（items.json 里查不到）时不摆空副行
    expect(namePair(undefined, "Tritanium", "zh")).toEqual({ main: "Tritanium", sub: "" })
    expect(namePair("   ", "Tritanium", "en")).toEqual({ main: "Tritanium", sub: "" })
    // 中英同名（比如专有名词）只印一遍
    expect(namePair("Jita", "Jita", "zh")).toEqual({ main: "Jita", sub: "" })
    expect(namePair("Jita", "Jita", "en")).toEqual({ main: "Jita", sub: "" })
    // 两个都空也不能印出空白
    expect(namePair("", "", "en").main).toBe("")
  })

  it("名称排序跟显示口径一致：切到英文界面就按英文名排", () => {
    const catalog = toCatalog(RAW)
    const cnNames = new Map([
      [18, "斜长岩"],
      [34, "三钛合金"],
      [2333, "采矿测量芯片 II"],
    ])
    const all = [0, 1, 2]
    // 英文界面：Mining / Plagioclase / Tritanium
    expect(sortTypeRows(catalog, all, "name", false, cnNames, "en")).toEqual([2, 0, 1])
    // 中文界面必须用中文名（用 ASCII 值避开各平台 ICU 对汉字的排序差异）
    const ascii = new Map([
      [18, "BBB"],
      [34, "AAA"],
      [2333, "CCC"],
    ])
    expect(sortTypeRows(catalog, all, "name", false, ascii, "zh")).toEqual([1, 0, 2])
  })

  it("数字格式化：ISK 千分位、短写法、数量取整", () => {
    expect(formatIsk(13688.77)).toBe("13,688.77")
    expect(formatIsk(1234567)).toBe("1,234,567")
    expect(formatIsk(0.5)).toBe("0.50")
    expect(formatIsk(0)).toBe("—")
    expect(formatIskShort(999)).toBe("999")
    expect(formatIskShort(12_345)).toBe("12.3K")
    expect(formatIskShort(2_400_000)).toBe("2.40M")
    expect(formatIskShort(3_100_000_000)).toBe("3.10B")
    expect(formatQty(229999977)).toBe("229,999,977")
    expect(formatQty(0)).toBe("—")
  })

  it("时间戳格式化对空值与脏值都退化成 —，不抛错", () => {
    expect(formatStamp(null)).toBe("—")
    expect(formatStamp("")).toBe("—")
    expect(formatStamp("not-a-date")).toBe("—")
    expect(formatStamp("2026-09-30T20:10:34.6436802Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatDay("2026-09-27")).toBe("09-27")
    expect(formatDay("bogus")).toBe("bogus")
  })

  it("库存按价格升序；被买过的行（quantity < initial）单独挑出来", () => {
    const stock: RawMarketStockRow[] = [
      { stationId: 1, stationName: "B", systemName: "Jita", price: 120, quantity: 10, initialQuantity: 10, updatedAt: "t" },
      { stationId: 2, stationName: "A", systemName: "Jita", price: 90, quantity: 7, initialQuantity: 10, updatedAt: "t" },
      { stationId: 3, stationName: "C", systemName: "Jita", price: 150, quantity: 3, initialQuantity: 3, updatedAt: "t" },
    ]
    expect(sortStockByPrice(stock).map((item) => item.stationId)).toEqual([2, 1, 3])
    expect(touchedStockRows(stock).map((item) => item.stationId)).toEqual([2])
    // 原数组不能被改（界面在别处还引用着同一份）
    expect(stock.map((item) => item.stationId)).toEqual([1, 2, 3])
  })

  it("价格图：点数与数据一致、min/max 正确、价格全平时不出现 NaN", () => {
    const history: RawMarketHistoryPoint[] = [
      { day: "2026-09-01", low: 98, high: 102, avg: 100, volume: 10, orders: 3 },
      { day: "2026-09-02", low: 108, high: 112, avg: 110, volume: 20, orders: 4 },
      { day: "2026-09-03", low: 118, high: 122, avg: 120, volume: 30, orders: 5 },
    ]
    const chart = historyChart(history, 320, 72)
    expect(chart.points).toHaveLength(3)
    expect(chart.min).toBe(100)
    expect(chart.max).toBe(120)
    expect(chart.path.startsWith("M")).toBe(true)
    expect(chart.path.includes("NaN")).toBe(false)
    expect(chart.area.endsWith("Z")).toBe(true)
    // 最低价贴下边、最高价贴上边（pad = 3）
    expect(chart.points[2].y).toBeCloseTo(3, 5)
    expect(chart.points[0].y).toBeCloseTo(69, 5)

    const flat = historyChart(
      [
        { day: "2026-09-01", low: 100, high: 100, avg: 100, volume: 1, orders: 1 },
        { day: "2026-09-02", low: 100, high: 100, avg: 100, volume: 1, orders: 1 },
      ],
      320,
      72
    )
    expect(flat.path.includes("NaN")).toBe(false)
    expect(flat.points.every((point) => Number.isFinite(point.y))).toBe(true)
    // 空历史不炸，回空图
    expect(historyChart([], 320, 72).path).toBe("")
  })
})
