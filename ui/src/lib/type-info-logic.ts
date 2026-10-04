/**
 * 「悬停简介 / 属性」的纯逻辑：把 market:typeInfo 的回包折成界面要显示的串。
 *
 * 单独放一层是为了能单测：格式化踩到的是 SDE 的历史包袱（同一个「s」在中文里
 * 既是秒又是毫秒），改错一处就是满屏错数字，而且只有在悬停时才看得见。
 *
 * 只有三条跟 unitID 走的规则，不是每属性一张对照表：
 *   - unitID 101 的「秒」实际以毫秒存（护盾 / 电容回充时间、射速、装填…），显示前除以 1000，
 *     够一分钟的（回充时间那类）按游戏口径写成「10分25秒」；
 *   - unitID 108 是抗性的「共振系数」，1 表示 0% 抗性，显示成 (1 - 值) × 100；
 *   - unitID 115 / 116 的单位串（组别ID / 类别ID）是说明文字不是单位，值是引用，数字后面不拼它。
 */
import type {
  RawMarketTypeInfo,
  RawMarketTypeInfoAttr,
  RawMarketTypeInfoBonusEntry,
} from "@/lib/ipc"
import { t } from "@/lib/i18n"

/** 悬停卡里简介截到多少字（截断后的尾巴给一个省略号，细节去右栏看） */
export const TOOLTIP_DESCRIPTION_LIMIT = 180
/** 悬停卡里最多列几条属性：再多就把卡片撑成一面墙，也挡住了相邻的行 */
export const TOOLTIP_ATTRIBUTE_LIMIT = 6

const UNIT_MILLIS = 101
const UNIT_RESONANCE = 108
const UNIT_TYPE_REF = 116
const UNIT_GROUP_REF = 115

/** 数值 → 显示串：整数带千分位，小数最多两位（0.6666667 → 0.67） */
export function formatAttrNumber(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (Number.isInteger(value)) return value.toLocaleString("en-US")
  return String(Math.round(value * 100) / 100)
}

/** 数字 + SDE 原单位符号；无量纲就只回数字，不留一个尾随空格 */
function withUnit(value: number, unit: string | null): string {
  const number = formatAttrNumber(value)
  return unit ? number + " " + unit : number
}

/**
 * unitID 101 的毫秒值 → 显示串：不到一分钟照旧「2.1 s」（射速、扫描速度这类），
 * 满一分钟的按游戏属性面板的口径写成「10分25秒」—— 中文里那条「护盾回充时间」
 * 在游戏里就是这么写的，直接显示成 625 s 会被当成算错。
 */
function formatMillis(value: number, unit: string | null): string {
  const seconds = value / 1000
  if (seconds < 60) return withUnit(seconds, unit)
  const minutes = Math.floor(seconds / 60)
  return t("{m}分{s}秒", { m: minutes, s: formatAttrNumber(seconds - minutes * 60) })
}

/**
 * 枚举型单位：SDE 把可选值直接写在单位串里，例如
 * `1=小型  2=中型  3=大型`、`1=True 0=False`、`1=Male 2=Unisex 3=Female`。
 * 不自己建对照表：按 `数字=` 的位置把标签切出来，值对上哪一个就用哪一个。
 */
export function enumUnitLabel(unit: string | null, value: number): string | null {
  if (!unit || unit.indexOf("=") < 0) return null
  const marks = [...unit.matchAll(/(\d+)\s*=/g)]
  if (marks.length < 2) return null
  for (let i = 0; i < marks.length; i += 1) {
    if (Number(marks[i][1]) !== value) continue
    const start = (marks[i].index ?? 0) + marks[i][0].length
    const end = i + 1 < marks.length ? marks[i + 1].index ?? unit.length : unit.length
    const label = unit.slice(start, end).trim()
    return label || null
  }
  return null
}

/** 一条属性的显示值：能被引用的显示名字，其余按单位规则折算后拼 SDE 原单位符号 */
export function formatAttrValue(attr: RawMarketTypeInfoAttr): string {
  // 「主技能需求」这类引用：侧车已经把 typeID 解析成物品名，名字在就用名字
  if (attr.typeName) return attr.typeName
  if (attr.unitId === UNIT_TYPE_REF || attr.unitId === UNIT_GROUP_REF) {
    return formatAttrNumber(attr.value)
  }
  const label = enumUnitLabel(attr.unit, attr.value)
  if (label) return label
  if (attr.unitId === UNIT_MILLIS) return formatMillis(attr.value, attr.unit)
  if (attr.unitId === UNIT_RESONANCE) return withUnit((1 - attr.value) * 100, attr.unit)
  return withUnit(attr.value, attr.unit)
}

