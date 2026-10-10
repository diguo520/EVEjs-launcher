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
import type {
  RawMarketAdjust,
  RawMarketAdjustInput,
  RawMarketStockRow,
  RawMarketSummary,
} from "@/lib/ipc"
import { formatIsk, parseAdjustDraft } from "@/lib/market-logic"

/**
 * 「修改最优价格」弹窗：两列并排（左最优买价 / 右最优卖价）。
 *
 * 为什么改的是「某个空间站的种子价」而不是一个区域级的数字：区域最优价本身不是一条记录，
 * 它是 `region_summaries` 按区域算出来的聚合 —— 最优卖价 = 该区域所有种子卖单的最低售价。
 * 所以「把最优卖价改成 X」的落地方式就是：把**当前持有最优卖价那个空间站**的种子价改成 X。
 * 写完由市场服务重算摘要，区域最优价随之变成 X（新值不低于其它站时，最优价会落到别的站上，
 * 这是聚合本身的语义，回包吐出来的实际值会照实显示）。
 *
 * 买价那一列目前只读：市场服务的管理接口只有 `seed-stock/adjust`（写 `seed_stock`，
 * 也就是卖单），`seed_buy_orders` 这张表服务端从头到尾只读，没有任何写入口 ——
 * 所以最优买价在这一版只能看、不能改。
 */
export function BestPriceDialog({
  typeId,
  typeName,
  summary,
  stock,
  onClose,
  onSubmit,
}: {
  typeId: number
  typeName: string
  summary?: RawMarketSummary | null
  stock: RawMarketStockRow[]
  onClose: () => void
  onSubmit: (input: RawMarketAdjustInput) => Promise<RawMarketAdjust | null>
}) {
  const [ask, setAsk] = useState("")
  const [saving, setSaving] = useState(false)

  const askStationId = summary?.askStation ?? 0
  const bidStationId = summary?.bidStation ?? 0
  const stationName = (id: number) =>
    stock.find((row) => row.stationId === id)?.stationName ?? t("空间站 #{id}", { id })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return

    if (!askStationId) {
      toast.error(t("没法保存"), { description: t("这个物品在区域内还没有卖单，改不了。") })
      return
    }

    const draft = parseAdjustDraft(ask, "")
    if (!draft.ok) {
      toast.error(t("没法保存"), { description: t(draft.reason) })
      return
    }
    if (draft.price === null) return

    setSaving(true)
    const reply = await onSubmit({ stationId: askStationId, typeId, price: draft.price })
    setSaving(false)

    if (!reply || reply.ok !== true) {
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>修改最优价格</DialogTitle>
          <DialogDescription>
            区域最优价由「持有这个价的空间站」的种子价决定，改完立刻生效；游戏里把市场窗口关掉再打开就能看到。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-input bg-background/40 px-3 py-2">
          <div data-i18n-skip className="truncate text-[12px] text-foreground">
            {typeName}
          </div>
          <div data-i18n-skip className="truncate text-[11px] text-tertiary">
            #{typeId}
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          {/* 两列并排：左边买价（只读），右边卖价（可改） */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
              <Label htmlFor="best-price-bid" className="text-destructive">
                最优买价
              </Label>
              <div className="flex items-baseline justify-between gap-2">
                <span data-i18n-skip className="tabular text-[13px] font-semibold text-destructive">
                  {formatIsk(summary?.bestBid ?? 0)}
                </span>
                <span data-i18n-skip className="min-w-0 truncate text-[10px] text-tertiary">
                  {bidStationId ? stationName(bidStationId) : t("无买单")}
                </span>
              </div>
              <Input
                id="best-price-bid"
                value=""
                readOnly
                disabled
                placeholder="—"
                className="tabular"
              />
              <p className="text-[10px] leading-relaxed text-tertiary">
                服务端没有开放种子买单的写入接口，最优买价这一项暂时只能查看。
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
              <Label htmlFor="best-price-ask" className="text-success">
                最优卖价
              </Label>
              <div className="flex items-baseline justify-between gap-2">
                <span data-i18n-skip className="tabular text-[13px] font-semibold text-success">
                  {formatIsk(summary?.bestAsk ?? 0)}
                </span>
                <span data-i18n-skip className="min-w-0 truncate text-[10px] text-tertiary">
                  {askStationId ? stationName(askStationId) : t("无卖单")}
                </span>
              </div>
              <Input
                id="best-price-ask"
                value={ask}
                onChange={(event) => setAsk(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder={askStationId ? String(summary?.bestAsk ?? "") : "—"}
                className="tabular"
              />
              <p className="text-[10px] leading-relaxed text-tertiary">
                留空表示这一项不改。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !askStationId}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
