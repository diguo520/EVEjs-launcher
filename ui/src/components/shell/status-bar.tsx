import { ShieldAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/common/status-dot"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { LAUNCHER_META, type Service } from "@/lib/mock"
import type { EnvCheckState } from "@/hooks/use-env-check"
import type { SessionReadout } from "@/hooks/use-launcher"

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

export function StatusBar({
  env,
  services,
  session,
  onOpenLegalNotice,
}: {
  env: EnvCheckState
  services: Service[]
  session: SessionReadout
  /** 法律声明缩到底部后的入口；没确认过之前不显示（那时弹窗还在） */
  onOpenLegalNotice?: () => void
}) {
  const { evejsVersion, repoRoot } = useLauncherVersion()
  const running = services.filter((s) => s.state === "running").length

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
      <Cell label="服务" value={`${running}/${services.length} RUNNING`} tone="accent" />
      <Cell label="在线人数" value={session.pilots} />
      {/* 端口没人监听时 ping 是「—」：那种情况下写 "— ms" 反而像读数是零 */}
      <Cell
        label="PING"
        value={session.ping === "—" ? "—" : `${session.ping} ms`}
      />
      <div className="flex-1" />
      <Cell label="EVEJS" value={evejsVersion} />
      {/* PATH 是当前服务端的根目录（app:info.repoRoot），不是写死的示例路径 */}
      <Cell
        label="PATH"
        value={repoRoot || "—"}
        className="hidden max-w-[340px] truncate lg:flex"
      />
      <Cell
        label="ALERTS"
        value={session.alerts}
        tone={session.alerts > 0 ? "warn" : "ok"}
      />
      <Cell label="会话" value={session.uptime} className="hidden md:flex" />
      <Cell
        value={`© ${LAUNCHER_META.sponsor}`}
        tone="warn"
        // 底部入口在它右边时，右边框交给入口那条收尾
        className={onOpenLegalNotice ? undefined : "border-r-0"}
      />
      {onOpenLegalNotice ? (
        <button
          type="button"
          onClick={onOpenLegalNotice}
          title="查看法律声明"
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r-0 border-input px-3 py-1.5 text-[11px] text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <ShieldAlert className="size-3.5" />
          法律声明
        </button>
      ) : null}
    </footer>
  )
}
