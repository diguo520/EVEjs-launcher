import { useState } from "react"
import { AlertTriangle, Check, Download, EyeOff, Pencil, Sparkles, Trash2, Undo2 } from "lucide-react"
import { formatInt, formatRelative } from "@/lib/format"
import { buildReviews, reviewStageLabel } from "@/lib/market"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Rating, RatingPicker } from "@/components/ui/rating"
import { cn } from "@/lib/utils"
import type { MarketItem } from "@/lib/market"

export interface MarketDetailDialogProps {
  item: MarketItem | null
  now: number
  onOpenChange: (open: boolean) => void
  onInstall: () => void
  onUpdate: () => void
  onUninstall: () => void
  onWithdraw: () => void
  /** 自己发的条目才有，用来改资料、提版本。 */
  onEdit: () => void
  /** 自己发的条目才有：下架 / 重新上架。 */
  onToggleListing: () => void
  /** 给这条打个 1–5 分。 */
  onRate: (stars: number) => void
  /** 收回自己打过的分。 */
  onClearRating: () => void
  /** 写 / 改自己那条评价。 */
  onSaveReview: (text: string) => void
  /** 删掉自己写的那条评价。 */
  onClearReview: () => void
  /** 当前作者署名，用来给本机写的那条评价署名。 */
  authorName: string
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-background/40 px-2.5 py-1.5">
      <span className="hud-label text-[10px] text-muted-foreground/60">{label}</span>
      <span className="truncate font-mono text-xs tabular-nums text-foreground">{value}</span>
    </div>
  )
}

const REVIEW_MAX = 200

/**
 * 写评价的输入框。初值从已保存的那条取，没改动就点不动「保存」——
 * 免得手滑点一下把写好的东西又存一遍。父级按条目 id 给了 key，
 * 换一条模组就是一次全新的挂载，不用另外写重置逻辑。
 */
function ReviewComposer({
  value,
  onSave,
  onClear,
}: {
  value: string
  onSave: (text: string) => void
  onClear: () => void
}) {
  const [text, setText] = useState(value)
  const trimmed = text.trim()
  const dirty = trimmed !== value.trim()

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        maxLength={REVIEW_MAX}
        placeholder="说两句：手感怎么样、稳不稳定、值不值得装"
        className="hud-scroll w-full resize-none rounded-sm border border-border bg-background/60 px-2 py-1.5 text-xs leading-relaxed text-foreground transition-colors placeholder:text-muted-foreground/50 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
          {text.length}/{REVIEW_MAX}
        </span>
        {value ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            删除评价
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={!dirty || trimmed === ""}
          onClick={() => onSave(text)}
        >
          {value ? "保存修改" : "发表评价"}
        </Button>
      </div>
    </div>
  )
}

