/**
 * 物品 / 市场浏览器的纯逻辑：紧凑数组 → 列式表、分类树、筛选、排序、格式化与迷你价格图。
 * 与 React 无关，方便单独验证；组件只负责渲染。
 *
 * 为什么是「列式表」而不是「对象数组」：catalog 一次有 19,352 个物品 × 14 列，
 * 展开成 19,352 个 JS 对象要多占好几倍内存（启动器对内存敏感），装进
 * Int32Array / Float64Array 只要 1 MB 出头，筛选还更快。渲染时只把当前这一页
 * 的几十行折成对象。
 *
 * 数据是**活的**：catalog 里的 bestAsk / askQty 直接读 market.sqlite 的
 * region_summaries，游戏里一成交就变。所以这里不做任何缓存或快照 ——
 * 页面每次打开都重新拉（见 use-market.ts）。
 */
import type {
  RawMarketCatalog,
  RawMarketHistoryPoint,
  RawMarketOverview,
  RawMarketStockRow,
  RawMarketTreeRow,
  RawMarketTypeRow,
} from "@/lib/ipc"
import { t } from "@/lib/i18n"

/* ---------------- 列式物品表 ---------------- */

/** catalog 行里每一列的下标，避免满屏魔法数字 */
const COL = {
  typeId: 0,
  mgId: 1,
  groupId: 2,
  catId: 3,
  name: 4,
  basePrice: 5,
  volume: 6,
  portionSize: 7,
  bestAsk: 8,
  askQty: 9,
  askStation: 10,
  bestBid: 11,
  bidQty: 12,
  bidStation: 13,
} as const

export interface MarketTypeTable {
  length: number
  typeId: Int32Array
  /** SDE 市场分类组 id（分类树按它挂） */
  mgId: Int32Array
  groupId: Int32Array
  catId: Int32Array
  /** SDE 英文名（权威名，中文名由 items.json 补） */
  name: string[]
  basePrice: Float64Array
  volume: Float64Array
  portionSize: Int32Array
  bestAsk: Float64Array
  askQty: Float64Array
  askStation: Int32Array
  bestBid: Float64Array
  bidQty: Float64Array
  bidStation: Int32Array
}

export interface MarketStation {
  id: number
  name: string
  systemId: number
  systemName: string
  security: number
}

export interface MarketNode {
  id: number
  nameZh: string
  nameEn: string
  children: MarketNode[]
  /** 含自身的物品数（按 SDE 分类归属统计，与当前筛选无关） */
  count: number
}

export interface MarketCatalog {
  region: { id: number; name: string }
  /** false = 没找到运行时 SDE：分类树为空，列表退化成平铺 */
  sde: boolean
  stations: MarketStation[]
  /** 站点 id → 站名 */
  stationName: Map<number, string>
  roots: MarketNode[]
  nodeById: Map<number, MarketNode>
  /** 节点 id → 父节点 id（-1 = 根）；面包屑用 */
  parentOf: Map<number, number>
  /** 节点 id → 自身 + 全部后代的 mgId（筛选用） */
  idsUnder: Map<number, number[]>
  groups: Map<number, { zh: string; en: string }>
  categories: Map<number, { zh: string; en: string }>
  types: MarketTypeTable
}

const EMPTY_TABLE: MarketTypeTable = {
  length: 0,
  typeId: new Int32Array(0),
  mgId: new Int32Array(0),
  groupId: new Int32Array(0),
  catId: new Int32Array(0),
  name: [],
  basePrice: new Float64Array(0),
  volume: new Float64Array(0),
  portionSize: new Int32Array(0),
  bestAsk: new Float64Array(0),
  askQty: new Float64Array(0),
  askStation: new Int32Array(0),
  bestBid: new Float64Array(0),
  bidQty: new Float64Array(0),
  bidStation: new Int32Array(0),
}

export const EMPTY_CATALOG: MarketCatalog = {
  region: { id: 0, name: "" },
  sde: false,
  stations: [],
  stationName: new Map(),
  roots: [],
  nodeById: new Map(),
  parentOf: new Map(),
  idsUnder: new Map(),
  groups: new Map(),
  categories: new Map(),
  types: EMPTY_TABLE,
}

