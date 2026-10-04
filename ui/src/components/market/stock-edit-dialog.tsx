import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import type { RawMarketAdjust, RawMarketAdjustInput, RawMarketStockRow } from "@/lib/ipc"
import { formatIsk, formatQty, parseAdjustDraft } from "@/lib/market-logic"

/**
 * 单个空间站的「改价 / 改量」弹窗。
 *
 * 一次只改「一个空间站 + 一个物品」—— 这是市场服务管理接口的粒度（见 market.rs 的
 * adjust_seed_stock）。改的是**种子库存**，也就是服务端预置的那批 NPC 货；玩家自己的
 * 挂单走的是另一套下单接口，不在这里。
 *
 * 挂载即打开：调用方按选中的行决定渲不渲染，所以输入框初值直接用 useState 初始化，
 * 不需要 useEffect 去同步 —— 也就没有「打开第二个站时还留着上一个站的值」这个坑。
 */
export function StockEditDialog({
  row,
  typeId,
  typeName,
  onClose,
  onSubmit,
}: {
  row: RawMarketStockRow
  typeId: number
  typeName: string
  onClose: () => void
  onSubmit: (input: RawMarketAdjustInput) => Promise<RawMarketAdjust | null>
}) {
  // 初值就是当前值：改价十有八九是在原价上微调，从空框开始敲太费事
  const [price, setPrice] = useState(() => String(row.price))
  const [quantity, setQuantity] = useState(() => String(row.quantity))
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return

    const draft = parseAdjustDraft(price, quantity)
    if (!draft.ok) {
      toast.error(t("没法保存"), { description: t(draft.reason) })
      return
    }

    const input: RawMarketAdjustInput = { stationId: row.stationId, typeId }
    if (draft.price !== null) input.price = draft.price
    if (draft.quantity !== null) input.quantity = draft.quantity

    setSaving(true)
    const reply = await onSubmit(input)
    setSaving(false)

    if (!reply || reply.ok !== true) {
      // reason 是后端原话（服务端的英文报错，或「连不上市场服务」）；过一遍 t() 是为了
      // 让目录里有的那几条跟着语言走，目录里没有的原样显示，不会变成空白
      const reason = reply?.reason?.trim()
      toast.error(t("修改失败"), {
        description: reason ? t(reason) : t("市场服务没有回话，稍后再试。"),
      })
      return
    }

    toast.success(t("种子库存已更新"), {
      description: t("游戏里把市场窗口关掉再打开就能看到新价。"),
    })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改种子库存</DialogTitle>
          <DialogDescription>
            改的是服务端预置的 NPC 库存（种子库存）：保存后立刻生效，游戏里把市场窗口关掉再打开就能看到。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-input bg-background/40 px-3 py-2">
          <div data-i18n-skip className="truncate text-[12px] text-foreground">
            {typeName}
          </div>
          <div data-i18n-skip className="truncate text-[11px] text-tertiary">
            {row.stationName}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
            <span className="flex items-center gap-1.5">
              当前价格
              <span data-i18n-skip className="tabular text-foreground">
                {formatIsk(row.price)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              当前库存
              <span data-i18n-skip className="tabular text-foreground">
                {formatQty(row.quantity)}
              </span>
            </span>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="stock-edit-price">价格（ISK）</Label>
            <Input
              id="stock-edit-price"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              className="tabular"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="stock-edit-quantity">数量</Label>
            <Input
              id="stock-edit-quantity"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              className="tabular"
            />
            <p className="text-[11px] leading-relaxed text-tertiary">
              留空表示这一项不改。
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
