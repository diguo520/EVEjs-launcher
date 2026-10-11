import * as React from "react"
import { AlertTriangle, Loader2, Minus, Plus, Radio } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatIskShort } from "@/lib/market-logic"
import {
  colorOf,
  eventTone,
  umbrellaTone,
  type EventTone,
  type FactionEvent,
  type UmbrellaState,
} from "@/lib/faction-logic"
import { useLocale } from "@/components/shell/locale-provider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * 旗舰保护伞的状态色：与模组自己的分档一致（就绪=绿 / 冷却=黄 / 参战=红 / 未启用与未组建=灰）。
 * 军事页的状态徽标与总览势力卡上的徽标共用这一份，避免两处着色漂移。
 */
export const UMBRELLA_TONE_CLASS: Record<
  ReturnType<typeof umbrellaTone>,
  string
> = {
  success: "border-success/50 text-success",
  warning: "border-warning/50 text-warning",
  destructive: "border-destructive/50 text-destructive",
  muted: "border-border text-muted-foreground",
}

export function umbrellaToneClass(state: UmbrellaState): string {
  return UMBRELLA_TONE_CLASS[umbrellaTone(state)]
}

/**
 * 势力推演页统一的下拉：**不用原生 `<select>`**。
 *
 * 原生控件的展开面板由系统画（浅色高亮条 + 系统滚动条），在启动器这套暗色指挥室里格外扎眼，
 * 也跟其它页的 shadcn 下拉不是一套观感。这里把 shadcn 的 Select 收成 24px 的行高，
 * 尺寸与页面里的筛选按钮、输入框对齐。
 */
