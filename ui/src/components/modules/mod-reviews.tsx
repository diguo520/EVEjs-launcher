import { useState } from "react"
import { t } from "@/lib/i18n"
import { PlayerFlag, fromCountryLabel } from "@/lib/player-name"
import {
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Pencil,
  Star,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  REVIEW_FILTER_LABEL,
  REVIEW_SORT_LABEL,
  REVIEW_SORT_ORDER,
  countReviewFilters,
  isStaleReview,
  matchReviewFilter,
  pendingReplies,
  ratingOf,
  reviewFilterOrder,
  relativeDate,
  reviewCount,
  sortReviews,
  todayISO,
  type ReviewFilter,
  type ReviewSort,
} from "@/lib/mod-logic"
import type { ModEntry, ModReview } from "@/lib/mock"
import { useLocale } from "@/components/shell/locale-provider"
import { cn } from "@/lib/utils"

/** 五颗星：满星数按四舍五入，空星只留描边 */
export function Stars({ value, className }: { value: number; className?: string }) {
  const filled = Math.round(value)
  return (
    <span className={cn("flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn("size-3", n <= filled ? "text-telemetry" : "text-border")}
          fill={n <= filled ? "currentColor" : "none"}
        />
      ))}
    </span>
  )
}

/** 评分汇总行：大星 + 综合分 + 评分人数（简介挪到详情标题下了，长简介不再把这一行撑高） */
function RatingRow({ mod }: { mod: ModEntry }) {
  const { average, count } = ratingOf(mod)

  if (count === 0) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
        <Stars value={0} />
        <span className="text-[12px] text-tertiary">暂无评分</span>
        <span className="text-[11px] text-tertiary/80">
          还没有人打分，装过之后回来投一票。
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
      <Stars value={average} />
      <span className="tabular text-[14px] font-semibold text-foreground">
        {average.toFixed(1)}
      </span>
      <span className="tabular text-[11px] text-tertiary">
        ({count.toLocaleString()})
      </span>
    </div>
  )
}

/** 点星：写评分和改评分共用同一套星标 */
function StarPicker({
  value,
  onChange,
}: {
  value: number
  onChange: (stars: number) => void
}) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={t("{n} 星", { n })}
          aria-pressed={n === value}
          onClick={() => onChange(n)}
          className="rounded-sm p-0.5 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Star
            className={cn("size-4", n <= value ? "text-telemetry" : "text-border")}
            fill={n <= value ? "currentColor" : "none"}
          />
        </button>
      ))}
    </span>
  )
}

/**
 * 我的评分。打分是主操作，写两句是顺手的事，
 * 所以先只露星标，点了星再展开输入框——不写文字也能只打分。
 */
function MyRating({
  mod,
  onSubmit,
}: {
  mod: ModEntry
  onSubmit: (input: { stars: number; body: string }) => void
}) {
  const [stars, setStars] = useState(0)
  const [body, setBody] = useState("")

  const mine = mod.reviews.find((review) => review.mine) ?? null

  if (mine) {
    return (
      <div className="rounded-md border border-input bg-background/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[12px] font-semibold text-foreground">我的评分</span>
          <Stars value={mine.stars} />
          <span className="tabular text-[11px] text-foreground">
            {mine.stars.toFixed(1)}
          </span>
          <span className="min-w-2 flex-1" />
          <span className="text-[10px] text-tertiary">
            你的这一票已经计入上面的平均分
          </span>
        </div>
        <p className="mt-1 text-[11px] text-tertiary/80">
          想改分数或者改文字，在下面那条「我的评价」上点修改。
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-input bg-background/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[12px] font-semibold text-foreground">我的评分</span>
        <StarPicker value={stars} onChange={setStars} />
        <span className="text-[11px] text-tertiary">
          {stars > 0 ? t("{n} 星", { n: stars }) : "点星星打分"}
        </span>
        <span className="min-w-2 flex-1" />
        <span className="text-[10px] text-tertiary">
          你的这一票会计入上面的平均分
        </span>
      </div>

      <p className="mt-1 text-[11px] text-tertiary/80">
        打满分可以顺手写两句，让别人知道值不值得装。
      </p>

      {stars > 0 ? (
        <>
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="说说实际用起来怎么样，比如和哪些模组冲突、占用多少资源。"
            className="mt-2 min-h-[64px] text-[12px]"
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <span className="text-[10px] text-tertiary">不写文字也可以只打分</span>
            <Button
              size="sm"
              onClick={() => {
                onSubmit({ stars, body: body.trim() })
                setStars(0)
                setBody("")
              }}
            >
              发布评价
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 评价列表的排序与筛选：做成一行小字，不跟主内容抢视线 */
function ReviewControls({
  order,
  counts,
  filter,
  onFilterChange,
  sort,
  onSortChange,
}: {
  /** 按身份裁过的分档顺序：作者的模组才摆「待回复」 */
  order: ReviewFilter[]
  counts: Record<ReviewFilter, number>
  filter: ReviewFilter
  onFilterChange: (filter: ReviewFilter) => void
  sort: ReviewSort
  onSortChange: (sort: ReviewSort) => void
}) {
  const chip = (active: boolean) =>
    cn(
      "rounded-sm px-1.5 py-0.5 text-[11px] transition-colors",
      active ? "font-semibold text-primary" : "text-tertiary hover:text-foreground"
    )

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-0.5">
        {REVIEW_SORT_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === sort}
            onClick={() => onSortChange(item)}
            className={chip(item === sort)}
          >
            {REVIEW_SORT_LABEL[item]}
          </button>
        ))}
      </span>

      <span className="flex items-center gap-0.5">
        {order.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === filter}
            onClick={() => onFilterChange(item)}
            className={chip(item === filter)}
          >
            {REVIEW_FILTER_LABEL[item]}
            <span className="tabular ml-0.5">{counts[item]}</span>
          </button>
        ))}
      </span>
    </div>
  )
}

