import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import { downloadCsv } from "@/lib/csv"
import { formatDateTime } from "@/lib/format"
import type { LogEntry, LogModule } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { LogDetailPanel } from "@/components/logs/LogDetailPanel"
import { LogErrorPanel } from "@/components/logs/LogErrorPanel"
import { LogKpiRow } from "@/components/logs/LogKpiRow"
import { LogTable } from "@/components/logs/LogTable"
import { LogToolbar } from "@/components/logs/LogToolbar"

/** 时间范围下拉的取值 → 毫秒窗口。 */
const RANGE_WINDOW_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
}

export function LogsPage() {
  const { logs, now, clearLogs } = useEngine()

  const [levelFilter, setLevelFilter] = useState<string>("ALL")
  const [moduleFilter, setModuleFilter] = useState<string[]>([])
  const [query, setQuery] = useState<string>("")
  const [range, setRange] = useState<string>("all")
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [clearOpen, setClearOpen] = useState(false)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const windowMs = RANGE_WINDOW_MS[range] ?? 0
    const cutoff = windowMs > 0 ? now - windowMs : 0

    return logs.filter((entry) => {
      if (levelFilter !== "ALL" && entry.level !== levelFilter) return false
      if (moduleFilter.length > 0 && !moduleFilter.includes(entry.module)) return false
      if (cutoff > 0 && entry.ts < cutoff) return false
      if (needle === "") return true
      return entry.message.toLowerCase().includes(needle)
    })
  }, [logs, levelFilter, moduleFilter, query, range, now])

  const selectedLog: LogEntry | null = useMemo(
    () => logs.find((entry) => entry.id === selectedId) ?? null,
    [logs, selectedId],
  )

  const toggleModule = (module: LogModule) =>
    setModuleFilter((prev) =>
      prev.includes(module) ? prev.filter((item) => item !== module) : [...prev, module],
    )

  const handleExport = () => {
    if (filtered.length === 0) {
      toast.warning("当前筛选结果为空，没有可导出的日志")
      return
    }
    downloadCsv(
      "eve-logs.csv",
      ["时间", "级别", "模块", "内容"],
      filtered.map((entry) => [
        formatDateTime(entry.ts),
        entry.level,
        entry.module,
        entry.message,
      ]),
    )
    toast.success(`已导出 ${filtered.length} 条日志`)
  }

  return (
    <div className="flex flex-col gap-4">
      <LogKpiRow levelFilter={levelFilter} onLevelFilterChange={setLevelFilter} />

      <LogToolbar
        query={query}
        onQueryChange={setQuery}
        modules={moduleFilter}
        onToggleModule={toggleModule}
        range={range}
        onRangeChange={setRange}
        onExport={handleExport}
        onClear={() => setClearOpen(true)}
        resultCount={filtered.length}
        totalCount={logs.length}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <LogTable entries={filtered} selectedId={selectedId} onSelect={setSelectedId} />
          <LogDetailPanel entry={selectedLog} />
        </div>
        <LogErrorPanel entries={filtered} selectedId={selectedId} onSelect={setSelectedId} />
      </div>

      <Modal
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清空日志"
        description="日志缓冲会被立即清空，实时流从零开始，且无法恢复。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const removed = logs.length
                clearLogs()
                setSelectedId(null)
                setClearOpen(false)
                toast.error(`已清空 ${removed} 条日志`)
              }}
            >
              确认清空
            </Button>
          </>
        }
      >
        <div className="rounded-md border border-border bg-background/40 px-3 py-2.5 font-mono text-xs text-muted-foreground">
          当前缓冲 {logs.length} 条 · 覆盖全部级别与模块
        </div>
      </Modal>
    </div>
  )
}