export function FactionSelect({
  value,
  onChange,
  options,
  className,
  ariaLabel,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  className?: string
  ariaLabel?: string
  placeholder?: string
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          "h-6 w-full gap-1 rounded-sm border-input bg-transparent px-2 py-0 text-[11px] text-muted-foreground [&>span]:text-left [&_svg]:size-3",
          className
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[300px]">
        {options.map((item) => (
          <SelectItem key={item.value} value={item.value} className="py-1 pl-2 pr-6 text-[11.5px]">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * 主题化的数字框：**不带原生上下三角**。
 *
 * `<input type="number">` 在 WebView2 里会画一块系统的灰色微调按钮，跟这套暗色界面不搭；
 * 这里用文本输入（`inputMode` 保证桌面端也只弹数字键盘）+ 两个减/加按钮，
 * 取值一律夹在 [min, max] 内，空输入回落到 min。
 */
export function FactionNumber({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
  ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  className?: string
  ariaLabel?: string
}) {
  const { t } = useLocale()
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  const button =
    "inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-input text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        aria-label={t("减 {n}", { n: step })}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className={button}
      >
        <Minus className="size-3" />
      </button>
      <input
        value={String(value)}
        inputMode="numeric"
        aria-label={ariaLabel}
        onChange={(event) => {
          const digits = event.target.value.replace(/[^\d]/g, "")
          onChange(digits === "" ? min : clamp(Number(digits)))
        }}
        className="tabular h-6 w-16 rounded-sm border border-input bg-transparent px-2 text-center text-[11px] text-foreground focus:border-primary focus:outline-none"
      />
      <button
        type="button"
        aria-label={t("加 {n}", { n: step })}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className={button}
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}

/** 势力色点：面板给的是十六进制色，非法值退成中性灰 */
export function FactionDot({
  color,
  className,
}: {
  color: string | undefined
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: colorOf(color) }}
    />
  )
}

const TIER_LABEL: Record<string, string> = {
  major: "大势力",
  empire: "帝国",
  minor: "独立势力",
  clan: "氏族",
  trader: "商团",
  pirate: "海盗",
  fallen: "没落",
}

/** 层级 id → 当前语言的名字（面板只给 id，名字在启动器这边） */
export function tierLabelOf(tier: string, t: (source: string) => string): string {
  const label = TIER_LABEL[tier]
  return label ? t(label) : tier
}

/** 势力层级徽标（文案口径与模组自己的标签一致） */
export function TierChip({ tier, count }: { tier: string; count?: number }) {
  const { t } = useLocale()
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {tierLabelOf(tier, t)}
      {typeof count === "number" ? <span className="tabular text-tertiary">{count}</span> : null}
    </span>
  )
}

/** 一段小横条：领地分布、库存缺口一类「部分 / 全部」的读数 */
export function MiniBar({
  value,
  max,
  color,
  className,
}: {
  value: number
  max: number
  color?: string
  className?: string
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <span className={cn("inline-block h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <span
        className="block h-full rounded-full"
        style={{ width: `${ratio * 100}%`, backgroundColor: colorOf(color) }}
      />
    </span>
  )
}

/** 标签 + 数值的一行（卡片的通用读数列） */
export function Field({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "default" | "warning" | "destructive" | "success"
}) {
  const toneClass = {
    default: "text-foreground",
    warning: "text-warning",
    destructive: "text-destructive",
    success: "text-success",
  }[tone ?? "default"]
  return (
    <div className="min-w-0">
      <div className="panel-label truncate">{label}</div>
      <div className={cn("tabular mt-0.5 truncate text-[13px] font-semibold", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-tertiary">{hint}</div> : null}
    </div>
  )
}

/** 空态 / 错误态 / 加载态：三种状态的统一画法，别让面板开天窗 */
export function PanelState({
  loading,
  error,
  empty,
  emptyHint,
  onRetry,
  children,
}: {
  loading?: boolean
  error?: string
  empty?: boolean
  emptyHint?: React.ReactNode
  onRetry?: () => void
  children?: React.ReactNode
}) {
  const { t } = useLocale()
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("正在读取面板")}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <AlertTriangle className="size-4 text-warning" />
        <div className="max-w-md text-[12px] text-muted-foreground">{error}</div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            {t("重试")}
          </button>
        ) : null}
      </div>
    )
  }
  if (empty) {
    return (
      <div className="py-10 text-center text-[12px] text-muted-foreground">
        {emptyHint ?? t("面板还没给出数据")}
      </div>
    )
  }
  return <>{children}</>
}

const TONE_CLASS: Record<EventTone, string> = {
  fleet: "text-telemetry",
  combat: "text-destructive",
  intel: "text-primary",
  territory: "text-warning",
  economy: "text-success",
  logistics: "text-muted-foreground",
  system: "text-tertiary",
  other: "text-muted-foreground",
}

/**
 * 势力动态：事件流的滚动列表。
 *
 * 文案直接用模组写好的 `text`（几百种事件类型，重启一遍文案表没有意义，还会跟着模组升级漂移）；
 * 只有时间和分组着色是启动器加的。掉线时**必须**显式标出来 —— 静默停在最后一帧会让人
 * 以为「世界不动了」，而实际是连接断了。
 */
export function EventFeed({
  events,
  colorByKey,
  connected,
  streamReason,
  limit = 60,
  className,
}: {
  events: FactionEvent[]
  colorByKey: Map<string, string>
  connected: boolean
  streamReason?: string
  limit?: number
  className?: string
}) {
  const { t } = useLocale()
  const rows = events.slice(0, limit)
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-1.5 pb-2 text-[10px]">
        <Radio className={cn("size-3", connected ? "text-success" : "text-warning")} />
        <span className={connected ? "text-success" : "text-warning"}>
          {connected ? t("实时") : t("已断开")}
        </span>
        {!connected && streamReason ? (
          <span className="truncate text-tertiary">{streamReason}</span>
        ) : null}
        <span className="ml-auto tabular text-tertiary">{rows.length}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-tertiary">{t("还没有事件")}</div>
        ) : (
          rows.map((item) => {
            const color = item.factionKey ? colorByKey.get(item.factionKey) : undefined
            return (
              <div key={item.id} className="flex items-baseline gap-2 text-[11.5px] leading-relaxed">
                <span className="tabular shrink-0 text-tertiary">
                  {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
                </span>
                <span className={cn("shrink-0", TONE_CLASS[eventTone(item.group)])}>{item.label}</span>
                {color ? <FactionDot color={color} /> : null}
                <span className="min-w-0 flex-1 text-muted-foreground">{item.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 势力名 + 颜色的小徽标（列表里到处要用） */
export function FactionTag({
  name,
  color,
  className,
}: {
  name: string
  color?: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <FactionDot color={color} />
      <span className="truncate text-[12px] text-foreground">{name}</span>
    </span>
  )
}

/** 金额读数（走启动器统一的 ISK 短写法 K/M/B） */
export function Isk({ value, className }: { value: number; className?: string }) {
  return <span className={cn("tabular", className)}>{formatIskShort(value)}</span>
}
