import { useMemo, useState } from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  CATEGORY_COUNTS,
  CATEGORY_NAMES,
} from "@/lib/manual-data"
import {
  REQUIRES_ORDER,
  countBy,
  filterCommandRows,
  groupByCategory,
  requiresBadge,
  requiresShort,
  type CommandRow,
} from "@/lib/manual-logic"
import {
  CategoryChips,
  CopyButton,
  EmptyHint,
  ResultCount,
  SearchInput,
} from "@/components/commands/command-shared"

const HEAD = [
  { key: "cmd", label: "指令", className: "w-[118px]" },
  { key: "alias", label: "别名", className: "w-[104px]" },
  { key: "desc", label: "说明", className: "min-w-[160px]" },
  { key: "params", label: "参数", className: "w-[196px]" },
  { key: "example", label: "示例", className: "w-[228px]" },
  { key: "requires", label: "条件", className: "w-[86px]" },
  { key: "note", label: "备注", className: "w-[196px]" },
  { key: "op", label: "", className: "w-[64px]" },
]

/** 指令全表：按分类分组，支持分类 / 使用条件 / 关键词三重筛选 */
export function CommandSections({
  rows,
  onDeleteCustom,
}: {
  rows: CommandRow[]
  onDeleteCustom: (cmd: string) => void
}) {
  const [cat, setCat] = useState("all")
  const [requires, setRequires] = useState("all")
  const [query, setQuery] = useState("")

  const catOptions = useMemo(
    () =>
      CATEGORY_NAMES.map((name) => ({
        key: name,
        label: name,
        count: CATEGORY_COUNTS[name] ?? 0,
      })),
    []
  )

  // 条件角标只统计当前分类下的条目，避免选了大类后角标和列表对不上
  const inCategory = useMemo(
    () => (cat === "all" ? rows : rows.filter((r) => r.cat === cat)),
    [rows, cat]
  )
  const requiresCounts = useMemo(() => countBy(inCategory, (r) => r.requires), [inCategory])
  const requiresOptions = useMemo(
    () =>
      REQUIRES_ORDER.filter((level) => (requiresCounts[level] ?? 0) > 0).map((level) => ({
        key: level,
        label: requiresShort(level),
        count: requiresCounts[level],
      })),
    [requiresCounts]
  )

  const filtered = useMemo(
    () => filterCommandRows(rows, { cat, requires, query }),
    [rows, cat, requires, query]
  )
  const groups = useMemo(() => groupByCategory(filtered), [filtered])

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <span className="panel-label">搜索</span>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="指令 / 别名 / 说明 / 参数 / 备注"
          />
        </div>
        <div className="flex items-center gap-3 lg:justify-end">
          <span className="tabular text-[11px] text-muted-foreground">
            共 {rows.length} 条指令 · {CATEGORY_NAMES.length} 个分类
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="panel-label shrink-0">分类</span>
          <CategoryChips
            options={catOptions}
            value={cat}
            onChange={setCat}
            allLabel="全部分类"
            allCount={rows.length}
            className="min-w-0 flex-1"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="panel-label shrink-0">条件</span>
          <CategoryChips
            options={requiresOptions}
            value={requires}
            onChange={setRequires}
            allLabel="不限"
            className="min-w-0 flex-1"
          />
          <ResultCount shown={filtered.length} total={rows.length} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyHint text="没有匹配的指令" />
      ) : (
        /* 表格自带滚动容器，把限高挂到它身上，表头才能 sticky 在滚动区内 */
        <div className="overflow-hidden rounded-md border border-input [&>div]:max-h-[560px]">
          <Table>
            <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
              <TableRow className="hover:bg-transparent">
                {HEAD.map((h) => (
                  <TableHead key={h.key} className={h.className}>
                    {h.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>

            {/* 每个分类一个 tbody：既省掉外层 Fragment，分组语义也更准 */}
            {groups.map((group) => (
              <TableBody key={group.category}>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={HEAD.length}
                    className="border-y border-input bg-secondary/40 py-1.5"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {group.category}
                    </span>
                    <span className="tabular ml-2 text-[10px] text-tertiary">
                      {group.rows.length} 条
                    </span>
                  </TableCell>
                </TableRow>

                {group.rows.map((r) => (
                  <TableRow key={r.uid ?? r.cmd} className="group">
                    <TableCell className="tabular text-[13px] font-semibold text-telemetry">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{r.cmd}</span>
                        {r.custom ? <Badge variant="outline">自定义</Badge> : null}
                      </span>
                    </TableCell>

                    <TableCell className="tabular text-[11px] text-muted-foreground">
                      {r.alias || "—"}
                    </TableCell>

                    <TableCell className="text-[13px]">{r.desc}</TableCell>

                    <TableCell className="tabular text-[11px] text-muted-foreground">
                      {r.params}
                    </TableCell>

                    <TableCell className="tabular text-[12px] text-primary/85">
                      {r.example}
                    </TableCell>

                    <TableCell>
                      <Badge variant={requiresBadge(r.requires)}>
                        {requiresShort(r.requires)}
                      </Badge>
                    </TableCell>

                    <TableCell
                      className={cn(
                        "text-[12px]",
                        r.note ? "text-muted-foreground" : "text-tertiary"
                      )}
                    >
                      {r.note || "—"}
                    </TableCell>

                    <TableCell className="p-1">
                      <div className="flex items-center gap-0.5">
                        <CopyButton
                          iconOnly
                          text={r.cmd}
                          label={`复制 ${r.cmd}`}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        />
                        {r.custom ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            title={`删除自定义指令 ${r.cmd}`}
                            onClick={() => onDeleteCustom(r.cmd)}
                            className="h-7 w-7 px-0 opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <X />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}
