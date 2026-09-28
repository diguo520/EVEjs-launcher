/**
 * 指令手册的纯逻辑：标签表、筛选、指令拼接与原始数据归一化。
 * 与 React 无关，方便单独验证；组件只负责渲染。
 */
import { formatCount } from "@/lib/mock"
import { t } from "@/lib/i18n"

/* ---------------- 原始数据形状 ---------------- */

/** 手册内联的数组，落盘时压缩成短数组，这里再展开成对象 */
type RawTemplate = [string, string, string, string, string, string, string, string]
type RawItem = [number, string, string, string, string]
type RawNpc = [string, string, number, string, string, string, number, string]
type RawQa = [number, string, string]

export interface TemplateRow {
  id: string
  name: string
  nameZh: string
  group: string
  faction: string
  tier: string
  variant: string
  source: string
}

export interface ItemRow {
  typeID: number
  nameCn: string
  nameEn: string
  group: string
  cat: string
}

export interface NpcRow {
  key: string
  nameEn: string
  typeID: number
  nameCn: string
  factionId: string
  factionName: string
  bounty: number
  tag: string
}

export interface QaRow {
  typeID: number
  nameEn: string
  nameCn: string
}

export function toTemplates(raw: unknown): TemplateRow[] {
  return (raw as RawTemplate[]).map((r) => ({
    id: r[0],
    name: r[1],
    nameZh: r[2],
    group: r[3],
    faction: r[4],
    tier: r[5],
    variant: r[6],
    source: r[7],
  }))
}

export function toItems(raw: unknown): ItemRow[] {
  return (raw as RawItem[]).map((r) => ({
    typeID: r[0],
    nameCn: r[1],
    nameEn: r[2],
    group: r[3],
    cat: r[4],
  }))
}

export function toNpcs(raw: unknown): NpcRow[] {
  return (raw as RawNpc[]).map((r) => ({
    key: r[0],
    nameEn: r[1],
    typeID: r[2],
    nameCn: r[3],
    factionId: r[4],
    factionName: r[5],
    bounty: r[6],
    tag: r[7],
  }))
}

export function toQa(raw: unknown): QaRow[] {
  return (raw as RawQa[]).map((r) => ({
    typeID: r[0],
    nameEn: r[1],
    nameCn: r[2],
  }))
}

/* ---------------- 指令 ---------------- */

export interface CommandEntry {
  cmd: string
  alias: string
  desc: string
  params: string
  example: string
  requires: string
  typeID: string
  note: string
}

export interface CommandCategory {
  category: string
  commands: CommandEntry[]
}

/** 列表里渲染的一行：指令 + 所属分类（自定义条目额外打标） */
export interface CommandRow extends CommandEntry {
  cat: string
  custom?: boolean
  /** 渲染用的稳定标识。手册里 /allskins、/upwellauto 各出现两次，指令名不能当 key */
  uid?: string
}

export const REQUIRES_ORDER = ["无", "需停泊", "需太空", "需 GM 角色"] as const

export type RequiresLevel = (typeof REQUIRES_ORDER)[number]

export const REQUIRES_SHORT: Record<RequiresLevel, string> = {
  无: "无限制",
  需停泊: "需停泊",
  需太空: "需太空",
  "需 GM 角色": "需 GM",
}

type BadgeTone = "secondary" | "telemetry" | "default" | "warning"

export const REQUIRES_BADGE: Record<RequiresLevel, BadgeTone> = {
  无: "secondary",
  需停泊: "telemetry",
  需太空: "default",
  "需 GM 角色": "warning",
}

export function requiresShort(level: string): string {
  return REQUIRES_SHORT[level as RequiresLevel] ?? level
}

export function requiresBadge(level: string): BadgeTone {
  return REQUIRES_BADGE[level as RequiresLevel] ?? "secondary"
}

export interface CommandFilter {
  cat: string
  requires: string
  query: string
}

