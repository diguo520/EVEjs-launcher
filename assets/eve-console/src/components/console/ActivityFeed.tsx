import { useMemo } from "react"
import { useEngine } from "@/lib/engine"
import { formatInt } from "@/lib/format"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { MiniBars } from "@/components/ui/sparkline"
import type { LogModule } from "@/lib/types"

const MODULE_ORDER: LogModule[] = ["星图", "市场", "战斗", "网络", "AI", "账号", "存档", "内核"]

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/40 px-3 py-2 shadow-sm">
      <p className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="font-mono text-lg font-semibold leading-none tabular-nums text-foreground">
          {value}
        </span>
        {unit ? <span className="font-mono text-[10px] text-muted-foreground">{unit}</span> : null}
      </p>
    </div>
  )
}

/** 运行摘要 + 各子系统活动分布，用来一眼看出「世界在忙什么」。 */
export function ActivityFeed() {
  const { logs, samples, tickCount, config } = useEngine()

  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    logs.forEach((entry) => counts.set(entry.module, (counts.get(entry.module) ?? 0) + 1))
    return MODULE_ORDER.map((module) => ({ label: module, value: counts.get(module) ?? 0 })).filter(
      (item) => item.value > 0,
    )
  }, [logs])

  const peakPlayers = samples.reduce((max, s) => Math.max(max, s.players), 0)
  const avgFrame =
    samples.length > 0 ? samples.reduce((sum, s) => sum + s.frameMs, 0) / samples.length : 0
  const warnCount = logs.filter((l) => l.level === "WARN" || l.level === "ERROR").length

  return (
    <Panel>
      <PanelHeader eyebrow="shard pulse" title="运行摘要" />
      <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="累计 tick" value={formatInt(tickCount)} />
          <Stat label="峰值在线" value={String(peakPlayers)} unit={`/ ${config.maxPlayers}`} />
          <Stat label="平均帧耗时" value={avgFrame > 0 ? avgFrame.toFixed(0) : "--"} unit="ms" />
          <Stat label="告警条数" value={formatInt(warnCount)} />
        </div>
        <div className="min-w-0">
          <p className="hud-label mb-2 text-[10px] text-muted-foreground/70">子系统活动分布</p>
          {moduleCounts.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground/60">启动后开始统计</p>
          ) : (
            <MiniBars items={moduleCounts} />
          )}
        </div>
      </div>
    </Panel>
  )
}
