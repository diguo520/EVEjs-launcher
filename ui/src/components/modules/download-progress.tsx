import { Download, Package, ShieldCheck, X } from "lucide-react"

import { t } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { PHASE_LABEL, type DownloadTask } from "@/hooks/use-mod-downloads"
import { formatBytes } from "@/lib/mod-logic"
import { cn } from "@/lib/utils"

const BYTES_PER_MB = 1024 * 1024

const PHASE_ICON = {
  downloading: Download,
  verifying: ShieldCheck,
  installing: Package,
} as const

/**
 * 模组下载进度块：阶段 + 百分比 + 速度 + 进度条 + 取消。
 * 卡片里与详情弹窗里共用同一份读数。
 */
export function DownloadProgress({
  task,
  onCancel,
  className,
}: {
  task: DownloadTask
  onCancel?: () => void
  className?: string
}) {
  const Icon = PHASE_ICON[task.phase]
  const percent = Math.floor(task.progress)
  /* 体积读数按字节算：几 KB 的小包在 MB 口径下会读成 0.0 / 0.0 MB（2026-10-16 报障），
     formatBytes 会自己挑 B / KB / MB */
  const totalBytes = task.sizeMB * BYTES_PER_MB
  const movedBytes = (totalBytes * task.progress) / 100

  return (
    <div
      className={cn(
        "rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span className="text-[12px] font-semibold text-primary">
          {PHASE_LABEL[task.phase]}
        </span>
        <span className="tabular text-[11px] text-tertiary">
          {task.kind === "update"
            ? `${task.fromVersion} → ${task.targetVersion}`
            : task.targetVersion}
        </span>
        <div className="min-w-2 flex-1" />
        {task.phase === "downloading" ? (
          <span className="tabular text-[11px] text-muted-foreground">
            {task.speed.toFixed(1)} MB/s
          </span>
        ) : null}
        <span className="tabular text-[12px] font-bold text-primary">{percent}%</span>
        {onCancel ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCancel}
            title="取消下载"
            className="text-tertiary hover:text-destructive"
          >
            <X />
          </Button>
        ) : null}
      </div>

      <Progress
        value={task.progress}
        tone={task.phase === "installing" ? "success" : "primary"}
        className="mt-2"
      />

      <div className="tabular mt-1.5 flex items-center justify-between text-[10px] text-tertiary">
        <span>
          {formatBytes(movedBytes)} / {formatBytes(totalBytes)}
        </span>
        <span>
          {task.phase === "downloading"
            ? t("剩余 {size}", { size: formatBytes(Math.max(0, totalBytes - movedBytes)) })
            : "本地处理中"}
        </span>
      </div>
    </div>
  )
}