/** 简介折成一行：原文里有换行，悬停卡里一行一行排会占掉半屏 */
export function clampDescription(
  text: string | undefined,
  limit = TOOLTIP_DESCRIPTION_LIMIT
): { text: string; truncated: boolean } {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  if (flat.length <= limit) return { text: flat, truncated: false }
  return { text: flat.slice(0, limit).trimEnd() + "…", truncated: true }
}

/** 悬停卡的显示计划：加成 + 简介（截断）+ 前几条属性 + 属性总条数 */
export interface TypeInfoPlan {
  description: string
  descriptionTruncated: boolean
  attributes: RawMarketTypeInfoAttr[]
  /** 属性总数：比 attributes 多时卡片给一句「共 N 项」 */
  total: number
  /** 技能加成 / 特有加成（游戏里的「每升一级：」那几段） */
  bonuses: TypeInfoBonusView[]
}

export function tooltipPlan(
  info: RawMarketTypeInfo | null,
  descriptionLimit = TOOLTIP_DESCRIPTION_LIMIT,
  attributeLimit = TOOLTIP_ATTRIBUTE_LIMIT
): TypeInfoPlan {
  const brief = clampDescription(info?.description, descriptionLimit)
  const all = info?.attributes ?? []
  return {
    description: brief.text,
    descriptionTruncated: brief.truncated,
    attributes: all.slice(0, attributeLimit),
    total: all.length,
    bonuses: bonusPlan(info),
  }
}

/* --------------------------- 加成（技能 / 特有） --------------------------- */

export interface TypeInfoBonusView {
  /** 技能名；特有加成时是空串 */
  skill: string
  /** true = 特有加成（后端给 `skillId = 0`，游戏里排在最末一段） */
  role: boolean
  entries: { value: string | null; text: string }[]
}

/**
 * 一条加成的数字：`15` + `%` 拼成 `15%`。
 *
 * 百分号**不留空格**：客户端就是 `15% 护盾值加成`（而属性页签里的抗性是 `50 %`，
 * 两处本来就不同）。没有数值的那条回 null，界面只画文字（「可以安装拦截泡发射器」）。
 */
export function bonusValue(entry: RawMarketTypeInfoBonusEntry): string | null {
  if (entry.value == null || !Number.isFinite(entry.value)) return null
  const number = formatAttrNumber(entry.value)
  if (!entry.unit) return number
  return entry.unit === "%" ? number + "%" : number + " " + entry.unit
}

/**
 * 加成折成界面要画的几段。没有加成的物品回空数组 —— 界面据此整块不画，
 * 而不是留一个空标题（市场上大部分物品本来就没有加成，这是常态）。
 */
export function bonusPlan(info: RawMarketTypeInfo | null): TypeInfoBonusView[] {
  const out: TypeInfoBonusView[] = []
  for (const section of info?.bonuses ?? []) {
    const entries = (section.entries ?? []).map((entry) => ({
      value: bonusValue(entry),
      text: entry.text,
    }))
    if (entries.length === 0) continue
    out.push({ skill: section.skill ?? "", role: section.skillId === 0, entries })
  }
  return out
}

/* ------------------------ 属性分区（游戏「属性」页签） ------------------------ */

/** 感应强度：SDE 把这 4 条塞在「目标锁定系统」(6) 里，客户端单独一段，这里也拆出来 */
export const SECTION_SENSOR = -6

/**
 * 分区标题：SDE 的 `dogmaAttributeCategories` 只有英文原话，而游戏里这一段是本地化的。
 * 只给舰船身上那几段配标题，其余分类沿用 SDE 英文名 —— 编一张 37 条的对照表，
 * 只会多出一处会过期的翻译。
 */
const SECTION_TITLE: Record<number, string> = {
  2: "护盾",
  3: "装甲",
  4: "结构",
  5: "电容器",
  6: "目标锁定系统",
  17: "导航",
  36: "电子抗性",
  40: "仓库",
  [SECTION_SENSOR]: "感应强度",
}

const SENSOR_ATTRIBUTES = new Set([208, 209, 210, 211])

/**
 * 有几条属性客户端挂在别的分区下，SDE 的分类却不是 —— 照客户端挪一下：
 * 质量（4）与容量（38）在 SDE 里都属于「结构」，客户端把它们放在「导航」与「仓库」。
 */
const SECTION_OVERRIDE: Record<number, number> = {
  4: 17,
  38: 40,
}

/**
 * 段落顺序照客户端：护盾 → 装甲 → 结构 → 电容器 → 导航 → 目标锁定 → 感应强度 →
 * 仓库 → 电子抗性；其余分类（装备、无人机、采矿…）按分类 id 接在后面。
 */
