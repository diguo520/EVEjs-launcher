import type { LucideIcon } from "lucide-react"
import { Panel } from "@/components/ui/panel"
import { cn } from "@/lib/utils"

export type StatTone = "neutral" | "primary" | "warn" | "danger"

const TONE_TEXT: Record<StatTone, string> = {
  neutral: "text-foreground",
  primary: "text-primary",
  warn: "text-amber-300",
  danger: "text-red-300",
}

export interface StatTileProps {
  icon: LucideIcon
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: StatTone
}

/** 一格数字：图标 + 标签 + 大号数值 + 一行小注。市场总览和作者总览共用。 */
export function StatTile({ icon: Icon, label, value, unit, sub, tone = "neutral" }: StatTileProps) {
  return (
    <Panel className="flex min-w-0 flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "neutral" ? "text-muted-foreground" : TONE_TEXT[tone],
          )}
        />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <p className="flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono text-2xl font-semibold leading-none tabular-nums",
            TONE_TEXT[tone],
          )}
        >
          {value}
        </span>
        {unit ? <span className="font-mono text-[10px] text-muted-foreground">{unit}</span> : null}
      </p>
      {sub ? (
        <span className="truncate font-mono text-[10px] text-muted-foreground/60">{sub}</span>
      ) : null}
    </Panel>
  )
}
