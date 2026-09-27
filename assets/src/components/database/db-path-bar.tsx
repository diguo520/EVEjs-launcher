import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { DB_META } from "@/lib/mock"

/** 底部：世界存档落地路径 + 统计刷新 */
export function DbPathBar() {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-input bg-card/60 px-3 py-2">
      <span className="panel-label shrink-0">DATABASE</span>
      <code className="tabular min-w-0 flex-1 truncate text-[12px] text-primary">
        {DB_META.path}
      </code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => toast.success("统计已刷新")}
        className="shrink-0"
      >
        <RefreshCw />
        刷新统计
      </Button>
    </div>
  )
}
