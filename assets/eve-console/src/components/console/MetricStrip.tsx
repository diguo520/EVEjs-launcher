import { Cpu, Gauge, HardDrive, Users, Wifi } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatInt } from "@/lib/format"
import { Sparkline } from "@/components/ui/sparkline"
import { Panel } from "@/components/ui/panel"
import { cn } from "@/lib/utils"

function MetricTile({
  icon: Icon,
  label,
  value,
  unit,
  sub,
  series,
  max,
  tone = "primary",
  className,
}: {
  icon: typeof Cpu
  label: string
  value: string
  unit?: string
  sub?: string
  series: number[]
  max?: number
  tone?: "primary" | "warn" | "danger" | "neutral"
  className?: string
}) {
  return (
    <Panel className={cn("flex min-w-0 flex-col gap-2 p-3", className)}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
          {value}
        </span>
        {unit ? <span className="font-mono text-xs text-muted-foreground">{unit}</span> : null}
      </div>
      <Sparkline data={series} max={max} height={34} tone={tone} />
      <p className="truncate font-mono text-[10px] text-muted-foreground/60">{sub ?? " "}</p>
    </Panel>
  )
}

export function MetricStrip() {
  const { samples, config, serverStatus } = useEngine()

  const last = samples.length > 0 ? samples[samples.length - 1] : null
  const running = serverStatus === "running"
  const dash = "--"

  const peakPlayers = samples.reduce((max, s) => Math.max(max, s.players), 0)
  const avgFrame =
    samples.length > 0
      ? samples.reduce((sum, s) => sum + s.frameMs, 0) / samples.length
      : config.tickRate > 0
        ? 1000 / config.tickRate
        : 0

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      <MetricTile
        icon={Cpu}
        label="cpu 占用"
        value={running && last ? last.cpu.toFixed(0) : dash}
        unit="%"
        sub={running ? `负载 ${Math.round((last?.cpu ?? 0) / 10)}/10` : "服务端未运行"}
        series={samples.map((s) => s.cpu)}
        max={100}
        tone={(last?.cpu ?? 0) > 80 ? "warn" : "primary"}
      />
      <MetricTile
        icon={HardDrive}
        label="内存占用"
        value={running && last ? formatInt(last.mem) : dash}
        unit="MB"
        sub={running ? `上限 ${formatInt(6400)} MB` : "服务端未运行"}
        series={samples.map((s) => s.mem)}
        max={6400}
      />
      <MetricTile
        icon={Gauge}
        label="tick 速率"
        value={running && last ? String(last.tick) : dash}
        unit="/s"
        sub={running ? `单 tick ${avgFrame.toFixed(1)} ms` : "服务端未运行"}
        series={samples.map((s) => s.frameMs)}
        tone={avgFrame > 120 ? "warn" : "primary"}
      />
      <MetricTile
        icon={Users}
        label="在线玩家"
        value={running && last ? String(last.players) : dash}
        unit={`/ ${config.maxPlayers}`}
        sub={running ? `峰值 ${peakPlayers} 人` : "服务端未运行"}
        series={samples.map((s) => s.players)}
        max={config.maxPlayers}
      />
      <MetricTile
        icon={Wifi}
        label="网络吞吐"
        value={running && last ? last.net.toFixed(1) : dash}
        unit="Mbps"
        sub={running ? `端口 ${config.port}` : "服务端未运行"}
        series={samples.map((s) => s.net)}
        tone="primary"
        className={cn("hidden xl:flex")}
      />
    </div>
  )
}