function toTable(rows: RawMarketTypeRow[]): MarketTypeTable {
  const n = rows.length
  if (n === 0) return EMPTY_TABLE
  const table: MarketTypeTable = {
    length: n,
    typeId: new Int32Array(n),
    mgId: new Int32Array(n),
    groupId: new Int32Array(n),
    catId: new Int32Array(n),
    name: new Array<string>(n),
    basePrice: new Float64Array(n),
    volume: new Float64Array(n),
    portionSize: new Int32Array(n),
    bestAsk: new Float64Array(n),
    askQty: new Float64Array(n),
    askStation: new Int32Array(n),
    bestBid: new Float64Array(n),
    bidQty: new Float64Array(n),
    bidStation: new Int32Array(n),
  }
  for (let i = 0; i < n; i += 1) {
    const row = rows[i]
    table.typeId[i] = row[COL.typeId]
    table.mgId[i] = row[COL.mgId]
    table.groupId[i] = row[COL.groupId]
    table.catId[i] = row[COL.catId]
    table.name[i] = row[COL.name]
    table.basePrice[i] = row[COL.basePrice]
    table.volume[i] = row[COL.volume]
    table.portionSize[i] = row[COL.portionSize]
    table.bestAsk[i] = row[COL.bestAsk]
    table.askQty[i] = row[COL.askQty]
    table.askStation[i] = row[COL.askStation]
    table.bestBid[i] = row[COL.bestBid]
    table.bidQty[i] = row[COL.bidQty]
    table.bidStation[i] = row[COL.bidStation]
  }
  return table
}

/** 分类树：挂父子、统计每个节点的物品数、算出每个节点「自身 + 后代」的 id 集合 */
function toTree(rows: RawMarketTreeRow[], table: MarketTypeTable) {
  const roots: MarketNode[] = []
  const nodeById = new Map<number, MarketNode>()
  const idList: { id: number; parent: number }[] = []

  for (const [id, parent, zh, en] of rows) {
    nodeById.set(id, { id, nameZh: zh, nameEn: en, children: [], count: 0 })
    idList.push({ id, parent })
  }
  for (const { id, parent } of idList) {
    const node = nodeById.get(id)
    if (!node) continue
    const host = parent >= 0 ? nodeById.get(parent) : undefined
    if (host) host.children.push(node)
    else roots.push(node)
  }

  // 统计：每个物品沿祖先链向上累加。树最深 6 层、物品不到 3 万个，
  // 一次性做完 ≈ 十几万次操作，比每次筛选重算便宜得多。
  const parentOf = new Map<number, number>()
  for (const { id, parent } of idList) parentOf.set(id, parent)
  for (let i = 0; i < table.length; i += 1) {
    let cursor = table.mgId[i]
    // 上限 16 层：数据异常成环时也不会把界面卡死
    for (let depth = 0; cursor >= 0 && depth < 16; depth += 1) {
      const node = nodeById.get(cursor)
      if (!node) break
      node.count += 1
      cursor = parentOf.get(cursor) ?? -1
    }
  }

  const sortNodes = (nodes: MarketNode[]) => {
    nodes.sort((a, b) => b.count - a.count || a.id - b.id)
    for (const node of nodes) sortNodes(node.children)
  }
  sortNodes(roots)

  const idsUnder = new Map<number, number[]>()
  const walk = (node: MarketNode): number[] => {
    const out = [node.id]
    for (const child of node.children) out.push(...walk(child))
    idsUnder.set(node.id, out)
    return out
  }
  for (const root of roots) walk(root)

  return { roots, nodeById, parentOf, idsUnder }
}

