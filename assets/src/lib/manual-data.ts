/**
 * 指令手册的常驻数据：概览数字、指令全表、QA 装备。
 * 三张表都不大（合计约 60KB），直接同步解析，标签页计数和列表首屏才不用等。
 * 模板 / 物品 / NPC 三张大表在 use-manual-data 里懒加载。
 */
import commandsRaw from "@/data/commands.json?raw"
import metaRaw from "@/data/manual-meta.json?raw"
import qaRaw from "@/data/qa.json?raw"

import {
  toQa,
  type CommandCategory,
  type CommandRow,
  type QaRow,
} from "@/lib/manual-logic"

export interface ManualMeta {
  source: string
  categories: number
  commands: number
  templates: number
  items: number
  npcs: number
  qa: number
  requires: Record<string, number>
}

export const MANUAL_META = JSON.parse(metaRaw) as ManualMeta

export const COMMAND_CATEGORIES = JSON.parse(commandsRaw) as CommandCategory[]

/** 分类名列表，顺序与手册一致 */
export const CATEGORY_NAMES: string[] = COMMAND_CATEGORIES.map((g) => g.category)

/** 拍平成一维，列表按分类分组时再拆开。uid 按「分类序号:条目序号」给，位置固定 */
export const BASE_COMMAND_ROWS: CommandRow[] = COMMAND_CATEGORIES.flatMap((g, gi) =>
  g.commands.map((c, ci) => ({ ...c, cat: g.category, uid: `base:${gi}:${ci}` }))
)

export const QA_ROWS: QaRow[] = toQa(JSON.parse(qaRaw))

/** 每个分类的指令条数，筛选条角标用 */
export const CATEGORY_COUNTS: Record<string, number> = COMMAND_CATEGORIES.reduce<
  Record<string, number>
>((acc, g) => {
  acc[g.category] = g.commands.length
  return acc
}, {})
