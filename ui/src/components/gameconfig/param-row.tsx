import { RotateCcw } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SliderField } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLocale } from "@/components/shell/locale-provider"
import { cn } from "@/lib/utils"
import {
  controlOf,
  labelOf,
  sliderSpecOf,
  valueSummary,
  type GameConfigDefinition,
} from "@/lib/game-config-model"

/**
 * 一条宇宙参数：左边名字 + key + 默认值，右边控件。两列并排由外层网格摆。
 *
 * 服务端的英文说明放在悬停提示里，不铺在行内 —— 167 条铺开会让面板变成一堵墙。
 * 被环境变量接管的条目整行置灰并标注：改文件对它不生效。
 */
export function ParamRow({
  def,
  text,
  defaultValue,
  envLocked,
  changed,
  error,
  onText,
  onReset,
}: {
  def: GameConfigDefinition
  text: string
  defaultValue: unknown
  envLocked: boolean
  changed: boolean
  error?: string
  onText: (value: string) => void
  onReset: () => void
}) {
  const { t } = useLocale()
  const control = controlOf(def)
  const slider = sliderSpecOf(def)
  const description = def.description.join("\n")

  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-1.5 border-b border-border/60 px-4 py-3",
        "sm:grid-cols-[minmax(0,1fr)_minmax(0,260px)] sm:items-center",
        envLocked && "opacity-60"
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] text-foreground">{labelOf(def)}</span>
          {changed ? (
            <span className="shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
              已改
            </span>
          ) : null}
          {envLocked ? (
            <span className="shrink-0 rounded-sm border border-warning/40 bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
              环境变量接管
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={labelOf(def)}
                className="tabular min-w-0 flex-1 truncate text-left text-[10px] text-tertiary hover:text-muted-foreground"
              >
                {def.key}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-[420px] whitespace-pre-line">
              {def.key}
              {description ? "\n" + description : ""}
              {def.validValues ? "\n" + def.validValues : ""}
              {def.envVar ? "\n环境变量：" + def.envVar : ""}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="tabular mt-0.5 truncate text-[10px] text-tertiary">
          {t("默认 {value}", { value: valueSummary(defaultValue) || "—" })}
        </div>
        {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Control
            def={def}
            text={text}
            control={control}
            slider={slider}
            disabled={envLocked}
            onText={onText}
          />
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={envLocked}
          aria-label="恢复默认值"
          title="恢复默认值"
          className={cn(
            "shrink-0 rounded-md p-1.5 text-tertiary transition-colors",
            "hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus",
            "disabled:pointer-events-none disabled:opacity-40"
          )}
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function Control({
  def,
  text,
  control,
  slider,
  disabled,
  onText,
}: {
  def: GameConfigDefinition
  text: string
  control: ReturnType<typeof controlOf>
  slider: ReturnType<typeof sliderSpecOf>
  disabled: boolean
  onText: (value: string) => void
}) {
  const name = labelOf(def)

  if (control === "switch") {
    return (
      <div className="flex items-center gap-2">
        <Switch
          checked={text === "true"}
          disabled={disabled}
          aria-label={name}
          onCheckedChange={(next) => onText(next ? "true" : "false")}
        />
        <span className="tabular text-[11px] text-muted-foreground">
          {text === "true" ? "开" : "关"}
        </span>
      </div>
    )
  }

  if (control === "slider" && slider) {
    return (
      <SliderField
        value={Number(text)}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        text={text}
        label={name}
        disabled={disabled}
        onText={onText}
      />
    )
  }

  if (control === "select") {
    const options = (def.allowedValues ?? []).map(String)
    return (
      <Select value={text} disabled={disabled} onValueChange={onText}>
        <SelectTrigger aria-label={name} className="h-7 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option} className="text-[12px]">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (control === "json") {
    return (
      <Textarea
        value={text}
        disabled={disabled}
        rows={4}
        spellCheck={false}
        aria-label={name}
        onChange={(event) => onText(event.target.value)}
        className="min-h-0 font-mono text-[11px] leading-relaxed"
      />
    )
  }

  return (
    <Input
      value={text}
      disabled={disabled}
      spellCheck={false}
      inputMode={control === "number" ? "decimal" : undefined}
      aria-label={name}
      onChange={(event) => onText(event.target.value)}
      className={cn("tabular h-7 text-[12px]", control === "text" && "font-mono text-[11px]")}
    />
  )
}