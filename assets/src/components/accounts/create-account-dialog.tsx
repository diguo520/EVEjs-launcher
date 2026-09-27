import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  validateAccountName,
  type Account,
  type AccountRole,
  type Guard,
} from "@/lib/launcher-logic"

export interface NewAccountPayload {
  name: string
  role: AccountRole
}

/** 新建账号：只建账号，角色随后在卡片里逐个创建 */
export function CreateAccountDialog({
  open,
  onOpenChange,
  accounts,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  accounts: Account[]
  onSubmit: (payload: NewAccountPayload) => Guard
}) {
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [gm, setGm] = useState(false)

  const trimmed = name.trim()
  const nameGuard = trimmed ? validateAccountName(trimmed, accounts) : null

  function reset() {
    setName("")
    setPassword("")
    setGm(false)
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (nameGuard && !nameGuard.ok) {
      toast.error("账号名不可用", { description: nameGuard.reason })
      return
    }

    const guard = onSubmit({ name: trimmed, role: gm ? "GM" : "PLAYER" })
    if (!guard.ok) {
      toast.error("创建失败", { description: guard.reason })
      return
    }

    toast.success(`账号 ${trimmed} 已创建`, {
      description: `权限组 ${gm ? "GM" : "PLAYER"} · 已预留 ${MAX_CHARACTERS_PER_ACCOUNT} 个角色槽`,
    })
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建账号</DialogTitle>
          <DialogDescription>
            每个账号固定 {MAX_CHARACTERS_PER_ACCOUNT} 个角色槽；角色不在这里建，
            账号建好后到游戏内创建，会自动同步回卡片。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="new-account-name">
              账号名 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 capsuleer"
              autoComplete="off"
              spellCheck={false}
              className="tabular"
            />
            {nameGuard && !nameGuard.ok ? (
              <p className="text-[11px] leading-relaxed text-destructive">
                {nameGuard.reason}
              </p>
            ) : (
              <p className="text-[11px] leading-relaxed text-tertiary">
                3–20 位，只能用字母、数字、下划线、点或连字符。
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-account-password">密码</Label>
            <Input
              id="new-account-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空则使用服务端默认密码"
              autoComplete="new-password"
              className="tabular"
            />
          </div>

          <div className="flex items-center gap-2.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
            <Checkbox
              id="new-account-gm"
              checked={gm}
              onCheckedChange={(v) => setGm(v === true)}
            />
            <div className="min-w-0">
              <Label
                htmlFor="new-account-gm"
                className="cursor-pointer text-[12px] text-foreground"
              >
                授予 GM 权限
              </Label>
              <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
                可使用指令手册中的管理类指令，请谨慎授予。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!trimmed || (nameGuard !== null && !nameGuard.ok)}>
              创建账号
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
