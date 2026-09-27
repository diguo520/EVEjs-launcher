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
  className,
}: {
  table: DbTableModel
  selectedKey: string | null
  onSelectRow: (key: string | null) => void
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
            {table.columns.length} 列 · {table.rows.toLocaleString("en-US")} 行
          </div>
        </div>

        <div className="min-w-2 flex-1" />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast.success(`已创建备份 ${table.name}.sqlite`)}
          >
            <Save />
            备份
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast("请选择要恢复的备份文件…")}
          >
            <Upload />
            恢复
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast.success(`已重新读取 ${table.name}`)}
          >
            <RefreshCw />
            刷新
          </Button>
          <Button
            size="sm"
            onClick={() => toast("原型演示：新增行需连接真实数据库")}
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
