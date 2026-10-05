import { useMemo, useState, type ReactNode } from "react"
import { Activity, BookOpen, Gauge, Pencil, Store, TrendingUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CopyButton, EmptyHint, LoadingHint } from "@/components/commands/command-shared"
import { StockEditDialog } from "@/components/market/stock-edit-dialog"
import { AttributeEditDialog } from "@/components/market/attribute-edit-dialog"
import { DescriptionDialog } from "@/components/market/description-dialog"
import { TypeInfoPanel } from "@/components/market/item-tooltip"
import { useLocale } from "@/components/shell/locale-provider"
import type {
  RawMarketAdjust,
  RawMarketAdjustInput,
  RawMarketAttrsInput,
  RawMarketBook,
  RawMarketHistoryPoint,
  RawMarketSetAttrs,
  RawMarketStockRow,
  RawMarketTypeInfo,
} from "@/lib/ipc"
import {
  formatDay,
  formatIsk,
  formatQty,
  formatStamp,
  historyChart,
  namePair,
  sortStockByPrice,
  touchedStockRows,
  type MarketCatalog,
} from "@/lib/market-logic"
import type { LocaleCode } from "@/lib/i18n"
import { buildItemCommand } from "@/lib/manual-logic"

/** 价格图逻辑尺寸；渲染时按容器宽度缩（viewBox + w-full） */
const CHART_W = 320
const CHART_H = 72

/**
 * 右栏：选中物品的盘口明细。
 *
 * 三块数据只在点开某个物品时才拉（market:book）—— 23 个空间站的库存 + 30 天价格史
 * + 成交回执，一起塞进全量清单里会让每次开页面都多传好几 MB。
 */