/** IPC 原样回的 catalog → 界面用的模型。缺字段一律当空，不抛错（后端失败时页面要给提示而不是白屏） */
export function toCatalog(raw: RawMarketCatalog | null | undefined): MarketCatalog {
  if (!raw?.ok) return EMPTY_CATALOG
  const table = toTable(raw.types ?? [])
  const { roots, nodeById, parentOf, idsUnder } = toTree(raw.tree ?? [], table)
  const stations: MarketStation[] = (raw.stations ?? []).map((row) => ({
    id: row.station_id,
    name: row.station_name,
    systemId: row.solar_system_id,
    systemName: row.solar_system_name,
    security: row.security,
  }))
  return {
    region: raw.region ?? { id: 0, name: "" },
    sde: raw.sde === true,
    stations,
    stationName: new Map(stations.map((station) => [station.id, station.name])),
    roots,
    nodeById,
    parentOf,
    idsUnder,
    groups: new Map((raw.groups ?? []).map(([id, zh, en]) => [id, { zh, en }])),
    categories: new Map((raw.categories ?? []).map(([id, zh, en]) => [id, { zh, en }])),
    types: table,
  }
}

/* ---------------- 筛选与排序 ---------------- */

export interface MarketFilter {
  /** 选中的分类节点 id；null = 全部物品 */
  nodeId: number | null
  query: string
  /** typeID → 中文名（来自 ui/src/data/items.json）；还没加载完就传 null */
  cnNames?: Map<number, string> | null
}

export type MarketSortKey = "name" | "ask" | "bid" | "qty" | "typeId"

function matches(table: MarketTypeTable, index: number, query: string, cn: Map<number, string> | null) {
  if (table.name[index].toLowerCase().includes(query)) return true
  if (String(table.typeId[index]).includes(query)) return true
  const zh = cn?.get(table.typeId[index])
  return zh ? zh.toLowerCase().includes(query) : false
}

/** 命中的行号（不是物品）。19k 行全表扫一遍是毫秒级，所以筛选放在前端做，每次按键都即时。 */
export function filterTypeRows(catalog: MarketCatalog, filter: MarketFilter): number[] {
  const table = catalog.types
  // 传了节点但树上没有（SDE 缺失 / 节点被撤）：空结果，不能当成「全部」
  const set =
    filter.nodeId == null ? null : new Set(catalog.idsUnder.get(filter.nodeId) ?? [])
  const query = filter.query.trim().toLowerCase()
  const cn = filter.cnNames ?? null
  const out: number[] = []
  for (let i = 0; i < table.length; i += 1) {
    if (set && !set.has(table.mgId[i])) continue
    if (query && !matches(table, i, query, cn)) continue
    out.push(i)
  }
  return out
}

const SORT_VALUE: Record<Exclude<MarketSortKey, "name">, (table: MarketTypeTable, i: number) => number> = {
  ask: (table, i) => table.bestAsk[i],
  bid: (table, i) => table.bestBid[i],
  qty: (table, i) => table.askQty[i],
  typeId: (table, i) => table.typeId[i],
}

/**
 * 排序。默认按名称升序；价格 / 库存按数值降序更符合「先看贵的、先看多的」，
 * 但涨跌互见会让人迷惑，所以方向由调用方显式给（`desc`），界面上一键切换。
 */
export function sortTypeRows(
  catalog: MarketCatalog,
  rows: number[],
  key: MarketSortKey,
  desc = false,
  cnNames?: Map<number, string> | null,
  locale = "zh"
): number[] {
  const table = catalog.types
  const value = key === "name" ? null : SORT_VALUE[key]
  // 名称排序必须跟屏幕上显示的那个名字用同一个口径（namePair），
  // 否则英文界面按中文名排出来的顺序看起来就是乱的
  const nameOf = (index: number) =>
    namePair(cnNames?.get(table.typeId[index]), table.name[index], locale).main
  return [...rows].sort((a, b) => {
    let cmp: number
    if (value) cmp = value(table, a) - value(table, b)
    else cmp = nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true })
    if (cmp === 0) cmp = table.typeId[a] - table.typeId[b]
    return desc ? -cmp : cmp
  })
}

/** 面包屑：从根节点到该节点的中文名路径（不含"全部"） */
export function nodePath(catalog: MarketCatalog, id: number): MarketNode[] {
  const out: MarketNode[] = []
  let cursor = id
  for (let depth = 0; cursor >= 0 && depth < 16; depth += 1) {
    const node = catalog.nodeById.get(cursor)
    if (!node) break
    out.unshift(node)
    cursor = catalog.parentOf.get(cursor) ?? -1
  }
  return out
}

