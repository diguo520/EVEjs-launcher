import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { call, callOr, subscribe } from "@/lib/ipc"
import { t } from "@/lib/i18n"

/** `download:progress` 的一帧（`total` 拿不到时是 null，界面就只报已下字节） */
export interface DownloadProgress {
  file: string
  received: number
  total: number | null
  path: string
}

/** `download:saveAs` 的回包：下完 / 取消 / 失败三种 */
interface DownloadReply {
  ok: boolean
  canceled?: boolean
  reason?: string
  path?: string
  bytes?: number
}

/**
 * 首页横幅的下载状态：谁在下、下了多少、怎么取消。
 *
 * 为什么状态放在横幅这一层而不是「按钮自己」：种子文件、服务端各版本、版本弹窗里的每一行
 * 共用同一份进度（Rust 侧也只允许一条下载），三处看到的必须是同一个数。
 */
export function useLauncherDownloads() {
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  /** 从点下到回包为止「正在下的对象名」：进度帧还没到时，界面也要能显示在下载 */
  const [activeFile, setActiveFile] = useState("")

  useEffect(
    () =>
      subscribe("onDownloadProgress", (payload) => {
        const frame = payload as DownloadProgress | null
        if (!frame || typeof frame.received !== "number") return
        setProgress(frame)
      }),
    []
  )

  const start = useCallback(async (file: string, suggestedName?: string) => {
    setActiveFile(file)
    setProgress(null)
    try {
      const reply = await call<DownloadReply>("downloadSaveAs", file, suggestedName ?? file)
      // 取消（选路径时取消 / 下载中点取消）不是错误，只提示一句
      if (reply?.canceled) toast.info(t("已取消下载"))
      else if (reply?.ok) toast.success(t("已保存到 {path}", { path: reply.path ?? "" }))
      else toast.error(t("下载失败"), { description: reply?.reason })
    } catch (err) {
      // 桥不在（浏览器里预览）或调用本身抛错：这一条必须报出来，静默失败等于按钮坏了
      toast.error(t("下载失败"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setActiveFile("")
      setProgress(null)
    }
  }, [])

  const cancel = useCallback(() => {
    void callOr("downloadCancel", null)
  }, [])

  return { active: activeFile !== "", activeFile, progress, start, cancel }
}
