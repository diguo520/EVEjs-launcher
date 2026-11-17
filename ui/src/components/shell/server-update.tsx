import * as React from "react"

import { callOr, hasIpc, subscribe } from "@/lib/ipc"
import { t } from "@/lib/i18n"
import { toast } from "sonner"

export interface ServerUpdateCheck {
  ok?: boolean
  currentVersion?: string
  latestVersion?: string
  available?: boolean
  file?: string
  sizeBytes?: number
  reason?: string
}

export type ServerUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "applying"
  | "done"
  | "error"

export interface ServerUpdateValue {
  /** 本地服务端版本（不带 v 前缀） */
  currentVersion: string
  /** 清单里的最新服务端版本 */
  latestVersion: string
  /** 是否有可升级的新版本 */
  available: boolean
  /** 正在检查 / 下载 / 升级 */
  phase: ServerUpdatePhase
  /** 下载进度 0–100 */
  progress: number
  /** 下载/升级过程中的说明，或失败原因 */
  message: string
  /** 检查一次新版本 */
  checkForUpdate: () => Promise<void>
  /** 下载整包并升级：两步串起来，中途失败如实报告 */
  upgrade: () => Promise<void>
}

const FALLBACK: ServerUpdateValue = {
  currentVersion: "",
  latestVersion: "",
  available: false,
  phase: "idle",
  progress: 0,
  message: "",
  checkForUpdate: async () => {},
  upgrade: async () => {},
}

const ServerUpdateContext = React.createContext<ServerUpdateValue>(FALLBACK)

/**
 * 服务端在线升级状态：查新版（R2 清单）→ 下整包 → 停服升级 → 删包。
 *
 * 状态提升到外壳，供「关于」页的升级图标、侧栏齿轮提示、开机画面指示共用一份，
 * 避免各处各查一次、版本号对不上。挂载后自动查一次，之后由用户点图标触发升级。
 */
export function useServerUpdateState(): ServerUpdateValue {
  const live = hasIpc()
  const [check, setCheck] = React.useState<ServerUpdateCheck | null>(null)
  const [phase, setPhase] = React.useState<ServerUpdatePhase>("idle")
  const [received, setReceived] = React.useState(0)
  const [total, setTotal] = React.useState(0)
  const [applyStep, setApplyStep] = React.useState(0)
  const [message, setMessage] = React.useState("")

  // 下载 / 升级合并成一条 0–100 的总进度：下载占前 DOWNLOAD_WEIGHT%，
  // 升级阶段在剩下的区间里渐进，全部步骤完成才到 100%。
  const DOWNLOAD_WEIGHT = 60

  // 下载进度：只认本次升级的整包（file 与清单里的一致），避免串到首页下载。
  React.useEffect(
    () =>
      subscribe("onDownloadProgress", (payload) => {
        const frame = payload as { file?: string; received?: number; total?: number } | null
        if (!frame || typeof frame.received !== "number") return
        if (check?.file && frame.file && frame.file !== check.file) return
        setReceived(frame.received)
        setTotal(typeof frame.total === "number" ? frame.total : 0)
      }),
    [check?.file]
  )

  const checkForUpdate = React.useCallback(async () => {
    if (!live) return
    setPhase("checking")
    setMessage("")
    const result = await callOr<ServerUpdateCheck>("serverUpdateCheck", null)
    if (!result) {
      setPhase("error")
      setMessage(t("读不到服务端版本清单"))
      return
    }
    setCheck(result)
    setPhase(result.available ? "idle" : "done")
    if (!result.ok) setMessage(result.reason ?? "")
  }, [live])

  // 挂载后自动查一次：关于页的升级图标、侧栏齿轮提示都要靠它亮起来。
  React.useEffect(() => {
    if (!live) return
    void checkForUpdate()
  }, [live, checkForUpdate])

  const upgrade = React.useCallback(async () => {
    if (!check?.file || !check.latestVersion) return
    setPhase("downloading")
    setReceived(0)
    setTotal(check.sizeBytes ?? 0)
    setApplyStep(0)
    setMessage("")
    const downloaded = await callOr<{ ok?: boolean; reason?: string }>(
      "serverUpdateDownload",
      null,
      check.file,
      check.latestVersion
    )
    if (!downloaded?.ok) {
      setPhase("error")
      setMessage(downloaded?.reason ?? t("下载失败"))
      return
    }
    setPhase("applying")
    setMessage(t("正在升级服务端，期间服务会暂停…"))
    // 升级是本地整包替换，无细粒度回报，用定时步进把剩余区间平滑推到 100。
    setApplyStep(0)
    const applied = await callOr<{ ok?: boolean; reason?: string; message?: string }>(
      "serverUpdateApply",
      null,
      check.latestVersion
    )
    if (applied?.ok) {
      setApplyStep(1)
      setPhase("done")
      setMessage(applied.message ?? t("服务端已更新并重启"))
      toast.success(t("服务端升级完成"))
      await checkForUpdate()
    } else {
      setPhase("error")
      setMessage(applied?.reason ?? t("升级失败"))
      toast.error(t("升级失败"), { description: applied?.reason })
    }
  }, [check, checkForUpdate])

  // 下载阶段：0 → DOWNLOAD_WEIGHT；升级/完成阶段：DOWNLOAD_WEIGHT → 100。
  const downloadFrac = total > 0 ? Math.min(1, received / total) : 0
  const progress =
    phase === "downloading"
      ? Math.floor(downloadFrac * DOWNLOAD_WEIGHT)
      : Math.min(100, Math.floor(DOWNLOAD_WEIGHT + (100 - DOWNLOAD_WEIGHT) * applyStep))

  // 升级阶段平滑推进 applyStep，直到后端完成（done 时置 1）。
  React.useEffect(() => {
    if (phase !== "applying") return
    const timer = window.setInterval(() => {
      setApplyStep((prev) => Math.min(0.98, prev + 0.02))
    }, 120)
    return () => window.clearInterval(timer)
  }, [phase])

  return React.useMemo<ServerUpdateValue>(
    () => ({
      currentVersion: check?.currentVersion ?? "",
      latestVersion: check?.latestVersion ?? "",
      available: Boolean(check?.available),
      phase,
      progress,
      message,
      checkForUpdate,
      upgrade,
    }),
    [check, phase, progress, message, checkForUpdate, upgrade]
  )
}

export function ServerUpdateProvider({
  value,
  children,
}: {
  value: ServerUpdateValue
  children: React.ReactNode
}) {
  return (
    <ServerUpdateContext.Provider value={value}>{children}</ServerUpdateContext.Provider>
  )
}

export function useServerUpdate() {
  return React.useContext(ServerUpdateContext)
}
