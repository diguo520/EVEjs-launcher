import { useMemo } from "react"
import { ArrowUpCircle, Download, PackageCheck, Store } from "lucide-react"
import { formatInt } from "@/lib/format"
import type { MarketItem } from "@/lib/market"
import { StatTile } from "./StatTile"

export interface MarketStatsProps {
  items: MarketItem[]
}

/** 市场总览：收录规模、本地覆盖度与更新压力。 */
export function MarketStats({ items }: MarketStatsProps) {
  const summary = useMemo(() => {
    /* 自己下架的条目还留在列表里（好让自己能重新上架），但对外已经不算收录了。 */
    const live = items.filter((item) => !item.entry.delisted)
    const installed = live.filter((item) => item.installed).length
    const updatable = live.filter((item) => item.status === "update").length
    const featured = live.filter((item) => item.entry.featured).length
    const downloads = live.reduce((sum, item) => sum + item.entry.downloads, 0)
    const hottest = live.reduce((max, item) => Math.max(max, item.entry.downloads), 0)
    const totalSize = live.reduce((sum, item) => sum + item.entry.sizeMb, 0)
    return { listed: live.length, installed, updatable, featured, downloads, hottest, totalSize }
  }, [items])

  const coverage =
    summary.listed === 0 ? 0 : Math.round((summary.installed / summary.listed) * 100)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        icon={Store}
        label="市场收录"
        value={String(summary.listed)}
        sub={`${summary.featured} 个官方精选 · 合计 ${formatInt(summary.totalSize)} MB`}
      />
      <StatTile
        icon={PackageCheck}
        label="本地已装"
        value={String(summary.installed)}
        sub={`覆盖市场 ${coverage}%`}
        tone="primary"
      />
      <StatTile
        icon={ArrowUpCircle}
        label="可更新"
        value={String(summary.updatable)}
        sub={summary.updatable > 0 ? "本地版本落后于市场" : "全部为最新版本"}
        tone={summary.updatable > 0 ? "warn" : "neutral"}
      />
      <StatTile
        icon={Download}
        label="累计下载"
        value={formatInt(summary.downloads)}
        sub={`最热单品 ${formatInt(summary.hottest)} 次`}
      />
    </div>
  )
}
