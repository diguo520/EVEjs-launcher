import type { UniverseConfig } from "@/lib/types"
import { DEFAULT_CONFIG } from "@/lib/seed"
import { formatFixed, formatInt } from "@/lib/format"

/** 参数分组，和 Tabs 的 value 一一对应。 */
export type ConfigGroupId = "world" | "growth" | "economy" | "runtime"

export interface ConfigGroup {
  id: ConfigGroupId
  label: string
  hint: string
}

export const CONFIG_GROUPS: ConfigGroup[] = [
  { id: "world", label: "世界", hint: "决定星域规模与危险程度，改动在下次启动世界时生效" },
  { id: "growth", label: "成长", hint: "角色与资产的获取速度倍率，1.0x 为官方手感" },
  { id: "economy", label: "经济", hint: "市场税收、订单刷新节奏与 NPC 买卖盘深度" },
  { id: "runtime", label: "运行", hint: "进程、网关与存档节奏，改动即刻作用于调度器" },
]

/** 参数用什么控件编辑。 */
export type ConfigControl = "slider" | "switch" | "text" | "number" | "password"

export interface ConfigField {
  key: keyof UniverseConfig
  label: string
  desc: string
  group: ConfigGroupId
  control: ConfigControl
  /** 显示在数值后面的单位，例如 % / x / s。 */
  unit?: string
  /** 显示在数值前面的前缀，例如端口号前面的冒号。 */
  prefix?: string
  /** 小数位，0 走千分位整数。 */
  decimals?: number
  min?: number
  max?: number
  step?: number
  /** 口令类字段只显示位数，不显示明文。 */
  masked?: boolean
}

