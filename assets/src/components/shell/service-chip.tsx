import { cn } from "@/lib/utils"
import { StatusDot, type DotTone } from "@/components/common/status-dot"
import { SERVICE_STATE_LABEL, type Service, type ServiceState } from "@/lib/mock"

const stateTone: Record<ServiceState, DotTone> = {
  running: "primary",
  ready: "success",
  stopped: "idle",
  error: "destructive",
}

const stateText: Record<ServiceState, string> = {
  running: "text-primary",
  ready: "text-success",
  stopped: "text-muted-foreground",
  error: "text-destructive",
}

export function ServiceChip({
  service,
  onClick,
}: {
  service: Service
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${service.name} · ${service.desc} · 端口 ${service.port}`}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 transition-colors",
        "hover:border-primary/45 hover:bg-secondary",
        "focus-visible:outline-none focus-visible:shadow-focus"
      )}
    >
      <StatusDot
        tone={stateTone[service.state]}
        pulse={service.state === "running"}
      />
      <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
        {service.en}
      </span>
      <span
        className={cn(
          "font-mono text-[10px] font-semibold tracking-[0.06em]",
          stateText[service.state]
        )}
      >
        {SERVICE_STATE_LABEL[service.state]}
      </span>
    </button>
  )
}