/* ---------------- 展示辅助 ---------------- */

/**
 * 名称按界面语言排两行，**两行都显示，只是谁在上谁在下**：
 *   中文界面 → 中文名在上、SDE 英文名在下；
 *   其它语言 → 英文名在上、中文名在下。
 *
 * 为什么不干脆按语言只留一个名字：物品的官方名就是 SDE 的英文名，中文名是本启动器
 * 配的对照名；两边都摆出来，中文玩家和外国玩家核对的是同一样东西，搜索也两边都能命中
 * （见 filterTypeRows 的 matches）。名字一样时副行留空，不重复印一遍。
 */
export function namePair(
  nameZh: string | undefined,
  nameEn: string,
  locale: string
): { main: string; sub: string } {
  const zh = (nameZh ?? "").trim()
  const en = (nameEn ?? "").trim()
  if (locale === "zh") return { main: zh || en, sub: zh && en !== zh ? en : "" }
  return { main: en || zh, sub: zh && zh !== en ? zh : "" }
}

/** 整数千分位；小于 1 的保留两位小数（ISK 能精确到分） */
export function formatIsk(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "—"
  if (Math.abs(value) < 1) return value.toFixed(2)
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

/** 统计瓦片用的短写法：1.23M / 4.56B */
export function formatIskShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toFixed(0)
}

export function formatQty(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  return Math.round(value).toLocaleString("en-US")
}

/** ISO 时刻 → 本地时间。库里给的是 UTC（带 Z 的 .NET 风格时间戳），交给 Date 解析 */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "—"
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return "—"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 价格史里的 "2026-09-27" → "09-27"（横轴标签） */
export function formatDay(day: string): string {
  const parts = day.split("-")
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : day
}

/** 站点行按价格升序：卖单从便宜到贵，和游戏里市场窗口的顺序一致 */
export function sortStockByPrice(stock: RawMarketStockRow[]): RawMarketStockRow[] {
  return [...stock].sort((a, b) => a.price - b.price || a.stationId - b.stationId)
}

/** 被成交扣过库存的站点行（quantity < initialQuantity）。空数组 = 这个品种还没人买过 */
export function touchedStockRows(stock: RawMarketStockRow[]): RawMarketStockRow[] {
  return stock.filter((row) => row.quantity < row.initialQuantity)
}

/* ---------------- 迷你价格图 ---------------- */

export interface HistoryChart {
  /** SVG 折线路径（按 avg） */
  path: string
  /** 折线下方的闭合填充区 */
  area: string
  points: { x: number; y: number; day: string; avg: number }[]
  min: number
  max: number
}

/** 30 天均价折线。价格全平时把线画在中线，不让除零变成 NaN。 */
export function historyChart(
  history: RawMarketHistoryPoint[],
  width: number,
  height: number,
  pad = 3
): HistoryChart {
  const empty: HistoryChart = { path: "", area: "", points: [], min: 0, max: 0 }
  if (history.length === 0) return empty
  const prices = history.map((point) => point.avg)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min
  const innerW = Math.max(1, width - pad * 2)
  const innerH = Math.max(1, height - pad * 2)
  const stepX = history.length > 1 ? innerW / (history.length - 1) : 0

  const points = history.map((point, index) => ({
    x: pad + index * stepX,
    y: span === 0 ? pad + innerH / 2 : pad + innerH - ((point.avg - min) / span) * innerH,
    day: point.day,
    avg: point.avg,
  }))

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ")
  const first = points[0]
  const last = points[points.length - 1]
  const area = `${path} L${last.x.toFixed(2)} ${(pad + innerH).toFixed(2)} L${first.x.toFixed(2)} ${(pad + innerH).toFixed(2)} Z`

  return { path, area, points, min, max }
}

/* ---------------- 价格史大图（对齐游戏里的市场图表） ---------------- */

/**
 * 大图布局：价格区在上、体积区在下，两区**共用同一条横轴**（游戏里也是这么叠的）。
 * 价格刻度放左边、体积刻度放右边 —— 与游戏那张图一致。
 */
