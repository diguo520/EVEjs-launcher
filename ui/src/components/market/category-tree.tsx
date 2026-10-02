import { useMemo, useState } from "react"
import { ChevronRight, Layers } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { namePair, nodePath, type MarketCatalog, type MarketNode } from "@/lib/market-logic"
import type { LocaleCode } from "@/lib/i18n"

/** 搜索时最多铺多少条命中：分组有 2,043 个，全铺出来比树还长 */
const SEARCH_LIMIT = 60

/**
 * 左栏：市场分类树。
 *
 * 树一共 2,043 个节点，**只渲染展开的那几层**（折叠的子树根本不进 DOM），
 * 否则光这一栏就够卡一下。搜索时换成平铺命中结果并带上面包屑 —— 让用户
 * 自己一层层点开去找一个只知道名字的分组是不现实的。
 */
export function CategoryTree({
  catalog,
  activeId,
  onSelect,
  locale,
  className,
}: {
  catalog: MarketCatalog
  activeId: number | null
  onSelect: (id: number | null) => void
  locale: LocaleCode
  className?: string
}) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out: MarketNode[] = []
    for (const node of catalog.nodeById.values()) {
      if (node.count === 0) continue
      if (node.nameZh.toLowerCase().includes(q) || node.nameEn.toLowerCase().includes(q)) {
        out.push(node)
        if (out.length >= SEARCH_LIMIT) break
      }
    }
    return out.sort((a, b) => b.count - a.count)
  }, [catalog, query])

  /** 展开状态下要渲染的行：深度优先，折叠的分支不进列表 */
  const rows = useMemo(() => {
    const out: { node: MarketNode; depth: number }[] = []
    const walk = (nodes: MarketNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth })
        if (expanded.has(node.id)) walk(node.children, depth + 1)
      }
    }
    walk(catalog.roots, 0)
    return out
  }, [catalog, expanded])

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="panel-label">{catalog.sde ? "市场分类" : "分类不可用"}</span>
        <Badge variant="secondary" className="tabular">
          {catalog.nodeById.size}
        </Badge>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索分类…"
          className="h-8 text-[12px]"
          aria-label="搜索分类"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {hits ? (
          hits.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-tertiary">没有匹配的分类</p>
          ) : (
            hits.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect(node.id)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                  node.id === activeId && "bg-accent/60"
                )}
              >
                <span data-i18n-skip className="truncate text-[12px] text-foreground">
                  {namePair(node.nameZh, node.nameEn, locale).main}
                </span>
                <span data-i18n-skip className="truncate text-[10px] text-tertiary">
                  {nodePath(catalog, node.id)
                    .slice(0, -1)
                    .map((item) => namePair(item.nameZh, item.nameEn, locale).main)
                    .join(" / ")}
                </span>
              </button>
            ))
          )
        ) : (
          <>
            <TreeRow
              depth={0}
              label="全部物品"
              count={catalog.types.length}
              active={activeId === null}
              icon
              onClick={() => onSelect(null)}
            />
            {rows.map(({ node, depth }) => {
              const pair = namePair(node.nameZh, node.nameEn, locale)
              return (
              <TreeRow
                key={node.id}
                depth={depth}
                label={pair.main}
                labelEn={pair.sub}
                count={node.count}
                active={node.id === activeId}
                expandable={node.children.length > 0}
                expanded={expanded.has(node.id)}
                onToggle={() => toggle(node.id)}
                onClick={() => onSelect(node.id)}
              />
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

function TreeRow({
  depth,
  label,
  labelEn,
  count,
  active,
  expandable = false,
  expanded = false,
  icon = false,
  onToggle,
  onClick,
}: {
  depth: number
  label: string
  labelEn?: string
  count: number
  active: boolean
  expandable?: boolean
  expanded?: boolean
  icon?: boolean
  onToggle?: () => void
  onClick: () => void
}) {
  return (
    <div
      className={cn(
        "group relative flex w-full items-center gap-1 rounded-sm pr-2 transition-colors",
        active ? "bg-accent/60" : "hover:bg-accent/40"
      )}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "折叠" : "展开"}
          className="flex size-4 shrink-0 items-center justify-center text-tertiary hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}

      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        {icon ? <Layers className="size-3 shrink-0 text-tertiary" /> : null}
        <span className="min-w-0 flex-1">
          <span data-i18n-skip className="block truncate text-[12px] leading-tight">
            {label}
          </span>
          {labelEn ? (
            <span data-i18n-skip className="block truncate text-[9px] leading-tight text-tertiary">
              {labelEn}
            </span>
          ) : null}
        </span>
        <span className="tabular shrink-0 text-[10px] text-tertiary">{count}</span>
      </button>
    </div>
  )
}
