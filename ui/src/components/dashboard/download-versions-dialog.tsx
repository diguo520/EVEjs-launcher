import { useEffect, useMemo, useState } from "react"
import { HardDriveDownload, Loader2 } from "lucide-react"
import { toast } from "sonner"

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
import { callOr } from "@/lib/ipc"
import { formatBytes } from "@/lib/mod-logic"
import {
  CLIENT_VERSIONS,
  SERVER_VERSIONS,
  compareVersions,
  latestServerVersion,
  type ServerVersion,
} from "@/lib/mock"
import type { useLauncherDownloads } from "@/hooks/use-launcher-downloads"

/** `download:index` / `download:clientIndex` 的回包：清单归一化结果 */
interface RemoteIndex {
  ok?: boolean
  reason?: string
  versions?: { file?: unknown; version?: unknown; sizeBytes?: unknown }[]
}

/**
 * 服务端 / 客户端下载列表：打开时读远端清单，**加载中先显示动画**，
 * 读到了用桶里的、读不到（没网 / 清单没传 / 格式坏了）提示失败并退回内置清单。
 *
 * 下载走同一条通道（另存为 + 内置下载器），进度条与横幅共用同一份状态。
 */
export function DownloadVersionsDialog({
  open,
  onOpenChange,
  downloads,
  kind,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  downloads: ReturnType<typeof useLauncherDownloads>
  kind: "server" | "client"
}) {
  const isServer = kind === "server"
  const channel = isServer ? "downloadIndex" : "downloadClientIndex"
  const fallback = isServer ? SERVER_VERSIONS : CLIENT_VERSIONS

  // 只在弹窗打开时读一次 —— 版本列表变化是按天算的，没必要每次渲染都打一次网络。
  const [remote, setRemote] = useState<ServerVersion[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setRemote(null)
    void callOr<RemoteIndex>(channel, null)
      .then((reply) => {
        if (!alive) return
        const rows: ServerVersion[] = []
        if (reply?.ok && Array.isArray(reply.versions)) {
          for (const row of reply.versions) {
            if (typeof row.file !== "string" || typeof row.version !== "string") continue
            const bytes = typeof row.sizeBytes === "number" ? row.sizeBytes : 0
            rows.push({
              file: row.file,
              version: row.version,
              size: bytes > 0 ? formatBytes(bytes) : "—",
            })
          }
        }
        if (rows.length === 0) toast.error(t("清单加载失败"))
        else setRemote(rows)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        toast.error(t("清单加载失败"))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, channel])

  const versions = useMemo(() => {
    const usable = (remote ?? []).filter((entry) => entry.file && entry.version)
    if (usable.length === 0) return fallback
    return [...usable].sort((left, right) => compareVersions(right.version, left.version))
  }, [remote, fallback])
  const latest = latestServerVersion(versions)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(isServer ? "服务端版本" : "客户端种子文件")}</DialogTitle>
          <DialogDescription>{t("点「下载」挑个位置，整包就存到本机。")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-[12px]">{t("加载中")}</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {versions.map((entry) => {
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
        )}

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
