/**
 * 势力推演页的数据形状与纯换算。
 *
 * 数据源是模组自带的 Web 面板（127.0.0.1:26410），启动器通过 `faction:api` 代理读它，
 * 形状以模组 lib/sim/web/* 的实际回包为准（2026-10-11 在 0.12.9 + 模组 0.2.3 上实测）。
 *
 * 这一层只做形状收窄与换算，不放任何用户可见的中文（文案走 t()，见页面组件）：
 * 面板自己回的 text / label / name 都是模组写好的中文，启动器原样显示、不重写文案表。
 */

import { pad2 as pad } from "@/lib/time"

/* ------------------------------- 探针 / 状态 ------------------------------- */

export interface FactionAlertCounts {
  bad: number
  warn: number
  info: number
}

/** /api/status：顶栏要的几个读数 */
export interface FactionStatus {
  now: number
  speed: number
  paused: boolean
  alertCounts: FactionAlertCounts
}

/**
 * faction:status 的回包。三种状态分得清：
 *   ok=false                → 读不到令牌（模组没装 / 没跑过）
 *   ok=true,available=false → 有令牌但连不上面板（服务端没起）
 *   ok=true,available=true  → 正常，status 可用
 */
export interface FactionProbe {
  ok: boolean
  available: boolean
  url: string
  port: number
  reason: string
  database: string
  status: FactionStatus | null
}

/** 把 faction:status 的原始回包收窄成探针对象（字段缺就当没有，绝不抛） */
export function parseProbe(raw: unknown): FactionProbe {
  const source = (raw ?? {}) as Record<string, unknown>
  const counts = (source.status ?? {}) as Record<string, unknown>
  const alertCounts = (counts.alertCounts ?? {}) as Record<string, unknown>
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0
  const status =
    source.status && typeof source.status === "object" && !Array.isArray(source.status)
      ? {
          now: num(counts.now),
          speed: num(counts.speed),
          paused: counts.paused === true,
          alertCounts: {
            bad: num(alertCounts.bad),
            warn: num(alertCounts.warn),
            info: num(alertCounts.info),
          },
        }
      : null
  return {
    ok: source.ok === true,
    available: source.available === true,
    url: typeof source.url === "string" ? source.url : "",
    port: num(source.port),
    reason: typeof source.reason === "string" ? source.reason : "",
    database: typeof source.database === "string" ? source.database : "",
    status,
  }
}

/* --------------------------------- 事件 --------------------------------- */

/** SSE 事件（模组 event_log 的一行；text 是模组渲染好的中文） */
export interface FactionEvent {
  id: number
  at: number
  factionKey: string | null
  type: string
  label: string
  group: string
  text: string
  payload?: unknown
}

/** 事件分组 → 界面色调（分组 id 见 /api/events/types 的 groups） */
export type EventTone =
  | "fleet"
  | "combat"
  | "intel"
  | "territory"
  | "economy"
  | "logistics"
  | "system"
  | "other"

export function eventTone(group: string): EventTone {
  switch (group) {
    case "fleet":
    case "combat":
    case "intel":
    case "territory":
    case "economy":
    case "logistics":
    case "system":
      return group
    default:
      return "other"
  }
}

/** 按 id 去重并倒序（重连回补会重复给帧），最多留 limit 条 */
export function mergeEvents(
  existing: FactionEvent[],
  incoming: FactionEvent[],
  limit = 200
): FactionEvent[] {
  const seen = new Set(existing.map((item) => item.id))
  const merged = [...existing]
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  merged.sort((left, right) => right.id - left.id)
  return merged.slice(0, limit)
}

/* -------------------------------- 势力一览 -------------------------------- */

export interface FactionFleetRole {
  role: string
  fleets: number
  ships: number
}

/** /api/overview 的 factions[]：界面真正渲染的那部分字段 */
export interface FactionBrief {
  key: string
  name: string
  color: string
  tier: string
  paused: boolean
  morale: number
  power: number
  armedShips: number
  armedFleets: number
  fleets: {
    total: number
    ships: number
    inFlight: number
    docked: number
    byRole: FactionFleetRole[]
  }
  economy: {
    treasury: number
    stockUnits: number
    miningFleets: number
    jobs: number
    stuckCount: number
    gapCount: number
    targets: number
    tight: boolean
    capital: { enabled: boolean; owned: Record<string, number> }
  }
  military: {
    patrols: number
    scouts: number
    strikes: number
    capital: boolean
    sightings: number
    alarms: number
    stuck: number
  }
  territory: {
    owned: number
    front: number
    contested: number
    middle: number
    rear: number
    presence: number
  }
  structures: {
    total: number
    online: number
    building: number
    reinforced: number
    destroyed: number
    influence: number
  }
  home: { systemID: number; systemName: string }
  logistics: { open: number; delivered: number; lost: number }
  relations: { key: string; name: string; color: string; relation: string }[]
  relationCounts: { hostile: number; friendly: number; neutral: number }
  /** 旗舰保护伞摘要（模组总览页也是把这几个字段做成一个徽标挂在卡上） */
  umbrella?: UmbrellaSummary
}

export interface OverviewAlert {
  level: string
  kind: string
  factionKey: string | null
  text: string
  systemID?: number
  at: number
}

export interface OverviewPayload {
  now: number
  speed: number
  paused: boolean
  uptimeMs: number
  scenario: { id: string; name: string; factions: string[] }
  alerts: OverviewAlert[]
  alertCounts: FactionAlertCounts
  events: FactionEvent[]
  factions: FactionBrief[]
  paging: { total: number; page: number; pages: number; size: number }
  tiers: Record<string, number>
  population: { count: number; money?: { tax: number; upkeep: number } }
  crisis: { era: string }
}

export type FactionSort = "power" | "ships" | "money" | "territory" | "name"

export interface FactionFilter {
  tier?: string
  query?: string
  sort?: FactionSort
}

/** 按当前排序键排序；同名按名字兜底，保证顺序稳定 */
export function sortFactions(list: FactionBrief[], sort: FactionSort = "power"): FactionBrief[] {
  const metric = (item: FactionBrief): number => {
    switch (sort) {
      case "ships":
        return item.armedShips
      case "money":
        return item.economy.treasury
      case "territory":
        return item.territory.owned
      case "name":
        return 0
      case "power":
      default:
        return item.power
    }
  }
  const copy = [...list]
  copy.sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name, "zh")
    const diff = metric(right) - metric(left)
    return diff !== 0 ? diff : left.name.localeCompare(right.name, "zh")
  })
  return copy
}

