import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useEngine, type AccountDraft } from "@/lib/engine"
import type { Account } from "@/lib/types"
import { downloadCsv } from "@/lib/csv"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { AccountStats } from "@/components/accounts/AccountStats"
import { AccountToolbar, type AccountFilters } from "@/components/accounts/AccountToolbar"
import { AccountTable, type AccountSortKey } from "@/components/accounts/AccountTable"
import { AccountDialog } from "@/components/accounts/AccountDialog"
import { GrantDialog } from "@/components/accounts/GrantDialog"
import { BulkActionBar } from "@/components/accounts/BulkActionBar"

const INITIAL_FILTERS: AccountFilters = {
  query: "",
  status: "ALL",
  faction: "ALL",
  role: "ALL",
}

export function AccountsPage() {
  const {
    accounts,
    now,
    createAccount,
    updateAccount,
    removeAccount,
    grantIsk,
    grantSp,
    setAccountStatus,
  } = useEngine()

  const [filters, setFilters] = useState<AccountFilters>(INITIAL_FILTERS)
  const [sortKey, setSortKey] = useState<AccountSortKey>("isk")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantMode, setGrantMode] = useState<"isk" | "sp">("isk")
  const [grantTargets, setGrantTargets] = useState<Account[]>([])
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null)

  const patchFilters = (patch: Partial<AccountFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }))

  const filtered = useMemo(() => {
    const needle = filters.query.trim().toLowerCase()
    return accounts.filter((account) => {
      if (filters.status !== "ALL" && account.status !== filters.status) return false
      if (filters.faction !== "ALL" && account.faction !== filters.faction) return false
      if (filters.role !== "ALL" && account.role !== filters.role) return false
      if (needle === "") return true
      return [account.character, account.username, account.corp, account.shipName, account.solarSystem]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    })
  }, [accounts, filters])

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1
    return [...filtered].sort((a, b) => {
      const left = a[sortKey]
      const right = b[sortKey]
      if (typeof left === "string" && typeof right === "string") {
        return left.localeCompare(right, "zh-Hans-CN") * dir
      }
      return ((left as number) - (right as number)) * dir
    })
  }, [filtered, sortKey, sortDir])

  const handleSort = (key: AccountSortKey) => {
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "character" ? "asc" : "desc")
    }
  }

  const toggleRow = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const toggleAll = () => {
    const visibleIds = sorted.map((a) => a.id)
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
    setSelectedIds(allSelected ? [] : visibleIds)
  }

  const selectedAccounts = accounts.filter((a) => selectedIds.includes(a.id))

  const exportRows = (list: Account[], filename: string) => {
    downloadCsv(
      filename,
      ["角色名", "账号", "军团", "势力", "权限", "ISK", "技能点", "安等", "状态", "舰船", "所在星系", "游玩时长(小时)"],
      list.map((a) => [
        a.character,
        a.username,
        a.corp,
        a.faction,
        a.role,
        a.isk,
        a.skillPoints,
        a.securityStatus,
        a.status === "online" ? "在线" : a.status === "banned" ? "已封禁" : "离线",
        a.shipName,
        a.solarSystem,
        a.playtimeHours,
      ]),
    )
    toast.success(`已导出 ${list.length} 条账号记录`)
  }

  const openGrant = (targets: Account[], mode: "isk" | "sp") => {
    setGrantTargets(targets)
    setGrantMode(mode)
    setGrantOpen(true)
  }

  const handleEditorSubmit = (draft: AccountDraft) => {
    if (editingAccount) {
      updateAccount(editingAccount.id, draft)
    } else {
      createAccount(draft)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <AccountStats accounts={accounts} />

      <AccountToolbar
        filters={filters}
        onFiltersChange={patchFilters}
        onCreate={() => {
          setEditingAccount(null)
          setEditorOpen(true)
        }}
        onExport={() => exportRows(sorted, "eve-accounts.csv")}
        resultCount={sorted.length}
        totalCount={accounts.length}
      />

      <BulkActionBar
        count={selectedIds.length}
        onGrant={(mode) => openGrant(selectedAccounts, mode)}
        onBan={() => {
          setAccountStatus(selectedIds, "banned")
          toast.warning(`已封禁 ${selectedIds.length} 个账号`)
          setSelectedIds([])
        }}
        onUnban={() => {
          setAccountStatus(selectedIds, "offline")
          toast.success(`已解封 ${selectedIds.length} 个账号`)
          setSelectedIds([])
        }}
        onExport={() => exportRows(selectedAccounts, "eve-accounts-selected.csv")}
        onClear={() => setSelectedIds([])}
      />

      <AccountTable
        accounts={sorted}
        selectedIds={selectedIds}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        now={now}
        onEdit={(account) => {
          setEditingAccount(account)
          setEditorOpen(true)
        }}
        onGrant={(account, mode) => openGrant([account], mode)}
        onToggleBan={(account) => {
          const next = account.status === "banned" ? "offline" : "banned"
          setAccountStatus([account.id], next)
          toast[next === "banned" ? "warning" : "success"](
            next === "banned" ? `${account.character} 已被封禁` : `${account.character} 已解封`,
          )
        }}
        onDelete={(account) => setPendingDelete(account)}
      />

      <AccountDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        account={editingAccount}
        onSubmit={handleEditorSubmit}
      />

      <GrantDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        mode={grantMode}
        targets={grantTargets}
        onConfirm={(amount) => {
          const ids = grantTargets.map((a) => a.id)
          if (grantMode === "isk") grantIsk(ids, amount)
          else grantSp(ids, amount)
          setSelectedIds([])
        }}
      />

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="删除账号"
        description="该角色的资产与技能点会一并从世界中移除，且无法撤销。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) {
                  removeAccount(pendingDelete.id)
                  setSelectedIds((prev) => prev.filter((id) => id !== pendingDelete.id))
                  toast.error(`已删除账号 ${pendingDelete.username}`)
                }
                setPendingDelete(null)
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        {pendingDelete ? (
          <div className="rounded-md border border-border bg-background/40 px-3 py-2.5 font-mono text-xs text-muted-foreground">
            {pendingDelete.character} · {pendingDelete.username} · {pendingDelete.corp}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
