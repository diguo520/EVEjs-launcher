import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react"
import type { ModEntry } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

type BadgeTone = "neutral" | "primary" | "success" | "warn" | "danger" | "outline"

/** 分类配色：玩法偏主色，经济偏告警，AI 偏成功，其余走中性。 */
const CATEGORY_TONE: Record<string, BadgeTone> = {
  玩法: "primary",
  经济: "warn",
  AI: "success",
  画面: "neutral",
  工具: "outline",
}

export interface ModRowProps {
  mod: ModEntry
  /** 与之冲突且同样处于启用状态的模组名。 */
  conflictingNames: string[]
  canMoveUp: boolean
  canMoveDown: boolean
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
}

export function ModRow({
  mod,
  conflictingNames,
  canMoveUp,
  canMoveDown,
  onToggle,
  onMove,
}: ModRowProps) {
  const hasConflict = conflictingNames.length > 0
  const dimmed = !mod.enabled

  return (
    <div
      className={cn(
        "flex items-stretch gap-3 rounded-md border bg-background/40 p-3 transition-colors",
        hasConflict ? "border-destructive/50" : "border-border",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex w-11 shrink-0 flex-col items-center gap-1">
        <span className="font-mono text-2xl font-semibold leading-none tabular-nums text-primary">
          {mod.order}
        </span>
        <span className="hud-label text-[10px] text-muted-foreground/70">order</span>
        <div className="mt-1 flex flex-col gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={!canMoveUp}
            onClick={() => onMove(-1)}
            aria-label={`${mod.name} 上移`}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={!canMoveDown}
            onClick={() => onMove(1)}
            aria-label={`${mod.name} 下移`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "truncate text-sm font-semibold",
              dimmed ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {mod.name}
          </span>
          <Badge tone="outline" className="px-1 py-0 text-[10px]">
            {mod.version}
          </Badge>
          <Badge tone={CATEGORY_TONE[mod.category] ?? "neutral"} className="px-1 py-0 text-[10px]">
            {mod.category}
          </Badge>
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {mod.sizeMb} MB
          </span>
        </div>

        <p className="truncate font-mono text-[10px] text-muted-foreground/70">{mod.author}</p>
        <p
          className={cn(
            "text-xs leading-relaxed",
            dimmed ? "text-muted-foreground/60" : "text-muted-foreground",
          )}
        >
          {mod.desc}
        </p>

        {hasConflict ? (
          <div className="mt-0.5 flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-red-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>与 {conflictingNames.join("、")} 冲突</span>
          </div>
        ) : null}
      </div>

      <div className="flex w-16 shrink-0 flex-col items-end justify-between gap-2">
        <Switch checked={mod.enabled} onCheckedChange={onToggle} />
        <span
          className={cn(
            "font-mono text-[10px]",
            mod.enabled ? "text-emerald-300" : "text-muted-foreground/60",
          )}
        >
          {mod.enabled ? "已启用" : "已停用"}
        </span>
      </div>
    </div>
  )
}