/** 势力一览的筛选：层级 + 名称/标识/家园搜索 */
export function filterFactions(list: FactionBrief[], filter: FactionFilter = {}): FactionBrief[] {
  const query = (filter.query ?? "").trim().toLowerCase()
  const tier = filter.tier ?? ""
  const kept = list.filter((item) => {
    if (tier && tier !== "all" && item.tier !== tier) return false
    if (!query) return true
    return (
      item.name.toLowerCase().includes(query) ||
      item.key.toLowerCase().includes(query) ||
      item.home.systemName.toLowerCase().includes(query)
    )
  })
  return sortFactions(kept, filter.sort)
}

export interface FactionTotals {
  power: number
  armedShips: number
  armedFleets: number
  fleetShips: number
  treasury: number
  owned: number
  front: number
  jobs: number
  delivered: number
}

/** 势力一览的汇总条 */
export function factionTotals(list: FactionBrief[]): FactionTotals {
  const totals: FactionTotals = {
    power: 0,
    armedShips: 0,
    armedFleets: 0,
    fleetShips: 0,
    treasury: 0,
    owned: 0,
    front: 0,
    jobs: 0,
    delivered: 0,
  }
  for (const item of list) {
    totals.power += item.power
    totals.armedShips += item.armedShips
    totals.armedFleets += item.armedFleets
    totals.fleetShips += item.fleets.ships
    totals.treasury += item.economy.treasury
    totals.owned += item.territory.owned
    totals.front += item.territory.front
    totals.jobs += item.economy.jobs
    totals.delivered += item.logistics.delivered
  }
  return totals
}

/** 层级清单（模组的层级 id；顺序固定，界面不跟着回包的键序走） */
export const TIER_ORDER = ["major", "empire", "minor", "clan", "trader", "pirate", "fallen"] as const

export function tierCounts(tiers: Record<string, number> | undefined): { tier: string; count: number }[] {
  const source = tiers ?? {}
  const known = TIER_ORDER.filter((tier) => (source[tier] ?? 0) > 0).map((tier) => ({
    tier,
    count: source[tier] ?? 0,
  }))
  const rest = Object.keys(source)
    // `all` 是总数不是层级（模组也把它放在同一张表里），界面另有「全部 N」按钮，这里排掉
    .filter(
      (tier) =>
        tier !== "all" &&
        !TIER_ORDER.includes(tier as (typeof TIER_ORDER)[number]) &&
        source[tier] > 0
    )
    .map((tier) => ({ tier, count: source[tier] }))
  return [...known, ...rest]
}

/* --------------------------------- 外交 --------------------------------- */

export type RelationKind = "hostile" | "neutral" | "friendly"

export interface RelationPair {
  a: string
  b: string
  relation: string
}

/** 关系表按 a|b 建索引；两个方向都写，查哪边都命中 */
export function relationMap(pairs: RelationPair[]): Map<string, RelationKind> {
  const map = new Map<string, RelationKind>()
  for (const pair of pairs) {
    const kind = relationKind(pair.relation)
    map.set(`${pair.a}|${pair.b}`, kind)
    map.set(`${pair.b}|${pair.a}`, kind)
  }
  return map
}

export function relationKind(value: string): RelationKind {
  return value === "hostile" || value === "friendly" ? value : "neutral"
}

/**
 * 某个势力对外的关系（按对方名字排序）。
 *
 * 面板的关系表**两个方向各写一行**（实测某势力 240 行 = 120 个对方 × 2），
 * 所以这里按对方去重，否则界面上每个对手会各出现两遍。
 */
export function relationsFor(
  key: string,
  pairs: RelationPair[],
  lookup: Map<string, { name: string; color: string }>
): { key: string; name: string; color: string; relation: RelationKind }[] {
  const seen = new Map<string, { key: string; name: string; color: string; relation: RelationKind }>()
  for (const pair of pairs) {
    if (pair.a !== key && pair.b !== key) continue
    const other = pair.a === key ? pair.b : pair.a
    if (seen.has(other)) continue
    const meta = lookup.get(other)
    seen.set(other, {
        key: other,
        name: meta?.name ?? other,
        color: meta?.color ?? "#64748b",
        relation: relationKind(pair.relation),
      })
  }
  const out = [...seen.values()]
  out.sort((left, right) => left.name.localeCompare(right.name, "zh"))
  return out
}

/* --------------------------------- 星图 --------------------------------- */

/** /api/starmap：模组把 5000+ 星系拍成列式数组下发（对象数组会多占好几倍内存） */
export interface StarmapRaw {
  count: number
  bounds: number[]
  ids: number[]
  x: number[]
  y: number[]
  sec: number[]
  r: number[]
  en: string[]
  zh: string[]
  st: number[]
  links: number[]
  regions: [number, string, string, number, number][]
}

export interface StarmapPoint {
  id: number
  x: number
  y: number
  sec: number
  region: number
  name: string
  stations: number
}

export interface StarmapView {
  points: StarmapPoint[]
  /** 星门连线，两个点下标成对出现 */
  links: [number, number][]
  /** 索引：星系 id → points 下标（舰队 / 战场定位用） */
  index: Map<number, number>
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * 列式星图 → 可画的对象数组。
 *
 * zh / en 两份名字都在，界面按语言取（中文界面用中文名，其余用英文名，与游戏里一致）；
 * 取不到就用 id，绝不空着。
 */
export function starmapView(
  raw: StarmapRaw | null | undefined,
  preferZh: boolean
): StarmapView {
  const empty: StarmapView = {
    points: [],
    links: [],
    index: new Map(),
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  }
  if (!raw || !Array.isArray(raw.ids) || raw.ids.length === 0) return empty
  const count = Math.min(Number(raw.count) || raw.ids.length, raw.ids.length)
  const points: StarmapPoint[] = new Array(count)
  const index = new Map<number, number>()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i < count; i += 1) {
    const x = Number(raw.x[i])
    const y = Number(raw.y[i])
    const id = Number(raw.ids[i])
    const zh = raw.zh?.[i]
    const en = raw.en?.[i]
    points[i] = {
      id,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      sec: Number(raw.sec?.[i]) || 0,
      region: Number(raw.r?.[i]) || 0,
      name: (preferZh ? zh || en : en || zh) || String(id),
      stations: Number(raw.st?.[i]) || 0,
    }
    index.set(id, i)
    if (points[i].x < minX) minX = points[i].x
    if (points[i].y < minY) minY = points[i].y
    if (points[i].x > maxX) maxX = points[i].x
    if (points[i].y > maxY) maxY = points[i].y
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }
  const links: [number, number][] = []
  const rawLinks = Array.isArray(raw.links) ? raw.links : []
  for (let i = 0; i + 1 < rawLinks.length; i += 2) {
    const left = Number(rawLinks[i])
    const right = Number(rawLinks[i + 1])
    if (Number.isFinite(left) && Number.isFinite(right)) links.push([left, right])
  }
  return { points, links, index, bounds: { minX, minY, maxX, maxY } }
}

/** 把星图坐标铺满一块画布：等比缩放 + 居中 */
export interface MapTransform {
  scale: number
  offsetX: number
  offsetY: number
}

