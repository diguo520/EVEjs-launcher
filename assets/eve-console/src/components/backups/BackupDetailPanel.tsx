import { Download, RotateCcw, Trash2 } from "lucide-react"
import { formatDateTime, formatInt, formatRelative } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"
import { Tooltip } from "@/components/ui/tooltip"
import { BackupKindBadge } from "./BackupKindBadge"
import type { Backup, ServerStatus } from "@/lib/types"

export interface BackupDetailPanelProps {
  backup: Backup | null
  serverStatus: ServerStatus
  now: number
  onRestore: (backup: Backup) => void
  onExport: (backup: Backup) => void
  onDelete: (backup: Backup) => void
}

function DetailRow({
  label,
  value,
  mono = true,
  wide = false,
}: {
  label: string
  value: string
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="hud-label text-[10px] text-muted-foreground/70">{label}</dt>
      <dd
        className={
          mono
            ? "mt-0.5 break-all font-mono text-sm tabular-nums text-foreground"
            : "mt-0.5 break-words text-sm text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  )
}

export function BackupDetailPanel({
  backup,
  serverStatus,
  now,
  onRestore,
  onExport,
  onDelete,
}: BackupDetailPanelProps) {
  const restoreLocked = serverStatus === "running" || serverStatus === "starting"

  return (
    <Panel className="flex min-w-0 flex-col">
      <PanelHeader
        eyebrow="snapshot detail"
        title={backup ? backup.label : "快照详情"}
        actions={backup ? <BackupKindBadge kind={backup.kind} /> : null}
      />

      {backup === null ? (
        <EmptyState title="从左侧选一份快照查看详情" hint="点击时间线上的任意节点" />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <DetailRow label="快照标识" value={backup.id} />
            <DetailRow label="类型" value={backup.kind} />
            <DetailRow label="创建时间" value={formatDateTime(backup.createdAt)} />
            <DetailRow label="距今" value={formatRelative(backup.createdAt, now)} />
            <DetailRow label="大小" value={`${formatInt(backup.sizeMb)} MB`} />
            <DetailRow label="世界版本" value={backup.version} />
            <DetailRow label="当时在线人数" value={`${formatInt(backup.playersAt)} 人`} />
            <div className="col-span-2 min-w-0">
              <dt className="hud-label text-[10px] text-muted-foreground/70">备注</dt>
              <dd className="mt-0.5 break-words text-sm text-muted-foreground">
                {backup.note || "（无备注）"}
              </dd>
            </div>
          </dl>

          <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
            回滚会把世界状态整体还原到该快照，之后产生的存档会被覆盖。该快照时刻有{" "}
            <span className="font-mono tabular-nums text-foreground">
              {formatInt(backup.playersAt)}
            </span>{" "}
            名舰长在线。
          </p>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip
                content={
                  restoreLocked ? "服务端运行中或正在启动，回滚会损坏世界状态" : "把世界还原到该快照"
                }
              >
                <span className="inline-flex">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={restoreLocked}
                    onClick={() => onRestore(backup)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    回滚到此处
                  </Button>
                </span>
              </Tooltip>

              <Button variant="secondary" size="md" onClick={() => onExport(backup)}>
                <Download className="h-3.5 w-3.5" />
                导出
              </Button>

              <Button
                variant="danger"
                size="md"
                className="ml-auto"
                onClick={() => onDelete(backup)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            </div>

            {restoreLocked ? (
              <p className="text-xs text-amber-300">请先停止服务端再回滚</p>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  )
}
