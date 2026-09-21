/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import { Badge, StatusDot } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ServerStatus } from "@/lib/types"

type Tone = "neutral" | "primary" | "success" | "warn" | "danger" | "outline"

interface StatusMeta {
  label: string
  tone: Tone
  pulse: boolean
  /** 服务端是否处于「有世界在跑」的状态。 */
  live: boolean
}

export const STATUS_META: Record<ServerStatus, StatusMeta> = {
  stopped: { label: "已停止", tone: "neutral", pulse: false, live: false },
  starting: { label: "启动中", tone: "warn", pulse: true, live: false },
  running: { label: "运行中", tone: "success", pulse: true, live: true },
  stopping: { label: "停止中", tone: "warn", pulse: true, live: false },
  crashed: { label: "已崩溃", tone: "danger", pulse: false, live: false },
}

export function ServerStatusPill({
  serverStatus,
  className,
  showDot = true,
}: {
  serverStatus: ServerStatus
  className?: string
  showDot?: boolean
}) {
  const meta = STATUS_META[serverStatus]
  return (
    <Badge tone={meta.tone} className={cn("gap-1.5 px-2 py-1", className)}>
      {showDot ? <StatusDot tone={meta.tone} pulse={meta.pulse} /> : null}
      {meta.label}
    </Badge>
  )
}