export function fitTransform(
  bounds: StarmapView["bounds"],
  width: number,
  height: number,
  padding = 16
): MapTransform {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6)
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6)
  const usableW = Math.max(width - padding * 2, 1)
  const usableH = Math.max(height - padding * 2, 1)
  const scale = Math.min(usableW / spanX, usableH / spanY)
  const offsetX = padding + (usableW - spanX * scale) / 2 - bounds.minX * scale
  // 屏幕 y 向下、星图 y 向上：翻一下，否则整张图上下颠倒
  const offsetY = height - padding - (usableH - spanY * scale) / 2 + bounds.minY * scale
  return { scale, offsetX, offsetY }
}

export function projectPoint(
  transform: MapTransform,
  x: number,
  y: number
): { px: number; py: number } {
  return { px: x * transform.scale + transform.offsetX, py: -y * transform.scale + transform.offsetY }
}

/* --------------------------------- 杂项 --------------------------------- */

/** `/api/control` 的 `factions[]`：48 个「有实体」的势力的名录（key / 名 / 色 / 层级） */
export interface RosterEntry {
  key: string
  name: string
  color: string
  tier: string
}

export function rosterOf(entries: RosterEntry[] | undefined): Map<string, RosterEntry> {
  const map = new Map<string, RosterEntry>()
  for (const entry of entries ?? []) {
    if (entry && typeof entry.key === "string") map.set(entry.key, entry)
  }
  return map
}

/** 模组的势力 id → 界面用的名字（名录里没有的（只有记录的政体）就显示 id，不编造） */
export function nameOf(roster: Map<string, RosterEntry>, key: string | null | undefined): string {
  if (!key) return "—"
  return roster.get(key)?.name ?? key
}

export function rosterColors(roster: Map<string, RosterEntry>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [key, entry] of roster) map.set(key, entry.color)
  return map
}

/** 模组 `lib/bridge/militaryCommands.js` 里的相位 / 状态 / 角色文案（与面板口径一致） */
export const OP_PHASE_LABEL: Record<string, string> = {
  muster: "集结中",
  outbound: "前往",
  dwell: "驻留",
  returning: "返航",
  resting: "休整",
  sweeping: "侦察中",
  watching: "盯梢",
  lingering: "等待目标",
  siege: "攻打建筑",
  battle: "交战中",
  holding: "守候",
  standby: "待命",
  engaged: "参战",
  cooldown: "冷却",
}

export const OP_STATUS_LABEL: Record<string, string> = {
  waiting: "等舰队",
  active: "进行中",
  done: "结束",
  lost: "全灭",
  failed: "失败",
  cancelled: "取消",
}

export const OP_KIND_LABEL: Record<string, string> = {
  patrol: "巡逻",
  scout: "侦察",
  strike: "打击",
  capital: "旗舰",
  gank: "伏击",
  snare: "拦截",
  logistics: "运输",
  mining: "采矿",
}

export const FLEET_ROLE_LABEL: Record<string, string> = {
  mining: "采矿队",
  logistics: "运输队",
  patrol: "巡逻队",
  scout: "侦察队",
  strike: "打击队",
  capital: "旗舰队",
  tackle: "抓人船队",
  interdictor: "拦截泡泡船队",
  player: "玩家",
  freighter: "货舰",
}

export const BATTLE_OUTCOME_LABEL: Record<string, string> = {
  destroyed: "一方全灭",
  retreat: "一方撤退",
  draw: "平局",
  disengaged: "脱离",
  "no-fight": "没打起来",
  handover: "交给真船实打",
  concord: "统合部介入",
}

/** 面板给英文 id 的字段，按当前语言取名字；词典里没有就原样显示（不猜） */
export function labelOf(
  dictionary: Record<string, string>,
  id: string | null | undefined,
  t: (source: string) => string
): string {
  if (!id) return "—"
  const label = dictionary[id]
  return label ? t(label) : id
}

/* ------------------------------- 旗舰保护伞 ------------------------------- */

/**
 * 旗舰队（保护伞）的五个状态词，**照抄模组自己的词典**（`lib/sim/web/overview.js` 的 UMBRELLA）。
 *
 * 状态怎么算也照抄它的口径（`lib/sim/overviewView.js::umbrellaOf`）：
 *   没开启 → off；开启了但还没组起旗舰队 → none；`engagedIn` 有值 → engaged；其余看能不能出动。
 *
 * ⚠️ 一处**刻意不照抄**：模组那行判据是 `group.ready ? "ready" : "cooling"`，而 `group.ready`
 * 是一个**对象**（`{ok, why}`），永远为真 —— 于是「旗舰队冷却中 / 跳跃疲劳太高 / 没船点诱导力场」
 * 这些明明出不了动的情况，在模组总览上照样显示成「待命就绪」。这里改成看 `ready.ok`，
 * 并把 `why` 原样带到界面上（「不能出动：跳跃引擎冷却」），用户看到的与事实一致。
 */
export type UmbrellaState = "off" | "none" | "ready" | "cooling" | "engaged"

/** 与 `useLocale()` 的 `t` 同形：纯函数接收翻译器用，不引入组件层依赖 */
export type Translate = (text: string, vars?: Record<string, string | number>) => string

export const UMBRELLA_STATE_LABEL: Record<string, string> = {
  off: "未启用",
  none: "未组建",
  ready: "待命就绪",
  cooling: "冷却中",
  engaged: "参战中",
}

/** `/api/overview` 里每个势力带的保护伞摘要 */
export interface UmbrellaSummary {
  state: string
  ships: number
  phase?: string | null
  baseName?: string | null
  engagedIn?: string | null
  fatigueMinutes?: number
  jumps?: number
  backing?: string | null
  hullsHave?: number
  hullsNeeded?: number
}

export interface UmbrellaHull {
  typeID: number
  qty: number
  have: number
}

export interface UmbrellaGroup {
  opID?: number
  fleetID?: number
  ships?: number
  phase?: string
  baseName?: string | null
  /** 模组给的是对象（见上面 UMBRELLA_STATE_LABEL 的说明） */
  ready?: { ok?: boolean; why?: string } | null
  fatigueMinutes?: number
  activationMinutes?: number
  jumps?: number
  lastRefusal?: { at?: number; why?: string } | null
  engagedIn?: string | null
  backing?: { systemName?: string; strikeOpID?: number; alarmID?: number } | null
}

/** `/api/military` 的 `umbrella[势力]` */
export interface UmbrellaView {
  key?: string
  enabled?: boolean
  template?: string | null
  hulls?: UmbrellaHull[]
  demand?: string | null
  group?: UmbrellaGroup | null
  coverage?: { count?: number; sample?: string[] }
  rules?: {
    rangeMode?: string
    jumpRangeLY?: number
    rangeJumps?: number
    zones?: string[]
    respectHighSec?: boolean
  }
}

