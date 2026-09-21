/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/ui/panel"
import { Select } from "@/components/ui/select"
import { MOD_CATEGORY_OPTIONS } from "./ModToolbar"

export type MarketSort = "hot" | "rating" | "recent" | "size"

export const MARKET_SORT_OPTIONS = [
  { value: "hot", label: "按热度" },
  { value: "rating", label: "按评分" },
  { value: "recent", label: "按更新时间" },
  { value: "size", label: "按体积" },
]

export interface MarketFilters {
  query: string
  category: string
  sort: MarketSort
  /** 只看还没装的，装完一批之后用来接着逛。 */
  onlyAvailable: boolean
}

export interface MarketToolbarProps {
  filters: MarketFilters
  onFiltersChange: (patch: Partial<MarketFilters>) => void
  resultCount: number
  totalCount: number
  /** 当前筛选结果里可安装 / 可更新的条目数。 */
  actionableCount: number
}

export function MarketToolbar({
  filters,
  onFiltersChange,
  resultCount,
  totalCount,
  actionableCount,
}: MarketToolbarProps) {
  const dirty =
    filters.query !== "" ||
    filters.category !== "ALL" ||
    filters.sort !== "hot" ||
    filters.onlyAvailable

  return (
    <Panel className="flex flex-wrap items-center gap-2 p-3">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={filters.query}
          onChange={(e) => onFiltersChange({ query: e.target.value })}
          placeholder="搜索模组名、作者、标签或描述 …"
          className="pl-8"
        />
      </div>

      <Select
        value={filters.category}
        onValueChange={(v) => onFiltersChange({ category: v })}
        className="w-[124px]"
        options={MOD_CATEGORY_OPTIONS}
      />

      <Select
        value={filters.sort}
        onValueChange={(v) => onFiltersChange({ sort: v as MarketSort })}
        className="w-[124px]"
        options={MARKET_SORT_OPTIONS}
      />

      <label className="flex cursor-pointer select-none items-center gap-1.5 px-1">
        <Checkbox
          checked={filters.onlyAvailable}
          onCheckedChange={(checked) => onFiltersChange({ onlyAvailable: checked })}
          aria-label="只看未安装"
        />
        <span className="text-xs text-muted-foreground">只看未安装</span>
      </label>

      {dirty ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onFiltersChange({ query: "", category: "ALL", sort: "hot", onlyAvailable: false })
          }
        >
          <X className="h-3.5 w-3.5" />
          清除
        </Button>
      ) : null}

      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {resultCount} / {totalCount}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground/60">
        可操作 {actionableCount}
      </span>
    </Panel>
  )
}
