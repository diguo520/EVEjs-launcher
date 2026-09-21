import { Download, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Panel } from "@/components/ui/panel"

export interface AccountFilters {
  query: string
  status: string
  faction: string
  role: string
}

export interface AccountToolbarProps {
  filters: AccountFilters
  onFiltersChange: (patch: Partial<AccountFilters>) => void
  onCreate: () => void
  onExport: () => void
  resultCount: number
  totalCount: number
}

export function AccountToolbar({
  filters,
  onFiltersChange,
  onCreate,
  onExport,
  resultCount,
  totalCount,
}: AccountToolbarProps) {
  const dirty =
    filters.query !== "" || filters.status !== "ALL" || filters.faction !== "ALL" || filters.role !== "ALL"

  return (
    <Panel className="flex flex-wrap items-center gap-2 p-3">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={filters.query}
          onChange={(e) => onFiltersChange({ query: e.target.value })}
          placeholder="搜索角色名、账号、军团或舰船 …"
          className="pl-8"
        />
      </div>

      <Select
        value={filters.status}
        onValueChange={(v) => onFiltersChange({ status: v })}
        className="w-[112px]"
        options={[
          { value: "ALL", label: "全部状态" },
          { value: "online", label: "在线" },
          { value: "offline", label: "离线" },
          { value: "banned", label: "已封禁" },
        ]}
      />
      <Select
        value={filters.faction}
        onValueChange={(v) => onFiltersChange({ faction: v })}
        className="w-[112px]"
        options={[
          { value: "ALL", label: "全部势力" },
          { value: "加达里", label: "加达里" },
          { value: "米玛塔尔", label: "米玛塔尔" },
          { value: "艾玛", label: "艾玛" },
          { value: "盖伦特", label: "盖伦特" },
        ]}
      />
      <Select
        value={filters.role}
        onValueChange={(v) => onFiltersChange({ role: v })}
        className="w-[112px]"
        options={[
          { value: "ALL", label: "全部权限" },
          { value: "管理员", label: "管理员" },
          { value: "军团指挥", label: "军团指挥" },
          { value: "玩家", label: "玩家" },
          { value: "观察者", label: "观察者" },
        ]}
      />

      {dirty ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onFiltersChange({ query: "", status: "ALL", faction: "ALL", role: "ALL" })
          }
        >
          <X className="h-3.5 w-3.5" />
          清除
        </Button>
      ) : null}

      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {resultCount} / {totalCount}
      </span>

      <Button variant="secondary" size="md" onClick={onExport}>
        <Download className="h-3.5 w-3.5" />
        导出 CSV
      </Button>
      <Button variant="primary" size="md" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        新建账号
      </Button>
    </Panel>
  )
}