export interface PriceChartLayout {
  width: number
  /** 价格区高度 */
  priceHeight: number
  /** 体积区高度 */
  volumeHeight: number
  /** 两区之间的留白 */
  gap: number
  padLeft: number
  padRight: number
  padTop: number
  /** 留给横轴日期标签 */
  padBottom: number
}

/** 均线窗口：与游戏图例一致（5 天 / 20 天） */
export const PRICE_MA_WINDOWS = [5, 20] as const

export interface PriceChartPoint {
  day: string
  low: number
  high: number
  avg: number
  volume: number
  x: number
  yAvg: number
  yLow: number
  yHigh: number
  yVolume: number
}

export interface PriceChartTick {
  value: number
  y: number
}

export interface PriceChartModel {
  points: PriceChartPoint[]
  /** 5 日均线（不足 5 天的头部不画） */
  ma5: { x: number; y: number }[]
  /** 20 日均线（不足 20 天就整条不画） */
  ma20: { x: number; y: number }[]
  priceTicks: PriceChartTick[]
  volumeTicks: PriceChartTick[]
  dayLabels: { x: number; day: string }[]
  priceTop: number
  priceBottom: number
  volumeTop: number
  volumeBottom: number
  /** 窗口内的最低 / 最高价（含上下影线） */
  min: number
  max: number
  peakVolume: number
}

/**
 * 简单移动平均。前 `window - 1` 天样本不够，回 null —— 界面据此**不画**那一段，
 * 而不是拿不足的样本硬算一个会误导人的均值。
 */
export function movingAverage(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (!Number.isFinite(window) || window <= 0) return out
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]
    if (index >= window) sum -= values[index - window]
    if (index >= window - 1) out[index] = sum / window
  }
  return out
}

/**
 * 把理想步长收成「好看」的档位：1 / 2 / 2.5 / 5 / 10 × 10ⁿ，取最接近的那个。
 *
 * 带上 2.5 这一档是为了 0…100 这类区间：只有 1/2/5 时理想步长 25 会被抬到 50，
 * 刻度只剩三根；2.5 能给出 0/25/50/75/100 这种整齐又不稀疏的轴。
 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 0
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const candidates = [1, 2, 2.5, 5, 10]
  let best = candidates[0]
  for (const candidate of candidates) {
    if (Math.abs(candidate - normalized) < Math.abs(best - normalized)) best = candidate
  }
  return best * magnitude
}

/**
 * 刻度值：「好看」的步长（1 / 2 / 5 × 10ⁿ）铺满 [min, max]。
 *
 * 直接等分区间会出现 `0.8734亿` 这种刻度，而游戏里是 0.70 / 0.73 / 0.76… 这种整齐值。
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count <= 0) return []
  if (max <= min) return [min]
  const step = niceStep((max - min) / count)
  if (!(step > 0)) return []
  const out: number[] = []
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    out.push(Number(value.toPrecision(12)))
    if (out.length > 16) break
  }
  return out
}

/** 坐标轴单位。**一根轴只能用一个** —— 否则同一根轴上会并排出现「0.70亿」和「8,800万」。 */
export type AxisUnit = "none" | "wan" | "yi" | "k" | "m" | "b"

/**
 * 按**整根轴的最大值**挑单位（不是逐个刻度值挑，那样会在一根轴上混单位）。
 *
 * 阈值是对着游戏那张图定的：中文客户端把 7,000 万 ~ 8,800 万这一段写成
 * `0.70亿`…`0.88亿` —— 全都不到 1 亿却用亿，所以中文的「亿」不是卡在 1e8，
 * 而是千万级（1e7）就切过去。其他语言仍按 K/M/B，与 `formatIskShort` 同一套口径。
 */
export function pickAxisUnit(max: number, locale: string): AxisUnit {
  const abs = Math.abs(max)
  if (!Number.isFinite(abs)) return "none"
  if (locale.startsWith("zh")) {
    if (abs >= 1e7) return "yi"
    if (abs >= 1e4) return "wan"
    return "none"
  }
  if (abs >= 1e9) return "b"
  if (abs >= 1e6) return "m"
  if (abs >= 1e3) return "k"
  return "none"
}

