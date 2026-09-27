import { DB_TABLES, type DbColumn, type DbTable } from "@/lib/mock"

/** 单元格可能出现的值：SQLite 里任何字段都可能是 NULL */
export type DbValue = string | number | null

export interface DbRow {
  /** 行标识：优先用主键值拼出来，删行之后仍然稳定 */
  key: string
  values: Record<string, DbValue>
}

export interface DbTableModel {
  name: string
  /** 表内总行数（大表在演示数据里只预载前若干行） */
  rows: number
  columns: DbColumn[]
  data: DbRow[]
}

function primaryKeyOf(table: DbTable, row: Record<string, DbValue>, index: number): string {
  const pk = table.columns.filter((c) => c.pk).map((c) => c.name)
  if (pk.length === 0) return `${table.name}#${index}`
  return pk.map((name) => String(row[name])).join("|")
}

/** 把静态表结构转成页面可操作的模型；删行等操作只改本地副本 */
export function buildTables(): DbTableModel[] {
  return DB_TABLES.map((table) => ({
    name: table.name,
    rows: table.rows,
    columns: table.columns,
    data: table.data.map((row, index) => ({
      key: primaryKeyOf(table, row, index),
      values: row,
    })),
  }))
}

/** 主键展示串：多列主键用 · 连接 */
export function primaryKeyLabel(table: DbTableModel, row: DbRow): string {
  const pk = table.columns.filter((c) => c.pk).map((c) => c.name)
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
