import { Download, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { t } from "@/lib/i18n"
import { formatBytes } from "@/lib/mod-logic"
import type { DownloadProgress } from "@/hooks/use-launcher-downloads"

/**
 * 下载进度条：横幅里与版本弹窗里共用同一份读数（同一个 hook 状态）。
 * 拿不到总长（服务端没给 Content-Length）就只报已下字节、进度条画 0 —— 不编一个百分比出来。
 */
export function DownloadStrip({
  file,
  progress,
  onCancel,
}: {
  file: string
  progress: DownloadProgress | null
  onCancel: () => void
}) {
  const received = progress?.received ?? 0
  const total = progress?.total ?? 0
  const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0

  return (
    <div className="rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Download className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0 text-[12px] font-semibold text-primary">{t("下载中")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-tertiary" title={file}>
          {file}
        </span>
        <span className="tabular shrink-0 text-[12px] font-bold text-primary">
          {total > 0 ? `${percent}%` : formatBytes(received)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCancel}
          title={t("取消下载")}
          className="shrink-0 text-tertiary hover:text-destructive"
        >
          <X />
        </Button>
      </div>
      <Progress value={percent} className="mt-2" />
      <div className="tabular mt-1.5 text-[10px] text-tertiary">
        {formatBytes(received)}
        {total > 0 ? ` / ${formatBytes(total)}` : ""}
      </div>
    </div>
  )
}
