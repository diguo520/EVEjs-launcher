import { useMemo } from "react"
import { ClipboardCheck, Download, Package, Star } from "lucide-react"
import { formatInt } from "@/lib/format"
import { summarizeMyMods, type MyModItem } from "@/lib/market"
import { StatTile } from "./StatTile"

export interface MyModStatsProps {
  items: MyModItem[]
}

/** 作者总览：名下作品的规模、口碑和待办，一眼看完。 */
export function MyModStats({ items }: MyModStatsProps) {
  const summary = useMemo(() => summarizeMyMods(items), [items])

  const unpublished = summary.total - summary.published

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        icon={Package}
        label="名下模组"
        value={String(summary.total)}
        sub={
          summary.total === 0
            ? "还没有作品"
            : `${summary.published} 个上架过 · ${unpublished} 个只在本机`
        }
      />
      <StatTile
        icon={Download}
        label="累计下载"
        value={formatInt(summary.downloads)}
        sub={
          summary.hottest
            ? `最热一条「${summary.hottest.name}」${formatInt(summary.hottest.downloads)} 次`
            : "还没上架过，暂时没有数据"
        }
      />
      <StatTile
        icon={Star}
        label="平均评分"
        value={summary.ratingCount === 0 ? "—" : summary.rating.toFixed(1)}
        sub={summary.ratingCount === 0 ? "还没有人评分" : `共 ${formatInt(summary.ratingCount)} 人评分`}
        tone="primary"
      />
      <StatTile
        icon={ClipboardCheck}
        label="审核中"
        value={String(summary.reviewing)}
        sub={summary.reviewing > 0 ? "通过后自动上架市场" : "没有在审的条目"}
        tone={summary.reviewing > 0 ? "warn" : "neutral"}
      />
    </div>
  )
}
