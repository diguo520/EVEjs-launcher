import { Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { LEVEL_FILTER_ORDER, type LevelFilter } from "@/lib/log-logic"

const FILTER_TONE: Record<LevelFilter, string> = {
  all: "text-muted-foreground",
  INFO: "text-primary",
  WARN: "text-warning",
  ERROR: "text-destructive",
  DEBUG: "text-tertiary",
}

const FILTER_LABEL: Record<LevelFilter, string> = {
  all: "全部",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  DEBUG: "DEBUG",
}

/** 日志级别过滤条：每档带实时计数，颜色即语义 */
export function LogLevelFilter({
  value,
  onChange,
  counts,
  className,
}: {
  value: LevelFilter
  onChange: (v: LevelFilter) => void
  counts: Record<LevelFilter, number>
  className?: string
}) {
  // DEBUG 只在真的有这类日志时才摆出来
  const order = LEVEL_FILTER_ORDER.filter(
    (key) => key !== "DEBUG" || counts.DEBUG > 0
  )

  return (
    /* 五档挤不下就换行：一条不换行会顶出面板，窄窗下整页跟着长出一条横向滚动条 */
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {order.map((key) => {
        const active = value === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors",
              active
                ? "border-border bg-secondary " + FILTER_TONE[key]
                : "border-transparent text-tertiary hover:bg-secondary/60 hover:text-muted-foreground"
            )}
          >
            {FILTER_LABEL[key]}
            <span className="tabular text-[10px] opacity-70">{counts[key]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 日志关键字过滤框：只比正文与来源，右侧显示命中行数 */
export function LogSearch({
  value,
  onChange,
  hits,
  className,
}: {
  value: string
  onChange: (value: string) => void
  hits: number
  className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="过滤日志"
        aria-label="过滤日志"
        className={cn("h-7 pl-7 text-[11px]", value ? "pr-14" : "pr-2")}
      />
      {value ? (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <span className="tabular text-[10px] text-tertiary">{hits}</span>
          <button
            type="button"
            onClick={() => onChange("")}
            title="清除关键字"
            className="rounded-sm text-tertiary transition-colors hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