/** 摘要 → 状态（口径见 UMBRELLA_STATE_LABEL 的说明） */
export function umbrellaStateOf(summary: UmbrellaSummary | null | undefined): UmbrellaState {
  if (!summary) return "off"
  if (summary.state === "off") return "off"
  if (summary.state === "none") return "none"
  if (summary.engagedIn) return "engaged"
  if (summary.phase === "cooldown") return "cooling"
  if (summary.state === "cooling" || summary.state === "engaged") return summary.state
  return "ready"
}

export interface UmbrellaRow {
  key: string
  state: UmbrellaState
  ships: number
  phase: string | null
  baseName: string | null
  engagedIn: string | null
  fatigueMinutes: number
  activationMinutes: number
  jumps: number
  template: string | null
  demand: string | null
  coverage: number
  hullsNeeded: number
  hullsHave: number
  /** 出不了动的原因（`ready.ok === false` 时的 why） */
  blockedReason: string | null
  lastRefusal: string | null
  /** 正在为哪个星系的防守待命 */
  backing: string | null
  /** 需要人看一眼的（参战 / 冷却 / 出不了动 / 上次没去 / 正在替人待命） */
  attention: boolean
}

/**
 * `/api/military` 的 umbrella 表 → 表格行。
 *
 * 为什么要有这个函数：实测 48 家**全部** `enabled: true`，其中绝大多数是「待命就绪 / 疲劳 0」
 * 的同一张卡 —— 直接铺成卡片墙没有信息量。这里把每家的关键事实摊平，
 * 再按 `attention` 分桶（界面默认只列需要看的，其余折成一行计数）。
 */
export function umbrellaRows(record: Record<string, UmbrellaView> | undefined): UmbrellaRow[] {
  const rows: UmbrellaRow[] = []
  for (const [key, view] of Object.entries(record ?? {})) {
    if (!view) continue
    const group = view.group ?? null
    const readyOk = group?.ready ? group.ready.ok !== false : false
    const blockedReason = group?.ready && group.ready.ok === false ? group.ready.why ?? "" : null
    const lastRefusal = group?.lastRefusal?.why ?? null
    const backing = group?.backing?.systemName ?? null
    let state: UmbrellaState
    if (view.enabled === false) state = "off"
    else if (!group) state = "none"
    else if (group.engagedIn) state = "engaged"
    else if (!readyOk) state = "cooling"
    else state = "ready"
    const hullsNeeded = (view.hulls ?? []).reduce((sum, hull) => sum + (Number(hull.qty) || 0), 0)
    const hullsHave = (view.hulls ?? []).reduce(
      (sum, hull) => sum + Math.min(Number(hull.have) || 0, Number(hull.qty) || 0),
      0
    )
    rows.push({
      key,
      state,
      ships: Number(group?.ships) || 0,
      phase: group?.phase ?? null,
      baseName: group?.baseName ?? null,
      engagedIn: group?.engagedIn ?? null,
      fatigueMinutes: Number(group?.fatigueMinutes) || 0,
      activationMinutes: Number(group?.activationMinutes) || 0,
      jumps: Number(group?.jumps) || 0,
      template: view.template ?? null,
      demand: view.demand ?? null,
      coverage: Number(view.coverage?.count) || 0,
      hullsNeeded,
      hullsHave,
      blockedReason,
      lastRefusal,
      backing,
      attention:
        state === "engaged" ||
        state === "cooling" ||
        blockedReason !== null ||
        lastRefusal !== null ||
        backing !== null,
    })
  }
  // 需要看的排前面（参战 > 冷却 > 能出动），同档按舰船数与名字
  const rank: Record<UmbrellaState, number> = { engaged: 0, cooling: 1, none: 2, ready: 3, off: 4 }
  rows.sort((left, right) => {
    if (left.attention !== right.attention) return left.attention ? -1 : 1
    if (rank[left.state] !== rank[right.state]) return rank[left.state] - rank[right.state]
    if (left.ships !== right.ships) return right.ships - left.ships
    return left.key.localeCompare(right.key)
  })
  return rows
}

/** 分桶：需要看的 / 其余（界面默认只列前者） */
export function umbrellaBuckets(rows: UmbrellaRow[]): {
  attention: UmbrellaRow[]
  rest: UmbrellaRow[]
} {
  return {
    attention: rows.filter((row) => row.attention),
    rest: rows.filter((row) => !row.attention),
  }
}

/** 保护伞状态 → 界面色调（与模组自己的 ok/warn/bad/muted 分档一致） */
export function umbrellaTone(state: UmbrellaState): "success" | "warning" | "destructive" | "muted" {
  switch (state) {
    case "ready":
      return "success"
    case "cooling":
      return "warning"
    case "engaged":
      return "destructive"
    default:
      return "muted"
  }
}

/** 规则一句话：`3.5 光年 · 后方/中间 · 不进高安`（单位与区域名按当前语言） */
export function umbrellaRange(view: UmbrellaView | undefined, t: Translate): string {
  const rules = view?.rules
  if (!rules) return "—"
  const range =
    rules.rangeMode === "jumps"
      ? t("{n} 跳", { n: rules.rangeJumps ?? 0 })
      : t("{n} 光年", { n: rules.jumpRangeLY ?? 0 })
  const zones = (rules.zones ?? []).map((zone) => zoneLabel(zone, t)).join("/")
  const highsec = rules.respectHighSec ? t("不进高安") : ""
  return [range, zones, highsec].filter(Boolean).join(" · ")
}

/** 区域 id → 模组自己的中文（`lib/sim/web/overview.js` 的 ZONES） */
export function zoneLabel(zone: string, t: Translate): string {
  const map: Record<string, string> = {
    rear: "后方",
    middle: "中间",
    front: "前线",
    contested: "争夺",
  }
  return map[zone] ? t(map[zone]) : zone
}

/* ------------------------------- 领土（realm） ------------------------------- */

/**
 * `/api/realm`：领土归属的**列式**快照，按基底星图的索引逐位对齐（本机 5485 个星系）。
 *
 * 为什么必须这么读：这份数据是按星系逐位压出来的（`owner` 每个星系 2 个字符），
 * 模组自己的星图也是这么解的（`lib/sim/web/starmap.js` 的 decodeColumn / prepareRealm）。
 * 记住 `count` 必须等于基底星图的星系数 —— 对不上就**一个都不上色**（宁可不上色，也别错位染色）。
 */
export interface RealmRaw {
  count: number
  /** "claims" 等（本机是 claims 制） */
  ownership?: string
  version?: string
  at?: number
  /** 2 字符/星系：归属编号（0 = 无主，其余要减 1 才是政体序号） */
  owner?: string
  /** 1 字符/星系：宣称状态（0 无 / 1 被宣称 / 2 被占领 / 3 围攻中） */
  cl?: string
}