const SECTION_ORDER = [2, 3, 4, 5, 17, 6, SECTION_SENSOR, 40, 36]

function sectionRank(id: number): number {
  const at = SECTION_ORDER.indexOf(id)
  return at < 0 ? SECTION_ORDER.length + id : at
}

/**
 * 护盾 / 装甲 / 结构：值属性 + 四条「共振系数」（1 = 0% 抗性）。
 *
 * 「有效 HP」按客户端口径：值 ÷ (1 − 四抗平均)。裂谷级护盾 500、抗性 0/20/40/50%
 * 正好是 689.66，装甲 350 与 50/45/25/10% 是 518.52 —— 与游戏里显示的一致。
 */
const DEFENCE_ATTRS: { section: number; hp: number; resists: number[]; fallback?: number[] }[] = [
  { section: 2, hp: 263, resists: [271, 274, 273, 272] },
  { section: 3, hp: 265, resists: [267, 270, 269, 268] },
  // 结构抗性有两套 id：船体那套是 974-977，通用的那套是 109-113。服务端的静态表
  // **只会填其中一套**（实测 129 艘船：115 艘只有 974-977、14 艘只有 109-113，
  // 没有两套都填的），所以哪套有真值就用哪套 —— 否则整段会显示成 0% 抗性。
  { section: 4, hp: 9, resists: [974, 977, 976, 975], fallback: [113, 110, 109, 111] },
]

export interface TypeInfoResist {
  id: number
  /** SDE 里那条抗性属性的本地化名字（护盾电磁伤害抗性…） */
  name: string
  /** 已折算成百分比（共振 0.5 → 50） */
  percent: number
}

export interface TypeInfoDefence {
  /** 护盾容量 / 装甲值 / 结构值 */
  hp: number
  /** 有效 HP */
  effective: number
  /** 电磁 / 热能 / 动能 / 爆炸，顺序与客户端一致 */
  resists: TypeInfoResist[]
}

export interface TypeInfoSectionView {
  /** 分类 id；感应强度是 `SECTION_SENSOR` */
  id: number
  /** 分区标题（未知分类退成 SDE 英文名） */
  title: string
  rows: RawMarketTypeInfoAttr[]
  /** 只有护盾 / 装甲 / 结构有：头部那一行「有效 HP」与四抗 */
  defence?: TypeInfoDefence
}

/**
 * 把属性折成游戏「属性」页签里的分区：顺序、标题、有效 HP。
 *
 * 后端已经按「分类 → 属性 id」排好序，这里只做**相邻归类**，不重排行内顺序 ——
 * 排两遍只会让两边的顺序有分歧。
 */
export function attributeSections(
  attributes: RawMarketTypeInfoAttr[] | undefined,
  categories: Record<string, string> | undefined
): TypeInfoSectionView[] {
  const byId = new Map<number, RawMarketTypeInfoAttr>()
  const sections = new Map<number, TypeInfoSectionView>()
  for (const attr of attributes ?? []) {
    byId.set(attr.id, attr)
    const id = SENSOR_ATTRIBUTES.has(attr.id)
      ? SECTION_SENSOR
      : SECTION_OVERRIDE[attr.id] ?? attr.category
    let section = sections.get(id)
    if (!section) {
      section = {
        id,
        title: SECTION_TITLE[id] ?? categories?.[String(attr.category)] ?? "",
        rows: [],
      }
      sections.set(id, section)
    }
    section.rows.push(attr)
  }
  const out = [...sections.values()].sort(
    (left, right) => sectionRank(left.id) - sectionRank(right.id)
  )
  for (const section of out) {
    const spec = DEFENCE_ATTRS.find((item) => item.section === section.id)
    if (!spec) continue
    const hp = byId.get(spec.hp)
    if (!hp || !(hp.value > 0)) continue
    // 一套抗性要么四条都在、要么整段不画：宁可没有，也不要画一个算错的「有效 HP」
    const pick = (ids: number[]): TypeInfoResist[] | null => {
      const rows: TypeInfoResist[] = []
      for (const id of ids) {
        const attr = byId.get(id)
        if (!attr) return null
        rows.push({ id, name: attr.name, percent: (1 - attr.value) * 100 })
      }
      // 四条都是 0%（共振 1）= 这套没填，交给另一套
      return rows.every((row) => row.percent === 0) ? null : rows
    }
    const resists = pick(spec.resists) ?? (spec.fallback ? pick(spec.fallback) : null)
    if (!resists) continue
    const average = resists.reduce((sum, item) => sum + item.percent, 0) / resists.length / 100
    section.defence = {
      hp: hp.value,
      effective: average >= 1 ? hp.value : hp.value / (1 - average),
      resists,
    }
  }
  return out
}
