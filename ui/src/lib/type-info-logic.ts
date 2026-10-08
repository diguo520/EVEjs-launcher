/**
 * 「悬停简介 / 属性」的纯逻辑：把 market:typeInfo 的回包折成界面要显示的串。
 *
 * 单独放一层是为了能单测：格式化踩到的是 SDE 的历史包袱（同一个「s」在中文里
 * 既是秒又是毫秒），改错一处就是满屏错数字，而且只有在悬停时才看得见。
 *
 * 只有四条跟 unitID 走的规则，不是每属性一张对照表：
 *   - unitID 101 的「秒」实际以毫秒存（护盾 / 电容回充时间、射速、装填…），显示前除以 1000，
 *     够一分钟的（回充时间那类）按游戏口径写成「10分25秒」；
 *   - unitID 108 是抗性的「共振系数」，1 表示 0% 抗性，显示成 (1 - 值) × 100；
 *   - unitID 111 是它的反向写法（SDE 原话：0.1 = 90%、0.9 = 10%），同一套折算 —— 定锚建筑
 *     那四条「伤害抗性加成」（130-133，内部名是 `…DamageResonanceMultiplier`）就是这一族，
 *     0.75 表示 25% 抗性，不折算的话会显示成 0.75 %；
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
const UNIT_INVERSE_PERCENT = 111
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
  if (attr.unitId === UNIT_RESONANCE || attr.unitId === UNIT_INVERSE_PERCENT) {
    return withUnit((1 - attr.value) * 100, attr.unit)
  }
  return withUnit(attr.value, attr.unit)
}

/* ------------------------ 原厂值（属性被改过时的「还原」目标） ------------------------ */

/**
 * 一条属性的 SDE 原厂值。
 *
 * 后端只在**确实被改过**时才回 `originalValue`（见 market.rs 的 `info_attribute`），
 * 没回就说明现值就是原厂值 —— 所以这里不用 `attr.value` 兜底也不会错。这条口径很重要：
 * 弹窗要拿它判断「这一行跟原厂值到底差没差」，判错了会把没改过的行也标成「已修改」。
 */
export function attrOriginalValue(attr: RawMarketTypeInfoAttr): number {
  return attr.modified === true && attr.originalValue != null ? attr.originalValue : attr.value
}

/**
 * 原厂值的显示串：与现值同一套折算规则（毫秒 / 共振系数 / 枚举单位都能对上）。
 *
 * 引用型属性（unitId 115 / 116，值是别的物品的 typeID）要把 `typeName` 清掉 ——
 * 那个名字是按**现值**解析出来的，原值可能指向另一个物品，留着就会印出一个错名字。
 */
export function formatOriginalValue(attr: RawMarketTypeInfoAttr): string {
  return formatAttrValue({ ...attr, value: attrOriginalValue(attr), typeName: null })
}

/**
 * 「可还原」的行：现值与 SDE 原厂值**已经不一致** —— 也就是后端在 `modified` 上标出来的
 * 那些（改过、并且已经落盘）。
 *
 * 刻意**不看草稿**：刚输入还没保存的改动不算。用户要的是「还原已经改掉的东西」，输入过程
 * 中行尾冒出一个还原图标只会让人以为哪里出错了。反过来说，没被改过的行原值本来就等于现值，
 * 所以「只给已保存的改动画原值」不会少显示任何信息。
 */