/** 领土列的字母表（与模组 REALM_ALPHABET 逐字一致，别改） */
export const REALM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const REALM_CODE = (() => {
  const table = new Uint8Array(128)
  for (let k = 0; k < REALM_ALPHABET.length; k += 1) table[REALM_ALPHABET.charCodeAt(k)] = k
  return table
})()

/** 一列定长编码 → 整数数组（宽度 2 是 12 位，宽度 1 是 6 位） */
export function decodeRealmColumn(text: string, count: number, width: 1 | 2): Int16Array {
  const out = new Int16Array(count)
  for (let k = 0; k < count; k += 1) {
    let value = 0
    for (let c = 0; c < width; c += 1) {
      value = value * 64 + REALM_CODE[text.charCodeAt(k * width + c) & 127]
    }
    out[k] = value
  }
  return out
}

/**
 * 归属列 → 每个星系的政体序号（0 起；`-1` = 无主）。
 *
 * `expectedCount` 传基底星图的星系数：**对不上就返回 null**，调用方退回不按势力上色。
 * 长度错位时逐位染色会把整张图的归属画错位，比不染色难查得多。
 */
export function realmOwner(
  raw: RealmRaw | null | undefined,
  expectedCount: number
): Int16Array | null {
  const count = Number(raw?.count) || 0
  if (!raw?.owner || count === 0 || count !== expectedCount) return null
  const values = decodeRealmColumn(raw.owner, count, 2)
  const out = new Int16Array(count)
  for (let k = 0; k < count; k += 1) out[k] = values[k] - 1
  return out
}

/** 宣称 / 占领 / 围攻状态列（0 无 / 1 被宣称 / 2 被占领 / 3 围攻中） */
export function realmClaims(
  raw: RealmRaw | null | undefined,
  expectedCount: number
): Uint8Array | null {
  const count = Number(raw?.count) || 0
  if (!raw?.cl || count === 0 || count !== expectedCount) return null
  const values = decodeRealmColumn(raw.cl, count, 1)
  const out = new Uint8Array(count)
  for (let k = 0; k < count; k += 1) out[k] = Math.max(0, Math.min(3, values[k]))
  return out
}

/** `/api/realm/polities` 的一行：`[key, name, tier, color, capital, systems, passive]` */
export interface RealmPolity {
  key: string
  name: string
  tier: string
  color: string
  capital: number
  systems: number
}

/**
 * 政体清单。**顺序就是归属编号的顺序**（模组按 key 排序后编号，`owner` 减 1 直接当这里的下标），
 * 所以这个数组既用来查颜色，也用来查名字 —— 不要按 systems 重排后再当索引。
 */
export function realmPolities(raw: unknown): RealmPolity[] {
  const rows = (raw as { polities?: unknown } | null)?.polities
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 6)
    .map((row) => ({
      key: String(row[0] ?? ""),
      name: String(row[1] ?? ""),
      tier: String(row[2] ?? ""),
      color: colorOf(String(row[3] ?? "")),
      capital: Number(row[4]) || 0,
      systems: Number(row[5]) || 0,
    }))
}

/**
 * 领土两份数据是否**成对**。
 *
 * `owner` 列给的是「第几个政体」，而政体清单是另一个请求；势力扩地 / 丢星系时模组会重新编号，
 * 若拿旧的归属列配新的清单，**整张图会按错误的势力上色**（而且看起来「很正常」，极难发现）。
 * 好在两者有一个硬不变量：归属列里第 i 号政体的星系数，必须等于清单里第 i 条的 `systems`
 * （本机实测 121/121 恒等）。对不上就整份丢弃、不上领土色。
 */
export function territoryPairsUp(owner: Int16Array | null, polities: RealmPolity[]): boolean {
  if (!owner || polities.length === 0) return false
  const counted = new Map<number, number>()
  for (const value of owner) {
    if (value < 0) continue
    counted.set(value, (counted.get(value) ?? 0) + 1)
  }
  for (let index = 0; index < polities.length; index += 1) {
    if ((counted.get(index) ?? 0) !== polities[index].systems) return false
  }
  // 归属列里出现了清单之外的编号，同样说明两份数据不是一对
  for (const index of counted.keys()) {
    if (index >= polities.length) return false
  }
  return true
}

/* ------------------------------ 玩家主权（游戏侧） ------------------------------ */

/**
 * 玩家军团 / 联盟的主权声明。
 *
 * **不是模组的数据**：模组 `/api/realm` 只描述它自己模拟出来的 NPC 政体版图，看不到玩家主权。
 * 这份来自游戏库 `gameStore.sovereignty`（经侧车 `sovereignty-cli.js` 整理）：
 * 一行 = 一个星系的正式主权声明（allianceID / corporationID / 主权结构 / 声明时刻）。
 */
export interface SovereigntyClaim {
  systemID: number
  allianceID: number
  corporationID: number
  claimStructureID: number
  claimTime: string
}

export interface SovereigntyView {
  /** 星系 → 主权声明 */
  claims: Map<number, SovereigntyClaim>
  /** 联盟 id → 名字 / 简称 */
  alliances: Map<number, { name: string; shortName: string }>
  /** 军团 id → 名字 */
  corporations: Map<number, string>
  /** 星系 → 建筑数（主权枢纽 + 建筑，回答「这里真有东西吗」） */
  structureCounts: Map<number, number>
}

export const EMPTY_SOVEREIGNTY: SovereigntyView = {
  claims: new Map(),
  alliances: new Map(),
  corporations: new Map(),
  structureCounts: new Map(),
}

/** 侧车回包 → 可查的视图（字段乱给也不抛，缺什么当空） */
export function sovereigntyView(raw: unknown): SovereigntyView {
  const source = (raw ?? {}) as Record<string, unknown>
  if (source.ok === false) return EMPTY_SOVEREIGNTY

  const claims = new Map<number, SovereigntyClaim>()
  if (Array.isArray(source.systems)) {
    for (const entry of source.systems) {
      const row = (entry ?? {}) as Record<string, unknown>
      const systemID = Number(row.systemID) || 0
      if (systemID <= 0) continue
      claims.set(systemID, {
        systemID,
        allianceID: Number(row.allianceID) || 0,
        corporationID: Number(row.corporationID) || 0,
        claimStructureID: Number(row.claimStructureID) || 0,
        claimTime: typeof row.claimTime === "string" ? row.claimTime : "",
      })
    }
  }

  const alliances = new Map<number, { name: string; shortName: string }>()
  const rawAlliances = source.alliances
  if (rawAlliances && typeof rawAlliances === "object") {
    for (const [key, value] of Object.entries(rawAlliances as Record<string, unknown>)) {
      const id = Number(key) || 0
      const row = (value ?? {}) as Record<string, unknown>
      if (id <= 0) continue
      alliances.set(id, {
        name: typeof row.name === "string" ? row.name : "",
        shortName: typeof row.shortName === "string" ? row.shortName : "",
      })
    }
  }

  const corporations = new Map<number, string>()
  const rawCorporations = source.corporations
  if (rawCorporations && typeof rawCorporations === "object") {
    for (const [key, value] of Object.entries(rawCorporations as Record<string, unknown>)) {
      const id = Number(key) || 0
      if (id > 0 && typeof value === "string") corporations.set(id, value)
    }
  }

  const structureCounts = new Map<number, number>()
  const rawCounts = source.structureCounts
  if (rawCounts && typeof rawCounts === "object") {
    for (const [key, value] of Object.entries(rawCounts as Record<string, unknown>)) {
      const id = Number(key) || 0
      if (id > 0) structureCounts.set(id, Number(value) || 0)
    }
  }

  return { claims, alliances, corporations, structureCounts }
}

