import { useCallback, useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"

import { Panel, SectionHeading, StatTile } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { EmptyHint, LoadingHint, usePagedList } from "@/components/commands/command-shared"
import { CategoryTree } from "@/components/market/category-tree"
import { ItemDetail } from "@/components/market/item-detail"
import { ItemList, PAGE_SIZE } from "@/components/market/item-list"
import { TradesPanel } from "@/components/market/trades-panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useMarket } from "@/hooks/use-market"
import { useManualData } from "@/hooks/use-manual-data"
import { filterTypeRows, marketTiles, sortTypeRows, type MarketSortKey } from "@/lib/market-logic"

/**
 * 物品 / 市场浏览器。
 *
 * 数据全部来自服务端那份**活的市场库**（market.sqlite）：库存与最优买卖价由
 * market-cli.js 只读直查，游戏里成交一笔、刷新一下数字就变；市场服务没启动也能读
 * （只读 + WAL，不跟服务端抢锁）。启动器里**不落任何随包快照** —— 那是 2026-10-02
 * 用户明确否掉的方案：静态清单看到的不是当下的库存和价格。
 *
 * 左栏分类树 / 中栏清单 / 右栏盘口，与数据库页同一种三栏骨架。
 */
export function MarketPage() {
  // 物品名 / 分类名是数据，不走翻译桥，得自己按当前语言取（见 namePair）
  const { locale } = useLocale()
  const store = useMarket()
  // 中文名与指令手册共用同一份 items.json（模块级缓存，切页不会重复解析）
  const { rows: items } = useManualData("items")
  const cnNames = useMemo(
    () => new Map(items.map((row) => [row.typeID, row.nameCn] as const)),
    [items]
  )

  const [nodeId, setNodeId] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [sortKey, setSortKey] = useState<MarketSortKey>("name")
  const [sortDesc, setSortDesc] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)

  const filtered = useMemo(() => {
    const hit = filterTypeRows(store.catalog, { nodeId, query, cnNames })
    return sortTypeRows(store.catalog, hit, sortKey, sortDesc, cnNames, locale)
  }, [store.catalog, nodeId, query, cnNames, sortKey, sortDesc, locale])

  const paged = usePagedList(
    filtered,
    PAGE_SIZE,
    `${nodeId ?? "all"}|${query}|${sortKey}|${sortDesc}`
  )

  const pick = useCallback(
    (typeId: number) => {
      setSelected(typeId)
      void store.selectType(typeId)
    },
    [store]
  )

  const clearPick = useCallback(() => {
    setSelected(null)
    void store.selectType(null)
  }, [store])

  /** 换排序键时同一键再点一次就是反向；换键则回到该键更合理的默认方向 */
  const applySort = useCallback(
    (key: MarketSortKey) => {
      if (key === sortKey) {
        setSortDesc((prev) => !prev)
        return
      }
      setSortKey(key)
      setSortDesc(key !== "name")
    },
    [sortKey]
  )

  const tiles = useMemo(() => marketTiles(store.overview), [store.overview])
  const unavailable = store.reason != null && !store.catalogLoaded

  return (
    <div className="space-y-4">
      <SectionHeading
        title="物品市场"
        sub="// ITEM & MARKET CATALOG"
        actions={
          <div className="flex items-center gap-2">
            <span className="tabular hidden max-w-[420px] truncate text-[11px] text-muted-foreground sm:inline">
              {store.overview?.path ?? (store.loading ? "正在读取市场库…" : "—")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2 text-[11px]"
              onClick={() => void store.refresh()}
              disabled={store.loading}
            >
              <RefreshCw className={store.loading ? "size-3 animate-spin" : "size-3"} />
              刷新
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <StatTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            delta={tile.delta}
            tone={tile.tone}
          />
        ))}
      </div>

      <Panel
        flush
        tag="// MARKET"
        title="物品 / 市场浏览器"
        meta={
          store.catalogLoaded
            ? `${store.catalog.region.name || "?"} · ${store.catalog.stations.length} 站`
            : undefined
        }
        className="min-h-[560px]"
        bodyClassName="flex min-h-0"
      >
        {unavailable ? (
          <div className="flex w-full flex-1 items-center justify-center p-6">
            <div className="max-w-md space-y-2 text-center">
              <p className="text-[13px] text-foreground">读不到市场库</p>
              <p data-i18n-skip className="text-[11px] leading-relaxed text-tertiary">
                {store.reason}
              </p>
              <p className="text-[11px] text-tertiary">
                市场库由服务端的市场服务在建种子时生成；先启动一次市场服务，再回来刷新。
              </p>
            </div>
          </div>
        ) : store.loading && !store.catalogLoaded ? (
          <div className="w-full flex-1 p-4">
            <LoadingHint label="市场清单" />
          </div>
        ) : (
          <div className="grid min-h-0 w-full flex-1 grid-rows-[auto_minmax(280px,1fr)] lg:grid-rows-1 lg:grid-cols-[220px_1fr_340px]">
            <CategoryTree
              catalog={store.catalog}
              activeId={nodeId}
              onSelect={(id) => {
                setNodeId(id)
                paged.setPage(0)
              }}
              locale={locale}
              className="border-b border-input lg:border-b-0 lg:border-r"
            />
            <ItemList
              catalog={store.catalog}
              rows={paged.rows}
              page={paged.page}
              pageCount={paged.pageCount}
              onPage={paged.setPage}
              activeTypeId={selected}
              onSelect={pick}
              cnNames={cnNames}
              locale={locale}
              query={query}
              onQuery={(value) => {
                setQuery(value)
                paged.setPage(0)
              }}
              sortKey={sortKey}
              sortDesc={sortDesc}
              onSort={applySort}
              loading={false}
              failed={false}
              className="min-w-0 border-b border-input lg:border-b-0 lg:border-r"
            />
            <div className="flex min-h-0 flex-col">
              {selected == null ? (
                <TradesPanel
                  trades={store.trades}
                  loading={store.tradesLoading}
                  cnNames={cnNames}
                  locale={locale}
                  onPick={pick}
                  onRefresh={() => void store.refreshTrades()}
                />
              ) : (
                <>
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-input px-3 py-1.5">
                    <span className="panel-label">盘口明细</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={clearPick}
                    >
                      最近成交
                    </Button>
                  </div>
                  <ItemDetail
                    book={store.book}
                    loading={store.bookLoading}
                    cnName={selected == null ? "" : cnNames.get(selected) ?? ""}
                    catalog={store.catalog}
                    stationName={store.catalog.stationName}
                    locale={locale}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </Panel>

      {store.catalogLoaded && filtered.length === 0 ? (
        <EmptyHint text="当前分类与关键词下没有物品，换个筛选条件试试" />
      ) : null}
    </div>
  )
}
