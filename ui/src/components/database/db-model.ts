import type { DbColumn } from "@/lib/mock"
import type { RawDbColumn, RawDbOverview, RawDbTable, RawDbTableInfo } from "@/lib/ipc"

/** 单元格可能出现的值：SQLite 里任何字段都可能是 NULL */
export type DbValue = string | number | null

export interface DbRow {
  /** 行标识：优先用主键值拼出来，删行之后仍然稳定 */
  key: string
  values: Record<string, DbValue>
}

export interface DbTableModel {
  name: string
  /** 表内总行数（页面只载入前若干行，见 loaded） */
  rows: number
  columns: DbColumn[]
  data: DbRow[]
  /** 本次实际载入的行数；undefined = 全部在该模型里（原型演示数据） */
  loaded?: number
}

/** 主键的列名列表 */
function pkNames(columns: DbColumn[]): string[] {
  return columns.filter((column) => column.pk).map((column) => column.name)
}

/** 行标识：有主键用主键值，没有就退回行号 */
export function rowKey(
  columns: DbColumn[],
  tableName: string,
  row: Record<string, DbValue>,
  index: number
): string {
  const pk = pkNames(columns)
  if (pk.length === 0) return `${tableName}#${index}`
  return pk.map((name) => String(row[name])).join("|")
}

/** 后端列定义（SQLite PRAGMA table_info）→ 页面列模型 */
export function columnFromRaw(raw: RawDbColumn, isPk: boolean): DbColumn {
  return {
    name: raw.name,
    type: raw.type || "—",
    pk: isPk || Number(raw.pk) > 0,
    notNull: Number(raw.notnull) > 0,
    def:
      raw.dflt_value === null || raw.dflt_value === undefined
        ? "—"
        : String(raw.dflt_value),
  }
}

/** `database:overview.tables[]` → 只够左栏清单用的模型（暂无列与行） */
export function listModel(info: RawDbTableInfo): DbTableModel {
  return { name: info.name, rows: info.rows ?? 0, columns: [], data: [] }
}

/** `database:table` → 中栏与右栏用的完整模型 */
export function tableFromRaw(raw: RawDbTable): DbTableModel {
  const keys = new Set<string>()
  for (const entry of raw.primaryKeys ?? []) {
    if (typeof entry === "string") keys.add(entry)
    else if (entry && typeof entry.name === "string") keys.add(entry.name)
  }
  const columns = (raw.columns ?? []).map((column) => columnFromRaw(column, keys.has(column.name)))
  const data = (raw.rows ?? []).map((row, index) => ({
    key: rowKey(columns, raw.table, row as Record<string, DbValue>, index),
    values: row as Record<string, DbValue>,
  }))
  return {
    name: raw.table,
    rows: typeof raw.total === "number" ? raw.total : data.length,
    columns,
    data,
    loaded: data.length,
  }
}

/** 概览里的表统计 → 模型（用真 sizeBytes / indexes 补在旁注上） */
export function overviewIndex(overview: RawDbOverview | null): Map<string, RawDbTableInfo> {
  const map = new Map<string, RawDbTableInfo>()
  for (const info of overview?.tables ?? []) {
    if (info?.name) map.set(info.name, info)
  }
  return map
}

/** 主键展示串：多列主键用 · 连接 */
export function primaryKeyLabel(table: DbTableModel, row: DbRow): string {
  const pk = pkNames(table.columns)
  if (pk.length === 0) return row.key
  return pk.map((name) => String(row.values[name])).join(" · ")
}

/** 大数值加千分位方便扫读；小数值（价格、比例）保持原样 */
export function formatDbNumber(value: number): string {
  return Number.isInteger(value) && Math.abs(value) >= 10000
    ? value.toLocaleString("en-US")
    : String(value)
}

/** 按列定义拼出建表语句 */
export function buildDdl(table: DbTableModel): string {
  const lines = table.columns.map((column) => {
    const parts = [column.name, column.type]
    if (column.pk) parts.push("PRIMARY KEY")
    if (column.notNull) parts.push("NOT NULL")
    if (column.def !== "—" && column.def !== "NULL") parts.push(`DEFAULT ${column.def}`)
    return `  ${parts.join(" ")}`
  })
  return `CREATE TABLE ${table.name} (\n${lines.join(",\n")}\n);`
}
