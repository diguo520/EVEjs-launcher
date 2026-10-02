import { useState, type FormEvent } from "react"

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
import { t } from "@/lib/i18n"
import type { Guard, PendingCredential } from "@/lib/launcher-logic"

/**
 * 「本机没存过这个账号的密码」时补录一次。
 *
 * 后端 `accounts.rs::launch_stored` 只认本机 `launcher-settings.json` 里的 DPAPI 密文；
 * 别的启动器（或服务端 account-cli）建的账号在这里没有密文，一键进不去。以前只弹一句
 * 「请手动输入一次密码」却没有输入的地方（2026-10-02 报障）。这里把带密码的
 * `login:start(..., remember, characterId)` 接上：输一次就能进，勾了记住下次回到一键路。
 */
export function PasswordPromptDialog({
  pending,
  accountName,
  open,
  onOpenChange,
  onSubmit,
}: {
  pending: PendingCredential | null
  accountName: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (password: string, remember: boolean) => Promise<Guard>
}) {
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const mode = pending?.mode ?? "enter"

  /**
   * 关掉就把状态清干净：别把上一个号的密码留在框里。
   * 放在关闭回调里而不是 effect 里 —— effect 里同步 setState 会触发一轮多余的渲染，
   * 对话框这种「关掉即重置」的语义在事件里表达也更直白。
   */
  function handleOpenChange(v: boolean) {
    if (!v) {
      setPassword("")
      setRemember(true)
      setError("")
      setBusy(false)
    }
    onOpenChange(v)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError("")
    const guard = await onSubmit(password, remember)
    setBusy(false)
    if (!guard.ok) {
      // 失败原因贴在框里而不是 toast：用户要看着它改密码，toast 会飘走
      setError(guard.reason)
      return
    }
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "enter" ? "输入密码以进入游戏" : "输入密码以创建角色"}
          </DialogTitle>
          <DialogDescription>
            {t(
              "「{name}」不是在当前启动器里创建的，本机没有保存它的密码。输入一次后会加密记住它，下次就能一键进入。",
              { name: accountName }
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="stored-credential-password">
              密码 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="stored-credential-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              autoComplete="current-password"
              autoFocus
              className="tabular"
            />
            {error ? (
              <p className="text-[11px] leading-relaxed text-destructive">{error}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
            <Checkbox
              id="stored-credential-remember"
              checked={remember}
              onCheckedChange={(v) => setRemember(v === true)}
            />
            <div className="min-w-0">
              <Label
                htmlFor="stored-credential-remember"
                className="cursor-pointer text-[12px] text-foreground"
              >
                记住密码
              </Label>
              <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
                密码已用当前 Windows 账户加密保存，进游戏不用重填。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={!password || busy}>
              {busy ? "正在登录…" : "登录"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}