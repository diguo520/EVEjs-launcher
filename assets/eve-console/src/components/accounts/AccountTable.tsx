import { ArrowDown, ArrowUp, Ban, Coins, MoreHorizontal, Pencil, ShieldCheck, Sparkles, Trash2 } from "lucide-react"
import type { Account } from "@/lib/types"
import { formatIsk, formatRelative, formatSecurity, formatSp } from "@/lib/format"
import { Badge, StatusDot } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown"
import { EmptyState } from "@/components/ui/panel"
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type AccountSortKey =
  | "character"
  | "isk"
  | "skillPoints"
  | "securityStatus"
  | "lastSeen"
  | "playtimeHours"

export interface AccountTableProps {
  accounts: Account[]
  selectedIds: string[]
  onToggleRow: (id: string) => void
  onToggleAll: () => void
  sortKey: AccountSortKey
  sortDir: "asc" | "desc"
  onSort: (key: AccountSortKey) => void
  onEdit: (account: Account) => void
  onGrant: (account: Account, mode: "isk" | "sp") => void
  onToggleBan: (account: Account) => void
  onDelete: (account: Account) => void
  now: number
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string
  sortKey: AccountSortKey
  activeKey: AccountSortKey
  dir: "asc" | "desc"
  onSort: (key: AccountSortKey) => void
  align?: "left" | "right"
}) {
  const active = sortKey === activeKey
  return (
    <Th className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active && "text-primary",
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : null}
      </button>
    </Th>
  )
}

function SecurityCell({ value }: { value: number }) {
  const tone =
    value >= 0.5 ? "text-emerald-300" : value > -0.5 ? "text-amber-300" : "text-red-300"
  return <span className={cn("font-mono tabular-nums", tone)}>{formatSecurity(value)}</span>
}

function StatusCell({ account }: { account: Account }) {
  if (account.status === "banned") {
    return (
      <Badge tone="danger">
        <StatusDot tone="danger" />
        已封禁
      </Badge>
    )
  }
  if (account.status === "online") {
    return (
      <Badge tone="success">
        <StatusDot tone="success" pulse />
        在线
      </Badge>
    )
  }
  return (
    <Badge tone="neutral">
      <StatusDot tone="neutral" />
      离线
    </Badge>
  )
}

export function AccountTable({
  accounts,
  selectedIds,
  onToggleRow,
  onToggleAll,
  sortKey,
  sortDir,
  onSort,
  onEdit,
  onGrant,
  onToggleBan,
  onDelete,
  now,
}: AccountTableProps) {
  const selectedSet = new Set(selectedIds)
  const allSelected = accounts.length > 0 && accounts.every((a) => selectedSet.has(a.id))
  const someSelected = accounts.some((a) => selectedSet.has(a.id)) && !allSelected

  return (
    <TableWrap className="max-h-[560px] rounded-lg border border-border bg-card shadow-md">
      <Table>
        <thead>
          <tr>
            <Th className="w-9 pr-0">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={onToggleAll}
                aria-label="全选当前列表"
              />
            </Th>
            <SortHeader
              label="角色 / 账号"
              sortKey="character"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
            />
            <Th>军团</Th>
            <Th>势力</Th>
            <SortHeader
              label="isk"
              sortKey="isk"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              label="技能点"
              sortKey="skillPoints"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              label="安等"
              sortKey="securityStatus"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              align="right"
            />
            <Th>状态</Th>
            <SortHeader
              label="最后在线"
              sortKey="lastSeen"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
            />
            <Th className="w-10 text-right">操作</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={10}>
                <EmptyState title="没有符合条件的账号" hint="试试放宽筛选条件，或直接新建一个" />
              </td>
            </tr>
          ) : (
            accounts.map((account) => {
              const selected = selectedSet.has(account.id)
              return (
                <Tr key={account.id} data-selected={selected}>
                  <Td className="pr-0">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => onToggleRow(account.id)}
                      aria-label={`选择 ${account.character}`}
                    />
                  </Td>
                  <Td>
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-foreground">
                          {account.character}
                        </span>
                        {account.role === "管理员" ? (
                          <Badge tone="primary" className="px-1 py-0 text-[10px]">
                            管理
                          </Badge>
                        ) : account.role === "军团指挥" ? (
                          <Badge tone="outline" className="px-1 py-0 text-[10px]">
                            指挥
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                        {account.username} · {account.shipName}
                      </span>
                    </div>
                  </Td>
                  <Td className="max-w-[140px] truncate text-muted-foreground">{account.corp}</Td>
                  <Td>
                    <span className="text-xs text-muted-foreground">{account.faction}</span>
                  </Td>
                  <Td className="text-right font-mono text-foreground">{formatIsk(account.isk)}</Td>
                  <Td className="text-right font-mono text-muted-foreground">
                    {formatSp(account.skillPoints)}
                  </Td>
                  <Td className="text-right">
                    <SecurityCell value={account.securityStatus} />
                  </Td>
                  <Td>
                    <StatusCell account={account} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatRelative(account.lastSeen, now)}
                  </Td>
                  <Td className="text-right">
                    <Dropdown>
                      <DropdownTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="账号操作">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownTrigger>
                      <DropdownContent>
                        <DropdownItem onSelect={() => onEdit(account)}>
                          <Pencil className="h-3.5 w-3.5" />
                          编辑资料
                        </DropdownItem>
                        <DropdownItem onSelect={() => onGrant(account, "isk")}>
                          <Coins className="h-3.5 w-3.5" />
                          发放 ISK
                        </DropdownItem>
                        <DropdownItem onSelect={() => onGrant(account, "sp")}>
                          <Sparkles className="h-3.5 w-3.5" />
                          发放技能点
                        </DropdownItem>
                        <DropdownSeparator />
                        <DropdownItem onSelect={() => onToggleBan(account)}>
                          {account.status === "banned" ? (
                            <>
                              <ShieldCheck className="h-3.5 w-3.5" />
                              解除封禁
                            </>
                          ) : (
                            <>
                              <Ban className="h-3.5 w-3.5" />
                              封禁账号
                            </>
                          )}
                        </DropdownItem>
                        <DropdownItem tone="danger" onSelect={() => onDelete(account)}>
                          <Trash2 className="h-3.5 w-3.5" />
                          删除账号
                        </DropdownItem>
                      </DropdownContent>
                    </Dropdown>
                  </Td>
                </Tr>
              )
            })
          )}
        </tbody>
      </Table>
    </TableWrap>
  )
}
