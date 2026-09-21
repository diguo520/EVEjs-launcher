import type { MarketItem } from "@/lib/market"
import { MarketCard } from "./MarketCard"
import { EmptyState, Panel } from "@/components/ui/panel"

export interface MarketGridProps {
  items: MarketItem[]
  now: number
  /** 未经筛选的市场收录总数，用于空态提示与计数。 */
  totalCount: number
  onInstall: (item: MarketItem) => void
  onUpdate: (item: MarketItem) => void
  onUninstall: (item: MarketItem) => void
  onCancel: (item: MarketItem) => void
  onWithdraw: (item: MarketItem) => void
  onOpenDetail: (item: MarketItem) => void
  onEdit: (item: MarketItem) => void
  onToggleListing: (item: MarketItem) => void
}

/** 市场目录：卡片网格，一屏能横向比版本、评分和体积。 */
export function MarketGrid({
  items,
  now,
  totalCount,
  onInstall,
  onUpdate,
  onUninstall,
  onCancel,
  onWithdraw,
  onOpenDetail,
  onEdit,
  onToggleListing,
}: MarketGridProps) {
  if (items.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="没有符合条件的模组"
          hint={totalCount === 0 ? "市场索引为空" : "换个关键词，或把分类切回全部"}
        />
      </Panel>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {items.map((item) => (
        <MarketCard
          key={item.entry.id}
          item={item}
          now={now}
          onInstall={() => onInstall(item)}
          onUpdate={() => onUpdate(item)}
          onUninstall={() => onUninstall(item)}
          onCancel={() => onCancel(item)}
          onWithdraw={() => onWithdraw(item)}
          onOpenDetail={() => onOpenDetail(item)}
          onEdit={() => onEdit(item)}
          onToggleListing={() => onToggleListing(item)}
        />
      ))}
    </div>
  )
}
