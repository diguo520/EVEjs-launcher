import { X } from "lucide-react"
import type { InstallTask, MarketMod } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Panel, PanelHeader } from "@/components/ui/panel"

export interface MarketInstallQueueProps {
  tasks: InstallTask[]
  market: MarketMod[]
  onCancel: (id: string) => void
}

/** 下载队列：只在有任务时出现，跑满进度条后自动落进模组清单。 */
export function MarketInstallQueue({ tasks, market, onCancel }: MarketInstallQueueProps) {
  if (tasks.length === 0) return null

  return (
    <Panel className="border-primary/40">
      <PanelHeader
        eyebrow="download queue"
        title="正在下载"
        actions={<Badge tone="primary">{tasks.length} 个任务</Badge>}
      />
      <div className="flex flex-col gap-2 p-3">
        {tasks.map((task) => {
          const entry = market.find((m) => m.id === task.id)
          const name = entry?.name ?? task.id
          const pct = Math.round(task.progress)

          return (
            <div key={task.id} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-xs text-foreground">{name}</span>
              <Badge tone="outline" className="shrink-0 px-1 py-0 text-[10px]">
                {task.mode === "update" ? "更新" : "安装"}
              </Badge>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150 ease-linear"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-primary">
                {pct}%
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
                {entry ? `${entry.sizeMb} MB` : ""}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => onCancel(task.id)}
                aria-label={`取消下载 ${name}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
