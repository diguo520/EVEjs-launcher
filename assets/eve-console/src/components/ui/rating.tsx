import { useState } from "react"
import { Star } from "lucide-react"
import { formatInt } from "@/lib/format"
import { cn } from "@/lib/utils"

const STARS = [0, 1, 2, 3, 4]

export interface RatingProps {
  /** 0–5 分，支持小数。 */
  value: number
  /** 评分人数，传了才显示括号计数。 */
  count?: number
  className?: string
}

/**
 * 五星评分。底层铺一排灰星，上面盖一排金星并用百分比宽度裁切，
 * 这样半星不用额外准备图标，任意小数都能准确显示。
 */
export function Rating({ value, count, className }: RatingProps) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100))

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="relative inline-flex shrink-0" title={`评分 ${value.toFixed(1)} / 5`}>
        <span className="flex gap-px text-muted-foreground/30">
          {STARS.map((i) => (
            <Star key={i} className="h-3 w-3 shrink-0" fill="currentColor" strokeWidth={0} />
          ))}
        </span>
        <span className="absolute inset-0 overflow-hidden" style={{ width: `${pct}%` }}>
          <span className="flex gap-px text-amber-300">
            {STARS.map((i) => (
              <Star key={i} className="h-3 w-3 shrink-0" fill="currentColor" strokeWidth={0} />
            ))}
          </span>
        </span>
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {value.toFixed(1)}
      </span>
      {count !== undefined ? (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
          ({formatInt(count)})
        </span>
      ) : null}
    </span>
  )
}

export interface RatingPickerProps {
  /** 本机已经打过的分，1–5；没打过就不传。 */
  value?: number
  onRate: (stars: number) => void
  /** 收回自己那一票。没打过分的时候不显示这个入口。 */
  onClear: () => void
  className?: string
}

/**
 * 五星打分器。星星是可点的按钮，悬停先预览要打几分，点下去才算数。
 * 已经在下面那行显示的是所有人的平均分，这里只管本机自己那一票。
 */
export function RatingPicker({ value, onRate, onClear, className }: RatingPickerProps) {
  const [hover, setHover] = useState<number | null>(null)
  // 悬停时按悬停的分亮，移开就回到自己已经打过的分。
  const shown = hover ?? value ?? 0

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="hud-label text-[10px] text-muted-foreground/60">
        {value === undefined ? "我的评分" : "你打了"}
      </span>

      <span
        className="flex items-center gap-px"
        onMouseLeave={() => setHover(null)}
        role="radiogroup"
        aria-label="给这个模组打分"
      >
        {STARS.map((i) => {
          const star = i + 1
          const lit = star <= shown
          return (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={value === star}
              aria-label={`打 ${star} 分`}
              title={`打 ${star} 分`}
              onMouseEnter={() => setHover(star)}
              onFocus={() => setHover(star)}
              onBlur={() => setHover(null)}
              onClick={() => onRate(star)}
              className="rounded-sm p-0.5 transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              <Star
                className={cn(
                  "h-4 w-4 transition-colors",
                  lit ? "text-amber-300" : "text-muted-foreground/30 hover:text-amber-300/60",
                )}
                fill="currentColor"
                strokeWidth={0}
              />
            </button>
          )
        })}
      </span>

      {hover !== null ? (
        <span className="font-mono text-[10px] tabular-nums text-amber-300">打 {hover} 分</span>
      ) : value !== undefined ? (
        <>
          <span className="font-mono text-[10px] tabular-nums text-foreground">{value} 分</span>
          <button
            type="button"
            onClick={onClear}
            className="rounded-sm font-mono text-[10px] text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            收回评分
          </button>
        </>
      ) : (
        <span className="font-mono text-[10px] text-muted-foreground/60">点星星打分</span>
      )}
    </div>
  )
}
