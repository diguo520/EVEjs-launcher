import { useState } from "react"
import { toast } from "sonner"
import { Coins, Sparkles } from "lucide-react"
import type { Account } from "@/lib/types"
import { formatIsk, formatSp } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Input, Label } from "@/components/ui/input"
import { Modal } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export interface GrantDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "isk" | "sp"
  targets: Account[]
  onConfirm: (amount: number) => void
}

const ISK_PRESETS = [
  { label: "+1000 万", value: 10_000_000 },
  { label: "+1 亿", value: 100_000_000 },
  { label: "+10 亿", value: 1_000_000_000 },
  { label: "-1 亿", value: -100_000_000 },
]

const SP_PRESETS = [
  { label: "+50 万", value: 500_000 },
  { label: "+500 万", value: 5_000_000 },
  { label: "+2000 万", value: 20_000_000 },
  { label: "-500 万", value: -5_000_000 },
]

/** 关闭即卸载，重开时按当前模式重新初始化金额，省掉一次重置用的 effect。 */
export function GrantDialog({ open, onOpenChange, mode, targets, onConfirm }: GrantDialogProps) {
  if (!open) return null
  return (
    <GrantForm
      key={`${mode}-${targets.map((t) => t.id).join(",")}`}
      mode={mode}
      targets={targets}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  )
}

function GrantForm({ mode, targets, onOpenChange, onConfirm }: Omit<GrantDialogProps, "open">) {
  const [amountText, setAmountText] = useState(mode === "isk" ? "100000000" : "5000000")
  const presets = mode === "isk" ? ISK_PRESETS : SP_PRESETS

  const amount = Number(amountText.replace(/[^0-9-]/g, "")) || 0
  const Icon = mode === "isk" ? Coins : Sparkles
  const unit = mode === "isk" ? "ISK" : "技能点"
  const preview = mode === "isk" ? formatIsk(Math.abs(amount)) : formatSp(Math.abs(amount))

  const submit = () => {
    if (amount === 0) return
    onConfirm(amount)
    toast.success(`已向 ${targets.length} 个账号发放 ${amount > 0 ? "" : "负 "}${preview} ${unit}`)
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={`发放${unit}`}
      description={
        targets.length === 1
          ? `目标：${targets[0].character}（当前 ${mode === "isk" ? formatIsk(targets[0].isk) + " ISK" : formatSp(targets[0].skillPoints) + " SP"}）`
          : `已选中 ${targets.length} 个账号，发放后立即生效`
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={amount === 0}>
            确认发放
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>发放数量</Label>
          <div className="relative">
            <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={amountText}
              inputMode="numeric"
              onChange={(e) => setAmountText(e.target.value)}
              className="pl-8 font-mono"
            />
          </div>
          <p className="text-xs text-muted-foreground/70">
            填负数表示扣除。当前将发放{" "}
            <span className="font-mono text-primary">
              {amount >= 0 ? "+" : "-"}
              {preview}
            </span>{" "}
            {unit}
            {targets.length > 1 ? "（每人）" : ""}。
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setAmountText(String(preset.value))}
              className={cn(
                "rounded-sm border border-border bg-secondary/50 px-2 py-1 font-mono text-xs text-muted-foreground transition-colors",
                "hover:border-primary/40 hover:text-primary",
                amount === preset.value && "border-primary/50 bg-primary/12 text-primary",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          提示：负数额度会直接扣除，扣到 0 为止，不会变成负债。
        </p>
      </div>
    </Modal>
  )
}
