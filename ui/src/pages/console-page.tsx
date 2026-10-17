import { SectionHeading } from "@/components/common/panel"
import { LogPanel } from "@/components/console/log-panel"
import { LogArchives } from "@/components/console/log-archives"
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
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_300px] [&>*]:min-w-0">
        <LogPanel
          logs={launcher.logs}
          onClear={launcher.clearLogs}
          className="h-[560px]"
        />

        {/* 右栏跟日志面板同高：原来这里是「会话概览 + 链路读数」两块读数板，
            现在换成三组存档日志（主服务器 / 市场服务 / 客户端）—— 读数在顶栏与状态栏
            已经各有一份，这一列留给「上一轮到底打印了什么」更有用 */}
        <LogArchives className="h-[560px]" />
      </div>
    </div>
  )
}
