import { RefreshCw, Search, UserPlus } from "lucide-react"

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
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_ORDER,
  type StatusFilter,
} from "@/lib/launcher-logic"

const STATUS_OPTIONS: StatusFilter[] = ["ALL", ...ACCOUNT_STATUS_ORDER]

/** 账号列表筛选条：搜索 + 状态筛选 + 刷新 / 新建账号 */
export function AccountsToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  refreshing,
  onRefresh,
  onCreate,
}: {
  query: string
  onQueryChange: (v: string) => void
  status: StatusFilter
  onStatusChange: (v: StatusFilter) => void
  refreshing: boolean
  onRefresh: () => void
  onCreate: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="搜索账号名 / 角色名 / 舰船 / 星系"
          aria-label="搜索账号"
          className="pl-8"
        />
      </div>

      <Select value={status} onValueChange={(v) => onStatusChange(v as StatusFilter)}>
        <SelectTrigger className="w-[150px]" aria-label="按状态筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s === "ALL" ? "全部状态" : ACCOUNT_STATUS_LABEL[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        同步
      </Button>
      <Button onClick={onCreate}>
        <UserPlus />
        新建账号
      </Button>
    </div>
  )
}