/** 市场详情：把 README、功能要点与兼容性提醒放在一处，装之前能看全。 */
export function MarketDetailDialog({
  item,
  now,
  onOpenChange,
  onInstall,
  onUpdate,
  onUninstall,
  onWithdraw,
  onEdit,
  onToggleListing,
  onRate,
  onClearRating,
  onSaveReview,
  onClearReview,
  authorName,
}: MarketDetailDialogProps) {
  if (!item) return null
  const { entry, installed, status, progress, clashes, mine, reviewKind } = item
  const reviewing = status === "reviewing"
  const downloading = !reviewing && progress !== undefined
  // 下架的条目只有作者本人还看得到，所以这里不用再判断是不是自己的。
  const delisted = entry.delisted === true
  // 版本记录从新到旧排，最新那条就是当前版本。
  const versions = [...(entry.history ?? [])].reverse()
  // 评价列表：自己写的那条排最前，其余保持目录里的顺序。
  const reviews = buildReviews(entry, authorName)

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,720px)]"
      title={entry.name}
      description={`${entry.author} · ${entry.category} · ${entry.version}`}
      footer={
        <>
          <span className="mr-auto font-mono text-[10px] text-muted-foreground/60">
            {entry.requiresRestart ? "安装后需重启服务端生效" : "安装后无需重启"}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {mine && !reviewing ? (
            <Button variant="outline" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
              编辑资料
            </Button>
          ) : null}
          {mine && !reviewing ? (
            <Button variant="outline" onClick={onToggleListing}>
              {delisted ? (
                <>
                  <Undo2 className="h-3.5 w-3.5" />
                  重新上架
                </>
              ) : (
                <>
                  <EyeOff className="h-3.5 w-3.5" />
                  下架
                </>
              )}
            </Button>
          ) : null}
          {reviewing ? (
            <Button variant="outline" onClick={onWithdraw}>
              撤回提交
            </Button>
          ) : null}
          {installed ? (
            <Button variant="outline" onClick={onUninstall}>
              <Trash2 className="h-3.5 w-3.5" />
              卸载
            </Button>
          ) : null}
          {/* 下架之后没有可装可更的版本，这一格让给「重新上架」。 */}
          {reviewing || delisted ? null : status === "update" ? (
            <Button variant="primary" disabled={downloading} onClick={onUpdate}>
              <Download className="h-3.5 w-3.5" />
              {downloading ? `下载中 ${Math.round(progress ?? 0)}%` : `更新到 ${entry.version}`}
            </Button>
          ) : status === "available" ? (
            <Button variant="primary" disabled={downloading} onClick={onInstall}>
              <Download className="h-3.5 w-3.5" />
              {downloading ? `下载中 ${Math.round(progress ?? 0)}%` : "安装到本地"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {entry.featured ? (
            <Badge tone="warn">
              <Sparkles className="h-3 w-3" />
              官方精选
            </Badge>
          ) : null}
          {mine ? <Badge tone="primary">我发布的</Badge> : null}
          {delisted ? <Badge tone="warn">已下架</Badge> : null}
          {status === "installed" ? <Badge tone="success">已安装</Badge> : null}
          {status === "update" ? <Badge tone="warn">可更新</Badge> : null}
          {reviewing ? <Badge tone="primary">审核中 · {reviewStageLabel(progress ?? 0)}</Badge> : null}
          {entry.tags.map((tag) => (
            <Badge key={tag} tone="outline">
              {tag}
            </Badge>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Meta label="最新版本" value={entry.version} />
          <Meta label="本地版本" value={installed ? installed.version : "未安装"} />
          <Meta label="体积" value={`${entry.sizeMb} MB`} />
          <Meta label="更新时间" value={formatRelative(entry.updatedAt, now)} />
          <Meta label="下载量" value={formatInt(entry.downloads)} />
          <Meta label="评分人数" value={formatInt(entry.ratingCount)} />
          <Meta label="互斥模组" value={entry.conflicts.length > 0 ? `${entry.conflicts.length} 个` : "无"} />
          <Meta label="重启要求" value={entry.requiresRestart ? "需要" : "不需要"} />
        </div>

        <div className="flex flex-col gap-2 rounded-sm border border-border bg-background/40 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-3">
            {entry.ratingCount === 0 ? (
              <Badge tone="primary" className="shrink-0">
                新上架 · 暂无评分
              </Badge>
            ) : (
              <Rating value={entry.rating} count={entry.ratingCount} />
            )}
            <span className="ml-auto text-right text-xs text-muted-foreground">{entry.desc}</span>
          </div>

          {/* 自己发的作品不给自己抬分，抬了也只是把作者总览的数字搅浑。 */}
          {mine ? (
            <p className="text-[11px] text-muted-foreground/70">
              这是你自己发的，评分留给别人打。
            </p>
          ) : (
            <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <RatingPicker value={entry.myRating} onRate={onRate} onClear={onClearRating} />
                <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
                  你的这一票会计入上面的平均分
                </span>
              </div>

              {entry.myRating === undefined ? (
                <p className="text-[11px] text-muted-foreground/60">
                  打完分可以顺手写两句，让别人知道值不值得装。
                </p>
              ) : (
                <ReviewComposer
                  key={entry.id}
                  value={entry.myReview?.text ?? ""}
                  onSave={onSaveReview}
                  onClear={onClearReview}
                />
              )}
            </div>
          )}
        </div>

        {reviewing ? (
          <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/8 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground">
                审核中 · {reviewStageLabel(progress ?? 0)}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-primary">
                {Math.round(progress ?? 0)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-linear"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              {reviewKind === "update"
                ? "这是你给这个模组提的新版本。通过审核后市场目录会就地换成新版，已经装了旧版的人会看到「可更新」。审核期间可以随时撤回，撤回了目录还是旧版。"
                : "这是你提交的条目，通过审核后会自动上架，届时就能像其他模组一样安装。审核期间可以随时撤回。"}
            </p>
          </div>
        ) : null}

        {delisted ? (
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/8 px-3 py-2.5">
            <span className="hud-label text-[10px] text-amber-300">已下架 · 别人看不到这条</span>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              市场目录里不再展示它，别人搜不到也装不了。已经装了的人本地副本保留，但不会再收到更新提示。
              随时可以重新上架，下载量和评分不会清零。
            </p>
          </div>
        ) : null}

        {clashes.length > 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-red-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              与当前已启用的 {clashes.join("、")} 冲突。装完先别启用，停掉其中一个再开。
            </span>
          </div>
        ) : null}

        {/* 攒够两版才值得单列；只有一版就还按「本次更新」那一块显示。 */}
        {versions.length >= 2 ? (
          <section className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/8 px-3 py-2.5">
            <h3 className="hud-label text-[10px] text-primary">
              版本记录 · 共 {versions.length} 版
            </h3>
            <ol className="hud-scroll flex max-h-56 flex-col gap-2.5 overflow-y-auto pr-1">
              {versions.map((item, index) => (
                <li key={`${item.version}-${item.at}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={index === 0 ? "primary" : "outline"}
                      className="px-1 py-0 text-[10px]"
                    >
                      {item.version}
                    </Badge>
                    {index === 0 ? (
                      <span className="text-[10px] text-primary">当前版本</span>
                    ) : null}
                    <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                      {formatRelative(item.at, now)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {item.changelog || "首个版本"}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        ) : entry.changelog ? (
          <section className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/8 px-3 py-2.5">
            <h3 className="hud-label text-[10px] text-primary">本次更新 · {entry.version}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{entry.changelog}</p>
          </section>
        ) : null}

        {entry.highlights.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="hud-label text-[10px] text-muted-foreground/70">功能要点</h3>
            <ul className="flex flex-col gap-1.5">
              {entry.highlights.map((line) => (
                <li
                  key={line}
                  className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="hud-label text-[10px] text-muted-foreground/70">模组说明</h3>
          <div className="flex flex-col gap-2">
            {entry.readme.map((paragraph) => (
              <p key={paragraph} className="text-xs leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </div>
        </section>

        {reviews.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="hud-label text-[10px] text-muted-foreground/70">
              玩家评价 · {reviews.length} 条
            </h3>
            <ul className="hud-scroll flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {reviews.map((review) => (
                <li
                  key={`${review.author}-${review.at}`}
                  className={cn(
                    "flex flex-col gap-1 rounded-sm border px-2.5 py-2",
                    review.mine ? "border-primary/35 bg-primary/8" : "border-border bg-background/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">{review.author}</span>
                    {review.mine ? (
                      <Badge tone="primary" className="px-1 py-0 text-[10px]">
                        你写的
                      </Badge>
                    ) : null}
                    <Rating value={review.stars} />
                    <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                      {formatRelative(review.at, now)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{review.text}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}
