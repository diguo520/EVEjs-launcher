import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Copy, Eraser } from "lucide-react"

import { cn } from "@/lib/utils"
import { ConsoleView } from "@/components/common/console-view"
import { Panel } from "@/components/common/panel"
import { LogLevelFilter, LogSearch } from "@/components/common/log-toolbar"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  LOG_TABS,
  LOG_TAB_LABEL,
  filterLogs,
  levelCounts,
  type LevelFilter,
  type LogTab,
} from "@/lib/log-logic"
import type { LogLine } from "@/lib/mock"

/** 全高终端面板：页签切换日志来源，关键字与级别二次收窄，内部滚动 */
export function LogPanel({
  logs,
  onClear,
  className,
}: {
  logs: LogLine[]
  onClear: () => void
  className?: string
}) {
  const [tab, setTab] = useState<LogTab>("sys")
  const [level, setLevel] = useState<LevelFilter>("all")
  const [keyword, setKeyword] = useState("")

  const matched = useMemo(
    () => filterLogs(logs, { tab, keyword }),
    [logs, tab, keyword]
  )
  const counts = useMemo(() => levelCounts(matched), [matched])
  const visible = useMemo(() => filterLogs(matched, { level }), [matched, level])

  async function copyVisible() {
    const text = visible
      .map((l) => `${l.t}  ${l.level.padEnd(5)} ${l.src.padEnd(8)} ${l.msg}`)
      .join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`已复制 ${visible.length} 行日志`, {
        description: `来源：${LOG_TAB_LABEL[tab]}`,
      })
    } catch {
      toast.error("复制失败", { description: "当前环境未授权访问剪贴板。" })
    }
  }

  return (
    <Panel
      tag="// SHELL"
      title={<span className="normal-case">root@tranquility</span>}
      meta={`${visible.length} / ${logs.length} 行`}
      flush
      className={cn("h-[420px]", className)}
      bodyClassName="flex min-h-0 flex-col"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={copyVisible}
            disabled={visible.length === 0}
            title="复制当前筛选结果"
          >
            <Copy />
            复制
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={logs.length === 0}
            title="清空全部日志"
            className="hover:text-destructive"
          >
            <Eraser />
            清空
          </Button>
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as LogTab)}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-input px-4 py-1.5">
          {/* min-w-0：标签条得能在这一行里被压缩，压不动就会把整页撑出横向滚动 */}
          <TabsList className="min-w-0 border-0">
            {LOG_TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="px-2 py-1">
                {LOG_TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex flex-wrap items-center gap-2">
            <LogLevelFilter value={level} onChange={setLevel} counts={counts} />
            <LogSearch
              value={keyword}
              onChange={setKeyword}
              hits={matched.length}
            />
          </div>
        </div>
      </Tabs>

      <ConsoleView
        lines={visible}
        cursor
        highlight={keyword}
        className="min-h-0 flex-1"
      />
    </Panel>
  )
}