/** 按给定的轴单位写一个刻度值 */
export function formatAxisTick(value: number, unit: AxisUnit, digits = 2): string {
  if (!Number.isFinite(value)) return "—"
  switch (unit) {
    // i18n-exempt: 亿 是中文单位本身，不是待翻译文案（其他语言走下面的 K/M/B）
    case "yi":
      return `${(value / 1e8).toFixed(digits)}亿`
    // i18n-exempt: 同上，万也是中文单位本身
    case "wan":
      return `${(value / 1e4).toFixed(digits)}万`
    case "b":
      return `${(value / 1e9).toFixed(digits)}B`
    case "m":
      return `${(value / 1e6).toFixed(digits)}M`
    case "k":
      return `${(value / 1e3).toFixed(1)}K`
    default:
      return value.toFixed(0)
  }
}

/** 「2026-09-27」→「09-27」，横轴标签用的短写法 */
export function shortDay(day: string): string {
  const parts = day.split("-")
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : day
}

/** 横轴日期标签：均匀挑最多 5 个，首尾一定在内（同一天只出现一次） */
function pickDayLabels(
  history: RawMarketHistoryPoint[],
  xOf: (index: number) => number,
  max = 5
): { x: number; day: string }[] {
  const count = history.length
  const wanted = Math.min(max, count)
  if (wanted <= 0) return []
  if (wanted === 1) return [{ x: xOf(0), day: history[0].day }]
  const seen = new Set<string>()
  const out: { x: number; day: string }[] = []
  for (let slot = 0; slot < wanted; slot += 1) {
    const index = Math.round((slot * (count - 1)) / (wanted - 1))
    const day = history[index].day
    if (seen.has(day)) continue
    seen.add(day)
    out.push({ x: xOf(index), day })
  }
  return out
}

/**
 * 把价格史算成一张图的全套几何：点、两条均线、两组刻度、日期标签。
 *
 * 刻意的口径（对着游戏那张图定，不是随手取的）：
 * - 价格域取**上下影线**的 min/max（不只是均价），否则影线会戳出画布；
 * - 上下各留 8% 余量，最值不贴边框；
 * - 体积区从 0 起算（柱状图不能截断基线）；
 * - 横轴按**天数等距**，缺失的日子不补零 —— 库里没有那天就是没有成交。
 */
export function buildPriceChart(
  history: RawMarketHistoryPoint[],
  layout: PriceChartLayout
): PriceChartModel | null {
  const count = history.length
  if (count === 0) return null

  const priceTop = layout.padTop
  const priceBottom = layout.padTop + layout.priceHeight
  const volumeTop = priceBottom + layout.gap
  const volumeBottom = volumeTop + layout.volumeHeight
  const plotLeft = layout.padLeft
  const plotRight = Math.max(layout.padLeft + 1, layout.width - layout.padRight)
  const plotWidth = plotRight - plotLeft

  const xOf = (index: number): number =>
    count === 1 ? plotLeft + plotWidth / 2 : plotLeft + (plotWidth * index) / (count - 1)

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let peakVolume = 0
  for (const row of history) {
    if (Number.isFinite(row.low)) min = Math.min(min, row.low)
    if (Number.isFinite(row.high)) max = Math.max(max, row.high)
    if (Number.isFinite(row.volume)) peakVolume = Math.max(peakVolume, row.volume)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 0
  }
  if (max <= min) max = min + Math.max(1, Math.abs(min) * 0.02)
  const padding = (max - min) * 0.08
  const domainMin = Math.max(0, min - padding)
  const domainMax = max + padding
  const domainSpan = domainMax - domainMin || 1

  const yPrice = (value: number): number =>
    priceBottom - ((value - domainMin) / domainSpan) * layout.priceHeight
  const yVolume = (value: number): number =>
    peakVolume <= 0
      ? volumeBottom
      : volumeBottom - Math.max(0, Math.min(1, value / peakVolume)) * layout.volumeHeight

  const points: PriceChartPoint[] = history.map((row, index) => ({
    day: row.day,
    low: row.low,
    high: row.high,
    avg: row.avg,
    volume: row.volume,
    x: xOf(index),
    yAvg: yPrice(row.avg),
    yLow: yPrice(row.low),
    yHigh: yPrice(row.high),
    yVolume: yVolume(row.volume),
  }))

  const averages = history.map((row) => row.avg)
  const line = (series: (number | null)[]): { x: number; y: number }[] =>
    series.flatMap((value, index) => (value == null ? [] : [{ x: xOf(index), y: yPrice(value) }]))

  return {
    points,
    ma5: line(movingAverage(averages, PRICE_MA_WINDOWS[0])),
    ma20: line(movingAverage(averages, PRICE_MA_WINDOWS[1])),
    priceTicks: niceTicks(domainMin, domainMax, 4).map((value) => ({ value, y: yPrice(value) })),
    volumeTicks: niceTicks(0, peakVolume, 3).map((value) => ({ value, y: yVolume(value) })),
    dayLabels: pickDayLabels(history, xOf),
    priceTop,
    priceBottom,
    volumeTop,
    volumeBottom,
    min,
    max,
    peakVolume,
  }
}

