import { Download, EyeOff, Pencil, Sparkles, Undo2, Upload } from "lucide-react"
import type { MyModItem } from "@/lib/market"
import { MY_STATUS_LABEL, reviewStageLabel } from "@/lib/market"
import { formatInt, formatRelative } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"
import { Rating } from "@/components/ui/rating"
import { cn } from "@/lib/utils"

/** 每种状态在列表里配什么色调，文案统一从 MY_STATUS_LABEL 取。 */
const STATUS_TONE: Record<MyModItem["status"], "neutral" | "primary" | "success" | "warn"> = {
  local: "neutral",
  reviewing: "primary",
  listed: "success",
  delisted: "warn",
}

export interface MyModListProps {
  items: MyModItem[]
  now: number
  /** 一条都没有时的引导：去建一个。 */
  onCreate: () => void
  /** 纯本地条目：填好资料提交审核。 */
  onSubmit: (item: MyModItem) => void
  /** 已上架的条目：改资料、提版本。 */
  onEdit: (item: MyModItem) => void
  /** 已上架 ↔ 已下架。 */
  onToggleListing: (item: MyModItem) => void
  /** 在审的条目：撤回提交。 */
  onWithdraw: (item: MyModItem) => void
  /** 上架过的条目：看市场详情页长什么样。 */
  onOpenDetail: (item: MyModItem) => void
  /** 把这份清单导成 CSV，留个账。 */
  onExport: () => void
}

/** 我创建的：作者自己的作品清单，改资料、提版本、上下架都在这一页办。 */
export function MyModList({
  items,
  now,
  onCreate,
  onSubmit,
  onEdit,
  onToggleListing,
  onWithdraw,
  onOpenDetail,
  onExport,
}: MyModListProps) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="my mods"
        title="我创建的"
        actions={
          <>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {items.length} 个
            </span>
            <Button variant="secondary" size="md" onClick={onExport}>
              <Download className="h-3.5 w-3.5" />
              导出 CSV
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-2 p-3">
        {items.length === 0 ? (
          <>
            <EmptyState
              title="你还没有创建过模组"
              hint="建一个，或者把现成的作品提交上架"
            />
            <div className="flex justify-center pb-4">
              <Button variant="outline" size="md" onClick={onCreate}>
                去创建模组
              </Button>
            </div>
          </>
        ) : (
          items.map((item) => (
            <MyModRow
              key={item.id}
              item={item}
              now={now}
              onSubmit={() => onSubmit(item)}
              onEdit={() => onEdit(item)}
              onToggleListing={() => onToggleListing(item)}
              onWithdraw={() => onWithdraw(item)}
              onOpenDetail={() => onOpenDetail(item)}
            />
          ))
        )}
      </div>
    </Panel>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
      {label} <span className="text-muted-foreground">{value}</span>
    </span>
  )
}

function MyModRow({
  item,
  now,
  onSubmit,
  onEdit,
  onToggleListing,
  onWithdraw,
  onOpenDetail,
}: {
  item: MyModItem
  now: number
  onSubmit: () => void
  onEdit: () => void
  onToggleListing: () => void
  onWithdraw: () => void
  onOpenDetail: () => void
}) {
  const { entry, local, status, progress, reviewKind } = item
  const reviewing = status === "reviewing"
  const unrated = entry !== undefined && entry.ratingCount === 0

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
        status === "delisted"
          ? "border-amber-500/35 bg-background/40"
          : reviewing
            ? "border-primary/35 bg-background/40"
            : "border-border bg-background/40 hover:border-primary/30",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {entry ? (
              <button
                type="button"
                onClick={onOpenDetail}
                className="truncate text-sm font-semibold text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                {item.name}
              </button>
            ) : (
              <span className="truncate text-sm font-semibold text-foreground">{item.name}</span>
            )}
            {entry?.featured ? (
              <Sparkles className="h-3 w-3 shrink-0 text-amber-300" aria-label="官方精选" />
            ) : null}
            <Badge tone={STATUS_TONE[status]} className="shrink-0 px-1 py-0 text-[10px]">
              {MY_STATUS_LABEL[status]}
            </Badge>
            {local?.enabled ? (
              <Badge tone="outline" className="shrink-0 px-1 py-0 text-[10px]">
                本地已启用
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-[10px] text-muted-foreground/70">
            {item.author} · {item.category} · {item.version}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
          {entry ? (
            <>
              <Meta label="下载" value={formatInt(entry.downloads)} />
              {unrated ? (
                <Meta label="评分" value="暂无" />
              ) : (
                <Rating value={entry.rating} count={entry.ratingCount} />
              )}
              <Meta label="更新" value={formatRelative(entry.updatedAt, now)} />
            </>
          ) : (
            <Meta label="体积" value={`${item.sizeMb} MB`} />
          )}
        </div>
      </div>

      <p className="line-clamp-1 text-xs leading-relaxed text-muted-foreground">{item.desc}</p>

      {reviewing ? (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-amber-400 transition-[width] duration-150 ease-linear"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-amber-300">
            {reviewStageLabel(progress ?? 0)} {Math.round(progress ?? 0)}%
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
        {entry ? (
          <Button variant="ghost" size="sm" onClick={onOpenDetail}>
            详情
          </Button>
        ) : null}

        {entry && !reviewing ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            编辑资料
          </Button>
        ) : null}

        {status === "local" ? (
          <span className="text-[11px] text-muted-foreground/60">
            还只在本地，提交后才会出现在别人的市场里
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {reviewing ? (
            <Button variant="ghost" size="sm" onClick={onWithdraw}>
              {reviewKind === "new" ? "撤回提交" : "撤回更新"}
            </Button>
          ) : null}

          {status === "local" ? (
            <Button variant="primary" size="sm" onClick={onSubmit}>
              <Upload className="h-3.5 w-3.5" />
              提交上架
            </Button>
          ) : null}

          {status === "listed" ? (
            <Button variant="outline" size="sm" onClick={onToggleListing}>
              <EyeOff className="h-3.5 w-3.5" />
              下架
            </Button>
          ) : null}

          {status === "delisted" ? (
            <Button variant="primary" size="sm" onClick={onToggleListing}>
              <Undo2 className="h-3.5 w-3.5" />
              重新上架
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
