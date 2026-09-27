import * as React from "react"
import { ArrowDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { splitHits } from "@/lib/log-logic"
import type { LogLevel, LogLine } from "@/lib/mock"

const levelClass: Record<LogLevel, string> = {
  INFO: "text-primary/90",
  WARN: "text-warning",
  ERROR: "text-destructive",
  DEBUG: "text-tertiary",
}

const messageClass: Record<LogLevel, string> = {
  INFO: "text-foreground/85",
  WARN: "text-warning/90",
  ERROR: "text-destructive/90",
  DEBUG: "text-muted-foreground",
}

/** 距底部多少像素内还算"在底部"，留一点余量免得抖动 */
const STICK_PX = 24

export interface ConsoleViewProps extends React.HTMLAttributes<HTMLDivElement> {
  lines: LogLine[]
  /** 行尾是否追加光标 */
  cursor?: boolean
  /** 需要标出来的关键字 */
  highlight?: string
}

/** 终端输出：时间戳 / 级别 / 来源 / 正文 四栏对齐，等宽字体 */
export function ConsoleView({
  lines,
  cursor = false,
  highlight = "",
  className,
  ...props
}: ConsoleViewProps) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  // 跟着最新一行走；手动往上翻就停住，翻回底部自动恢复
  const [follow, setFollow] = React.useState(true)
  const pausedAt = React.useRef(0)

  React.useEffect(() => {
    if (!follow) return
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [lines, follow])

  function onScroll() {
    const box = boxRef.current
    if (!box) return
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX
    if (bottom) {
      setFollow(true)
      return
    }
    // 停在当前位置：记下已经看到哪一行，之后新增几行就提示几条
    if (follow) pausedAt.current = lines.length
    setFollow(false)
  }

  const missed = follow ? 0 : Math.max(0, lines.length - pausedAt.current)

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} {...props}>
      <div
        ref={boxRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-background/70 px-3 py-2.5 font-mono text-[12px] leading-[1.75]"
      >
        {lines.map((line) => (
          <div key={line.id} className="flex gap-3 whitespace-pre-wrap break-words">
            <span className="shrink-0 text-tertiary">{line.t}</span>
            <span className={cn("w-11 shrink-0 font-semibold", levelClass[line.level])}>
              {line.level}
            </span>
            <span className="hidden w-16 shrink-0 text-muted-foreground sm:inline">
              {line.src}
            </span>
            {line.badge ? (
              <span className="h-fit shrink-0 rounded-sm border border-primary/45 bg-primary/10 px-1 text-[10px] font-semibold tracking-[0.08em] text-primary">
                {line.badge}
              </span>
            ) : null}
            <span className={cn("min-w-0 flex-1", messageClass[line.level])}>
              {splitHits(line.msg, highlight).map((part, index) =>
                part.hit ? (
                  <span key={index} className="rounded-sm bg-primary/25 text-foreground">
                    {part.text}
                  </span>
                ) : (
                  <span key={index}>{part.text}</span>
                )
              )}
            </span>
          </div>
        ))}
        {cursor ? (
          <div className="flex gap-2 text-primary">
            <span>▌</span>
          </div>
        ) : null}
        {lines.length === 0 ? (
          <div className="py-6 text-center text-tertiary">暂无日志输出</div>
        ) : null}
      </div>

      {follow ? null : (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute bottom-2 right-3 inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-background/90 px-2 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          <ArrowDown className="size-3" />
          {missed > 0 ? `${missed} 条新日志` : "回到最新"}
        </button>
      )}
    </div>
  )
}
