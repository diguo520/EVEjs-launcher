import { useState } from "react"
import { toast } from "sonner"

import { Panel, SectionHeading, StatTile } from "@/components/common/panel"
import { TableList } from "@/components/database/table-list"
import { TableBrowser } from "@/components/database/table-browser"
import { RowInspector } from "@/components/database/row-inspector"
import { DbPathBar } from "@/components/database/db-path-bar"
import { buildTables, type DbTableModel } from "@/components/database/db-model"
import { DB_META, DB_TABLES } from "@/lib/mock"

export function DatabasePage() {
  const [tables, setTables] = useState<DbTableModel[]>(buildTables)
  const [activeName, setActiveName] = useState<string>(DB_TABLES[0].name)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const activeTable = tables.find((t) => t.name === activeName) ?? tables[0]
  const selectedRow = activeTable.data.find((r) => r.key === selectedKey) ?? null

  function selectTable(name: string) {
    setActiveName(name)
    setSelectedKey(null)
  }

  function deleteRow(key: string) {
    setTables((prev) =>
      prev.map((table) =>
        table.name === activeTable.name
          ? {
              ...table,
              rows: Math.max(0, table.rows - 1),
              data: table.data.filter((r) => r.key !== key),
            }
          : table
      )
    )
    setSelectedKey(null)
    toast.error("已删除 1 行")
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="数据库"
        sub="// PERSISTENCE LAYER"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">{DB_META.file}</span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="DB SIZE" value={DB_META.sizeMB} unit="MB" tone="telemetry" delta="SQLite" />
        <StatTile label="数据表" value={DB_META.tableCount} tone="primary" delta="REAL" />
        <StatTile
          label="总行数"
          value={DB_META.rowTotal.toLocaleString("en-US")}
          tone="primary"
          delta="TOTAL"
        />
        <StatTile label="日志模式" value={DB_META.journal} tone="warning" delta="MODE" />
      </div>

      <Panel
        flush
        tag="// WORKBENCH"
        title="数据浏览器"
        meta={`${tables.length} 张表已挂载`}
        className="min-h-[520px]"
        bodyClassName="flex min-h-0"
      >
        <div className="grid min-h-0 w-full flex-1 grid-rows-[auto_auto_auto] lg:grid-rows-1 lg:grid-cols-[180px_1fr_220px]">
          <TableList
            tables={tables}
            activeName={activeTable.name}
            onSelect={selectTable}
            className="border-b border-input lg:border-b-0 lg:border-r"
          />
          <TableBrowser
            table={activeTable}
            selectedKey={selectedKey}
            onSelectRow={setSelectedKey}
            /* min-w-0：格子里是宽表格，不给它收缩的余地就会把整个网格撑出横向滚动 */
            className="min-w-0 border-b border-input lg:border-b-0 lg:border-r"
          />
          <RowInspector table={activeTable} row={selectedRow} onDelete={deleteRow} />
        </div>
      </Panel>

      <DbPathBar />
    </div>
  )
}
