import { ArrowDown, ArrowUp, Package } from "lucide-react"

import { cn } from "@/lib/utils"
import { EmptyHint, LoadingHint, Pagination, SearchInput } from "@/components/commands/command-shared"
import { ItemTooltip } from "@/components/market/item-tooltip"
import type { RawMarketTypeInfo } from "@/lib/ipc"
import {
  formatIsk,
  formatQty,
  namePair,
  type MarketCatalog,
  type MarketSortKey,
} from "@/lib/market-logic"
import type { LocaleCode } from "@/lib/i18n"

/** 列表一页多少行：够密（一屏能扫）又够轻（DOM 只多 60 行） */
export const PAGE_SIZE = 60

interface RowView {
  index: number
  typeId: number
  /** 正行：按界面语言取的名字 */
  main: string
  /** 副行：另一个语言的名字（同名或没有时为空） */
  sub: string
  ask: number
  askQty: number
  bid: number
}

/** 物品组名（如「拦截舰」）：悬停卡缩略图的悬停说明用；中文界面取中文，其余取 SDE 英文名 */
function groupName(catalog: MarketCatalog, index: number, locale: string): string {
  const group = catalog.groups.get(catalog.types.groupId[index])
  return (locale === "zh" ? group?.zh : group?.en) || ""
}

/** 只把当前这一页的行折成对象：19k 行全折出来要多占好几倍内存 */
export function rowView(
  catalog: MarketCatalog,
  index: number,
  cnNames: Map<number, string> | null,
  locale: string
): RowView {
  const table = catalog.types
  const typeId = table.typeId[index]
  const pair = namePair(cnNames?.get(typeId), table.name[index], locale)
  return {
    index,
    typeId,
    main: pair.main,
    sub: pair.sub,
    ask: table.bestAsk[index],
    askQty: table.askQty[index],
    bid: table.bestBid[index],
  }
}

const SORTS: { key: MarketSortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "ask", label: "卖价" },
  { key: "qty", label: "库存" },
]

/**
 * 中栏：物品清单。
 *
 * 筛选与排序在前端做（19k 行进一次全表扫是毫秒级），所以每次按键都即时，
 * 不需要往回发请求 —— 这也是「打开页面拉一次全量」换来的好处。
 */
export function ItemList({
  catalog,
  rows,
  page,
  pageCount,
  onPage,
  activeTypeId,
  onSelect,
  cnNames,
  locale,
  query,
  onQuery,
  sortKey,
  sortDesc,
  onSort,
  loadTypeInfo,
  loading,
  failed,
  className,
}: {
  catalog: MarketCatalog
  rows: number[]
  page: number
  pageCount: number
  onPage: (page: number) => void
  activeTypeId: number | null
  onSelect: (typeId: number) => void
  cnNames: Map<number, string> | null
  locale: LocaleCode
  query: string
  onQuery: (value: string) => void
  sortKey: MarketSortKey
  sortDesc: boolean
  onSort: (key: MarketSortKey) => void
  /** 悬停卡用：取简介与属性（同语言的重复调用由 use-market 的缓存挡掉） */
  loadTypeInfo: (typeId: number) => Promise<RawMarketTypeInfo | null>
  loading: boolean
  failed: boolean
  className?: string
}) {
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <SearchInput
            value={query}
            onChange={onQuery}
            placeholder="搜索中文名 / 英文名 / typeID…"
            className="min-w-0 flex-1"
          />
          <div className="flex shrink-0 items-center gap-1">
            {SORTS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onSort(item.key)}
                className={cn(
                  "flex h-8 items-center gap-1 rounded-sm border px-2 text-[11px] transition-colors",
                  item.key === sortKey
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-input text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
                {item.key === sortKey ? (
                  sortDesc ? (
                    <ArrowDown className="size-3" />
                  ) : (
                    <ArrowUp className="size-3" />
                  )
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="panel-label">{catalog.region.name || "市场"}</span>
          <span className="tabular text-[11px] text-muted-foreground">
            {rows.length.toLocaleString("en-US")} 项
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-y border-input bg-muted/20 px-3 py-1 text-[10px] uppercase tracking-[0.08em] text-tertiary">
        <span className="min-w-0 flex-1">物品</span>
        <span className="w-24 shrink-0 text-right">最优卖价</span>
        <span className="w-20 shrink-0 text-right">库存</span>
        <span className="w-24 shrink-0 text-right">最优买价</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3">
            <LoadingHint label="市场清单" />
          </div>
        ) : failed ? (
          <div className="p-3">
            <LoadingHint failed label="市场清单" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-3">
            <EmptyHint text="没有匹配的物品" />
          </div>
        ) : (
          rows.map((index) => {
            const row = rowView(catalog, index, cnNames, locale)
            const active = row.typeId === activeTypeId
            return (
              <ItemTooltip
                key={row.typeId}
                typeId={row.typeId}
                name={row.main}
                sub={row.sub}
                price={formatIsk(row.ask)}
                volume={catalog.types.volume[index]}
                catId={catalog.types.catId[index]}
                group={groupName(catalog, index, locale)}
                load={loadTypeInfo}
              >
                <button
                  type="button"
                  onClick={() => onSelect(row.typeId)}
                  className={cn(
                    "flex w-full items-center gap-2 border-b border-input/40 px-3 py-1.5 text-left transition-colors",
                    active ? "bg-accent/60" : "hover:bg-accent/40"
                  )}
                >
                  <Package className="size-3.5 shrink-0 text-tertiary" />
                  <span className="min-w-0 flex-1">
                    <span data-i18n-skip className="block truncate text-[12px] leading-tight text-foreground">
                      {row.main}
                    </span>
                    <span data-i18n-skip className="block truncate text-[10px] leading-tight text-tertiary">
                      {row.sub ? `${row.typeId} · ${row.sub}` : row.typeId}
                    </span>
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-[11px] text-success">
                    {formatIsk(row.ask)}
                  </span>
                  <span className="tabular w-20 shrink-0 text-right text-[11px] text-muted-foreground">
                    {formatQty(row.askQty)}
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-[11px] text-destructive">
                    {formatIsk(row.bid)}
                  </span>
                </button>
              </ItemTooltip>
            )
          })
        )}
      </div>

      <div className="shrink-0 border-t border-input px-3 py-2">
        <Pagination page={page} pageCount={pageCount} total={rows.length} onPage={onPage} unit="项" />
      </div>
    </div>
  )
}