export function filterCommandRows(rows: CommandRow[], f: CommandFilter): CommandRow[] {
  const q = f.query.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.cat !== "all" && r.cat !== f.cat) return false
    if (f.requires !== "all" && r.requires !== f.requires) return false
    if (!q) return true
    return (
      r.cmd.toLowerCase().includes(q) ||
      r.alias.toLowerCase().includes(q) ||
      r.desc.toLowerCase().includes(q) ||
      r.params.toLowerCase().includes(q) ||
      r.note.toLowerCase().includes(q) ||
      r.example.toLowerCase().includes(q)
    )
  })
}

/** 按分类分组，保持数据源里的分类顺序 */
export function groupByCategory(rows: CommandRow[]): { category: string; rows: CommandRow[] }[] {
  const buckets = new Map<string, CommandRow[]>()
  for (const r of rows) {
    const list = buckets.get(r.cat)
    if (list) list.push(r)
    else buckets.set(r.cat, [r])
  }
  return Array.from(buckets, ([category, list]) => ({ category, rows: list }))
}

/* ---------------- 计数 ---------------- */

/** 按某个键统计条数，用于筛选条上的角标 */
export function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const k = key(r)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** 按条数降序的键列表（数量相同的按字典序） */
export function keysByCount(counts: Record<string, number>): string[] {
  return Object.keys(counts).sort((a, b) => {
    const d = (counts[b] ?? 0) - (counts[a] ?? 0)
    return d !== 0 ? d : a.localeCompare(b, "zh-Hans-CN")
  })
}

/* ---------------- 标签表 ---------------- */

export const GROUP_LABEL: Record<string, string> = {
  "combat/anomaly": "战斗异常",
  "combat/escalation": "战斗远征",
  "combat/signature": "战斗签名",
  "combat_hacking/signature": "战斗破解",
  "data/signature": "数据站点",
  "gas/signature": "气体站点",
  "ghost/signature": "隐秘设施",
  "ice/anomaly": "冰矿异常",
  "ore/anomaly": "矿石异常",
  "ore/signature": "矿石签名",
  "relic/signature": "遗迹站点",
  "unknown/signature": "未知签名",
}

export function groupLabel(group: string): string {
  return GROUP_LABEL[group] ?? group
}

export const TEMPLATE_FACTION_LABEL: Record<string, string> = {
  angels: "天使",
  blood: "血袭者",
  guristas: "古斯塔斯",
  sanshas: "萨沙",
  serpentis: "天蛇",
  rogue_drones: "流浪无人机",
  sleepers: "沉睡者",
}

export function templateFactionLabel(faction: string): string {
  if (!faction) return "未标注"
  return TEMPLATE_FACTION_LABEL[faction] ?? faction
}

export const TIER_LABEL: Record<string, string> = {
  hideaway: "藏身处",
  hub: "枢纽",
  rally_point: "集结点",
  den: "巢穴",
  sanctum: "圣所",
  haven: "避风港",
  refuge: "避难所",
  port: "港口",
  burrow: "地穴",
  yard: "船坞",
  cluster: "集群",
  lesser: "小型",
  standard: "标准",
  improved: "进阶",
  superior: "高级",
  menagerie: "兽群",
  herd: "兽群",
  squad: "小队",
  collection: "集群",
  assembly: "集结",
  gathering: "聚集",
  patrol: "巡逻",
  horde: "部落",
  surveillance: "监视",
}

export function tierLabel(tier: string): string {
  if (!tier) return "未分级"
  if (/^c[1-6]$/.test(tier)) return tier.toUpperCase()
  return TIER_LABEL[tier] ?? tier
}

export const VARIANT_LABEL: Record<string, string> = {
  base: "基础",
  forsaken: "被遗弃",
  hidden: "隐秘",
  forlorn: "荒废",
}

export function variantLabel(variant: string): string {
  if (!variant) return "常规"
  return VARIANT_LABEL[variant] ?? variant
}

