import { Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/ui/panel"
import { Select } from "@/components/ui/select"

const KIND_OPTIONS = [
  { value: "ALL", label: "全部类型" },
  { value: "手动", label: "手动" },
  { value: "自动", label: "自动" },
  { value: "启动前", label: "启动前" },
]

export interface BackupToolbarProps {
  kindFilter: string
  queryText: string
  onKindFilterChange: (value: string) => void
  onQueryTextChange: (value: string) => void
  onCreate: () => void
  visibleCount: number
  totalCount: number
}

export function BackupToolbar({
  kindFilter,
  queryText,
  onKindFilterChange,
  onQueryTextChange,
  onCreate,
  visibleCount,
  totalCount,
}: BackupToolbarProps) {
  const dirty = kindFilter !== "ALL" || queryText !== ""

  return (
    <Panel className="flex flex-wrap items-center gap-2 p-3">
      <Button variant="primary" size="md" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        新建快照
      </Button>

      <Select
        value={kindFilter}
        onValueChange={onKindFilterChange}
        className="w-[120px]"
        options={KIND_OPTIONS}
      />

      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={queryText}
          onChange={(e) => onQueryTextChange(e.target.value)}
          placeholder="搜索快照名称或备注 …"
          className="pl-8"
        />
      </div>

      {dirty ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onKindFilterChange("ALL")
            onQueryTextChange("")
          }}
        >
          <X className="h-3.5 w-3.5" />
          清除
        </Button>
      ) : null}

      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        显示 {visibleCount} / 共 {totalCount}
      </span>
    </Panel>
  )
}
