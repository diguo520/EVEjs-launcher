import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"

/** 底部：世界存档落地路径 + 备份目录 + 统计刷新 */
export function DbPathBar({
  path,
  backupDir,
  backupCount,
  onRefresh,
}: {
  path: string
  /** 备份目录（database:backups.directory） */
  backupDir: string
  backupCount: number
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-input bg-card/60 px-3 py-2">
      <span className="panel-label shrink-0">DATABASE</span>
      <code className="tabular min-w-0 flex-1 truncate text-[12px] text-primary">
        {path || "—"}
      </code>
      {backupDir ? (
        <span
          className="tabular max-w-[280px] shrink-0 truncate text-[10px] text-tertiary"
          title={backupDir}
        >
          备份 {backupCount} 份 · {backupDir}
        </span>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onRefresh} className="shrink-0">
        <RefreshCw />
        刷新统计
      </Button>
    </div>
  )
}
