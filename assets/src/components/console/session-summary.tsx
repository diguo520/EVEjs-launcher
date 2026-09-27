import { Panel, StatTile } from "@/components/common/panel"
import { StatusDot } from "@/components/common/status-dot"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { LAUNCHER_META, SESSION } from "@/lib/mock"

/** 右侧会话概览：当前会话的核心读数 */
export function SessionSummary({
  logCount,
  runningCount,
  totalServices,
}: {
  logCount: number
  runningCount: number
  totalServices: number
}) {
  const { version } = useLauncherVersion()

  const readouts = [
    {
      k: "集群状态",
      v: `${runningCount}/${totalServices} RUNNING`,
      tone: runningCount === totalServices ? "text-success" : "text-warning",
    },
    {
      k: "告警",
      v: String(SESSION.alerts),
      tone: SESSION.alerts > 0 ? "text-warning" : "text-success",
    },
    { k: "更新通道", v: LAUNCHER_META.channel, tone: "text-muted-foreground" },
    { k: "启动器版本", v: version, tone: "text-muted-foreground" },
  ]

  return (
    <div className="flex flex-col gap-3">
      <Panel
        tag="// SESSION"
        title="会话概览"
        meta={
          <span className="flex items-center gap-1.5">
            <StatusDot tone="primary" pulse />
            LIVE
          </span>
        }
        bodyClassName="space-y-2.5"
      >
        <StatTile label="在线人数" value={SESSION.pilots} tone="success" />
        <StatTile label="PING" value={SESSION.ping} unit="ms" />
        <StatTile label="会话时长" value={SESSION.uptime} tone="primary" />
        <StatTile label="日志行数" value={logCount} delta="仅本机会话缓存" />
      </Panel>

      <Panel tag="// READOUT" title="链路读数" bodyClassName="space-y-2.5">
        {readouts.map((r) => (
          <div key={r.k} className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">{r.k}</span>
            <span className={`tabular text-[12px] font-semibold ${r.tone}`}>{r.v}</span>
          </div>
        ))}
        <p className="border-t border-input pt-2.5 text-[11px] leading-relaxed text-tertiary">
          日志仅在启动器运行期间保留，退出后自动丢弃。
        </p>
      </Panel>
    </div>
  )
}