/* ---------------------------------- KM ---------------------------------- */

/** `/api/military` 的 `battles[]`（一行离屏交战；`result` 是打完之后的结算） */
export interface BattleSide {
  key: string
  /** 参战舰队：fleetID → 该舰队这一场的战力 */
  committed?: Record<string, number>
  lost?: number
  retreated?: boolean
  lastPower?: number
}

export interface BattleView {
  battleID: number
  systemID: number
  systemName: string
  /** active（进行中）| done */
  status: string
  live?: boolean
  open?: boolean
  rounds?: number
  highsec?: boolean
  startedAt: number
  endedAt?: number | null
  siteLabel?: string | null
  site?: { kind?: string; toSystemID?: number } | null
  sides?: BattleSide[]
  result?: {
    outcome?: string
    winner?: string | null
    rounds?: number
    lost?: Record<string, number>
    retreated?: string[]
    fleets?: Record<string, number[]>
    power?: Record<string, { start?: number; end?: number }>
    durationSeconds?: number
    reason?: string | null
  } | null
}

export interface BattleSideRow {
  key: string
  /** 这一侧参战的舰队（编号 + 入场战力，按战力降序） */
  fleets: { id: number; power: number }[]
  lost: number
  start: number
  end: number
  retreated: boolean
}

export interface BattleRow {
  battleID: number
  systemID: number
  systemName: string
  /** 战场：模组已经写好的中文（「通往 X 的星门」/ 建筑名），缺了用站点类型兜底 */
  siteLabel: string
  siteKind: string
  highsec: boolean
  open: boolean
  startedAt: number
  endedAt: number | null
  durationSeconds: number
  rounds: number
  outcome: string
  winner: string | null
  totalLost: number
  sides: BattleSideRow[]
}

/**
 * 交战记录 → KM 用的行。
 *
 * 数字全部以模组的结算为准：`result.lost` / `result.power` / `result.fleets` 是它算完的，
 * 只有还没结算（进行中）才退回 `sides[]` 的实时读数。排序按开打时间倒序，进行中的排最前。
 */
export function battleRows(battles: BattleView[] | undefined): BattleRow[] {
  const rows: BattleRow[] = []
  for (const battle of battles ?? []) {
    if (!battle) continue
    const result = battle.result ?? null
    const sides: BattleSideRow[] = (battle.sides ?? []).map((side) => {
      const committed = side.committed ?? {}
      const fleets = Object.entries(committed)
        .map(([id, power]) => ({ id: Number(id), power: Number(power) || 0 }))
        .filter((entry) => Number.isFinite(entry.id))
        .sort((left, right) => right.power - left.power)
      const power = result?.power?.[side.key]
      return {
        key: side.key,
        fleets,
        lost: Number(result?.lost?.[side.key] ?? side.lost) || 0,
        start: Number(power?.start ?? fleets.reduce((sum, entry) => sum + entry.power, 0)) || 0,
        end: Number(power?.end ?? side.lastPower) || 0,
        retreated: Boolean(result?.retreated?.includes(side.key) || side.retreated),
      }
    })
    // 结算里有、sides 里没有的势力也要露出来（增援没进 sides 的情况）
    for (const [key, info] of Object.entries(result?.power ?? {})) {
      if (sides.some((side) => side.key === key)) continue
      sides.push({
        key,
        fleets: (result?.fleets?.[key] ?? []).map((id) => ({ id: Number(id), power: 0 })),
        lost: Number(result?.lost?.[key]) || 0,
        start: Number(info?.start) || 0,
        end: Number(info?.end) || 0,
        retreated: Boolean(result?.retreated?.includes(key)),
      })
    }
    sides.sort((left, right) => right.start - left.start)
    const endedAt = battle.endedAt ?? null
    const startedAt = Number(battle.startedAt) || 0
    const durationSeconds =
      Number(result?.durationSeconds) ||
      (endedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0)
    const open = battle.open === true || battle.status === "active" || battle.live === true
    rows.push({
      battleID: Number(battle.battleID) || 0,
      systemID: Number(battle.systemID) || 0,
      systemName: battle.systemName ?? "",
      siteLabel: battle.siteLabel ?? "",
      siteKind: battle.site?.kind ?? "",
      highsec: battle.highsec === true,
      open,
      startedAt,
      endedAt,
      durationSeconds,
      rounds: Number(result?.rounds ?? battle.rounds) || 0,
      outcome: result?.outcome ?? (open ? "active" : ""),
      winner: result?.winner ?? null,
      totalLost: sides.reduce((sum, side) => sum + side.lost, 0),
      sides,
    })
  }
  rows.sort((left, right) => {
    if (left.open !== right.open) return left.open ? -1 : 1
    return right.startedAt - left.startedAt
  })
  return rows
}

/** 交战结果 → 色调：有战损才上色，平局 / 没打起来保持中性 */
export function battleOutcomeTone(outcome: string): "success" | "warning" | "destructive" | "muted" {
  switch (outcome) {
    case "destroyed":
      return "destructive"
    case "handover":
    case "active":
      return "warning"
    default:
      return "muted"
  }
}

/**
 * 一场战斗周围的战斗事件（求援 / 应援 / 交战 / 战损…）。
 *
 * ⚠️ 这是**按「同一星系 + 时间窗」近似关联**，不是模组给的精确外键：模组事件里没有 battleID，
 * 只有 `payload.systemID` 与时刻。所以界面上必须写明这个口径，别让它看起来像官方战报流水。
 */
export function battleEventsFor(
  events: FactionEvent[],
  battle: { systemID: number; startedAt: number; endedAt: number | null; open: boolean },
  now: number,
  slackMs = 120_000
): FactionEvent[] {
  const from = battle.startedAt - slackMs
  const to = (battle.open ? now : battle.endedAt ?? battle.startedAt) + slackMs
  return events
    .filter((event) => {
      if (event.group !== "combat") return false
      if (event.at < from || event.at > to) return false
      const payload = event.payload
      if (!payload || typeof payload !== "object") return false
      return Number((payload as { systemID?: unknown }).systemID) === battle.systemID
    })
    .sort((left, right) => right.id - left.id)
}

