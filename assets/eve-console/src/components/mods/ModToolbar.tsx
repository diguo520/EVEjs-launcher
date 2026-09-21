/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import { Power, PowerOff, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/ui/panel"
import { Select } from "@/components/ui/select"

export interface ModFilters {
  query: string
  category: string
}

export const MOD_CATEGORY_OPTIONS = [
  { value: "ALL", label: "全部分类" },
  { value: "玩法", label: "玩法" },
  { value: "经济", label: "经济" },
  { value: "AI", label: "AI" },
  { value: "画面", label: "画面" },
  { value: "工具", label: "工具" },
]

export interface ModToolbarProps {
  filters: ModFilters
  onFiltersChange: (patch: Partial<ModFilters>) => void
  /** 当前列表里还需要启用的条目数。 */
  pendingEnable: number
  /** 当前列表里还需要停用的条目数。 */
  pendingDisable: number
  resultCount: number
  totalCount: number
  onEnableAll: () => void
  onDisableAll: () => void
}

export function ModToolbar({
  filters,
  onFiltersChange,
  pendingEnable,
  pendingDisable,
  resultCount,
  totalCount,
  onEnableAll,
  onDisableAll,
}: ModToolbarProps) {
  const dirty = filters.query !== "" || filters.category !== "ALL"

  return (
    <Panel className="flex flex-wrap items-center gap-2 p-3">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={filters.query}
          onChange={(e) => onFiltersChange({ query: e.target.value })}
          placeholder="搜索模组名、作者或描述 …"
          className="pl-8"
        />
      </div>

      <Select
        value={filters.category}
        onValueChange={(v) => onFiltersChange({ category: v })}
        className="w-[124px]"
        options={MOD_CATEGORY_OPTIONS}
      />

      {dirty ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onFiltersChange({ query: "", category: "ALL" })}
        >
          <X className="h-3.5 w-3.5" />
          清除
        </Button>
      ) : null}

      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {resultCount} / {totalCount}
      </span>

      <Button variant="outline" size="md" disabled={pendingEnable === 0} onClick={onEnableAll}>
        <Power className="h-3.5 w-3.5" />
        全部启用
      </Button>
      <Button variant="outline" size="md" disabled={pendingDisable === 0} onClick={onDisableAll}>
        <PowerOff className="h-3.5 w-3.5" />
        全部停用
      </Button>
    </Panel>
  )
}
