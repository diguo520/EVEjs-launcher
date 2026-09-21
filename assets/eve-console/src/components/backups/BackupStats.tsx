import { useMemo } from "react"
import { Clock3, Database, HardDrive, Tag } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatInt, formatRelative } from "@/lib/format"
import { Panel } from "@/components/ui/panel"
import type { Backup } from "@/lib/types"

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: typeof Database
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <Panel className="flex min-w-0 flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <Icon className={accent ? "h-3.5 w-3.5 shrink-0 text-primary" : "h-3.5 w-3.5 shrink-0 text-muted-foreground"} />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <span className="font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
        {value}
      </span>
      {sub ? (
        <span className="truncate font-mono text-[10px] text-muted-foreground/60">{sub}</span>
      ) : null}
    </Panel>
  )
}

export function BackupStats({ backups }: { backups: Backup[] }) {
  const { now } = useEngine()

  const summary = useMemo(() => {
    const totalMb = backups.reduce((sum, backup) => sum + backup.sizeMb, 0)
    const latest = backups.reduce<Backup | null>(
      (newest, backup) => (newest === null || backup.createdAt > newest.createdAt ? backup : newest),
      null,
    )
    return { totalMb, latest }
  }, [backups])

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        icon={Database}
        label="快照总数"
        value={formatInt(backups.length)}
        sub={`手动 ${backups.filter((b) => b.kind === "手动").length} · 自动 ${
          backups.filter((b) => b.kind === "自动").length
        } · 启动前 ${backups.filter((b) => b.kind === "启动前").length}`}
      />
      <Stat
        icon={HardDrive}
        label="占用总空间"
        value={`${formatInt(summary.totalMb)} MB`}
        sub="全部快照合计体积"
      />
      <Stat
        icon={Clock3}
        label="最近一次备份"
        value={summary.latest ? formatRelative(summary.latest.createdAt, now) : "—"}
        sub={summary.latest ? summary.latest.label : "尚无任何快照"}
      />
      <Stat
        icon={Tag}
        label="当前存档版本"
        value={summary.latest ? summary.latest.version : "—"}
        sub="最新快照记录的世界版本"
        accent
      />
    </div>
  )
}
