import { useState } from "react"
import { Plus, RefreshCw, Save, Upload } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataGrid } from "@/components/database/data-grid"
import { SchemaView, SqlView } from "@/components/database/schema-view"
import type { DbTableModel } from "@/components/database/db-model"

/** 中栏：当前表的数据 / 结构 / SQL 三种视图 */
export function TableBrowser({
  table,
  selectedKey,
  onSelectRow,
  onBackup,
  onRestore,
  onRefresh,
  onInsert,
  loading,
  extra,
  className,
}: {
  table: DbTableModel
  selectedKey: string | null
  onSelectRow: (key: string | null) => void
  /** 真备份（database:backup）；没给就是浏览器预览，点了只说明未接后端 */
  onBackup?: () => void
  /** 真恢复（database:restore 最新一份） */
  onRestore?: () => void
  /** 重新读概览与当前表 */
  onRefresh?: () => void
  /** 新增一行（database:insert，列值先留空） */
  onInsert?: () => void
  /** 正在从后端拉取这张表 */
  loading?: boolean
  /** 额外读数（比如真实列数），拼在「N 列 · M 行」后面 */
  extra?: string
  className?: string
}) {
  const [tab, setTab] = useState("data")

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-2 pt-2.5">
        <div className="min-w-0">
          <div className="tabular truncate text-[14px] font-semibold text-foreground">
            {table.name}
          </div>
          <div className="tabular mt-0.5 text-[11px] text-tertiary">
            {table.columns.length > 0 ? table.columns.length : extra ?? 0} 列 ·{" "}
            {table.rows.toLocaleString("en-US")} 行
            {table.loaded !== undefined ? (
              <span className="text-tertiary/70">
                {" "}
                · 已载入 {table.loaded.toLocaleString("en-US")} 行
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-w-2 flex-1" />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => (onBackup ? onBackup() : toast("没有连接后端，无法创建备份"))}
          >
            <Save />
            备份
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => (onRestore ? onRestore() : toast("没有连接后端，无法恢复备份"))}
          >
            <Upload />
            恢复
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => (onRefresh ? onRefresh() : toast("没有连接后端"))}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
          <Button
            size="sm"
            disabled={loading}
            onClick={() => (onInsert ? onInsert() : toast("没有连接后端，无法新增行"))}
          >
            <Plus />
            新增行
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-3">
          <TabsTrigger value="data">数据</TabsTrigger>
          <TabsTrigger value="schema">结构</TabsTrigger>
          <TabsTrigger value="sql">SQL</TabsTrigger>
        </TabsList>

        <TabsContent value="data" className="flex min-h-0 flex-1 flex-col">
          <DataGrid table={table} selectedKey={selectedKey} onSelect={onSelectRow} />
        </TabsContent>

        <TabsContent value="schema" className="flex min-h-0 flex-1 flex-col">
          <SchemaView table={table} />
        </TabsContent>

        <TabsContent value="sql" className="flex min-h-0 flex-1 flex-col">
          <SqlView table={table} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
