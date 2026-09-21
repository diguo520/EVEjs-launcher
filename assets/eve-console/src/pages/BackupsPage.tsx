import { useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import type { Backup } from "@/lib/types"
import { BackupStats } from "@/components/backups/BackupStats"
import { LocalProgressPanel } from "@/components/backups/LocalProgressPanel"
import { BackupToolbar } from "@/components/backups/BackupToolbar"
import { BackupTimeline } from "@/components/backups/BackupTimeline"
import { BackupDetailPanel } from "@/components/backups/BackupDetailPanel"
import { BackupConfirmDialog } from "@/components/backups/BackupConfirmDialog"
import { NewBackupDialog } from "@/components/backups/NewBackupDialog"

export function BackupsPage() {
  const { backups, now, serverStatus, createBackup, restoreBackup, deleteBackup } = useEngine()

  const [kindFilter, setKindFilter] = useState<string>("ALL")
  const [queryText, setQueryText] = useState<string>("")
  const [selectedId, setSelectedId] = useState<string>("")
  const [createOpen, setCreateOpen] = useState<boolean>(false)
  const [pendingRestore, setPendingRestore] = useState<Backup | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Backup | null>(null)

  /** 时间线按时间倒序，最新的排最上面。 */
  const sortedBackups = useMemo(
    () => [...backups].sort((a, b) => b.createdAt - a.createdAt),
    [backups],
  )

  const visibleBackups = useMemo(() => {
    const needle = queryText.trim().toLowerCase()
    return sortedBackups.filter((backup) => {
      if (kindFilter !== "ALL" && backup.kind !== kindFilter) return false
      if (needle === "") return true
      return `${backup.label} ${backup.note}`.toLowerCase().includes(needle)
    })
  }, [sortedBackups, kindFilter, queryText])

  const selectedBackup = sortedBackups.find((backup) => backup.id === selectedId) ?? null

  return (
    <div className="flex flex-col gap-4">
      {serverStatus === "running" ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm">服务端运行中，回滚操作已锁定</p>
            <p className="mt-0.5 text-xs text-amber-200/80">
              回滚会覆盖正在运行的世界状态。请先到控制台停止服务端，再回来执行回滚。
            </p>
          </div>
        </div>
      ) : null}

      <LocalProgressPanel />

      <BackupStats backups={backups} />

      <BackupToolbar
        kindFilter={kindFilter}
        queryText={queryText}
        onKindFilterChange={setKindFilter}
        onQueryTextChange={setQueryText}
        onCreate={() => setCreateOpen(true)}
        visibleCount={visibleBackups.length}
        totalCount={backups.length}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <BackupTimeline
          backups={visibleBackups}
          selectedId={selectedId}
          onSelect={setSelectedId}
          totalCount={backups.length}
        />

        <BackupDetailPanel
          backup={selectedBackup}
          serverStatus={serverStatus}
          now={now}
          onRestore={setPendingRestore}
          onExport={(backup) => {
            toast.success("快照已导出", { description: `${backup.label} · ${backup.sizeMb} MB` })
          }}
          onDelete={setPendingDelete}
        />
      </div>

      <NewBackupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(label, note) => {
          createBackup(label, note, "手动")
          setKindFilter("ALL")
          setQueryText("")
        }}
      />

      <BackupConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null)
        }}
        title="回滚世界状态"
        description="当前世界会被该快照整体覆盖，之后产生的进度无法找回。"
        confirmLabel="确认回滚"
        tone="primary"
        backup={pendingRestore}
        onConfirm={() => {
          if (pendingRestore) {
            restoreBackup(pendingRestore.id)
            toast.warning(`正在回滚到「${pendingRestore.label}」`, {
              description: `世界版本将还原至 ${pendingRestore.version}`,
            })
          }
          setPendingRestore(null)
        }}
      />

      <BackupConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="删除快照"
        description="删除后这份回滚点将永久消失，无法恢复。"
        confirmLabel="确认删除"
        tone="danger"
        backup={pendingDelete}
        onConfirm={() => {
          if (pendingDelete) {
            deleteBackup(pendingDelete.id)
            if (selectedId === pendingDelete.id) setSelectedId("")
            toast.error(`已删除快照「${pendingDelete.label}」`)
          }
          setPendingDelete(null)
        }}
      />
    </div>
  )
}
