import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import type { DbTableModel } from "@/components/database/db-model"

/** 左栏：数据表清单 + 表名搜索 */
export function TableList({
  tables,
  activeName,
  onSelect,
  className,
}: {
  tables: DbTableModel[]
  activeName: string
  onSelect: (name: string) => void
  className?: string
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tables
    return tables.filter((t) => t.name.toLowerCase().includes(q))
  }, [tables, query])

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="panel-label">数据表</span>
        <Badge variant="secondary" className="tabular">
          {tables.length}
        </Badge>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索表名…"
          className="h-8 text-[12px]"
          aria-label="搜索表名"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-tertiary">没有匹配的数据表</p>
        ) : null}

        {filtered.map((table) => {
          const active = table.name === activeName
          return (
            <button
              key={table.name}
              type="button"
              onClick={() => onSelect(table.name)}
              className={cn(
                "relative flex w-full items-center justify-between gap-2 rounded-sm py-1.5 pl-3 pr-2 text-left transition-colors",
                active
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-secondary"
              )}
            >
              {active ? (
                <span className="absolute inset-y-1 left-0 w-0.5 rounded-sm bg-primary" />
              ) : null}
              <span className="tabular truncate text-[13px]">{table.name}</span>
              <span className="tabular shrink-0 text-[10px] text-tertiary">
                {table.rows.toLocaleString("en-US")}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