/* ---------------- 概览瓦片 ---------------- */

export interface MarketTile {
  label: string
  value: string
  unit?: string
  delta: string
  tone: "telemetry" | "primary" | "warning" | "success"
}

/**
 * 概览 → 四张瓦片。第三个（成交笔数）是「库在动」的证据：
 * 只有 market_fill_receipts 里真落了成交回执它才会涨。
 */
export function marketTiles(overview: RawMarketOverview | null): MarketTile[] {
  const counts = overview?.counts
  return [
    {
      label: t("物品数"),
      value: (counts?.types ?? 0).toLocaleString("en-US"),
      delta: overview ? t("{count} 个空间站", { count: counts?.stations ?? 0 }) : "—",
      tone: "primary",
    },
    {
      label: t("库存行"),
      value: formatIskShort(counts?.stockRows ?? 0),
      delta: t("全站卖单"),
      tone: "telemetry",
    },
    {
      label: t("成交笔数"),
      value: (counts?.trades ?? 0).toLocaleString("en-US"),
      delta: t("{count} 个品种被买过", { count: counts?.touched ?? 0 }),
      tone: "success",
    },
    {
      label: t("最近成交"),
      value: overview?.lastChangeAt ? formatStamp(overview.lastChangeAt).slice(5) : "—",
      delta: t("库大小 {size} MB", { size: (((overview?.sizeBytes ?? 0) / 1048576) || 0).toFixed(1) }),
      tone: "warning",
    },
  ]
}

/**
 * 「改价 / 改量」弹窗里两个输入框的解析结果。
 *
 * `null` = 这一项**不改**（服务端对省掉的字段保持原值，见 `market.rs` 的
 * `adjust_seed_stock`），所以「只改价」「只改量」都是合法操作，不用逼用户把另一项抄一遍。
 */
export type AdjustDraft =
  | { ok: true; price: number | null; quantity: number | null }
  | { ok: false; reason: string }

/**
 * 解析价格 / 数量输入。
 *
 * 为什么在渲染层先挡一遍：服务端只校验「种子库存行存不存在」和「数量不能为负」，
 * 价格给个负数它也照收（那就是一档负价挂单），而输入框里「1.5 个」「abc」「-3」这类东西
 * 是在用户手里打出来的。校验不过就把原因交回界面，别让一次手滑写进市场库。
 *
 * 数量允许带千分位逗号（用户习惯把 9999999 写成 9,999,999），但不接受小数 ——
 * 静默截成整数比直接报错更糟。
 */
export function parseAdjustDraft(priceText: string, quantityText: string): AdjustDraft {
  const priceRaw = priceText.trim()
  const quantityRaw = quantityText.trim()
  if (!priceRaw && !quantityRaw) {
    return { ok: false, reason: "请至少改一项：价格或数量。" }
  }

  let price: number | null = null
  if (priceRaw) {
    const value = Number(priceRaw)
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, reason: "价格要填不小于 0 的数字。" }
    }
    price = value
  }

  let quantity: number | null = null
  if (quantityRaw) {
    const value = Number(quantityRaw.replace(/,/g, ""))
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, reason: "数量要填不小于 0 的整数。" }
    }
    quantity = value
  }

  return { ok: true, price, quantity }
}
