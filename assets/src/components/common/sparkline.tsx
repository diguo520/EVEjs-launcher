import type { Metric } from "@/lib/mock"
import { cn } from "@/lib/utils"

type Tone = Metric["tone"]

/** 曲线颜色跟读数状态走，取主题变量而不是写死色值 */
const TONE_STROKE: Record<Tone, string> = {
  primary: "hsl(var(--primary))",
  telemetry: "hsl(var(--telemetry))",
  success: "hsl(var(--success))",
  warning: "hsl(var(--warning))",
  destructive: "hsl(var(--destructive))",
}

const W = 100
const H = 26
const PAD = 3
/** 变化很小时的兜底量程，免得一条几乎平的线被拉成过山车 */
const MIN_SPAN = 6

/**
 * 迷你走势曲线：把一串采样画成线，具体数值由旁边的文字给出。
 * 横向非等比拉伸铺满容器，配 non-scaling-stroke 保证线宽不被拉变形。
 */
export function Sparkline({
  points,
  tone = "primary",
  className,
}: {
  points: number[]
  tone?: Tone
  className?: string
}) {
  if (points.length < 2) return null

  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(max - min, MIN_SPAN)
  // 以中位为中心扩到量程，平缓的数据落在中间一条线上
  const lo = (min + max) / 2 - span / 2

  const x = (index: number) => (index / (points.length - 1)) * W
  const y = (value: number) => H - PAD - ((value - lo) / span) * (H - PAD * 2)
  const line = points
    .map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`)
    .join(" ")
  const color = TONE_STROKE[tone]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      // 数值已由旁边的文字给出，曲线只是形状，读屏时跳过
      aria-hidden
      className={cn("h-5 w-full", className)}
    >
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={color} opacity="0.1" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
