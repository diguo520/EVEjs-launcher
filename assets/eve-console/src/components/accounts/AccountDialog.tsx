import { useState } from "react"
import { toast } from "sonner"
import type { Account, AccountRole, Faction } from "@/lib/types"
import type { AccountDraft } from "@/lib/engine"
import { CORP_POOL, SHIP_POOL, SYSTEM_POOL } from "@/lib/seed"
import { Button } from "@/components/ui/button"
import { Field, Input, Textarea } from "@/components/ui/input"
import { Modal } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"

const FACTIONS: Faction[] = ["加达里", "米玛塔尔", "艾玛", "盖伦特"]
const ROLES: AccountRole[] = ["管理员", "军团指挥", "玩家", "观察者"]

const EMPTY: AccountDraft = {
  username: "",
  character: "",
  corp: CORP_POOL[0],
  faction: "加达里",
  role: "玩家",
  isk: 5_000_000,
  skillPoints: 800_000,
  shipName: SHIP_POOL[0],
  solarSystem: SYSTEM_POOL[0],
  note: "",
}

export interface AccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传入账号表示编辑，null 表示新建。 */
  account: Account | null
  onSubmit: (draft: AccountDraft) => void
}

/** 把已有账号摊平成表单草稿；新建时给一份默认值。 */
function draftFrom(account: Account | null): AccountDraft {
  if (!account) return { ...EMPTY }
  return {
    username: account.username,
    character: account.character,
    corp: account.corp,
    faction: account.faction,
    role: account.role,
    isk: account.isk,
    skillPoints: account.skillPoints,
    shipName: account.shipName,
    solarSystem: account.solarSystem,
    note: account.note,
  }
}

/**
 * 关闭时整棵卸载、重开时重新挂载，表单初值直接由 useState 初始化器算出来。
 * 比「打开时用 effect 重置表单」干净，也不会引发级联渲染。
 */
export function AccountDialog({ open, onOpenChange, account, onSubmit }: AccountDialogProps) {
  if (!open) return null
  return (
    <AccountForm
      key={account?.id ?? "new"}
      account={account}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
    />
  )
}

function AccountForm({ account, onOpenChange, onSubmit }: Omit<AccountDialogProps, "open">) {
  const [draft, setDraft] = useState<AccountDraft>(() => draftFrom(account))
  const [iskText, setIskText] = useState(() => String(account?.isk ?? EMPTY.isk))
  const [spText, setSpText] = useState(() => String(account?.skillPoints ?? EMPTY.skillPoints))
  const [error, setError] = useState("")

  const patch = (next: Partial<AccountDraft>) => setDraft((prev) => ({ ...prev, ...next }))

  const submit = () => {
    if (draft.character.trim() === "") {
      setError("角色名不能为空")
      return
    }
    if (draft.username.trim() === "") {
      setError("账号名不能为空")
      return
    }
    const isk = Number(iskText.replace(/[^0-9]/g, ""))
    const sp = Number(spText.replace(/[^0-9]/g, ""))
    onSubmit({
      ...draft,
      character: draft.character.trim(),
      username: draft.username.trim(),
      isk: Number.isFinite(isk) ? isk : 0,
      skillPoints: Number.isFinite(sp) ? sp : 0,
    })
    toast.success(account ? `已更新 ${draft.character} 的资料` : `账号 ${draft.username} 已创建`)
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={account ? `编辑 ${account.character}` : "新建玩家账号"}
      description={
        account ? "修改后的资料会在下次该角色登录时生效。" : "创建后角色会落在默认空间站，可随时调整。"
      }
      className="w-[min(92vw,640px)]"
      footer={
        <>
          {error ? <span className="mr-auto text-xs text-red-300">{error}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit}>
            {account ? "保存修改" : "创建账号"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="账号名" hint="登录用的唯一标识，仅管理员可见">
          <Input
            value={draft.username}
            onChange={(e) => patch({ username: e.target.value })}
            placeholder="pilot048"
          />
        </Field>
        <Field label="角色名" hint="游戏内显示的名字">
          <Input
            value={draft.character}
            onChange={(e) => patch({ character: e.target.value })}
            placeholder="北辰凛"
          />
        </Field>

        <Field label="军团">
          <Select
            value={draft.corp}
            onValueChange={(v) => patch({ corp: v })}
            options={CORP_POOL.map((c) => ({ value: c, label: c }))}
          />
        </Field>
        <Field label="势力">
          <Select
            value={draft.faction}
            onValueChange={(v) => patch({ faction: v as Faction })}
            options={FACTIONS.map((f) => ({ value: f, label: f }))}
          />
        </Field>

        <Field label="权限">
          <Select
            value={draft.role}
            onValueChange={(v) => patch({ role: v as AccountRole })}
            options={ROLES.map((r) => ({ value: r, label: r }))}
          />
        </Field>
        <Field label="初始舰船">
          <Select
            value={draft.shipName}
            onValueChange={(v) => patch({ shipName: v })}
            options={SHIP_POOL.map((s) => ({ value: s, label: s }))}
          />
        </Field>

        <Field label="初始 isk">
          <Input
            value={iskText}
            inputMode="numeric"
            onChange={(e) => setIskText(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="初始技能点">
          <Input
            value={spText}
            inputMode="numeric"
            onChange={(e) => setSpText(e.target.value)}
            className="font-mono"
          />
        </Field>

        <Field label="初始星系">
          <Select
            value={draft.solarSystem}
            onValueChange={(v) => patch({ solarSystem: v })}
            options={SYSTEM_POOL.map((s) => ({ value: s, label: s }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="备注" hint="只给管理员看，玩家不可见">
            <Textarea
              value={draft.note}
              onChange={(e) => patch({ note: e.target.value })}
              placeholder="例如：内测老账号 / 误伤队友观察中"
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
