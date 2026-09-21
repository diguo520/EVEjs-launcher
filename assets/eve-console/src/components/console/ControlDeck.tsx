import { AlertTriangle, Play, RotateCw, Skull, Square } from "lucide-react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import { formatInt, formatUptime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { STATUS_META } from "@/components/layout/ServerStatusPill"
import { cn } from "@/lib/utils"
import { BootSequence } from "./BootSequence"

const STATUS_ACCENT: Record<string, string> = {
  stopped: "text-muted-foreground",
  starting: "text-amber-300",
  running: "text-primary",
  stopping: "text-amber-300",
  crashed: "text-red-300",
}

/** 停止态下先摆出这次启动会装载什么，让人对规模有概念。 */
function PreflightList() {
  const { config } = useEngine()
  const rows = [
    { label: "星系", value: formatInt(config.systems) },
    { label: "星门", value: formatInt(Math.round(config.systems * 1.51)) },
    { label: "小行星带", value: formatInt(Math.round(config.systems * 3.48)) },
    { label: "势力 AI 行为树", value: formatInt(148) },
    { label: "网关端口", value: `0.0.0.0:${config.port}` },
  ]

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="hud-label text-[10px] text-muted-foreground/70">{row.label}</dt>
          <dd className="truncate font-mono text-sm tabular-nums text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ControlDeck() {
  const {
    serverStatus,
    uptime,
    tickCount,
    config,
    crashReason,
    start,
    stop,
    restart,
    simulateCrash,
    accounts,
  } = useEngine()

  const meta = STATUS_META[serverStatus]
  const busy = serverStatus === "starting" || serverStatus === "stopping"
  const online = accounts.filter((a) => a.status === "online").length

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="hud-label text-[10px] text-muted-foreground/70">shard status</p>
          <div className="mt-1 flex items-baseline gap-3">
            <span className={cn("text-4xl font-semibold leading-none", STATUS_ACCENT[serverStatus])}>
              {meta.label}
            </span>
            {serverStatus === "running" ? (
              <span className="font-mono text-sm tabular-nums text-muted-foreground">
                {formatUptime(uptime)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {serverStatus === "running"
              ? `${config.serverName} 正在 0.0.0.0:${config.port} 上运行，${formatInt(online)} 名舰长在线，累计 tick ${formatInt(tickCount)}。`
              : serverStatus === "starting"
                ? "正在装载世界，装载期间请勿关闭窗口。"
                : serverStatus === "stopping"
                  ? "正在安全下线并写入退出存档 …"
                  : serverStatus === "crashed"
                    ? `上次运行非正常退出：${crashReason || "未知原因"}`
                    : "世界当前未运行。启动后即可进入自己的新伊甸。"}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {serverStatus === "running" || serverStatus === "starting" ? (
            <Button size="lg" variant="outline" disabled={busy} onClick={stop}>
              <Square className="h-4 w-4" />
              停止服务端
            </Button>
          ) : (
            <Button
              size="lg"
              variant="primary"
              disabled={busy}
              onClick={() => {
                start()
                toast.success("已下发启动指令", { description: "冷启动序列开始执行" })
              }}
            >
              <Play className="h-4 w-4" />
              {serverStatus === "crashed" ? "重新启动" : "启动服务端"}
            </Button>
          )}

          <Button
            size="lg"
            variant="secondary"
            disabled={busy || serverStatus === "stopped"}
            onClick={restart}
          >
            <RotateCw className="h-4 w-4" />
            重启
          </Button>

          <Button
            size="lg"
            variant="ghost"
            disabled={serverStatus !== "running"}
            onClick={simulateCrash}
            title="触发一次模拟崩溃，用来验证回滚流程"
          >
            <Skull className="h-4 w-4" />
            模拟崩溃
          </Button>
        </div>
      </div>

      <div className="border-t border-border bg-background/30 px-5 py-4">
        {serverStatus === "starting" ? (
          <BootSequence />
        ) : serverStatus === "crashed" ? (
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3.5 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div className="min-w-0">
              <p className="text-sm text-red-200">服务端非正常退出</p>
              <p className="mt-0.5 font-mono text-xs text-red-200/80">{crashReason}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                建议先到「存档与备份」回滚到最近一份自动快照，再重新启动。
              </p>
            </div>
          </div>
        ) : (
          <PreflightList />
        )}
      </div>
    </Panel>
  )
}
