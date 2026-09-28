import { Loader2, Play, RotateCw, Square } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusDot, type DotTone } from "@/components/common/status-dot"
import { useLocale } from "@/components/shell/locale-provider"
import { SERVICE_STATE_LABEL, type Service, type ServiceState } from "@/lib/mock"

/**
 * 状态配色：未启动灰、启动成功绿、已停止红、故障红。
 *
 * 「已停止」和「未启动」在后端都是 idle，谁红谁灰由 use-launcher 的本地观察决定
 * （见过它跑起来才算「停过」，见 use-launcher.ts 的 everRunningRef）。
 */
const stateTone: Record<ServiceState, DotTone> = {
  running: "success",
  ready: "idle",
  stopped: "destructive",
  error: "destructive",
}

const stateBar: Record<ServiceState, string> = {
  running: "bg-success",
  ready: "bg-border",
  stopped: "bg-destructive",
  error: "bg-destructive",
}

const stateBadge: Record<ServiceState, "default" | "success" | "secondary" | "destructive"> = {
  running: "success",
  ready: "secondary",
  stopped: "destructive",
  error: "destructive",
}

export function ServiceCard({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  service: Service
  busy: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}) {
  const { t } = useLocale()
  const isRunning = service.state === "running"

  const readouts = [
    { k: "PID", v: service.pid ?? "—" },
    { k: "CPU", v: service.cpu === null ? "—" : `${service.cpu.toFixed(1)}%` },
    { k: "内存", v: service.memMB === null ? "—" : `${(service.memMB / 1024).toFixed(2)} GB` },
    { k: "运行时长", v: service.uptime },
  ]

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card">
      <span className={cn("absolute inset-x-0 top-0 h-[2px]", stateBar[service.state])} />

      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot
              tone={stateTone[service.state]}
              pulse={service.state === "running"}
            />
            <span className="truncate text-[13px] font-semibold text-foreground">
              {service.name}
            </span>
          </div>
          <Badge variant={stateBadge[service.state]}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {SERVICE_STATE_LABEL[service.state]}
          </Badge>
        </div>

        <div className="tabular mt-1 text-[10px] tracking-[0.1em] text-tertiary">
          {t("{name} · 端口 {port}", { name: service.en, port: service.port })}
        </div>

        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {service.desc}
        </p>

        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {readouts.map((r) => (
            <div key={r.k} className="flex items-baseline justify-between gap-2">
              <dt className="text-[10px] text-tertiary">{r.k}</dt>
              <dd
                className={cn(
                  "tabular text-[12px] font-semibold",
                  isRunning ? "text-telemetry" : "text-muted-foreground"
                )}
              >
                {r.v}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex items-center gap-1.5 border-t border-input px-3 py-2">
        <Button
          size="sm"
          variant={isRunning ? "secondary" : "default"}
          disabled={busy || isRunning}
          onClick={onStart}
          className="flex-1"
        >
          <Play />
          启动
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onRestart}
          className="flex-1"
        >
          <RotateCw />
          重启
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !isRunning}
          onClick={onStop}
          className="flex-1 hover:border-destructive/60 hover:text-destructive"
        >
          <Square />
          停止
        </Button>
      </div>
    </div>
  )
}
