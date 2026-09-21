import { useState } from "react"
import { useLocation } from "react-router-dom"
import { Activity, Clock, Cpu, Download, Users } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatInt, formatUptime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { ServerStatusPill } from "./ServerStatusPill"
import { OfflineExportDialog } from "./OfflineExportDialog"

const ROUTE_META: Record<string, { title: string; eyebrow: string }> = {
  "/": { title: "指挥台", eyebrow: "command deck" },
  "/universe": { title: "宇宙参数", eyebrow: "universe tuning" },
  "/accounts": { title: "账号与角色", eyebrow: "pilot roster" },
  "/logs": { title: "日志中心", eyebrow: "event stream" },
  "/backups": { title: "存档与备份", eyebrow: "snapshots" },
  "/mods": { title: "模组管理", eyebrow: "load order" },
}

function Readout({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: typeof Activity
  label: string
  value: string
  tone?: "default" | "primary"
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5 shadow-sm">
      <Icon className={tone === "primary" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5 text-muted-foreground"} />
      <span className="hud-label text-[10px] text-muted-foreground/70">{label}</span>
      <span className="font-mono text-xs tabular-nums text-foreground">{value}</span>
    </div>
  )
}

export function TopBar() {
  const { pathname } = useLocation()
  const { serverStatus, uptime, samples, accounts, config, now } = useEngine()
  const [exportOpen, setExportOpen] = useState(false)

  const meta = ROUTE_META[pathname] ?? ROUTE_META["/"]
  const last = samples.length > 0 ? samples[samples.length - 1] : null
  const online = accounts.filter((a) => a.status === "online").length
  const clock = new Date(now).toLocaleTimeString("en-GB", { hour12: false })

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card/40 px-5 py-2.5 backdrop-blur-sm">
      <div className="min-w-0">
        <p className="hud-label text-[10px] text-muted-foreground/70">{meta.eyebrow}</p>
        <h1 className="truncate text-lg font-semibold text-foreground">{meta.title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ServerStatusPill serverStatus={serverStatus} className="h-7 px-2.5" />
        <div className="hidden items-center gap-2 xl:flex">
          <Readout icon={Clock} label="运行" value={serverStatus === "running" ? formatUptime(uptime) : "--:--:--"} />
          <Readout
            icon={Activity}
            label="tick"
            value={last ? `${last.tick}/s · ${last.frameMs.toFixed(0)}ms` : `${config.tickRate}/s`}
            tone="primary"
          />
          <Readout icon={Cpu} label="cpu" value={last ? `${last.cpu.toFixed(0)}%` : "--"} />
          <Readout icon={Users} label="在线" value={`${formatInt(online)}/${config.maxPlayers}`} />
        </div>
        <span className="hidden font-mono text-xs tabular-nums text-muted-foreground lg:inline">
          {clock}
        </span>

        {/* 顶栏是唯一常驻的位置：无论停在哪一页，都能把整份指挥台打包带走。 */}
        <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
          <Download className="h-3.5 w-3.5" />
          下载离线版
        </Button>
      </div>

      <OfflineExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </header>
  )
}
