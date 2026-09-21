import { useMemo } from "react"
import { AlertTriangle, Boxes, Gauge, HardDrive, Users } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatFixed, formatInt } from "@/lib/format"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { cn } from "@/lib/utils"

type ImpactTone = "primary" | "warn" | "danger"

const TONE_TEXT: Record<ImpactTone, string> = {
  primary: "text-primary",
  warn: "text-amber-300",
  danger: "text-red-300",
}

function ImpactTile({
  icon: Icon,
  label,
  value,
  unit,
  sub,
  tone = "primary",
}: {
  icon: typeof Gauge
  label: string
  value: string
  unit: string
  sub: string
  tone?: ImpactTone
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-background/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[tone])} />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono text-2xl font-semibold leading-none tabular-nums",
            TONE_TEXT[tone],
          )}
        >
          {value}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{unit}</span>
      </div>
      <p className="truncate font-mono text-[10px] tabular-nums text-muted-foreground/60">{sub}</p>
    </div>
  )
}

export function ImpactPanel() {
  const { config } = useEngine()

  const impact = useMemo(() => {
    const npcCount = config.systems * 3.4 * config.npcDensity
    const memMb = 620 + config.systems * 0.21 + npcCount * 0.03
    const frameMs =
      1000 / Math.max(1, config.tickRate) + config.systems / 900 + config.npcDensity * 4
    const orders = config.systems * 7.2
    const tickBudget = 1000 / Math.max(1, config.tickRate)
    return { npcCount, memMb, frameMs, orders, tickBudget, loadRatio: frameMs / tickBudget }
  }, [config])

  const frameTone: ImpactTone =
    impact.frameMs > 220 ? "danger" : impact.frameMs > 120 ? "warn" : "primary"
  const memTone: ImpactTone = impact.memMb > 4096 ? "warn" : "primary"

  return (
    <Panel>
      <PanelHeader
        eyebrow="impact estimate"
        title="参数影响预估"
        actions={
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
            按当前配置推算
          </span>
        }
      />
      <PanelBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <ImpactTile
            icon={HardDrive}
            label="内存占用"
            value={formatInt(impact.memMb)}
            unit="MB"
            sub={`基线 620 MB + 星域 ${formatInt(config.systems * 0.21)} MB`}
            tone={memTone}
          />
          <ImpactTile
            icon={Gauge}
            label="单 tick 耗时"
            value={formatFixed(impact.frameMs, 1)}
            unit="ms"
            sub={`预算 ${formatFixed(impact.tickBudget, 1)} ms`}
            tone={frameTone}
          />
          <ImpactTile
            icon={Users}
            label="NPC 数量"
            value={formatInt(impact.npcCount)}
            unit="个"
            sub={`密度 ${formatFixed(config.npcDensity, 1)}x · 星系 ${formatInt(config.systems)}`}
          />
          <ImpactTile
            icon={Boxes}
            label="市场挂单量"
            value={formatInt(impact.orders)}
            unit="条"
            sub={`税率 ${formatFixed(config.marketTax, 1)}% · 价差 ${formatInt(config.npcSpread)}%`}
          />
        </div>

        {impact.loadRatio > 1 ? (
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-md border px-3 py-2.5",
              impact.loadRatio > 2
                ? "border-destructive/40 bg-destructive/10"
                : "border-amber-300/40 bg-amber-300/10",
            )}
          >
            <AlertTriangle
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                impact.loadRatio > 2 ? "text-red-300" : "text-amber-300",
              )}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              单 tick 耗时已占到时间预算的{" "}
              <span
                className={cn(
                  "font-mono tabular-nums",
                  impact.loadRatio > 2 ? "text-red-300" : "text-amber-300",
                )}
              >
                {formatFixed(impact.loadRatio, 2)}x
              </span>
              ，运行中会出现 tick 超时告警。建议下调星系数量或提高 tick 速率。
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-border bg-background/30 px-3 py-2.5 text-xs text-muted-foreground/70">
            tick 时间预算占用{" "}
            <span className="font-mono tabular-nums text-primary">
              {formatFixed(impact.loadRatio, 2)}x
            </span>
            ，当前配置下调度器有充足余量。
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}