export function ItemDetail({
  book,
  loading,
  cnName,
  catalog,
  stationName,
  locale,
  className,
  onAdjust,
  onSaveAttrs,
  info,
  infoLoading,
}: {
  book: RawMarketBook | null
  loading: boolean
  cnName: string
  /** 分类 / 组合的中英文名不在盘口回包里，只能回全量清单里查 */
  catalog: MarketCatalog
  stationName: Map<number, string>
  locale: LocaleCode
  className?: string
  /** 改某站某物品的种子库存价格 / 数量（一次一个站，见 market.rs 的 adjust_seed_stock） */
  onAdjust: (input: RawMarketAdjustInput) => Promise<RawMarketAdjust | null>
  /** 改这个物品的 dogma 属性（见 market.rs 的 set_type_attributes） */
  onSaveAttrs: (input: RawMarketAttrsInput) => Promise<RawMarketSetAttrs | null>
  /** 简介与属性（market:typeInfo）：点开物品时由 market-page 拉一次，和盘口并行 */
  info: RawMarketTypeInfo | null
  infoLoading: boolean
}) {
  const history = useMemo(() => book?.history ?? [], [book])
  const stock = useMemo(() => sortStockByPrice(book?.stock ?? []), [book])
  const touched = useMemo(() => touchedStockRows(stock), [stock])
  const chart = useMemo(() => historyChart(history, CHART_W, CHART_H), [history])
  const fills = book?.fills ?? []
  // 正在改哪一行；null = 没开弹窗。放在早退之前：hooks 不能排在条件分支后面
  const [editing, setEditing] = useState<RawMarketStockRow | null>(null)
  // 属性编辑弹窗开着没有；同样要在早退之前声明
  const [editingAttrs, setEditingAttrs] = useState(false)
  // 物品简介弹窗：简介从页签里挪到了标题栏那个书页图标上
  const [showDescription, setShowDescription] = useState(false)
  const { t } = useLocale()

  if (loading && !book) {
    return (
      <div className={cn("p-3", className)}>
        <LoadingHint label="盘口" />
      </div>
    )
  }
  if (!book?.ok || !book.type) {
    return (
      <div className={cn("p-3", className)}>
        <EmptyHint text={book?.reason || "选中左侧物品查看盘口明细"} />
      </div>
    )
  }

  const type = book.type
  const summary = book.summary ?? null
  const stallName = (id: number) => stationName.get(id) ?? `#${id}`
  const pair = namePair(cnName, type.name, locale)
  // 组合 / 分类名跟物品名同一条规矩：中文界面取中文，其它语言取 SDE 英文名
  const group = catalog.groups.get(type.groupId)
  const category = catalog.categories.get(type.catId)
  const groupName = locale === "zh" ? group?.zh || type.groupName : group?.en || type.groupName
  const categoryName = (locale === "zh" ? category?.zh : category?.en) ?? ""
  // 简介与「有没有属性」都来自 typeInfo（点开物品时才拉一次），没到之前图标是禁用态
  const description = info?.ok === true ? (info.description ?? "").trim() : ""
  const hasAttrs = info?.ok === true && (info.attributes?.length ?? 0) > 0

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="shrink-0 border-b border-input px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div data-i18n-skip className="truncate text-[13px] font-semibold text-foreground">
              {pair.main}
            </div>
            <div data-i18n-skip className="truncate text-[10px] text-tertiary">
              {pair.sub ? `${type.typeId} · ${pair.sub}` : type.typeId}
            </div>
          </div>
          {/* 图标条：物品简介 / 改属性 / 复制刷取指令 —— 三个都是纯图标，跟游戏标题栏那排一样 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-tertiary hover:text-foreground"
              title={t("物品简介")}
              disabled={!description}
              onClick={() => setShowDescription(true)}
            >
              <BookOpen />
            </Button>
            {hasAttrs ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="text-tertiary hover:text-foreground"
                title={t("编辑属性")}
                onClick={() => setEditingAttrs(true)}
              >
                <Pencil />
              </Button>
            ) : null}
            <CopyButton
              iconOnly
              label="复制刷取指令"
              message="指令已复制"
              text={buildItemCommand(type.name, 100)}
              className="shrink-0"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge variant="secondary" className="tabular">
            {groupName}
          </Badge>
          {categoryName ? (
            <Badge variant="outline" className="tabular">
              {categoryName}
            </Badge>
          ) : null}
          <Badge variant="outline" className="tabular">
            体积 {type.volume}
          </Badge>
          <Badge variant="outline" className="tabular">
            单次 {type.portionSize}
          </Badge>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 px-3 py-2.5">
        <MiniStat
          icon={<TrendingUp className="size-3" />}
          label="最优卖价"
          value={formatIsk(summary?.bestAsk ?? 0)}
          hint={summary ? stallName(summary.askStation) : "无卖单"}
          tone="success"
        />
        <MiniStat
          icon={<Gauge className="size-3" />}
          label="最优买价"
          value={formatIsk(summary?.bestBid ?? 0)}
          hint={summary ? stallName(summary.bidStation) : "无买单"}
          tone="destructive"
        />
        <MiniStat
          icon={<Store className="size-3" />}
          label="全站库存"
          value={formatQty(summary?.askQty ?? 0)}
          hint={`${stock.length} 个空间站`}
          tone="foreground"
        />
        <MiniStat
          icon={<Activity className="size-3" />}
          label="被买过"
          value={`${touched.length} / ${stock.length}`}
          hint={summary ? formatStamp(summary.updatedAt) : "—"}
          tone="telemetry"
        />
      </div>

      <Tabs defaultValue="stock" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-3">
          <TabsTrigger value="stock">库存分布</TabsTrigger>
          <TabsTrigger value="history">价格史</TabsTrigger>
          <TabsTrigger value="fills">成交回执</TabsTrigger>
          <TabsTrigger value="info">属性</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <StockTable rows={stock} onEdit={setEditing} />
        </TabsContent>

        <TabsContent value="info" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          {/* key 带上物品 id：换物品时把折叠状态收回来 */}
          <TypeInfoPanel key={info?.typeId ?? 0} info={info} loading={infoLoading} />
        </TabsContent>

        <TabsContent value="history" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
          {history.length === 0 ? (
            <EmptyHint text="这个物品没有价格历史" />
          ) : (
            <div className="space-y-2">
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-20 w-full">
                <path d={chart.area} className="fill-primary/10" />
                <path d={chart.path} className="fill-none stroke-primary" strokeWidth="1.5" />
              </svg>
              <div className="flex justify-between text-[10px] text-tertiary">
                <span className="tabular">{formatDay(history[0].day)}</span>
                <span className="tabular">{formatDay(history[history.length - 1].day)}</span>
              </div>
              <HistoryStats history={history} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="fills" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          {fills.length === 0 ? (
            <div className="p-3">
              <EmptyHint text="这个物品还没有成交记录" />
            </div>
          ) : (
            <div className="divide-y divide-input/40">
              {fills.map((fill, index) => (
                <div
                  key={`${fill.at}-${index}`}
                  className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
                >
                  <span data-i18n-skip className="tabular min-w-0 flex-1 truncate text-tertiary">
                    {formatStamp(fill.at)}
                  </span>
                  <span className="tabular shrink-0 text-foreground">{formatIsk(fill.price)}</span>
                  <span className="tabular w-16 shrink-0 text-right text-muted-foreground">
                    ×{formatQty(fill.quantity)}
                  </span>
                  <Badge variant={fill.bid ? "secondary" : "outline"} className="shrink-0">
                    {fill.bid ? "买单" : "卖单"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {editing ? (
        <StockEditDialog
          row={editing}
          typeId={type.typeId}
          typeName={pair.main}
          onClose={() => setEditing(null)}
          onSubmit={onAdjust}
        />
      ) : null}

      {editingAttrs && info?.ok === true ? (
        <AttributeEditDialog
          typeId={type.typeId}
          typeName={pair.main}
          info={info}
          onClose={() => setEditingAttrs(false)}
          onSubmit={onSaveAttrs}
        />
      ) : null}

      {showDescription && description ? (
        <DescriptionDialog
          typeName={pair.main}
          text={description}
          onClose={() => setShowDescription(false)}
        />
      ) : null}
    </div>
  )
}

function MiniStat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode
  label: string
  value: string
  hint: string
  tone: "success" | "destructive" | "foreground" | "telemetry"
}) {
  const toneClass = {
    success: "text-success",
    destructive: "text-destructive",
    foreground: "text-foreground",
    telemetry: "text-telemetry",
  }[tone]
  return (
    <div className="rounded-md border border-input bg-background/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-tertiary">
        {icon}
        <span className="panel-label">{label}</span>
      </div>
      <div className={cn("tabular mt-1 truncate text-[15px] font-semibold", toneClass)}>{value}</div>
      <div data-i18n-skip className="truncate text-[10px] text-tertiary">
        {hint}
      </div>
    </div>
  )
}

function StockTable({
  rows,
  onEdit,
}: {
  rows: RawMarketStockRow[]
  onEdit: (row: RawMarketStockRow) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="p-3">
        <EmptyHint text="这个物品在任何空间站都没有库存" />
      </div>
    )
  }
  return (
    <div className="divide-y divide-input/40">
      {rows.map((row) => {
        const sold = row.quantity < row.initialQuantity
        return (
          <div key={row.stationId} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span data-i18n-skip className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                {row.stationName}
              </span>
              <span className="tabular shrink-0 text-[11px] text-success">
                {formatIsk(row.price)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="size-5 shrink-0 p-0 text-tertiary hover:text-foreground"
                title="改价 / 改量"
                onClick={() => onEdit(row)}
              >
                <Pencil className="size-3" />
              </Button>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-tertiary">
              <span data-i18n-skip className="min-w-0 flex-1 truncate">{row.systemName}</span>
              <span className="tabular shrink-0">库存 {formatQty(row.quantity)}</span>
              <span
                className={cn("tabular shrink-0", sold ? "text-warning" : "text-tertiary")}
                title={sold ? `种子 ${formatQty(row.initialQuantity)}` : "未被买过"}
              >
                {sold ? `-${formatQty(row.initialQuantity - row.quantity)}` : "—"}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HistoryStats({ history }: { history: RawMarketHistoryPoint[] }) {
  const prices = history.map((point) => point.avg)
  const volumes = history.reduce((sum, point) => sum + point.volume, 0)
  const low = Math.min(...prices)
  const high = Math.max(...prices)
  const avg = prices.reduce((sum, value) => sum + value, 0) / prices.length
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
      <Stat label="30 天最低" value={formatIsk(low)} />
      <Stat label="30 天最高" value={formatIsk(high)} />
      <Stat label="均价" value={formatIsk(avg)} />
      <Stat label="累计成交量" value={formatQty(volumes)} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-input/40 pb-1">
      <span className="text-tertiary">{label}</span>
      <span className="tabular text-foreground">{value}</span>
    </div>
  )
}
