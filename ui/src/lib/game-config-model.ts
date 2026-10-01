/**
 * 游戏世界参数的纯逻辑：控件选型、滑块范围、草稿转换、提交前校验、改动比对。
 *
 * 边界说明（重要）：这里的校验只是**给用户看的即时提示**，不是权威判定。
 * 真正的规则在服务端 `server/src/config/manager.js` —— 保存时值会再过一遍那边的
 * schema（未知键 / 类型 / 整型 / 范围 / 枚举），那边拒绝就是拒绝，界面不会绕过。
 */
import { t } from "@/lib/i18n"
import { GAME_CONFIG_LABELS, GAME_CONFIG_SECTIONS } from "@/data/game-config-labels"

export type ParamValueType = "boolean" | "number" | "string" | "json"

/** 服务端 getConfigDefinitions() 的一条（只保留界面要用的字段） */
export interface GameConfigDefinition {
  key: string
  /** 所属域文件（server / gameplay / world / mining / npc / economy） */
  domain: string
  /** 文件里的分区（configPath 的第一段） */
  section: string
  valueType: ParamValueType
  defaultValue: unknown
  description: string[]
  validValues: string | null
  integer: boolean
  minValue: number | null
  maxValue: number | null
  exclusiveMinValue: boolean
  allowBlank: boolean
  allowedValues: unknown[] | null
  envVar: string | null
}

/** 读通道（gameConfig:read / gameConfig:save）的回包 */
export interface GameConfigSnapshot {
  ok: boolean
  supported: boolean
  reason?: string
  rootDir?: string
  configDir?: string
  domains?: string[]
  evejsVersion?: string | null
  schemaVersion?: number | null
  definitions?: GameConfigDefinition[]
  values?: Record<string, unknown>
  defaults?: Record<string, unknown>
  sources?: Record<string, string>
  envOverrides?: string[]
  saved?: string[]
  backupDir?: string
  errors?: string[]
  legacy?: { shared: string | null; local: string | null }
}

export type ParamControl = "switch" | "slider" | "number" | "text" | "select" | "json"

export interface SliderSpec {
  min: number
  max: number
  step: number
}

/**
 * 倍率类：key 以 Multiplier / Scale / Speed 结尾。
 * 167 条里命中 8 条（技能训练、建筑计时、任务奖励、行星产出、虫洞寿命与游荡数量、
 * 工业速度、小行星带储量），正是玩家嘴里说的"倍数"。
 */
export function multiplierKindOf(key: string): boolean {
  return /(Multiplier|Scale|Speed)$/.test(key)
}

/** 倍率默认滑到 10 倍；两类量纲特殊的单独给范围 */
const DEFAULT_MULTIPLIER: SliderSpec = { min: 0, max: 10, step: 0.05 }
const SLIDER_OVERRIDES: Record<string, SliderSpec> = {
  skillTrainingSpeed: { min: 0, max: 20, step: 0.1 },
  miningBeltQuantityScale: { min: 0, max: 1, step: 0.01 },
}

/**
 * 该条目用滑块时的量程；返回 null 表示不用滑块。
 *
 * 只有两类走滑块：
 *   1. 倍率类（上面那 8 条）；
 *   2. 服务端 schema 自己框在 -1 ~ 1 的比值/概率（掉率、效率、安等阈值）。
 * 其余数字（端口、毫秒、体积）量程太大或不连续，滑块反而难对准，一律数字输入。
 */
export function sliderSpecOf(def: GameConfigDefinition): SliderSpec | null {
  if (def.valueType !== "number") return null
  if (def.allowedValues && def.allowedValues.length > 0) return null
  const override = SLIDER_OVERRIDES[def.key]
  if (override) return override
  if (multiplierKindOf(def.key)) return DEFAULT_MULTIPLIER
  if (
    typeof def.minValue === "number" &&
    typeof def.maxValue === "number" &&
    def.maxValue <= 1 &&
    def.minValue >= -1
  ) {
    return { min: def.minValue, max: def.maxValue, step: 0.01 }
  }
  return null
}

export function controlOf(def: GameConfigDefinition): ParamControl {
  if (def.valueType === "boolean") return "switch"
  if (def.valueType === "json") return "json"
  if (def.allowedValues && def.allowedValues.length > 0) return "select"
  if (def.valueType === "string") return "text"
  return sliderSpecOf(def) ? "slider" : "number"
}

/** 条目中文短名；服务端新增条目时回退到 key，不显示空白 */
export function labelOf(def: GameConfigDefinition): string {
  return GAME_CONFIG_LABELS[def.key] ?? def.key
}

export function sectionLabelOf(section: string): string {
  return GAME_CONFIG_SECTIONS[section] ?? section
}

/* ------------------------------ 草稿 ------------------------------ */

/**
 * 草稿一律用字符串存：开关是 "true"/"false"，数字是十进制文本，json 是 JSON 文本。
 * 这样输入框在编辑途中（"1." "-" ""）不会被反复解析回数字而抖掉光标。
 */
export type GameConfigDraft = Record<string, string>

export function draftOf(values: Record<string, unknown> | undefined): GameConfigDraft {
  const draft: GameConfigDraft = {}
  for (const [key, value] of Object.entries(values ?? {})) draft[key] = valueToText(value)
  return draft
}