export const SOURCE_LABEL: Record<string, string> = {
  client: "客户端",
  "eve-university": "EVE University",
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

/** NPC 势力里 `???` 是客户端没给名字的占位 */
export function npcFactionLabel(faction: string): string {
  if (!faction || faction === "???") return "未标注"
  return faction
}

/* ---------------- 各表筛选 ---------------- */

export function filterTemplates(
  rows: TemplateRow[],
  group: string,
  faction: string,
  query: string
): TemplateRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((t) => {
    if (group !== "all" && t.group !== group) return false
    if (faction !== "all" && t.faction !== faction) return false
    if (!q) return true
    return (
      t.id.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.nameZh.toLowerCase().includes(q) ||
      t.tier.toLowerCase().includes(q)
    )
  })
}

export function filterItems(rows: ItemRow[], cat: string, query: string): ItemRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((it) => {
    if (cat !== "all" && it.cat !== cat) return false
    if (!q) return true
    return (
      String(it.typeID).includes(q) ||
      it.nameCn.toLowerCase().includes(q) ||
      it.nameEn.toLowerCase().includes(q) ||
      it.group.toLowerCase().includes(q)
    )
  })
}

export function filterNpcs(rows: NpcRow[], faction: string, query: string): NpcRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((n) => {
    if (faction !== "all" && n.factionName !== faction) return false
    if (!q) return true
    return (
      n.key.toLowerCase().includes(q) ||
      n.nameEn.toLowerCase().includes(q) ||
      n.nameCn.toLowerCase().includes(q) ||
      String(n.typeID).includes(q) ||
      n.factionName.toLowerCase().includes(q)
    )
  })
}

export function filterQa(rows: QaRow[], query: string): QaRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(
    (it) =>
      it.nameCn.toLowerCase().includes(q) ||
      it.nameEn.toLowerCase().includes(q) ||
      String(it.typeID).includes(q)
  )
}

/* ---------------- 指令拼接 ---------------- */

/** 中文名要换成英文名——服务端 SDE 只认英文 */
export function resolveItemTarget(items: ItemRow[], input: string): string {
  const v = input.trim()
  if (!v) return ""
  if (/^\d+$/.test(v)) return v
  const byCn = items.find((it) => it.nameCn === v)
  if (byCn) return byCn.nameEn
  const lower = v.toLowerCase()
  const byEn = items.find((it) => it.nameEn.toLowerCase() === lower)
  if (byEn) return byEn.nameEn
  return v
}

export const ITEM_PLACEHOLDER = "<名称|ID>"

export function buildItemCommand(target: string, qty: number): string {
  return `/item ${target || t(ITEM_PLACEHOLDER)} ${qty}`
}

export function buildShipCommand(name: string): string {
  return `/ship ${name.trim() || t("<舰船名|typeID>")}`
}

export function buildNpcCommand(key: string, qty: number): string {
  return `/npc ${key || t("<npc键|typeID>")} ${qty}`
}

/** 异常生成用的是模板 id，不是模板名 */
export function buildSpawnCommand(id: string): string {
  return `/spawnsite ${id}`
}

/** 卡片上的第二个复制动作：typeID=名称，方便直接粘进其它指令 */
export function buildIdPair(row: { typeID: number; nameEn: string }): string {
  return `${row.typeID}=${row.nameEn}`
}

/* ---------------- 展示辅助 ---------------- */

/** 模板名可能是空的（客户端没给文案），退回中文名 / 占位 */
export function templateTitle(t: TemplateRow): string {
  return t.nameZh || t.name || "(无名)"
}

/** 英文名与中文名不同才有副标题可显示 */
export function templateSubtitle(t: TemplateRow): string {
  return t.name && t.name !== t.nameZh ? t.name : ""
}

export function formatBounty(isk: number): string {
  if (isk <= 0) return "无赏金"
  if (isk >= 1_000_000_000) return `${(isk / 1_000_000_000).toFixed(2)}B`
  if (isk >= 1_000_000) return `${(isk / 1_000_000).toFixed(1)}M`
  if (isk >= 1_000) return `${(isk / 1_000).toFixed(1)}K`
  return formatCount(isk)
}

/** 卡片标题：中文名优先，没有就退回英文名 */
export function displayName(nameCn: string, nameEn: string): string {
  return nameCn || nameEn || "(未命名)"
}
