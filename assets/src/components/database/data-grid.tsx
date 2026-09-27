import { useEffect, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DbValueText } from "@/components/database/value-text"
import type { DbTableModel } from "@/components/database/db-model"

const PAGE_SIZES = ["25", "50", "100"]

/** 中栏「数据」页签：筛选 + 分页 + 可点选的数据表 */
export function DataGrid({
  table,
  selectedKey,
  onSelect,
}: {
  table: DbTableModel
  selectedKey: string | null
  onSelect: (key: string | null) => void
}) {
  const [filter, setFilter] = useState("")
  const [pageSize, setPageSize] = useState("50")
  const [page, setPage] = useState(1)

  useEffect(() => {
    setPage(1)
  }, [table.name, filter, pageSize])

  const size = Number(pageSize)

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return table.data
    return table.data.filter((row) =>
      table.columns.some((column) =>
        String(row.values[column.name] ?? "")
          .toLowerCase()
          .includes(q)
      )
    )
  }, [table, filter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(page, pageCount)
  const rows = filtered.slice((current - 1) * size, current * size)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-input px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选当前页数据…"
          className="h-8 max-w-[240px] text-[12px]"
          aria-label="筛选当前页数据"
        />

        <Select value={pageSize} onValueChange={setPageSize}>
          <SelectTrigger className="h-8 w-[112px] text-[12px]" aria-label="每页行数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((v) => (
              <SelectItem key={v} value={v}>
                {v} 行 / 页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="min-w-2 flex-1" />

        <span className="tabular text-[11px] text-muted-foreground">
          第 {current} / {pageCount} 页
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={current <= 1}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={current >= pageCount}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {table.columns.map((column) => (
                <TableHead key={column.name} className="sticky top-0 z-10 bg-card">
                  <div className="tabular inline-flex items-center gap-1.5 text-foreground/70">
                    {column.name}
                    {column.pk ? <Badge variant="telemetry">PK</Badge> : null}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={Math.max(1, table.columns.length)}
                  className="py-8 text-center text-[12px] text-tertiary"
                >
                  没有匹配的行
                </TableCell>
              </TableRow>
            ) : null}

            {rows.map((row) => {
              const selected = row.key === selectedKey
              return (
                <TableRow
                  key={row.key}
                  data-state={selected ? "selected" : undefined}
                  onClick={() => onSelect(selected ? null : row.key)}
                  className={selected ? "cursor-pointer bg-primary/10" : "cursor-pointer"}
                >
                  {table.columns.map((column) => (
                    <TableCell key={column.name} className="whitespace-nowrap py-1.5">
                      <DbValueText value={row.values[column.name]} />
                    </TableCell>
                  ))}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="tabular shrink-0 border-t border-input px-3 py-1.5 text-[11px] text-tertiary">
        已加载 {filtered.length.toLocaleString("en-US")} 行 · 表内共{" "}
        {table.rows.toLocaleString("en-US")} 行
      </div>
    </div>
  )
}
