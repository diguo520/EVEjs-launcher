import { cn } from "@/lib/utils"

export interface SparklineProps {
  data: number[]
  /** 归一化上界；不传则取数据最大值。 */
  max?: number
  height?: number
  tone?: "primary" | "warn" | "danger" | "neutral"
  className?: string
}

const TONE_STROKE: Record<NonNullable<SparklineProps["tone"]>, string> = {
  primary: "hsl(var(--primary))",
  // SVG stroke 吃不到 Tailwind class，这里直接给色值。warn 没有对应 token，
  // 取 amber-400 与别处的 text-amber-300 同族；danger 复用 --destructive。
  warn: "hsl(38 92% 50%)",
  danger: "hsl(var(--destructive))",
  neutral: "hsl(var(--muted-foreground))",
}

/**
 * 手绘 SVG 折线：交易终端那种贴边、无圆角、带渐变填充的迷你走势。
 * 用 SVG 而不是图表库，密集面板里几十条曲线也不会拖慢渲染。
 */
export function Sparkline({
  data,
  max,
  height = 44,
  tone = "primary",
  className,
}: SparklineProps) {
  const width = 100
  const stroke = TONE_STROKE[tone]

  if (data.length < 2) {
    return (
      <div
        className={cn("flex items-center justify-center", className)}
        style={{ height }}
      >
        <span className="font-mono text-xs text-muted-foreground/60">等待采样…</span>
      </div>
    )
  }

  const upper = max ?? Math.max(...data) * 1.15
  const safeUpper = upper <= 0 ? 1 : upper
  const step = width / (data.length - 1)
  const points = data.map((value, index) => {
    const x = index * step
    const y = height - Math.max(0, Math.min(1, value / safeUpper)) * height
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const gradientId = `spark-${tone}`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.32" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${height} ${points.join(" ")} ${width},${height}`}
        fill={`url(#${gradientId})`}
      />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="miter"
      />
    </svg>
  )
}

export interface MiniBarsProps {
  items: { label: string; value: number }[]
  className?: string
}

/** 横向分布条：角色 / 势力占比这类小数据用。 */
export function MiniBars({ items, className }: MiniBarsProps) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
            {item.label}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.round((item.value / total) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}
