import { Loader2, Play, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { StatusDot } from "@/components/common/status-dot"
import { cn } from "@/lib/utils"

export function LaunchBanner({
  running,
  total,
  busy,
  blockers,
  onLaunchAll,
  onStopAll,
}: {
  running: number
  total: number
  busy: boolean
  /** 环境自检里缺了就没法启动的那几项，非空就是门禁挡着 */
  blockers: string[]
  onLaunchAll: () => void
  onStopAll: () => void
}) {
  const allUp = running === total
  const blocked = blockers.length > 0

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border",
        blocked
          ? "border-destructive/40 bg-destructive/[0.06]"
          : "border-primary/35 bg-primary/5"
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          blocked ? "bg-destructive" : "bg-primary"
        )}
      />
      <div className="flex flex-wrap items-center gap-4 py-3.5 pl-5 pr-4">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-md border",
            blocked
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-primary/40 bg-primary/10 text-primary"
          )}
        >
          <Play className="size-5" />
        </span>

        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-foreground">一键启动</span>
            <StatusDot
              tone={blocked ? "destructive" : allUp ? "primary" : "warning"}
              pulse={!allUp}
            />
            <span className="tabular text-[11px] text-muted-foreground">
              {running}/{total} RUNNING
            </span>
          </div>
          <p
            className={cn(
              "mt-1 text-[12px] leading-relaxed",
              blocked ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {blocked
              ? `环境自检门禁未放行：缺少 ${blockers.join("、")}，照环境自检里的指引补上再启动。`
              : "环境自检门禁 → 按序拉起全部服务。启动期间不要关闭启动器。"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* 门禁挡着就把按钮按死：拦不住就不叫门禁。理由就在旁边那行红字里 */}
          <Button
            onClick={onLaunchAll}
            disabled={busy || blocked}
            size="lg"
            className="px-7"
            title={blocked ? `缺少 ${blockers.join("、")}，补上后即可启动` : undefined}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Play />}
            {busy ? "启动中" : "一键启动"}
          </Button>
          <Button
            onClick={onStopAll}
            disabled={busy || running === 0}
            size="lg"
            variant="outline"
            className="hover:border-destructive/60 hover:text-destructive"
          >
            <Square />
            全部停止
          </Button>
        </div>
      </div>
    </div>
  )
}
