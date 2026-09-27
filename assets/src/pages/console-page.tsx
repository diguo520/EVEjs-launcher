import { SectionHeading } from "@/components/common/panel"
import { LogPanel } from "@/components/console/log-panel"
import { SessionSummary } from "@/components/console/session-summary"
import type { LauncherState } from "@/hooks/use-launcher"

export function ConsolePage({ launcher }: { launcher: LauncherState }) {
  return (
    <div className="space-y-4">
      <SectionHeading
        title="服务器日志"
        sub="// SERVER LOGS"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            集群 {launcher.runningCount}/{launcher.services.length} RUNNING · 在线{" "}
            {launcher.onlineCount}
          </span>
        }
      />

      {/* [&>*]:min-w-0：格子的最小宽度默认跟着内容走，日志面板头部很宽，窄窗会被它顶破 */}
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_260px] [&>*]:min-w-0">
        <LogPanel
          logs={launcher.logs}
          onClear={launcher.clearLogs}
          className="h-[560px]"
        />

        <SessionSummary
          logCount={launcher.logs.length}
          runningCount={launcher.runningCount}
          totalServices={launcher.services.length}
        />
      </div>
    </div>
  )
}
