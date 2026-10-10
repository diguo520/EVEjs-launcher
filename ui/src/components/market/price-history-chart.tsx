import { useMemo, useState } from "react"

import { useLocale } from "@/components/shell/locale-provider"
import type { RawMarketHistoryPoint } from "@/lib/ipc"
import {
  buildPriceChart,
  formatAxisTick,
  formatIsk,
  formatQty,
  pickAxisUnit,
  shortDay,
  type PriceChartLayout,
} from "@/lib/market-logic"

/**
 * 价格史大图（对齐游戏内市场图表的元素与口径）。
 *
 * 画的是游戏那张图的同一批东西，顺序也一样：上下影线 + 日平均价散点 + 5 / 20 日均线 +
 * 下方体积柱；价格刻度在左、体积刻度在右，两区共用一条横轴。
 *
 * 三点与游戏**刻意不同**，都是取舍不是偷懒：
 * - 配色沿用启动器的主题 token（`telemetry` 橙 / `primary` 青），而不是照搬游戏那层
 *   半透明玻璃 —— 这块面板两侧全是启动器自己的控件，混两种视觉语言会更花；
 * - **没有**「价格波动区间」那条灰带：游戏里它到底按 min/max 包络、滚动窗口还是 ±σ 算的
 *   没确认过，先留空，等口径确定再加，免得画出一条看着像其实不对的带；
 * - 没有缩放 / 平移 / 重置视角（游戏右侧那排开关）。窗口固定 30 天，够看趋势。
 *
 * 所有几何都来自 `buildPriceChart()`（纯函数、有单测），这里只负责把数字变成 SVG 元素
 * 与一个 hover 读数。
 */
