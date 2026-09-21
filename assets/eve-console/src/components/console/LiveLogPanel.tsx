import { useEffect, useMemo, useRef, useState } from "react"
import { Pause, Play, Trash2 } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatClock } from "@/lib/format"
import type { LogLevel, LogModule } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { Select } from "@/components/ui/select"
import { cn } from "@/lib/utils"

const LEVEL_STYLE: Record<LogLevel, string> = {
  DEBUG: "text-muted-foreground/70",
  INFO: "text-foreground",
  WARN: "text-amber-300",
  ERROR: "text-red-300",
}

const LEVEL_BADGE: Record<LogLevel, string> = {
  DEBUG: "text-muted-foreground/70",
  INFO: "text-primary",
  WARN: "text-amber-300",
  ERROR: "text-red-300",
}

const MODULES: LogModule[] = ["星图", "市场", "战斗", "网络", "AI", "账号", "存档", "内核"]

export function LiveLogPanel({ className }: { className?: string }) {
  const { logs, clearLogs, serverStatus } = useEngine()
  const [levelFilter, setLevelFilter] = useState<LogLevel | "ALL">("ALL")
  const [moduleFilter, setModuleFilter] = useState<string>("ALL")
  const [paused, setPaused] = useState(false)
  /** 暂停时冻结的「已看过的条数」，恢复滚动后失效。 */
  const [frozenCount, setFrozenCount] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () =>
      logs.filter(
        (entry) =>
          (levelFilter === "ALL" || entry.level === levelFilter) &&
          (moduleFilter === "ALL" || entry.module === moduleFilter),
      ),
    [logs, levelFilter, moduleFilter],
  )

  // 日志按时间正序，可视窗口始终取末尾 160 条；暂停时钉住那一刻的窗口，
  // 而不是从头切 —— 否则一暂停就跳回最旧的一条。
  const visible = paused
    ? filtered.slice(Math.max(0, frozenCount - 160), Math.max(1, frozenCount))
    : filtered.slice(-160)

  useEffect(() => {
    if (paused) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [visible.length, paused])

  const counts = useMemo(() => {
    const base: Record<string, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 }
    logs.forEach((entry) => {
      base[entry.level] += 1
    })
    return base
  }, [logs])

  return (
    <Panel className={cn("flex min-h-0 flex-col", className)}>
      <PanelHeader
        eyebrow="live output"
        title="实时日志流"
        actions={
          <>
            <Select
              value={moduleFilter}
              onValueChange={setModuleFilter}
              className="h-7 w-[104px] text-xs"
              options={[
                { value: "ALL", label: "全部模块" },
                ...MODULES.map((m) => ({ value: m, label: m })),
              ]}
            />
            <Select
              value={levelFilter}
              onValueChange={(v) => setLevelFilter(v as LogLevel | "ALL")}
              className="h-7 w-[96px] text-xs"
              options={[
                { value: "ALL", label: "全部级别" },
                { value: "DEBUG", label: "DEBUG" },
                { value: "INFO", label: "INFO" },
                { value: "WARN", label: "WARN" },
                { value: "ERROR", label: "ERROR" },
              ]}
            />
            <Button
              size="icon"
              variant={paused ? "primary" : "ghost"}
              className="h-7 w-7"
              onClick={() => {
                setFrozenCount(filtered.length)
                setPaused((p) => !p)
              }}
              aria-label={paused ? "继续滚动" : "暂停滚动"}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={clearLogs}
              aria-label="清空日志"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      />

      <div
        ref={scrollRef}
        className="hud-scroll min-h-[220px] flex-1 overflow-y-auto bg-background/40 px-3 py-2"
      >
        {visible.length === 0 ? (
          <p className="py-10 text-center font-mono text-xs text-muted-foreground/60">
            {serverStatus === "stopped" ? "服务端未运行，暂无输出" : "没有符合过滤条件的日志"}
          </p>
        ) : (
          visible.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2 border-b border-border/30 py-1 font-mono text-xs leading-relaxed last:border-0"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground/50">
                {formatClock(entry.ts)}
              </span>
              <span className={cn("w-[46px] shrink-0 font-semibold", LEVEL_BADGE[entry.level])}>
                {entry.level}
              </span>
              <span className="w-[40px] shrink-0 text-muted-foreground">[{entry.module}]</span>
              <span className={cn("min-w-0 flex-1 break-all", LEVEL_STYLE[entry.level])}>
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/70">
        <span>
          共 {logs.length} 条 · 显示 {visible.length} 条{paused ? " · 已暂停滚动" : ""}
        </span>
        <span className="flex items-center gap-3">
          <span>INFO {counts.INFO}</span>
          <span className="text-amber-300/80">WARN {counts.WARN}</span>
          <span className="text-red-300/80">ERROR {counts.ERROR}</span>
        </span>
      </div>
    </Panel>
  )
}
