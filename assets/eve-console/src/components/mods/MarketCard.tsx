import {
  AlertTriangle,
  BrainCircuit,
  Coins,
  Download,
  EyeOff,
  Image as ImageIcon,
  Pencil,
  Sparkles,
  Swords,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react"
import type { MarketItem } from "@/lib/market"
import { reviewCount } from "@/lib/market"
import { formatInt, formatRelative } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/ui/panel"
import { Rating } from "@/components/ui/rating"
import { cn } from "@/lib/utils"

/** 分类图标：让一屏卡片不用读文字也能大致分区。 */
const CATEGORY_ICON: Record<string, typeof Swords> = {
  玩法: Swords,
  经济: Coins,
  AI: BrainCircuit,
  画面: ImageIcon,
  工具: Wrench,
}

export interface MarketCardProps {
  item: MarketItem
  now: number
  onInstall: () => void
  onUpdate: () => void
  onUninstall: () => void
  onCancel: () => void
  onWithdraw: () => void
  onOpenDetail: () => void
  /** 只有自己发的条目才有，用来改资料、提版本。 */
  onEdit: () => void
  /** 下架 / 重新上架，同样只有自己发的条目才有。 */
  onToggleListing: () => void
}

export function MarketCard({
  item,
  now,
  onInstall,
  onUpdate,
  onUninstall,
  onCancel,
  onWithdraw,
  onOpenDetail,
  onEdit,
  onToggleListing,
}: MarketCardProps) {
  const { entry, installed, status, progress, clashes, mine } = item
  const Icon = CATEGORY_ICON[entry.category] ?? Wrench
  const reviewing = status === "reviewing"
  const downloading = !reviewing && progress !== undefined
  // 下架的条目只有作者本人还看得到，所以这里不用再判断是不是自己的。
  const delisted = entry.delisted === true
  // 刚上架的条目还没有人评分，用「新上架」占位比一排空星好看。
  const unrated = entry.ratingCount === 0
  const comments = reviewCount(entry)

  return (
    <Panel
      className={cn(
        "flex flex-col gap-2.5 p-3.5 transition-colors",
        clashes.length > 0 ? "border-destructive/50" : "hover:border-primary/35",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border",
            status === "available" || delisted
              ? "border-border bg-secondary/40 text-muted-foreground"
              : "border-primary/40 bg-primary/12 text-primary",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenDetail}
              className="truncate text-sm font-semibold text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              {entry.name}
            </button>
            {entry.featured ? (
              <Sparkles className="h-3 w-3 shrink-0 text-amber-300" aria-label="官方精选" />
            ) : null}
            {mine ? (
              <Badge tone="primary" className="shrink-0 px-1 py-0 text-[10px]">
                我的
              </Badge>
            ) : null}
            {delisted ? (
              <Badge tone="warn" className="shrink-0 px-1 py-0 text-[10px]">
                已下架
              </Badge>
            ) : null}
            {entry.myRating !== undefined ? (
              <Badge tone="warn" className="shrink-0 px-1 py-0 text-[10px]">
                你打了 {entry.myRating} 分
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-[10px] text-muted-foreground/70">{entry.author}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone="outline" className="px-1 py-0 text-[10px]">
            {entry.version}
          </Badge>
          {status === "installed" ? (
            <Badge tone="success" className="px-1 py-0 text-[10px]">
              已安装
            </Badge>
          ) : status === "update" ? (
            <Badge tone="warn" className="px-1 py-0 text-[10px]">
              可更新
            </Badge>
          ) : reviewing ? (
            <Badge tone="primary" className="px-1 py-0 text-[10px]">
              审核中
            </Badge>
          ) : null}
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{entry.desc}</p>

      <div className="flex flex-wrap items-center gap-1">
        <Badge tone="neutral" className="px-1 py-0 text-[10px]">
          {entry.category}
        </Badge>
        {entry.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="rounded-sm border border-border px-1 py-0 font-mono text-[10px] text-muted-foreground/70"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {unrated ? (
          <Badge tone="primary" className="px-1 py-0 text-[10px]">
            新上架 · 暂无评分
          </Badge>
        ) : (
          <Rating value={entry.rating} count={entry.ratingCount} />
        )}
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {formatInt(entry.downloads)} 次下载
        </span>
        {comments > 0 ? (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {comments} 条评价
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
        <span>{entry.sizeMb} MB</span>
        <span>{formatRelative(entry.updatedAt, now)}更新</span>
        {installed ? <span>本地 {installed.version}</span> : null}
        {!entry.requiresRestart ? <span>免重启</span> : null}
      </div>

      {clashes.length > 0 ? (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>与已启用的 {clashes.join("、")} 冲突</span>
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-1.5 border-t border-border pt-2.5">
        <Button variant="ghost" size="sm" onClick={onOpenDetail}>
          详情
        </Button>

        {mine ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            编辑资料
          </Button>
        ) : null}

        {mine && !delisted && !reviewing ? (
          <Button variant="ghost" size="sm" onClick={onToggleListing}>
            <EyeOff className="h-3.5 w-3.5" />
            下架
          </Button>
        ) : null}

        {reviewing || downloading ? (
          <div className="flex flex-1 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-150 ease-linear",
                  reviewing ? "bg-amber-400" : "bg-primary",
                )}
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <span
              className={cn(
                "shrink-0 font-mono text-[10px] tabular-nums",
                reviewing ? "text-amber-300" : "text-primary",
              )}
            >
              {Math.round(progress ?? 0)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={reviewing ? onWithdraw : onCancel}
            >
              {reviewing ? "撤回" : "取消"}
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-1.5">
            {/* 下架之后没有可装可更的版本，这一格让给「重新上架」。 */}
            {delisted ? (
              <Button variant="primary" size="sm" onClick={onToggleListing}>
                <Undo2 className="h-3.5 w-3.5" />
                重新上架
              </Button>
            ) : status === "available" ? (
              <Button variant="primary" size="sm" onClick={onInstall}>
                <Download className="h-3.5 w-3.5" />
                安装
              </Button>
            ) : status === "update" ? (
              <Button variant="primary" size="sm" onClick={onUpdate}>
                <Download className="h-3.5 w-3.5" />
                更新到 {entry.version}
              </Button>
            ) : null}
            {installed ? (
              <Button variant="outline" size="sm" onClick={onUninstall}>
                <Trash2 className="h-3.5 w-3.5" />
                卸载
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  )
}
