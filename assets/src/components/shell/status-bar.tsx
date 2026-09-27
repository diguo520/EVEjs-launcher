import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/common/status-dot"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { LAUNCHER_META, SERVICES, SESSION } from "@/lib/mock"
import type { EnvCheckState } from "@/hooks/use-env-check"

function Cell({
  label,
  value,
  tone = "default",
  className,
}: {
  label?: string
  value: React.ReactNode
  tone?: "default" | "ok" | "warn" | "error" | "accent"
  className?: string
}) {
  const toneClass = {
    default: "text-muted-foreground",
    ok: "text-success",
    warn: "text-warning",
    error: "text-destructive",
    accent: "text-primary",
  }[tone]

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap border-r border-input px-3 py-1.5",
        className
      )}
    >
      {label ? <span className="text-[10px] text-tertiary">{label}</span> : null}
      <span className={cn("tabular text-[11px]", toneClass)}>{value}</span>
    </div>
  )
}

export function StatusBar({ env }: { env: EnvCheckState }) {
  const { version } = useLauncherVersion()
  const running = SERVICES.filter((s) => s.state === "running").length

  // 自检结论跟着面板走：面板说缺东西，这里就不能还亮着绿灯说 READY
  const blocked = env.missingCount > 0
  const degraded = !blocked && env.warnCount > 0

  return (
    <footer className="flex shrink-0 items-stretch overflow-x-auto border-t border-border bg-card/85">
      <Cell
        value={
          <span className="flex items-center gap-1.5">
            <StatusDot tone={blocked ? "destructive" : degraded ? "warning" : "success"} />
            环境自检 {env.passCount}/{env.items.length}{" "}
            {blocked ? "NOT READY" : degraded ? "DEGRADED" : "READY"}
          </span>
        }
        tone={blocked ? "error" : degraded ? "warn" : "ok"}
      />
      <Cell label="服务" value={`${running}/4 RUNNING`} tone="accent" />
      <Cell label="在线人数" value={SESSION.pilots} />
      <Cell label="PING" value={`${SESSION.ping} ms`} />
      <div className="flex-1" />
      <Cell label="EVEJS" value={version} />
      <Cell label="PATH" value={LAUNCHER_META.rootPath} className="hidden lg:flex" />
      <Cell
        label="ALERTS"
        value={SESSION.alerts}
        tone={SESSION.alerts > 0 ? "warn" : "ok"}
      />
      <Cell label="会话" value={SESSION.uptime} className="hidden md:flex" />
      <Cell
        value={`© ${LAUNCHER_META.sponsor}`}
        tone="warn"
        className="border-r-0"
      />
    </footer>
  )
}