/** 作者回复的输入框：发布与修改共用，只有自己的模组才出现 */
function ReplyBox({
  initialBody = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialBody?: string
  submitLabel: string
  onSubmit: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState(initialBody)

  return (
    <div className="mt-1.5 rounded-sm border border-primary/30 bg-primary/5 px-2.5 py-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="以作者身份回复这条评价，说明修复计划或使用建议。"
        className="min-h-[56px] text-[12px]"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={body.trim().length === 0}
          onClick={() => onSubmit(body.trim())}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** 改自己的评价：复用写评价那套星标与输入框 */
function EditReview({
  review,
  onSubmit,
  onCancel,
}: {
  review: ModReview
  onSubmit: (input: { stars: number; body: string }) => void
  onCancel: () => void
}) {
  const [stars, setStars] = useState(review.stars)
  const [body, setBody] = useState(review.body)

  return (
    <div className="rounded-md border border-primary/40 bg-background/40 px-2.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[12px] font-semibold text-foreground">修改我的评价</span>
        <StarPicker value={stars} onChange={setStars} />
        <span className="tabular text-[11px] text-tertiary">{stars} 星</span>
      </div>

      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="说说实际用起来怎么样，比如和哪些模组冲突、占用多少资源。"
        className="mt-2 min-h-[64px] text-[12px]"
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" onClick={() => onSubmit({ stars, body: body.trim() })}>
          保存修改
        </Button>
      </div>
    </div>
  )
}

function ReviewItem({
  review,
  today,
  stale,
  canReply,
  onReply,
  onEditReply,
  onDeleteReply,
  onEdit,
  onDelete,
}: {
  review: ModReview
  /** 今天的日期，用来算「N 天前」 */
  today: string
  /** 评论写在旧版本上，标出版本号避免误导 */
  stale: boolean
  /** 自己的模组才允许回复 */
  canReply: boolean
  onReply: (body: string) => void
  onEditReply: (body: string) => void
  onDeleteReply: () => void
  onEdit: (input: { stars: number; body: string }) => void
  onDelete: () => void
}) {
  const { locale } = useLocale()
  const [replying, setReplying] = useState(false)
  const [editingReply, setEditingReply] = useState(false)
  const [confirmingReply, setConfirmingReply] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (editing) {
    return (
      <li>
        <EditReview
          review={review}
          onSubmit={(input) => {
            onEdit(input)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  return (
    <li className="rounded-md border border-input bg-background/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* 不显示昵称：评价服务不做账号，统一显示「来自 <地区> 的玩家」+ 旗子 */}
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <PlayerFlag country={review.country} />
          {fromCountryLabel(review.country, locale)}
        </span>
        <Stars value={review.stars} />
        <span className="tabular text-[11px] text-foreground">
          {review.stars.toFixed(1)}
        </span>
        {review.mine ? <Badge variant="default">我的评价</Badge> : null}
        {review.edited ? (
          <span className="text-[10px] text-tertiary">已编辑</span>
        ) : null}

        <span className="min-w-2 flex-1" />

        {stale ? (
          <span className="tabular text-[10px] text-tertiary">
            v{review.version}
          </span>
        ) : null}
        <span className="tabular text-[10px] text-tertiary">
          {relativeDate(review.date, today)}
        </span>

        {/* 自己的评价能改能删；别人的评价只有一个回复图标，不跟正文抢地方 */}
        {review.mine ? (
          confirming ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                确认删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                修改
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="hover:text-destructive"
                onClick={() => setConfirming(true)}
              >
                <Trash2 />
                删除
              </Button>
            </>
          )
        ) : canReply && !review.reply && !replying ? (
          /* 图标按钮没有文字，靠 title 和 aria-label 说明它是干什么的 */
          <Button
            variant="ghost"
            size="icon-sm"
            title="回复这条评价"
            aria-label="回复这条评价"
            onClick={() => setReplying(true)}
          >
            <CornerDownRight />
          </Button>
        ) : null}
      </div>

      {confirming ? (
        <p className="mt-1 text-[11px] text-destructive">
          删除后这条评价会从列表移除，该模组的评分人数与平均分一并回退。
        </p>
      ) : null}

      {review.body ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          {review.body}
        </p>
      ) : null}

      {review.reply ? (
        editingReply ? (
          <ReplyBox
            initialBody={review.reply.body}
            submitLabel="保存回复"
            onCancel={() => setEditingReply(false)}
            onSubmit={(body) => {
              onEditReply(body)
              setEditingReply(false)
            }}
          />
        ) : (
          <div className="mt-1.5 rounded-sm border-l-2 border-primary/45 bg-primary/5 py-1.5 pl-2.5 pr-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] font-semibold text-primary">作者回复</span>
              <span className="tabular text-[10px] text-tertiary">
                {relativeDate(review.reply.date, today)}
              </span>
              {review.reply.edited ? (
                <span className="text-[10px] text-tertiary">已编辑</span>
              ) : null}

              <span className="min-w-2 flex-1" />

              {canReply ? (
                confirmingReply ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={onDeleteReply}
                    >
                      确认删除
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingReply(false)}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingReply(true)}
                    >
                      <Pencil />
                      修改回复
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hover:text-destructive"
                      onClick={() => setConfirmingReply(true)}
                    >
                      <Trash2 />
                      删除回复
                    </Button>
                  </>
                )
              ) : null}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {review.reply.body}
            </p>
          </div>
        )
      ) : replying ? (
        <ReplyBox
          submitLabel="发布回复"
          onCancel={() => setReplying(false)}
          onSubmit={(body) => {
            onReply(body)
            setReplying(false)
          }}
        />
      ) : null}
    </li>
  )
}

export interface ModReviewsProps {
  mod: ModEntry
  onAddReview: (input: { stars: number; body: string }) => void
  onReply: (reviewId: string, body: string) => void
  onEditReply: (reviewId: string, body: string) => void
  onDeleteReply: (reviewId: string) => void
  onEditReview: (reviewId: string, input: { stars: number; body: string }) => void
  onDeleteReview: (reviewId: string) => void
}

/** 默认先摊开几条，剩下的折起来，避免详情弹窗被评价撑得过长 */
const VISIBLE_REVIEWS = 3

/** 详情页的评分与评价：汇总行 + 我的评分 + 玩家评价列表（含作者回复） */
export function ModReviews({
  mod,
  onAddReview,
  onReply,
  onEditReply,
  onDeleteReply,
  onEditReview,
  onDeleteReview,
}: ModReviewsProps) {
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState<ReviewFilter>("all")
  const [sort, setSort] = useState<ReviewSort>("recent")

  const today = todayISO()
  const counts = countReviewFilters(mod.reviews)
  const total = reviewCount(mod)
  const pending = pendingReplies(mod)

  const order = reviewFilterOrder(mod)
  const reviews = sortReviews(
    mod.reviews.filter((review) => matchReviewFilter(review, filter)),
    sort
  )
  const folded = reviews.length > VISIBLE_REVIEWS
  const shown = showAll || !folded ? reviews : reviews.slice(0, VISIBLE_REVIEWS)

  return (
    <div className="space-y-2.5">
      <RatingRow mod={mod} />

      <MyRating mod={mod} onSubmit={onAddReview} />

      {total > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h4 className="panel-label">玩家评价 · {total} 条</h4>
          {/* 作者才有回复能力：有待回复时点一下直接筛出来，不用自己翻 */}
          {mod.mine ? (
            pending > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setFilter("pending")
                  setShowAll(false)
                }}
                className="rounded-sm text-[10px] font-semibold text-warning transition-colors hover:text-primary"
              >
                你是作者 · 还有 {pending} 条评价没回复，点这里筛出来
              </button>
            ) : (
              <span className="text-[10px] text-primary">
                你是作者 · 可以回复下面每一条
              </span>
            )
          ) : null}
          <span className="min-w-2 flex-1" />
          <ReviewControls
            order={order}
            counts={counts}
            filter={filter}
            onFilterChange={setFilter}
            sort={sort}
            onSortChange={setSort}
          />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center">
          <p className="text-[12px] text-tertiary">还没有人写评价</p>
          <p className="mt-1 text-[11px] text-tertiary/80">
            第一个写的人，后面来装的人都会看到。
          </p>
        </div>
      )}

      {reviews.length > 0 ? (
        <ul className="space-y-2">
          {shown.map((review) => (
            <ReviewItem
              key={review.id}
              review={review}
              today={today}
              stale={isStaleReview(review, mod)}
              canReply={Boolean(mod.mine)}
              onReply={(body) => onReply(review.id, body)}
              onEditReply={(body) => onEditReply(review.id, body)}
              onDeleteReply={() => onDeleteReply(review.id)}
              onEdit={(input) => onEditReview(review.id, input)}
              onDelete={() => onDeleteReview(review.id)}
            />
          ))}
        </ul>
      ) : total > 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center">
          <p className="text-[12px] text-tertiary">这个筛选下没有评价</p>
          <p className="mt-1 text-[11px] text-tertiary/80">
            换个筛选条件，或者点上面的「全部」。
          </p>
        </div>
      ) : null}

      {folded ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? <ChevronUp /> : <ChevronDown />}
            {showAll ? "收起" : t("展开全部 {count} 条评价", { count: reviews.length })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
