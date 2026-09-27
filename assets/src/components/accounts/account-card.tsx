import { Trash2 } from "lucide-react"

import { Panel } from "@/components/common/panel"
import { CharacterSlot } from "@/components/accounts/character-slot"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ACCOUNT_ROLE_LABEL,
  ACCOUNT_STATUS_LABEL,
  MAX_CHARACTERS_PER_ACCOUNT,
  canDeleteAccount,
  freeSlots,
  onlineCharacter,
  type Account,
  type AccountStatus,
  type Character,
  type InGameCreation,
} from "@/lib/launcher-logic"

const STATUS_BADGE: Record<AccountStatus, "success" | "default" | "destructive"> = {
  READY: "success",
  NEW: "default",
  SUSPENDED: "destructive",
}

/** 一个账号 = 一张卡片：账号信息 + 3 个角色槽 */
export function AccountCard({
  account,
  creating,
  now,
  onEnter,
  onExit,
  onDelete,
  onDeleteAccount,
  onCreate,
}: {
  account: Account
  /** 全页共享的建号进度：只有正在建号的那个账号会亮起来 */
  creating: InGameCreation | null
  /** 页面统一往下发的当前时间，用来算在线时长 */
  now: number
  onEnter: (accountId: string, character: Character) => void
  onExit: (accountId: string, character: Character) => void
  onDelete: (accountId: string, character: Character) => void
  onDeleteAccount: (account: Account) => void
  onCreate: (accountId: string) => void
}) {
  const online = onlineCharacter(account)
  const pending = creating?.accountId === account.id ? creating.step : null
  const free = freeSlots(account)
  const canDelete = canDeleteAccount(account)
  const deleteHint =
    account.characters.length > 0
      ? `将永久删除账号「${account.name}」及其 ${account.characters.length} 个角色，角色名会一并释放、可被重新占用。该操作不可撤销。`
      : `将永久删除账号「${account.name}」。该操作不可撤销。`
  // 槽位固定 3 个：有角色的按顺序填，剩下的留空位
  const slots = Array.from({ length: MAX_CHARACTERS_PER_ACCOUNT }, (_, i) => ({
    index: i,
    character: account.characters[i] ?? null,
  }))

  return (
    <Panel
      flush
      tag={`// ${ACCOUNT_ROLE_LABEL[account.role]}`}
      title={account.name}
      meta={`槽位 ${account.characters.length}/${MAX_CHARACTERS_PER_ACCOUNT}`}
      actions={
        <div className="flex items-center gap-1.5">
          {online ? <Badge variant="success">在线 1</Badge> : null}
          <Badge variant={STATUS_BADGE[account.status]}>
            {ACCOUNT_STATUS_LABEL[account.status]}
          </Badge>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hover:text-destructive"
                disabled={!canDelete.ok}
                title={canDelete.ok ? `删除账号 ${account.name}` : canDelete.reason}
              >
                <Trash2 />
                <span className="sr-only">删除账号 {account.name}</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>删除账号</AlertDialogTitle>
                <AlertDialogDescription>{deleteHint}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => onDeleteAccount(account)}>
                  删除账号
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      }
    >
      <div className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {slots.map((slot) => (
          <CharacterSlot
            key={slot.character?.id ?? `empty-${slot.index}`}
            account={account}
            character={slot.character}
            index={slot.index}
            /* 客户端在捏的这个角色会落到第一个空槽，也只有它该显示进度 */
            creatingStep={slot.index === account.characters.length ? pending : null}
            now={now}
            onEnter={onEnter}
            onExit={onExit}
            onDelete={onDelete}
            onCreate={onCreate}
          />
        ))}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-input px-4 py-2">
        <span className="tabular text-[10px] text-tertiary">
          上次登录 {account.lastLogin}
        </span>
        <span className="tabular text-[10px] text-tertiary">建于 {account.createdAt}</span>
        <div className="min-w-2 flex-1" />
        <span className="tabular text-[10px] text-muted-foreground">
          {free > 0 ? `空余 ${free} 个槽位` : "槽位已满"}
        </span>
      </footer>
    </Panel>
  )
}
