import { useMemo, useState } from "react"
import { Eraser } from "lucide-react"

import { Panel } from "@/components/common/panel"
import { ConsoleView } from "@/components/common/console-view"
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

export function LiveConsole({
  logs,
  onClear,
}: {
  logs: LogLine[]
  onClear: () => void
}) {
  const [tab, setTab] = useState<LogTab>("sys")
  const [level, setLevel] = useState<LevelFilter>("all")
  const [keyword, setKeyword] = useState("")

  // 计数按"页签 + 关键字"收窄后的结果算：点某一档就知道这一档有几条命中
  const matched = useMemo(
    () => filterLogs(logs, { tab, keyword }),
    [logs, tab, keyword]
  )
  const counts = useMemo(() => levelCounts(matched), [matched])
  const visible = useMemo(() => filterLogs(matched, { level }), [matched, level])

  return (
    <Panel
      tag="// CONSOLE"
      title="实时日志"
      meta={`${visible.length} 行 · 自动滚动`}
      flush
      // 只兜住最小高度：单列时给终端一块够用的地方，两列时由同行的面板决定行高
      className="min-h-[420px]"
      bodyClassName="flex min-h-0 flex-col"
      actions={
        <Button variant="ghost" size="sm" onClick={onClear} title="清空当前日志">
          <Eraser />
          清空
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as LogTab)}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-input px-4 py-1.5">
          {/* min-w-0：标签条得能在这一行里被压缩，压不动就会把整页撑出横向滚动 */}
          <TabsList className="min-w-0 border-0">
            {LOG_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
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

      {/* contain:size：终端自己滚，内容不参与面板的高度计算。
          否则日志一多就把整行撑高，右边的环境自检跟着被拉长 */}
      <ConsoleView
        lines={visible}
        cursor
        highlight={keyword}
        className="min-h-0 flex-1 [contain:size]"
      />
    </Panel>
  )
}
