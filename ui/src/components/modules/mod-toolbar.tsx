import { FolderOpen, Loader2, RefreshCw, Search, Upload, X } from "lucide-react"

import { t } from "@/lib/i18n"
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
  ALL_CATEGORY,
  MARKET_FILTER_LABEL,
  MARKET_FILTER_ORDER,
  MINE_FILTER_LABEL,
  MINE_FILTER_ORDER,
  MOD_CATEGORIES,
  MOD_SORT_LABEL,
  MOD_SORT_ORDER,
  RATING_FILTER_LABEL,
  RATING_FILTER_ORDER,
  type MarketFilter,
  type MineFilter,
  type ModSort,
  type RatingFilter,
} from "@/lib/mod-logic"
import { cn } from "@/lib/utils"

/** 工具条上的分段切换：市场筛选和待回复筛选共用同一套样式 */
function Segmented<T extends string>({
  order,
  labels,
  counts,
  value,
  onChange,
}: {
  order: T[]
  labels: Record<T, string>
  counts?: Record<T, number>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-input bg-background/40 p-0.5">
      {order.map((item) => {
        const active = item === value
        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] transition-colors",
              active
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {labels[item]}
            <span
              className={cn(
                "tabular text-[10px]",
                active ? "text-primary/80" : "text-tertiary"
              )}
            >
              {counts?.[item] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function ModToolbar({
  query,
  category,
  onQueryChange,
  onCategoryChange,
  marketFilter,
  onMarketFilterChange,
  marketCounts,
  mineFilter,
  onMineFilterChange,
  mineCounts,
  sort,
  onSortChange,
  rating,
  onRatingChange,
  tag,
  onTagChange,
  onRefresh,
  onOpenModsDir,
  onImportZip,
  importing,
}: {
  query: string
  category: string
  onQueryChange: (value: string) => void
  onCategoryChange: (value: string) => void
  /** 点卡片标签带过来的筛选，空表示不限 */
  tag?: string | null
  onTagChange?: (value: string | null) => void
  /** 仅模组市场页签展示 */
  marketFilter?: MarketFilter
  onMarketFilterChange?: (value: MarketFilter) => void
  marketCounts?: Record<MarketFilter, number>
  /** 仅「我创建的」页签展示 */
  mineFilter?: MineFilter
  onMineFilterChange?: (value: MineFilter) => void
  mineCounts?: Record<MineFilter, number>
  /** 仅模组市场页签展示 */
  sort?: ModSort
  onSortChange?: (value: ModSort) => void
  /** 仅模组市场页签展示 */
  rating?: RatingFilter
  onRatingChange?: (value: RatingFilter) => void
  onRefresh: () => void
  /** 打开服务端根目录下的 mods 目录（后端会先确保它存在） */
  onOpenModsDir?: () => void
  /** 弹系统「打开文件」选 ZIP 导入；成功与否都由页面处理提示 */
  onImportZip?: () => void
  /** 导入进行中：按钮转圈并禁用，避免连点弹两次系统对话框 */
  importing?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索模组名 / ID / 作者 / 标签"
          className="pl-8"
        />
      </div>

      {/* 筛选生效时这里挂一枚可点的标签，不然点完就不知道该从哪儿取消了 */}
      {tag ? (
        <button
          type="button"
          onClick={() => onTagChange?.(null)}
          title={t("取消「{tag}」标签筛选", { tag })}
          className={cn(
            "flex items-center gap-1 rounded-sm border border-primary/55 bg-primary/10 px-2 py-1 text-[11px] text-primary transition-colors",
            "hover:border-primary/80 hover:bg-primary/15 focus-visible:outline-none focus-visible:shadow-focus"
          )}
        >
          标签：{tag}
          <X className="size-3" />
        </button>
      ) : null}

      {mineFilter && onMineFilterChange ? (
        <Segmented
          order={MINE_FILTER_ORDER}
          labels={MINE_FILTER_LABEL}
          counts={mineCounts}
          value={mineFilter}
          onChange={onMineFilterChange}
        />
      ) : null}

      {marketFilter && onMarketFilterChange ? (
        <Segmented
          order={MARKET_FILTER_ORDER}
          labels={MARKET_FILTER_LABEL}
          counts={marketCounts}
          value={marketFilter}
          onChange={onMarketFilterChange}
        />
      ) : null}

      {rating && onRatingChange ? (
        <Select
          value={rating}
          onValueChange={(value) => onRatingChange(value as RatingFilter)}
        >
          <SelectTrigger className="w-[128px]" aria-label="评分筛选">
            <SelectValue placeholder={RATING_FILTER_LABEL.all} />
          </SelectTrigger>
          <SelectContent>
            {RATING_FILTER_ORDER.map((item) => (
              <SelectItem key={item} value={item}>
                {RATING_FILTER_LABEL[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {sort && onSortChange ? (
        <Select
          value={sort}
          onValueChange={(value) => onSortChange(value as ModSort)}
        >
          <SelectTrigger className="w-[124px]" aria-label="排序方式">
            <SelectValue placeholder={MOD_SORT_LABEL.default} />
          </SelectTrigger>
          <SelectContent>
            {MOD_SORT_ORDER.map((item) => (
              <SelectItem key={item} value={item}>
                {MOD_SORT_LABEL[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <Select value={category} onValueChange={onCategoryChange}>
        <SelectTrigger className="w-[136px]">
          <SelectValue placeholder="全部分类" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CATEGORY}>全部分类</SelectItem>
          {MOD_CATEGORIES.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="outline" onClick={() => onOpenModsDir?.()}>
        <FolderOpen />
        打开 mods 目录
      </Button>

      <Button
        variant="outline"
        disabled={importing}
        onClick={() => onImportZip?.()}
      >
        {importing ? <Loader2 className="animate-spin" /> : <Upload />}
        {importing ? "正在导入…" : "导入 ZIP"}
      </Button>

      <Button variant="outline" onClick={onRefresh}>
        <RefreshCw />
        刷新列表
      </Button>
    </div>
  )
}
