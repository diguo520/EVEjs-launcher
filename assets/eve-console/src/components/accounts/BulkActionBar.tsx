import { Ban, Coins, Download, ShieldCheck, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface BulkActionBarProps {
  count: number
  onGrant: (mode: "isk" | "sp") => void
  onBan: () => void
  onUnban: () => void
  onExport: () => void
  onClear: () => void
}

export function BulkActionBar({
  count,
  onGrant,
  onBan,
  onUnban,
  onExport,
  onClear,
}: BulkActionBarProps) {
  if (count === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 shadow-sm">
      <span className="font-mono text-xs tabular-nums text-primary">已选中 {count} 个账号</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => onGrant("isk")}>
          <Coins className="h-3.5 w-3.5" />
          发放 ISK
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onGrant("sp")}>
          <Sparkles className="h-3.5 w-3.5" />
          发放技能点
        </Button>
        <Button size="sm" variant="secondary" onClick={onBan}>
          <Ban className="h-3.5 w-3.5" />
          批量封禁
        </Button>
        <Button size="sm" variant="secondary" onClick={onUnban}>
          <ShieldCheck className="h-3.5 w-3.5" />
          批量解封
        </Button>
        <Button size="sm" variant="secondary" onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          导出选中
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClear} aria-label="取消选择">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
