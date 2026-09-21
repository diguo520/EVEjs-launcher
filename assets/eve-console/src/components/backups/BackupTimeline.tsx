import { formatDateTime, formatInt } from "@/lib/format"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"
import { cn } from "@/lib/utils"
import { BackupKindBadge } from "./BackupKindBadge"
import type { Backup } from "@/lib/types"

export interface BackupTimelineProps {
  backups: Backup[]
  selectedId: string
  onSelect: (id: string) => void
  totalCount: number
}

function Dot({ latest }: { latest: boolean }) {
  return (
    <span
      className={cn(
        "absolute left-1/2 top-[14px] h-2.5 w-2.5 -translate-x-1/2 rounded-full border",
        latest
          ? "border-primary bg-primary ring-4 ring-primary/15"
          : "border-border bg-muted-foreground/40",
      )}
    />
  )
}

function Rail({ first, last, latest }: { first: boolean; last: boolean; latest: boolean }) {
  return (
    <div className="relative w-4 shrink-0">
      {first ? null : (
        <span className="absolute left-1/2 top-0 h-[14px] w-px -translate-x-1/2 bg-border" />
      )}
      {last ? null : (
        <span className="absolute bottom-0 left-1/2 top-[24px] w-px -translate-x-1/2 bg-border" />
      )}
      <Dot latest={latest} />
    </div>
  )
}

export function BackupTimeline({ backups, selectedId, onSelect, totalCount }: BackupTimelineProps) {
  return (
    <Panel className="flex min-w-0 flex-col">
      <PanelHeader
        eyebrow="snapshot timeline"
        title="快照时间线"
        actions={
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatInt(backups.length)} / {formatInt(totalCount)}
          </span>
        }
      />

      {backups.length === 0 ? (
        <EmptyState
          title="没有符合条件的快照"
          hint={totalCount === 0 ? "还没有任何快照，先新建一份" : "试试放宽类型筛选或清空搜索词"}
        />
      ) : (
        <div className="hud-scroll max-h-[620px] overflow-y-auto p-4">
          <ol className="flex flex-col">
            {backups.map((backup, index) => {
              const latest = index === 0
              const selected = backup.id === selectedId
              return (
                <li key={backup.id} className="flex gap-3 pb-3 last:pb-0">
                  <Rail first={index === 0} last={index === backups.length - 1} latest={latest} />

                  <button
                    type="button"
                    onClick={() => onSelect(backup.id)}
                    className={cn(
                      "min-w-0 flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                      selected
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-background/40 hover:border-primary/30 hover:bg-secondary/30",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {backup.label}
                      </span>
                      <BackupKindBadge kind={backup.kind} />
                      {latest ? (
                        <span className="hud-label text-[10px] text-primary">latest</span>
                      ) : null}
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
                        {formatDateTime(backup.createdAt)}
                      </span>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
                      <span>{formatInt(backup.sizeMb)} MB</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span>{backup.version}</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span>{formatInt(backup.playersAt)} 人在线</span>
                    </div>

                    {backup.note ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">
                        {backup.note}
                      </p>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Panel>
  )
}