export const CONFIG_FIELDS: ConfigField[] = [
  /* ---------------- 世界 ---------------- */
  {
    key: "systems",
    label: "星系数量",
    desc: "世界规模，直接决定内存与 tick 压力",
    group: "world",
    control: "slider",
    min: 100,
    max: 20000,
    step: 100,
    decimals: 0,
  },
  {
    key: "securitySpread",
    label: "安全等级跨度",
    desc: "高安到 0.0 的分布范围，越大越凶险",
    group: "world",
    control: "slider",
    unit: "%",
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
  },
  {
    key: "npcDensity",
    label: "NPC 密度",
    desc: "每个星系的巡逻队与海盗刷新倍率",
    group: "world",
    control: "slider",
    unit: "x",
    min: 0.2,
    max: 3,
    step: 0.1,
    decimals: 1,
  },

  /* ---------------- 成长 ---------------- */
  {
    key: "expRate",
    label: "经验倍率",
    desc: "角色经验获取速度",
    group: "growth",
    control: "slider",
    unit: "x",
    min: 0.1,
    max: 20,
    step: 0.1,
    decimals: 1,
  },
  {
    key: "skillRate",
    label: "技能训练倍率",
    desc: "在线与离线技能点产出速度",
    group: "growth",
    control: "slider",
    unit: "x",
    min: 0.1,
    max: 20,
    step: 0.1,
    decimals: 1,
  },
  {
    key: "iskRate",
    label: "ISK 收益倍率",
    desc: "赏金、任务与打捞的收益倍率",
    group: "growth",
    control: "slider",
    unit: "x",
    min: 0.1,
    max: 20,
    step: 0.1,
    decimals: 1,
  },
  {
    key: "lootRate",
    label: "掉落倍率",
    desc: "残骸与容器的掉落概率",
    group: "growth",
    control: "slider",
    unit: "x",
    min: 0.1,
    max: 20,
    step: 0.1,
    decimals: 1,
  },

  /* ---------------- 经济 ---------------- */
  {
    key: "marketTax",
    label: "市场税率",
    desc: "每笔成交抽取的税额",
    group: "economy",
    control: "slider",
    unit: "%",
    min: 0,
    max: 15,
    step: 0.5,
    decimals: 1,
  },
  {
    key: "orderRefresh",
    label: "订单刷新间隔",
    desc: "NPC 买卖盘重建的间隔秒数",
    group: "economy",
    control: "slider",
    unit: "s",
    min: 30,
    max: 3600,
    step: 10,
    decimals: 0,
  },
  {
    key: "npcSpread",
    label: "NPC 买卖价差",
    desc: "NPC 挂单相对市价的偏离幅度",
    group: "economy",
    control: "slider",
    unit: "%",
    min: 0,
    max: 30,
    step: 1,
    decimals: 0,
  },

  /* ---------------- 运行 ---------------- */
  {
    key: "tickRate",
    label: "tick 速率",
    desc: "世界每秒推进帧数，越高越吃 CPU",
    group: "runtime",
    control: "slider",
    unit: "/s",
    min: 5,
    max: 60,
    step: 1,
    decimals: 0,
  },
  {
    key: "autoSaveMinutes",
    label: "自动存档间隔",
    desc: "两次自动快照之间的分钟数",
    group: "runtime",
    control: "slider",
    unit: "min",
    min: 1,
    max: 120,
    step: 1,
    decimals: 0,
  },
  {
    key: "pvpEnabled",
    label: "允许玩家对战",
    desc: "关闭后玩家之间无法互相攻击",
    group: "runtime",
    control: "switch",
  },
  {
    key: "friendlyFire",
    label: "友军误伤",
    desc: "同军团成员之间也会造成伤害",
    group: "runtime",
    control: "switch",
  },
  {
    key: "persistentWorld",
    label: "持久化世界",
    desc: "关服后保留世界状态，下次续跑",
    group: "runtime",
    control: "switch",
  },
  {
    key: "serverName",
    label: "服务端名称",
    desc: "客户端服务器列表里显示的名字",
    group: "runtime",
    control: "text",
  },
  {
    key: "port",
    label: "网关端口",
    desc: "客户端连接使用的 TCP 端口",
    group: "runtime",
    control: "number",
    prefix: ":",
    min: 1,
    max: 65535,
  },
  {
    key: "maxPlayers",
    label: "人数上限",
    desc: "同时在线舰长的最大数量",
    group: "runtime",
    control: "number",
    unit: " 人",
    min: 1,
    max: 512,
  },
  {
    key: "adminPassword",
    label: "管理密码",
    desc: "进入管理控制台所需的口令",
    group: "runtime",
    control: "password",
    masked: true,
  },
]

export function fieldsOfGroup(group: ConfigGroupId): ConfigField[] {
  return CONFIG_FIELDS.filter((field) => field.group === group)
}

const LABEL_BY_KEY = new Map<string, string>(CONFIG_FIELDS.map((field) => [field.key, field.label]))

export function labelOf(key: keyof UniverseConfig): string {
  return LABEL_BY_KEY.get(key) ?? String(key)
}

export function findField(key: keyof UniverseConfig): ConfigField | undefined {
  return CONFIG_FIELDS.find((field) => field.key === key)
}

/** 把一个参数值渲染成终端里该有的样子：1.0x / 55% / 5,231 / 开启。 */
export function formatFieldValue(
  field: ConfigField,
  value: number | string | boolean,
): string {
  if (typeof value === "boolean") return value ? "开启" : "关闭"
  if (typeof value === "string") {
    if (field.masked) return `${value.length} 位`
    return value === "" ? "—" : value
  }
  const digits = field.decimals ?? 0
  const text = digits === 0 ? formatInt(value) : formatFixed(value, digits)
  return `${field.prefix ?? ""}${text}${field.unit ?? ""}`
}

/** 「默认 1.0x」这类对照小字。 */
export function formatDefaultText(field: ConfigField): string {
  return `默认 ${formatFieldValue(field, DEFAULT_CONFIG[field.key])}`
}

/** 与出厂配置逐字段比对，返回被改过的参数。 */
export function changedFields(config: UniverseConfig): ConfigField[] {
  return CONFIG_FIELDS.filter((field) => config[field.key] !== DEFAULT_CONFIG[field.key])
}