/** 战场类型（模组没给 siteLabel 时的兜底词） */
export const SITE_KIND_LABEL: Record<string, string> = {
  gate: "星门",
  structure: "建筑",
  station: "空间站",
  belt: "小行星带",
  anomaly: "异常空间",
}

/* ------------------------------ 逐舰 KM ------------------------------ */

/**
 * 一条逐舰击毁记录（图 2 的「单条 KM」）。
 *
 * 数据是**两条事件对起来的**（模组把「谁被打掉」与「这条值多少」分开写）：
 *   `loss`       → unitID、被击毁一方（事件自己的 factionKey）、舰队、星系、killer{key,fleetID}、battleID
 *   `killReward` → 同一个 unitID 的 `hullTypeID`（舰型）与 `value`（ISK）、`amount`（悬赏实付）
 * 实测只有一部分损失有 `killReward`（有的没走悬赏结算），那些行的舰型与价值就是空的 ——
 * 界面不能拿 0 冒充「不值钱」，要如实显示缺数据。
 */
export interface KillRow {
  /** loss 事件的 id（列表 key） */
  id: number
  at: number
  battleID: number | null
  systemID: number
  /** 被打掉的一方 */
  victimKey: string
  victimFleetID: number | null
  /** 谁打掉的 */
  killerKey: string | null
  killerFleetID: number | null
  /** engagement / gank / concord…（模组 `killer.kind`） */
  killerKind: string | null
  /** 被击毁的舰型（来自 killReward；缺了就是没有奖励记录） */
  shipTypeID: number | null
  /** 舰船价值（ISK） */
  value: number
  /** 悬赏实付（ISK） */
  reward: number
  /** 这一下把整支舰队打没了 */
  fleetLost: boolean
}

interface LossPayload {
  unitID?: number
  fleetID?: number
  typeID?: number
  systemID?: number
  battleID?: number
  fleetLost?: boolean
  killer?: { kind?: string; key?: string; fleetID?: number } | null
}

interface RewardPayload {
  unitID?: number
  hullTypeID?: number
  value?: number
  amount?: number
  victim?: string
}

function payloadOf(event: FactionEvent): Record<string, unknown> {
  const payload = event.payload
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
}

/** 把 `loss` 与同 unitID 的 `killReward` 对起来，按事件倒序 */
export function killRows(events: FactionEvent[]): KillRow[] {
  const rewards = new Map<number, RewardPayload>()
  for (const event of events) {
    if (event.type !== "killReward") continue
    const payload = payloadOf(event) as RewardPayload
    const unitID = Number(payload.unitID)
    if (Number.isFinite(unitID)) rewards.set(unitID, payload)
  }
  const rows: KillRow[] = []
  for (const event of events) {
    if (event.type !== "loss") continue
    const loss = payloadOf(event) as LossPayload
    const unitID = Number(loss.unitID)
    const reward = Number.isFinite(unitID) ? rewards.get(unitID) : undefined
    rows.push({
      id: event.id,
      at: event.at,
      battleID: Number.isFinite(Number(loss.battleID)) ? Number(loss.battleID) : null,
      systemID: Number(loss.systemID) || 0,
      victimKey: event.factionKey ?? reward?.victim ?? "",
      victimFleetID: Number.isFinite(Number(loss.fleetID)) ? Number(loss.fleetID) : null,
      killerKey: loss.killer?.key ?? null,
      killerFleetID: Number.isFinite(Number(loss.killer?.fleetID)) ? Number(loss.killer?.fleetID) : null,
      killerKind: loss.killer?.kind ?? null,
      shipTypeID: Number.isFinite(Number(reward?.hullTypeID)) ? Number(reward?.hullTypeID) : null,
      value: Number(reward?.value) || 0,
      reward: Number(reward?.amount) || 0,
      fleetLost: loss.fleetLost === true,
    })
  }
  rows.sort((left, right) => right.id - left.id)
  return rows
}

export interface BattleSideReport {
  key: string
  /** 被打掉的舰数 */
  lost: number
  /** 被打掉的 ISK */
  lostValue: number
  /** 打掉对方几艘 */
  kills: number
  /** 打掉对方多少 ISK */
  killValue: number
  /** ISK 效率：造成 /（造成 + 承受），0–1；双方都没损失时是 0 */
  efficiency: number
  /** 这一侧出现过的舰队编号（被打的 + 出手的） */
  fleets: number[]
}

export interface BattleShipLoss {
  typeID: number
  dead: number
  value: number
  /** 这一型里有几条损失没有价值记录（悬赏没结算） */
  unknown: number
}

/**
 * 一型舰船在**某一侧**的损失。
 *
 * `typeID` 为 `null` 就是「悬赏没结算、我们不知道这是什么船」的那一档 ——
 * 不许当成 0 号舰型，也不许丢掉：这条损失真实发生过，界面要如实显示「未知舰型」。
 */
export interface SideShipLoss extends Omit<BattleShipLoss, "typeID"> {
  /** 舰型；`null` = 悬赏未结算，舰型不明 */
  typeID: number | null
}

/** 阵营（一侧）的舰型损失明细 + 供进度条使用的占比 */
export interface BattleSideLosses {
  /** 阵营 key，与 `BattleSideReport.key` 对得上（含「只出手没挨打」的那一方） */
  key: string
  /** 这一侧被打掉的舰数（= `BattleSideReport.lost`，无舰型的也算） */
  lost: number
  /** 这一侧被打掉的 ISK（= `BattleSideReport.lostValue`） */
  lostValue: number
  /**
   * 这一侧的损失占**双方损失合计**的比例，0–1。
   *
   * 「双方」= 这一场里有过损失的所有阵营（`sides[].lost > 0`）——
   * 只出手、没挨打的一方不会把它的 0 摊进分母，否则一边倒的战斗会显示成 50/50。
   * 整场没有损失时是 0。
   */
  lostShare: number
  /** 分型明细，死得多的在前；未知舰型排在最后 */
  losses: SideShipLoss[]
}

export interface BattleReport {
  battleID: number
  firstAt: number
  lastAt: number
  systemID: number
  sides: BattleSideReport[]
  shipLosses: BattleShipLoss[]
  /** 按阵营拆开的舰型损失（双阵营对战界面用），顺序与 `sides` 同源，损失多的在前 */
  sideShipLosses: BattleSideLosses[]
  kills: KillRow[]
  totalLost: number
  totalValue: number
}

/**
 * 分型明细排序：死得多的在前 → ISK 高的在前 → 未知舰型沉底 → typeID 小的在前（保证确定性）。
 * 导出是为了让界面侧的自定义排序和这里保持一致。
 */
