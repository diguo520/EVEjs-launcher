import { useMemo } from "react"
import { AlertTriangle, HardDrive, Package, PackageCheck, PackageX } from "lucide-react"
import { Panel } from "@/components/ui/panel"
import { formatInt } from "@/lib/format"
import type { ModEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface ModStatsProps {
  mods: ModEntry[]
  /** 冲突组数（成对计数）。 */
  conflictCount: number
  /** 被卷入冲突的模组个数。 */
  conflictModCount: number
}

function Stat({
  icon: Icon,
  label,
  value,
  unit,
  sub,
  tone = "neutral",
}: {
  icon: typeof Package
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: "neutral" | "primary" | "danger"
}) {
  return (
    <Panel className="flex min-w-0 flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "danger"
              ? "text-red-300"
              : tone === "primary"
                ? "text-primary"
                : "text-muted-foreground",
          )}
        />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <p className="flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono text-2xl font-semibold leading-none tabular-nums",
            tone === "danger"
              ? "text-red-300"
              : tone === "primary"
                ? "text-primary"
                : "text-foreground",
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

/** 模组总览：条目、启用面、磁盘占用与冲突面。 */
export function ModStats({ mods, conflictCount, conflictModCount }: ModStatsProps) {
  const summary = useMemo(() => {
    const enabledCount = mods.filter((m) => m.enabled).length
    const totalSize = mods.reduce((sum, m) => sum + m.sizeMb, 0)
    const largest = mods.reduce((max, m) => Math.max(max, m.sizeMb), 0)
    const categories = new Set(mods.map((m) => m.category)).size
    return {
      enabledCount,
      disabledCount: mods.length - enabledCount,
      totalSize,
      largest,
      categories,
    }
  }, [mods])

  const enabledRatio =
    mods.length === 0 ? 0 : Math.round((summary.enabledCount / mods.length) * 100)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat
        icon={Package}
        label="模组总数"
        value={String(mods.length)}
        sub={`覆盖 ${summary.categories} 个分类`}
      />
      <Stat
        icon={PackageCheck}
        label="已启用"
        value={String(summary.enabledCount)}
        sub={`${enabledRatio}% 参与本次加载`}
        tone="primary"
      />
      <Stat
        icon={PackageX}
        label="已停用"
        value={String(summary.disabledCount)}
        sub="保留在磁盘，不参与加载"
      />
      <Stat
        icon={HardDrive}
        label="占用空间合计"
        value={formatInt(summary.totalSize)}
        unit="MB"
        sub={`最大单包 ${formatInt(summary.largest)} MB`}
      />
      <Stat
        icon={AlertTriangle}
        label="冲突数"
        value={String(conflictCount)}
        sub={conflictCount > 0 ? `涉及 ${conflictModCount} 个模组` : "加载顺序无冲突"}
        tone={conflictCount > 0 ? "danger" : "neutral"}
      />
    </div>
  )
}
