import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { formatDateTime, formatInt } from "@/lib/format"
import type { Backup } from "@/lib/types"

export interface BackupConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  tone: "primary" | "danger"
  backup: Backup | null
  onConfirm: () => void
}

export function BackupConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  backup,
  onConfirm,
}: BackupConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant={tone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {backup ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <span className="text-sm font-semibold text-foreground">{backup.label}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDateTime(backup.createdAt)} · {formatInt(backup.sizeMb)} MB · {backup.version} ·{" "}
            {formatInt(backup.playersAt)} 人在线
          </span>
          {backup.note ? (
            <span className="text-xs text-muted-foreground/80">{backup.note}</span>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