export function compareShipLosses(left: SideShipLoss, right: SideShipLoss): number {
  if (right.dead !== left.dead) return right.dead - left.dead
  if (right.value !== left.value) return right.value - left.value
  if ((left.typeID === null) !== (right.typeID === null)) return left.typeID === null ? 1 : -1
  return (left.typeID ?? 0) - (right.typeID ?? 0)
}

/**
 * 按 battleID 聚合出战斗报表（图 1 的骨架）。
 *
 * 与截图不同的地方，都是模组没有的数据 —— 界面上要写清楚，而不是留白当 0：
 *   · 没有伤害（DMG / DMG%）：模组不打伤害明细，只记「谁打掉了谁」；
 *   · 没有飞行员数：NPC 势力的作战单位是抽象出来的舰船，不是玩家飞行员；
 *   · ISK 只覆盖有 killReward 的损失：实测约六成损失有奖励记录，其余只有「掉了几艘」。
 */
export function battleReports(events: FactionEvent[]): BattleReport[] {
  const buckets = new Map<number, KillRow[]>()
  for (const kill of killRows(events)) {
    if (kill.battleID === null) continue
    const list = buckets.get(kill.battleID)
    if (list) list.push(kill)
    else buckets.set(kill.battleID, [kill])
  }
  const reports: BattleReport[] = []
  for (const [battleID, list] of buckets) {
    const sides = new Map<string, BattleSideReport>()
    const shipTypes = new Map<number, BattleShipLoss>()
    // 分侧表：victimKey → (typeID → 分型损失)。
    // 直接按阵营 key 挂一层 Map，不用拼字符串键 —— 拼键会在
    // `a\u0000none`（有船但没结算）与阵营名恰好叫 `a\u0000none` 的当（舰型 null）之间撞车，
    // 把一方的损失算进另一方。typeID 为 null 的单独成一档，不丢。
    const sideLosses = new Map<string, Map<number | null, SideShipLoss>>()
    const ensure = (key: string): BattleSideReport => {
      const found = sides.get(key)
      if (found) return found
      const created: BattleSideReport = {
        key,
        lost: 0,
        lostValue: 0,
        kills: 0,
        killValue: 0,
        efficiency: 0,
        fleets: [],
      }
      sides.set(key, created)
      return created
    }
    let totalLost = 0
    let totalValue = 0
    let firstAt = Number.POSITIVE_INFINITY
    let lastAt = 0
    let systemID = 0
    for (const kill of list) {
      firstAt = Math.min(firstAt, kill.at)
      lastAt = Math.max(lastAt, kill.at)
      systemID = systemID || kill.systemID
      totalLost += 1
      totalValue += kill.value
      const victim = ensure(kill.victimKey)
      victim.lost += 1
      victim.lostValue += kill.value
      if (kill.victimFleetID !== null && !victim.fleets.includes(kill.victimFleetID)) {
        victim.fleets.push(kill.victimFleetID)
      }
      if (kill.killerKey) {
        const killer = ensure(kill.killerKey)
        killer.kills += 1
        killer.killValue += kill.value
        if (kill.killerFleetID !== null && !killer.fleets.includes(kill.killerFleetID)) {
          killer.fleets.push(kill.killerFleetID)
        }
      }
      if (kill.shipTypeID !== null) {
        const row =
          shipTypes.get(kill.shipTypeID) ?? { typeID: kill.shipTypeID, dead: 0, value: 0, unknown: 0 }
        row.dead += 1
        row.value += kill.value
        if (kill.value <= 0) row.unknown += 1
        shipTypes.set(kill.shipTypeID, row)
      }
      // 分侧聚合：按 (victimKey, shipTypeID) 分桶。悬赏没结算的 shipTypeID 是 null，
      // 照样进桶（键为 null），界面显示成「未知舰型」——静默丢数会让两侧数量对不上账。
      let bucket = sideLosses.get(kill.victimKey)
      if (!bucket) {
        bucket = new Map<number | null, SideShipLoss>()
        sideLosses.set(kill.victimKey, bucket)
      }
      const sideRow = bucket.get(kill.shipTypeID) ?? { typeID: kill.shipTypeID, dead: 0, value: 0, unknown: 0 }
      sideRow.dead += 1
      sideRow.value += kill.value
      if (kill.value <= 0) sideRow.unknown += 1
      bucket.set(kill.shipTypeID, sideRow)
    }
    const sideRows = [...sides.values()]
    for (const side of sideRows) {
      const total = side.killValue + side.lostValue
      side.efficiency = total > 0 ? side.killValue / total : 0
      side.fleets.sort((left, right) => left - right)
    }
    sideRows.sort((left, right) => right.killValue - left.killValue || right.lost - left.lost)
    // 占比的分母只算**挨过打**的阵营：只出手那方的 0 摊进去会把一边倒显示成 50/50
    const lostTotal = sideRows.reduce((sum, side) => sum + side.lost, 0)
    const sideLossRows: BattleSideLosses[] = sideRows.map((side) => {
      // 这一侧的桶直接按 key 取，不存在前缀误匹配
      const bucket = sideLosses.get(side.key) ?? new Map<number | null, SideShipLoss>()
      return {
        key: side.key,
        lost: side.lost,
        lostValue: side.lostValue,
        lostShare: lostTotal > 0 ? side.lost / lostTotal : 0,
        losses: [...bucket.values()].sort(compareShipLosses),
      }
    })
    sideLossRows.sort((left, right) => right.lost - left.lost || right.lostValue - left.lostValue)
    reports.push({
      battleID,
      firstAt: Number.isFinite(firstAt) ? firstAt : lastAt,
      lastAt,
      systemID,
      sides: sideRows,
      shipLosses: [...shipTypes.values()].sort(
        (left, right) => right.dead - left.dead || right.value - left.value
      ),
      sideShipLosses: sideLossRows,
      kills: [...list].sort((left, right) => right.id - left.id),
      totalLost,
      totalValue,
    })
  }
  reports.sort((left, right) => right.lastAt - left.lastAt)
  return reports
}

export function formatSpeed(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return "—"
  return `${Number.isInteger(speed) ? speed : speed.toFixed(2)}×`
}

/** 运行时长：12m 34s / 3h 05m / 2d 07h（天数只到天，不再往下拆） */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${pad(hours)}h`
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

/** 推演时钟：把模拟时刻写成 10-11 21:44（本地时区） */
export function formatSimClock(now: number): string {
  if (!Number.isFinite(now) || now <= 0) return "—"
  const at = new Date(now)
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 势力色的兜底色：模组没给颜色时用得到 */
export const FALLBACK_COLOR = "#64748b"

export function colorOf(value: string | undefined): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : FALLBACK_COLOR
}