export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 展示用短文本（超长的数组/对象折叠成一行） */
export function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  try {
    const text = JSON.stringify(value)
    return text.length > 60 ? text.slice(0, 60) + "…" : text
  } catch {
    return String(value)
  }
}

/** 把草稿文本按条目类型转成可提交的值；失败返回中文原因 */
export function parseDraftValue(
  def: GameConfigDefinition,
  text: string
): { ok: true; value: unknown } | { ok: false; message: string } {
  const name = labelOf(def)
  if (def.valueType === "boolean") {
    if (text === "true") return { ok: true, value: true }
    if (text === "false") return { ok: true, value: false }
    return { ok: false, message: t("{name} 只能是 开 或 关", { name }) }
  }
  if (def.valueType === "number") {
    const trimmed = text.trim()
    if (trimmed === "") return { ok: false, message: t("{name} 不能为空", { name }) }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return { ok: false, message: t("{name} 必须是数字", { name }) }
    return { ok: true, value: parsed }
  }
  if (def.valueType === "json") {
    const trimmed = text.trim()
    if (trimmed === "") return { ok: false, message: t("{name} 不能为空", { name }) }
    try {
      return { ok: true, value: JSON.parse(trimmed) }
    } catch {
      return { ok: false, message: t("{name} 必须是合法的 JSON", { name }) }
    }
  }
  return { ok: true, value: text }
}

/** 提交前的即时校验：范围 / 整型 / 枚举 / 空值（权威判定仍在服务端） */
export function validateDraftValue(def: GameConfigDefinition, text: string): string | null {
  const parsed = parseDraftValue(def, text)
  if (!parsed.ok) return parsed.message
  const name = labelOf(def)
  const value = parsed.value
  if (def.valueType === "string") {
    const text2 = String(value)
    if (text2.trim() === "" && !def.allowBlank) return t("{name} 不能为空", { name })
    if (def.allowedValues && def.allowedValues.length > 0 && !def.allowedValues.includes(text2)) {
      return t("{name} 不在允许的取值里", { name })
    }
    return null
  }
  if (def.valueType === "number") {
    const num = value as number
    if (def.integer && !Number.isInteger(num)) return t("{name} 必须是整数", { name })
    if (typeof def.minValue === "number") {
      if (num < def.minValue || (def.exclusiveMinValue && num === def.minValue)) {
        return t("{name} 不能小于 {min}", { name, min: def.minValue })
      }
    }
    if (typeof def.maxValue === "number" && num > def.maxValue) {
      return t("{name} 不能大于 {max}", { name, max: def.maxValue })
    }
  }
  return null
}

/* ------------------------------ 改动比对 ------------------------------ */

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return a === b
}

export interface DraftDiff {
  /** 可提交的补丁（键 → 真值） */
  patch: Record<string, unknown>
  /** 校验不通过的条目（键 → 中文原因） */
  errors: Record<string, string>
}

/** 草稿相对当前值的差异；顺带把不合法的那几条挑出来 */
export function draftDiff(
  definitions: GameConfigDefinition[],
  draft: GameConfigDraft,
  values: Record<string, unknown>
): DraftDiff {
  const patch: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const def of definitions) {
    if (!Object.prototype.hasOwnProperty.call(draft, def.key)) continue
    const text = draft[def.key]
    const message = validateDraftValue(def, text)
    if (message) {
      errors[def.key] = message
      continue
    }
    const parsed = parseDraftValue(def, text)
    if (!parsed.ok) continue
    if (sameValue(parsed.value, values[def.key])) continue
    patch[def.key] = parsed.value
  }
  return { patch, errors }
}

/* ------------------------------ 过滤 / 分组 ------------------------------ */

export interface ParamFilter {
  query: string
  multipliersOnly: boolean
  changedOnly: boolean
}

export function filterDefinitions(
  definitions: GameConfigDefinition[],
  filter: ParamFilter,
  draft: GameConfigDraft,
  values: Record<string, unknown>
): GameConfigDefinition[] {
  const needle = filter.query.trim().toLowerCase()
  return definitions.filter((def) => {
    if (filter.multipliersOnly && !sliderSpecOf(def)) return false
    if (filter.changedOnly) {
      const text = draft[def.key]
      if (text === undefined) return false
      const parsed = parseDraftValue(def, text)
      if (!parsed.ok || sameValue(parsed.value, values[def.key])) return false
    }
    if (!needle) return true
    return (
      def.key.toLowerCase().includes(needle) ||
      labelOf(def).toLowerCase().includes(needle) ||
      (GAME_CONFIG_LABELS[def.key] ?? "").includes(filter.query.trim())
    )
  })
}

export interface ParamGroup {
  section: string
  label: string
  items: GameConfigDefinition[]
}

/** 按文件内分区归组，保持 schema 里的原始顺序 */
export function groupDefinitions(definitions: GameConfigDefinition[]): ParamGroup[] {
  const groups: ParamGroup[] = []
  const index = new Map<string, ParamGroup>()
  for (const def of definitions) {
    let group = index.get(def.section)
    if (!group) {
      group = { section: def.section, label: sectionLabelOf(def.section), items: [] }
      index.set(def.section, group)
      groups.push(group)
    }
    group.items.push(def)
  }
  return groups
}

export function definitionsOfDomain(
  definitions: GameConfigDefinition[],
  domain: string
): GameConfigDefinition[] {
  return definitions.filter((def) => def.domain === domain)
}