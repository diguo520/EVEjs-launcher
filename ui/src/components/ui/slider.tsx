import { cn } from "@/lib/utils"

/**
 * 拉动条（原生 input[type=range]）。
 *
 * 为什么不用 @radix-ui/react-slider：这是本页唯一的滑块需求，而 Radix 那一份会
 * 再拉一个依赖进来；原生 range 在 WebView2（Chromium）里键盘、无障碍、拖拽全都现成，
 * 只差一层外观。配色走主题变量，和开关 / 输入框同一套。
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(Number(event.target.value))}
      className={cn(
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary outline-none",
        "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none",
        "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border",
        "[&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary",
        "[&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110",
        "focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  )
}

/** 滑块 + 精确输入：拖动条看手感，输数字求准值 */
export function SliderField({
  value,
  min,
  max,
  step,
  text,
  onText,
  disabled,
  label,
  className,
}: {
  value: number
  min: number
  max: number
  step: number
  /** 输入框里的原始文本（编辑途中可能是 "" / "1."） */
  text: string
  onText: (text: string) => void
  disabled?: boolean
  label: string
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Slider
        value={Number.isFinite(value) ? value : min}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(next) => onText(String(next))}
      />
      <input
        value={text}
        disabled={disabled}
        inputMode="decimal"
        aria-label={label}
        onChange={(event) => onText(event.target.value)}
        className={cn(
          "tabular h-7 w-20 shrink-0 rounded-md border border-input bg-transparent px-2 text-right text-[12px]",
          "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
        )}
      />
    </div>
  )
}