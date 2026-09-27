import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { useManualData } from "@/hooks/use-manual-data"
import { MANUAL_META } from "@/lib/manual-data"
import {
  buildIdPair,
  buildItemCommand,
  countBy,
  displayName,
  filterItems,
  keysByCount,
} from "@/lib/manual-logic"
import {
  CategoryChips,
  CopyButton,
  EmptyHint,
  LoadingHint,
  NumberStepper,
  Pagination,
  RefCard,
  RefCardFoot,
  ResultCount,
  SearchInput,
  usePagedList,
} from "@/components/commands/command-shared"

const PAGE_SIZE = 24

/** 物品 ID 查询：26896 条物品，按分类与关键词筛选后可直接生成刷取指令 */
export function ItemPanel() {
  const { rows, loading, failed } = useManualData("items")
  const [query, setQuery] = useState("")
  const [cat, setCat] = useState("all")
  const [qty, setQty] = useState(100)

  const catCounts = useMemo(() => countBy(rows, (it) => it.cat), [rows])
  const catOptions = useMemo(
    () =>
      keysByCount(catCounts).map((key) => ({
        key,
        label: key,
        count: catCounts[key],
      })),
    [catCounts]
  )

  const filtered = useMemo(() => filterItems(rows, cat, query), [rows, cat, query])

  const { page, pageCount, rows: pageRows, setPage } = usePagedList(
    filtered,
    PAGE_SIZE,
    `${cat}|${query}`
  )

  if (loading || failed) {
    return <LoadingHint failed={failed} label="物品表" />
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_140px] lg:items-end">
        <div className="space-y-1.5">
          <span className="panel-label">搜索</span>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="中文名 / 英文名 / typeID / 分组"
          />
        </div>
        <div className="space-y-1.5">
          <span className="panel-label">数量</span>
          <NumberStepper id="item-qty" value={qty} onChange={setQty} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="panel-label shrink-0">分类</span>
        <CategoryChips
          options={catOptions}
          value={cat}
          onChange={setCat}
          allLabel="全部分类"
          allCount={MANUAL_META.items}
          className="min-w-0 flex-1"
        />
        <ResultCount shown={filtered.length} total={MANUAL_META.items} unit="件物品" />
      </div>

      {pageRows.length === 0 ? (
        <EmptyHint text="没有匹配的物品" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pageRows.map((it) => (
            <RefCard key={it.typeID}>
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {displayName(it.nameCn, it.nameEn)}
                </span>
                <Badge variant="secondary">{it.cat}</Badge>
              </div>
              <div className="tabular mt-0.5 truncate text-[11px] text-muted-foreground">
                {it.nameEn || "—"}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="tabular text-[11px] text-telemetry">{it.typeID}</span>
                <span className="truncate text-[11px] text-tertiary">{it.group}</span>
              </div>
              <RefCardFoot>
                <CopyButton
                  text={buildIdPair(it)}
                  label="ID=名称"
                  message="typeID=名称 已复制"
                  className="h-6 px-1.5 text-[11px]"
                />
                <CopyButton
                  text={buildItemCommand(it.nameEn, qty)}
                  label="刷取"
                  message={`已复制 · ${it.nameEn} × ${qty}`}
                  className="h-6 px-1.5 text-[11px]"
                />
              </RefCardFoot>
            </RefCard>
          ))}
        </div>
      )}

      <Pagination
        page={page}
        pageCount={pageCount}
        total={filtered.length}
        onPage={setPage}
        unit="件物品"
      />
    </div>
  )
}
