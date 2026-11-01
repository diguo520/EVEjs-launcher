import { HardDriveDownload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DownloadStrip } from "@/components/dashboard/download-strip"
import { t } from "@/lib/i18n"
import { SERVER_VERSIONS, latestServerVersion } from "@/lib/mock"
import type { useLauncherDownloads } from "@/hooks/use-launcher-downloads"

/**
 * 服务端版本列表：桶里每个整包一行，版本号最大的那条打「最新」徽标。
 *
 * 下载与种子文件走同一条通道（另存为 + 内置下载器），进度条与横幅共用同一份状态，
 * 所以弹窗里下、关掉弹窗后横幅接着显示，两边都不会各报一个数。
 */
export function ServerVersionsDialog({
  open,
  onOpenChange,
  downloads,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  downloads: ReturnType<typeof useLauncherDownloads>
}) {
  const latest = latestServerVersion()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("服务端版本")}</DialogTitle>
          <DialogDescription>{t("点「下载」挑个位置，整包就存到本机。")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {SERVER_VERSIONS.map((entry) => {
            const isLatest = latest?.file === entry.file
            const downloading = downloads.active && downloads.activeFile === entry.file
            return (
              <div
                key={entry.file}
                className="flex items-center gap-2 rounded-md border border-input px-2.5 py-2"
              >
                <HardDriveDownload className="size-3.5 shrink-0 text-tertiary" />
                <span className="tabular text-[12px] font-semibold text-foreground">
                  {entry.version}
                </span>
                {isLatest ? <Badge variant="secondary">{t("最新")}</Badge> : null}
                <div className="min-w-2 flex-1" />
                <span className="tabular text-[11px] text-tertiary">{entry.size}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={downloads.active}
                  onClick={() => void downloads.start(entry.file, entry.file)}
                >
                  {downloading ? t("下载中") : t("下载")}
                </Button>
              </div>
            )
          })}
        </div>

        {downloads.active ? (
          <DownloadStrip
            file={downloads.activeFile}
            progress={downloads.progress}
            onCancel={downloads.cancel}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