export function PriceHistoryChart({
  history,
  layout = DEFAULT_LAYOUT,
  className,
}: {
  history: RawMarketHistoryPoint[]
  layout?: PriceChartLayout
  className?: string
}) {
  const { t, locale } = useLocale()
  const model = useMemo(() => buildPriceChart(history, layout), [history, layout])
  const [hover, setHover] = useState<number | null>(null)

  if (!model) return null
  const total = layout.padTop + layout.priceHeight + layout.gap + layout.volumeHeight + layout.padBottom
  const active = hover != null ? model.points[hover] : null
  // 单位按**整根轴**挑一次：逐刻度挑会让同一根轴上混出「0.70亿」和「8,800万」
  const priceUnit = pickAxisUnit(model.max, locale)
  const volumeUnit = pickAxisUnit(model.peakVolume, locale)

  const path = (points: { x: number; y: number }[]): string =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ")

  // 用箭头常量而不是 function 声明：`model` 的 null 收窄只在同一个控制流里成立，
  // function 声明会被提升，TS 不认它后面才发生的那次收窄（TS18047）。
  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = ((event.clientX - rect.left) / rect.width) * layout.width
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    model.points.forEach((point, index) => {
      const distance = Math.abs(point.x - x)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    setHover(best)
  }

  return (
    <div className={className}>
      <Legend t={t} />
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${layout.width} ${total}`}
          className="w-full"
          onMouseMove={move}
          onMouseLeave={() => setHover(null)}
          role="img"
        >
          {/* 价格区的横向网格 + 左侧刻度 */}
          {model.priceTicks.map((tick) => (
            <g key={`price-${tick.value}`}>
              <line
                x1={layout.padLeft}
                x2={layout.width - layout.padRight}
                y1={tick.y}
                y2={tick.y}
                className="stroke-border"
                strokeWidth="1"
                strokeDasharray="3 4"
                strokeOpacity="0.55"
              />
              <text
                x={layout.padLeft - 6}
                y={tick.y + 3}
                textAnchor="end"
                className="tabular fill-tertiary text-[10px]"
              >
                {formatAxisTick(tick.value, priceUnit)}
              </text>
            </g>
          ))}

          {/* 上下影线：一天一根，从最低价拉到最高价 */}
          {model.points.map((point) => (
            <line
              key={`w-${point.day}`}
              x1={point.x}
              x2={point.x}
              y1={point.yHigh}
              y2={point.yLow}
              className="stroke-muted-foreground"
              strokeWidth="1"
              strokeOpacity="0.6"
            />
          ))}

          {/* 体积区：从 0 起算的柱 */}
          {model.points.map((point) => (
            <rect
              key={`v-${point.day}`}
              x={point.x - BAR_HALF_WIDTH}
              y={point.yVolume}
              width={BAR_HALF_WIDTH * 2}
              height={Math.max(1, model.volumeBottom - point.yVolume)}
              className="fill-primary"
              fillOpacity="0.4"
            />
          ))}

          {/* 均线压在散点下面：先画线，再画点，点才不会被线盖住 */}
          {model.ma20.length > 1 ? (
            <path
              d={path(model.ma20)}
              className="fill-none stroke-primary"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          ) : null}
          {model.ma5.length > 1 ? (
            <path
              d={path(model.ma5)}
              className="fill-none stroke-telemetry"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          ) : null}

          {model.points.map((point) => (
            <circle key={`p-${point.day}`} cx={point.x} cy={point.yAvg} r="2.4" className="fill-telemetry" />
          ))}

          {/* 体积区的分隔线与右侧刻度 */}
          <line
            x1={layout.padLeft}
            x2={layout.width - layout.padRight}
            y1={model.volumeBottom}
            y2={model.volumeBottom}
            className="stroke-border"
            strokeWidth="1"
          />
          {model.volumeTicks.map((tick) => (
            <text
              key={`vol-${tick.value}`}
              x={layout.width - layout.padRight + 6}
              y={tick.y + 3}
              textAnchor="start"
              className="tabular fill-tertiary text-[10px]"
            >
              {formatAxisTick(tick.value, volumeUnit, 0)}
            </text>
          ))}

          {/* 横轴日期 */}
          {model.dayLabels.map((label) => (
            <text
              key={`d-${label.day}`}
              x={label.x}
              y={model.volumeBottom + 15}
              textAnchor="middle"
              className="tabular fill-tertiary text-[10px]"
            >
              {shortDay(label.day)}
            </text>
          ))}

          {/* hover：一条竖线 + 把当天那个点圈出来 */}
          {active ? (
            <g>
              <line
                x1={active.x}
                x2={active.x}
                y1={model.priceTop}
                y2={model.volumeBottom}
                className="stroke-primary"
                strokeWidth="1"
                strokeOpacity="0.7"
              />
              <circle
                cx={active.x}
                cy={active.yAvg}
                r="4"
                className="fill-telemetry stroke-background"
                strokeWidth="1.5"
              />
            </g>
          ) : null}
        </svg>

        {active ? (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-md border border-border bg-card/95 px-2 py-1.5 text-[11px] shadow-lg"
            style={{
              // 靠右时把读数翻到左边，别顶出面板
              left: `${(active.x / layout.width) * 100}%`,
              transform: active.x > layout.width * 0.62 ? "translateX(-100%)" : "translateX(0)",
              marginLeft: active.x > layout.width * 0.62 ? -8 : 8,
            }}
          >
            <div className="tabular mb-1 text-foreground">{active.day}</div>
            <Row label={t("日平均价")} value={formatIsk(active.avg)} tone="text-telemetry" />
            <Row label={t("上限")} value={formatIsk(active.high)} />
            <Row label={t("下限")} value={formatIsk(active.low)} />
            <Row label={t("成交量")} value={formatQty(active.volume)} tone="text-primary" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 图例：与游戏同一套分组（日均价 / 5 日 / 20 日 / 成交量） */
function Legend({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <Item className="bg-telemetry" label={t("日平均价")} round />
      <Item className="bg-telemetry" label={t("5 日均线")} />
      <Item className="bg-primary" label={t("20 日均线")} />
      <Item className="bg-primary/40" label={t("成交量")} />
    </div>
  )
}

function Item({ className, label, round }: { className: string; label: string; round?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={round ? `size-2 rounded-full ${className}` : `h-0.5 w-3 ${className}`} />
      {label}
    </span>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-tertiary">{label}</span>
      <span className={`tabular ${tone ?? "text-foreground"}`}>{value}</span>
    </div>
  )
}

/** 与游戏那张图的比例接近：主图明显高于体积条 */
const DEFAULT_LAYOUT: PriceChartLayout = {
  width: 900,
  priceHeight: 300,
  volumeHeight: 80,
  gap: 18,
  padLeft: 62,
  padRight: 54,
  padTop: 10,
  padBottom: 22,
}

/** 体积柱的半宽；30 天铺满 900 宽时每天约 27px，柱子占一半多留一点缝 */
const BAR_HALF_WIDTH = 7
