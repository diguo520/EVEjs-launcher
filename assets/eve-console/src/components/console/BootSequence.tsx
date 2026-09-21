import { Check, Loader2 } from "lucide-react"
import { bootStages, useEngine } from "@/lib/engine"
import { cn } from "@/lib/utils"

/**
 * 冷启动分段清单。当前段高亮并转圈，已完成的段打勾，未到的段压暗。
 */
export function BootSequence() {
  const { bootProgress, bootStageIndex } = useEngine()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="hud-label text-[10px] text-muted-foreground">冷启动序列</span>
        <span className="font-mono text-xs tabular-nums text-primary">
          {Math.round(bootProgress * 100)}%
        </span>
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-primary transition-[width] duration-150 ease-linear"
          style={{ width: `${bootProgress * 100}%` }}
        />
      </div>

      <ol className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {bootStages.map((stage, index) => {
          const done = index < bootStageIndex
          const active = index === bootStageIndex
          return (
            <li key={stage.id} className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                  done && "border-primary/50 bg-primary/15 text-primary",
                  active && "border-primary bg-primary/15 text-primary",
                  !done && !active && "border-border text-transparent",
                )}
              >
                {done ? (
                  <Check className="h-3 w-3" />
                ) : active ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                )}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate text-xs leading-tight",
                    active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground/70",
                  )}
                >
                  {stage.label}
                </span>
                <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground/60">
                  {stage.detail}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
