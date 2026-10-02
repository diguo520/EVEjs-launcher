import { RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyHint, LoadingHint } from "@/components/commands/command-shared"
import type { RawMarketTrades } from "@/lib/ipc"
import { formatIsk, formatQty, formatStamp, namePair } from "@/lib/market-logic"
import type { LocaleCode } from "@/lib/i18n"

/**
 * 最近成交：没选中物品时右栏画这个。
 *
 * 它存在的意义是**证明库是活的** —— 这张表读的是 market_fill_receipts，
 * 游戏里成交一笔它才会多一行。用户刷新一下就能看到新流水，
 * 不用去猜「界面上的库存到底是游戏里的还是某份快照」。
 */
export function TradesPanel({
  trades,
  loading,
  cnNames,
  locale,
  onPick,
  onRefresh,
  className,
}: {
  trades: RawMarketTrades | null
  loading: boolean
  cnNames: Map<number, string> | null
  locale: LocaleCode
  onPick: (typeId: number) => void
  onRefresh: () => void
  className?: string
}) {
  const rows = trades?.rows ?? []

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-input px-3 py-2.5">
        <span className="panel-label">最近成交</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {loading && rows.length === 0 ? (
        <div className="p-3">
          <LoadingHint label="成交流水" />
        </div>
      ) : trades && trades.ok === false ? (
        <div className="p-3">
          <EmptyHint text={trades.reason || "读成交流水失败"} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-3">
          <EmptyHint text="这个市场库还没有成交记录；进游戏买卖一笔就会出现在这里" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-input/40">
          {rows.map((row, index) => (
            <button
              key={`${row.at}-${index}`}
              type="button"
              onClick={() => onPick(row.typeId)}
              className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center gap-2">
                <span data-i18n-skip className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                  {namePair(cnNames?.get(row.typeId), row.name, locale).main}
                </span>
                <Badge variant={row.bid ? "secondary" : "outline"} className="shrink-0">
                  {row.bid ? "买单" : "卖单"}
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-tertiary">
                <span data-i18n-skip className="tabular shrink-0">{formatStamp(row.at)}</span>
                <span data-i18n-skip className="min-w-0 flex-1 truncate">{row.stationName}</span>
                <span className="tabular shrink-0 text-foreground">{formatIsk(row.price)}</span>
                <span className="tabular shrink-0">×{formatQty(row.quantity)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
