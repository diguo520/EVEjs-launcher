import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PriceHistoryChart } from "@/components/market/price-history-chart"
import { useLocale } from "@/components/shell/locale-provider"
import type { RawMarketHistoryPoint } from "@/lib/ipc"

/**
 * 价格史大图的弹窗。
 *
 * 为什么做成弹窗而不是把右栏那张迷你图放大：右栏只有 340px 宽（`market-page` 的三列布局），
 * 游戏那张图是「主图 + 体积子图 + 双轴」，塞进 340px 里只会又变回一条谁也读不出细节的细线。
 * 弹窗有 ~900px，才放得下 30 天的影线、两条均线与两套刻度。
 */
export function PriceHistoryDialog({
  typeName,
  history,
  onClose,
}: {
  typeName: string
  history: RawMarketHistoryPoint[]
  onClose: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("价格史")}</DialogTitle>
          <DialogDescription data-i18n-skip className="truncate">
            {typeName}
          </DialogDescription>
        </DialogHeader>
        <PriceHistoryChart history={history} />
      </DialogContent>
    </Dialog>
  )
}