export function restorableAttrs(
  attributes: RawMarketTypeInfoAttr[] | undefined
): { id: number; original: number }[] {
  const out: { id: number; original: number }[] = []
  for (const attr of attributes ?? []) {
    if (attr.modified !== true) continue
    out.push({ id: attr.id, original: attrOriginalValue(attr) })
  }
  return out
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
 *
 * 表里覆盖的是**在售物品真的会用到**的分类，不是 SDE 的全部 37 条：装备 / 无人机 /
 * 舰载机那几段（炮台、过热、采矿、电子战…）SDE 同样只有英文名，不补的话中文用户与
 * 外语用户会在同一张面板上看到半截英文表头 —— 实测 49% 的在售物品至少有一条这样的
 * 表头，看着就像「没套上样式」。
 */
const SECTION_TITLE: Record<number, string> = {
  1: "装配",
  2: "护盾",
  3: "装甲",
  4: "结构",
  5: "电容器",
  6: "目标锁定系统",
  17: "导航",
  36: "电子抗性",
  40: "仓库",
  7: "其他属性",
  10: "无人机",
  8: "技能需求",
  37: "加成",
  // 装备 / 无人机 / 舰载机才会出现的分类（按实测出现频次排）
  29: "炮台",
  30: "导弹",
  51: "采矿",
  52: "过热",
  34: "舰载机能力",
  38: "舰载机属性",
  39: "超级武器",
  20: "远程协助",
  21: "目标标记",
  22: "能量中和",
  24: "感应抑阻",
  25: "目标干扰",
  26: "跟踪干扰",
  27: "跃迁扰频",
  28: "停滞缠绕",
  [SECTION_SENSOR]: "感应强度",
}

/** 四格感应强度的顺序：雷达 / 光雷达 / 磁力 / 引力 —— 客户端就是这么排的 */
export const SENSOR_ATTR_ORDER = [208, 209, 210, 211]

const SENSOR_ATTRIBUTES = new Set(SENSOR_ATTR_ORDER)

/**
 * 有几条属性客户端挂在别的分区下，SDE 的分类却不是 —— 照客户端挪一下：
 * 质量（4）在 SDE 里属于「结构」，客户端放在「导航」；容量（38）与体积（161）
 * 同理，客户端放在「仓库」。
 */
const SECTION_OVERRIDE: Record<number, number> = {
  4: 17,
  38: 40,
  161: 40,
}

/**
 * 没名字的遗留分类：SDE 的分类 0（压根没填 attributeCategoryID）与 9（字面就叫 NULL）
 * 装的是 `angelCartelProjectileReloadingSpeed`、`freighterBonusO1`、`帝国区禁用`
 * 这类散装属性，客户端不给它们单独起段，并进「其他属性」。
 *
 * 不并的话面板上会冒出一条**只有图标、一个字都没有**的标题带（分类 0；实测黄金富豪级
 * 17720、鲍鱼级 34328 等 29 艘船），或者一条写着 `NULL` 的（分类 9，实测 663 个物品）。
 */
const SECTION_CATEGORY: Record<number, number> = { 0: 7, 9: 7 }

/**
 * 质量（4）与惯性调整（70）：导航分区头部那条「朝向时间」由这两条算出来，
 * 它本身不是 SDE 里的一条属性。
 */
const MASS_ATTR = 4
const INERTIA_ATTR = 70

/**
 * 段落顺序照客户端：装配 → 护盾 → 装甲 → 结构 → 电容器 → 导航 → 目标锁定 →
 * 感应强度，装备 / 无人机 / 舰载机那几段（炮台、过热、采矿、电子战…）接在后面，
 * 再往后是仓库 → 电子抗性；其余分类（无人机、加成…）按分类 id 兜底排在最后。
 *
 * 显式列出来的都是**舰船身上没有**的分类（实测舰船只用到 0/1-10/17/36/37/38/40），
 * 所以动这张表不会改变舰船面板的段序。
 */
const SECTION_ORDER = [
  1, 2, 3, 4, 5, 17, 6, SECTION_SENSOR,
  29, 30, 51, 52, 34, 39, 20, 21, 22, 24, 25, 26, 27, 28,
  40, 36,
]

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
const DEFENCE_ATTRS: {
  section: number
  hp: number
  resists: number[]
  fallback?: number[]
  /**
   * 四条抗性全是 0% 时这一段还算不算真值。
   *
   * 护盾 / 装甲只有一套抗性 id，属性在就是真值 —— 铁骑舰载机的护盾抗性本来就是四条 0%
   * （实测 Ametat / Termite / Antaeus / Gungnir 全是共振 1），照样该画色块，否则整段退成
   * 普通属性行，看着就像没套上样式。
   *
   * 结构有两套 id（974-977 / 109-113），静态表可能只填一套、也可能两套都填，而其中一套
   * 常常整整齐齐四条 1（= 0%）。这种「整齐的 0%」到底是真值还是没填，分不出来 —— 但**画
   * 出来不受影响**：有非零值的那套优先；两组都是 0%（或只填了一套 0%）就照 0% 画色块。
   * 退成普通属性行反而更糟：无人机、舰载机这类结构抗性本来是 0% 的物品，结构段会跟
   * 护盾 / 装甲长得不一样（实测在售物品里有 239 件会这样，全都有 0% 抗性）。
   */
  zeroIsReal: boolean
}[] = [
  { section: 2, hp: 263, resists: [271, 274, 273, 272], zeroIsReal: true },
  { section: 3, hp: 265, resists: [267, 270, 269, 268], zeroIsReal: true },
  // 结构抗性有两套 id：船体那套是 974-977，通用的那套是 109-113。静态表的填法实测有三种：
  // 只填 974-977（75 件）、只填 109-113（811 件）、两套都填（9 件，且都是 974-977 全 1、
  // 109-113 有真值）。所以「有非零值的那套优先，否则用填了的那套」—— 两套都填时不会挑到
  // 那套整整齐齐的 0%，只有一套时也不会因为它是 0% 就把整段退成普通属性行。
  { section: 4, hp: 9, resists: [974, 977, 976, 975], fallback: [113, 110, 109, 111], zeroIsReal: true },
]

/**
 * 护盾 / 装甲 / 结构那几套四抗的属性 id（含结构的两套）。
 *
 * 面板把它们画成色块条，就不再当属性行重复列一遍 —— 服务端的结构抗性**两套 id 可能
 * 同时有值**（实测裂谷级 587：109-113 是 0.67、974-977 是 1），都列出来会多出四条
 * 同名行，其中一套还全是 0%。色块条本来只挑有真值的那一套，行里也就跟着只留挑中的那套。
 */
export const RESIST_ATTR_IDS = new Set(
  DEFENCE_ATTRS.flatMap((spec) => [...spec.resists, ...(spec.fallback ?? [])])
)

/**
 * 主伤害那四条：电磁（114）/ 热能（118）/ 动能（117）/ 爆炸（116），
 * 顺序与四抗色块、伤害类型图标同一套（电蓝 / 火红 / 动灰 / 爆橙）。
 *
 * 客户端的伤害不是一行一条，而是**一行四格**：四个伤害类型图标各带一个值，没有的那种
 * 写「-」（弹药、无人机、舰载机都是这么显示的）。所以这一组在分区里折成一行，
 * 插在原来第一条伤害属性所在的位置。
 */
export const DAMAGE_ATTRIBUTE_IDS = [114, 118, 117, 116] as const

/** 「伤害」这个标题 / 行名的界面文案键：八种语言的目录里都有 */
export const DAMAGE_TITLE = "伤害"

/**
 * 「伤害抗性加成」四条：电磁（984）/ 热能（987）/ 动能（986）/ 爆炸（985）。
 *
 * 顺序与主伤害、四抗色块同一套（电蓝 / 火红 / 动灰 / 爆橙）。护盾 / 装甲的抗性装备
 * （抗性涂层、抗性放大器、多谱抗性强化器…）在客户端里跟伤害一样是**一行四格**：四个
 * 伤害类型图标各带一个值，这个物品没有的那种写「-」。实测在售物品里 753 件用到这四条 ——
 * 单抗装备只填其中一条，另外三格就是「-」。
 *
 * 130-133 那套老的「伤害抗性加成」（弹道偏阻阵列这类定锚建筑）名字一样，内部名却是
 * `…DamageResonanceMultiplier`、单位是 111（反向修正百分比，1 = 不变、0.75 = 25% 抗性）。
 * 数值由 formatAttrValue 按单位折算后与本套同为「抗性百分比」，所以并进同一行四格；
 * 实测没有一件物品同时带两套 id，一行只认先命中的那一套。
 */
export const RESIST_BONUS_ATTRIBUTE_IDS = [984, 987, 986, 985] as const

/** 定锚建筑（护盾加固阵列）那套老的「伤害抗性加成」：电磁 133 / 热能 130 / 动能 131 / 爆炸 132 */
export const LEGACY_RESIST_BONUS_ATTRIBUTE_IDS = [133, 130, 131, 132] as const

/** 「伤害抗性加成」这个行名 / 标题的界面文案键：八种语言的目录里都有 */
export const RESIST_BONUS_TITLE = "伤害抗性加成"

/**
 * 折成一行四格的那几组属性：主伤害四条与伤害抗性加成四条。
 *
 * 一组可以给多套 id（`orders`）：抗性加成有两套，现代装备是 984-987，定锚建筑的
 * 护盾加固阵列是 130-133；名字与折算后的含义都一样，同一组只用先命中的那一套。
 *
 * 属性本身**不从 rows 里删掉** —— 右栏的「改属性」弹窗按 rows 列输入框，删了就没法改
 * 伤害与抗性加成了。渲染顺序由 `TypeInfoSectionView.items` 给。
 */
const QUAD_GROUPS: { label: string; orders: readonly (readonly number[])[] }[] = [
  { label: DAMAGE_TITLE, orders: [DAMAGE_ATTRIBUTE_IDS] },
  {
    label: RESIST_BONUS_TITLE,
    orders: [RESIST_BONUS_ATTRIBUTE_IDS, LEGACY_RESIST_BONUS_ATTRIBUTE_IDS],
  },
]

/**
 * 其余几套伤害量属性 → 伤害类型序号（0 电磁 / 1 热能 / 2 动能 / 3 爆炸）。
 *
 * 这些是铁骑舰载机那种「（每架铁骑舰载机）」家族（2131-2134 / 2171-2174 / 2227-2230 /
 * 2325-2328）与「死亡时伤害」那套（2271-2274）：客户端那一行四格只认上面那四条主伤害，
 * 所以它们保持一行一条，但属性行照样挂伤害类型图标与配色 —— 整段共用一个分区图标的话，
 * 一行「热能伤害」跟同段的射程、射速长得一模一样。名字带「加成」的 138-141 不算伤害量，
 * 不在其列。
 */
export const DAMAGE_ATTR_SLOT: Record<number, number> = {
  2131: 0, 2171: 0, 2227: 0, 2271: 0, 2325: 0,
  2132: 1, 2172: 1, 2228: 1, 2272: 1, 2326: 1,
  2133: 2, 2173: 2, 2229: 2, 2273: 2, 2327: 2,
  2134: 3, 2174: 3, 2230: 3, 2274: 3, 2328: 3,
}

/** 一条属性行是不是伤害量：是就给伤害类型序号（0..3），不是回 null（界面沿用分区图标） */
export function damageAttrSlot(attr: RawMarketTypeInfoAttr): number | null {
  const slot = DAMAGE_ATTR_SLOT[attr.id]
  return slot === undefined ? null : slot
}

export interface TypeInfoResist {
  id: number
  /** SDE 里那条抗性属性的本地化名字（护盾电磁伤害抗性…） */
  name: string
  /** 已折算成百分比（共振 0.5 → 50） */
  percent: number
}

export interface TypeInfoDefence {
  /** 护盾容量 / 装甲值 / 结构值；装备大多没有这三条，缺了就是 null */
  hp: number | null
  /** 有效 HP；没有 hp 时给 null（标题带右侧那截读数就不画） */
  effective: number | null
  /** 电磁 / 热能 / 动能 / 爆炸，顺序与客户端一致 */
  resists: TypeInfoResist[]
}

/**
 * 折成一行四格的属性组（伤害 / 伤害抗性加成）：四个伤害类型各一格 ——
 * 电磁 / 热能 / 动能 / 爆炸（与四抗色块同序），这个物品没有的那格留 null，
 * 界面照客户端画一个「-」。
 */
export interface TypeInfoQuad {
  /** 行名的界面文案键：「伤害」/「伤害抗性加成」 */
  label: string
  cells: (RawMarketTypeInfoAttr | null)[]
  /**
   * 这一段除了这一行四格什么都没有（末日武器、部分弹药这类「只有伤害」的段）：
   * 标题带直接就是行名，下面那行不再重复一遍行名，免得「炮台 / 伤害 / 四格」叠在一起
   * 像是套错了样式。实测在售物品里有 957 段是这种。
   */
  only: boolean
}

/** 分区正文里的一条：普通属性行，或者折成一行四格的那一组 */
export type TypeInfoRowItem =
  | { kind: "attr"; attr: RawMarketTypeInfoAttr }
  | { kind: "quad"; quad: TypeInfoQuad }

export interface TypeInfoSectionView {
  /** 分类 id；感应强度是 `SECTION_SENSOR` */
  id: number
  /** 分区标题（未知分类退成 SDE 英文名） */
  title: string
  /**
   * 这一段的全部属性（**含**折进四格的那几条）：右栏「改属性」弹窗按它列输入框，
   * 一条都不能少。
   */
  rows: RawMarketTypeInfoAttr[]
  /** 渲染顺序：普通属性行与四格行按原属性顺序交替（面板画 items，别直接画 rows） */
  items: TypeInfoRowItem[]
  /** 只有护盾 / 装甲 / 结构有：头部那一行「有效 HP」与四抗 */
  defence?: TypeInfoDefence
  /** 只有导航有：头部右侧那条「朝向时间」（秒），由质量与惯性调整算出来 */
  alignSeconds?: number
}

/**
 * 侧车从**类型字段**补出来的三条属性：质量（4）/ 容量（38）/ 体积（161）在 typeDogma
 * 里一条都没有，是侧车从 SDE 的类型数据（mass / capacity / volume）补进属性列表的，
 * 让属性面板跟游戏一样能列出它们。**它们在 dogma 里不存在，写不回去** —— 改属性的
 * 弹窗要跳过，否则用户改了会得到一个「写不进去」的失败提示。
 */
export const DERIVED_ATTR_IDS = new Set([MASS_ATTR, 38, 161])

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
    // 分类 0 / 9 先并进「其他属性」，再让分区的挪位表（质量、容量、体积）覆盖
    const category = SECTION_CATEGORY[attr.category] ?? attr.category
    const id = SENSOR_ATTRIBUTES.has(attr.id)
      ? SECTION_SENSOR
      : SECTION_OVERRIDE[attr.id] ?? category
    let section = sections.get(id)
    if (!section) {
      section = {
        id,
        title: SECTION_TITLE[id] ?? categories?.[String(category)] ?? "",
        rows: [],
        // 渲染顺序在这一趟走完之后统一补：四格行要等 defence 定下来，才知道哪几条行会被色块条吃掉
        items: [],
      }
      sections.set(id, section)
    }
    section.rows.push(attr)
  }
  const out = [...sections.values()].sort(
    (left, right) => sectionRank(left.id) - sectionRank(right.id)
  )
  const quads = new Map<number, TypeInfoQuad[]>()
  for (const section of out) {
    // 「伤害」与「伤害抗性加成」各折成一行四格：这一组属性不再单独列，只在原来第一条
    // 那组属性所在的位置占一行（弹药 / 无人机 / 抗性装备在客户端就是这么显示的）
  const grouped = QUAD_GROUPS.flatMap((group) => {
    const order = group.orders.find((ids) => section.rows.some((attr) => ids.includes(attr.id)))
    return order
      ? [{ label: group.label, cells: order.map((id) => byId.get(id) ?? null), only: false }]
      : []
  })
    if (grouped.length > 0) quads.set(section.id, grouped)
    const spec = DEFENCE_ATTRS.find((item) => item.section === section.id)
    if (!spec) continue
    // 一套抗性要么四条都在、要么整段不画：宁可没有，也不要画一个算错的「有效 HP」
    const complete = (ids: number[]): TypeInfoResist[] | null => {
      if (ids.length === 0) return null
      const rows: TypeInfoResist[] = []
      for (const id of ids) {
        const attr = byId.get(id)
        if (!attr) return null
        rows.push({ id, name: attr.name, percent: (1 - attr.value) * 100 })
      }
      return rows
    }
    // 一套抗性四条都齐才算数；四条都是 0%（共振 1）时算不算真值由 zeroIsReal 决定：
    // true = 照 0% 画（结构有两套 id，这时优先挑有非零值的那套），false = 当「这套没填」
    const filled = (rows: TypeInfoResist[] | null) =>
      rows && rows.some((row) => row.percent !== 0) ? rows : null
    const resists = spec.zeroIsReal
      ? filled(complete(spec.resists)) ?? complete(spec.fallback ?? []) ?? complete(spec.resists)
      : filled(complete(spec.resists)) ?? filled(spec.fallback ? complete(spec.fallback) : null)
    if (!resists) continue
    // 这条色块只看抗性齐不齐：护盾容量 / 装甲值 / 结构值只有船体与少数装备（损伤控制、
    // 会战模块）才有 —— 缺了照样画条，只是标题带右侧不给「有效 HP」那个读数。
    // 否则同一件装备的护盾段有条、装甲段没条（损伤控制就是），看着像样式漏做了。
    const hp = byId.get(spec.hp)
    const hpValue = hp && hp.value > 0 ? hp.value : null
    const average = resists.reduce((sum, item) => sum + item.percent, 0) / resists.length / 100
    section.defence = {
      hp: hpValue,
      effective: hpValue === null ? null : average >= 1 ? hpValue : hpValue / (1 - average),
      resists,
    }
  }
  // 导航头部那条「朝向时间」是算出来的，不是 SDE 里的属性：ln(4) × 惯性调整 × 质量 ÷ 10⁶。
  // 实测质量 997,000 kg、惯性 3.6 → 4.98 秒，与游戏显示一致；缺哪一条就不画。
  const nav = out.find((section) => section.id === 17)
  if (nav) {
    const mass = byId.get(MASS_ATTR)
    const inertia = byId.get(INERTIA_ATTR)
    if (mass && inertia && mass.value > 0 && inertia.value > 0) {
      nav.alignSeconds = (Math.log(4) * inertia.value * mass.value) / 1e6
    }
  }
  // 渲染顺序：普通属性行与四格行按原属性顺序交替。面板画 items（四格行占一行，同组的
  // 其余几条不再单独列），弹窗列 rows（一条都不少，改属性改得到）
  for (const section of out) {
    const items: TypeInfoRowItem[] = []
    for (const attr of section.rows) {
      const quad = quads
        .get(section.id)
        ?.find((row) => row.cells.some((cell) => cell?.id === attr.id))
      if (quad) {
        // 那一组只在第一条的位置占一行：同组另外几条跟着它一起折进去
        if (!items.some((item) => item.kind === "quad" && item.quad === quad)) {
          items.push({ kind: "quad", quad })
        }
        continue
      }
      // 色块条已经把四抗说清了，不再在下面重复列（结构抗性两套 id 会撞出四条同名行）
      if (section.defence && RESIST_ATTR_IDS.has(attr.id)) continue
      items.push({ kind: "attr", attr })
    }
    // 整段只有这一行四格（末日武器、部分弹药）：标题带直接写行名，行里不再重复一遍。
    // 实测在售物品里有 957 段是这种（Carbonized Lead S、Gjallarhorn 末日武器…）。
    if (items.length === 1 && items[0].kind === "quad") {
      items[0].quad.only = true
      section.title = items[0].quad.label
    }
    section.items = items
  }
  return out
}
