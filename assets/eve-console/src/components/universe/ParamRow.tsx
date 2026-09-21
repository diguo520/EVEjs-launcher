import { useRef, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useEngine } from "@/lib/engine"
import type { UniverseConfig } from "@/lib/types"
import { formatDefaultText, formatFieldValue, type ConfigField } from "./configMeta"

/** 一行参数：左侧名称+说明，中间控件，右侧当前值。 */
export function ParamRow({
  label,
  desc,
  control,
  display,
  defaultText,
}: {
  label: string
  desc: string
  control: ReactNode
  display: string
  defaultText: string
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:grid-cols-[minmax(150px,1.1fr)_minmax(0,1.4fr)_auto]">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground" title={label}>
          {label}
        </p>
        <p className="truncate text-xs text-muted-foreground/70" title={desc}>
          {desc}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        {control}
        <p className="font-mono text-[10px] tabular-nums text-muted-foreground/50">{defaultText}</p>
      </div>

      <div className="flex shrink-0 items-center justify-end sm:w-[104px]">
        <span className="font-mono text-sm tabular-nums text-foreground">{display}</span>
      </div>
    </div>
  )
}

/**
 * 数值输入框：非受控，失焦或回车才提交并夹紧到区间。
 * key 绑在外部值上，外部重置参数（例如恢复默认）时自动重挂载回填。
 */
export function NumberParam({
  value,
  min,
  max,
  onValueChange,
}: {
  value: number
  min: number
  max: number
  onValueChange: (next: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = () => {
    const el = inputRef.current
    if (!el) return
    const parsed = Number(el.value)
    if (el.value.trim() === "" || !Number.isFinite(parsed)) {
      el.value = String(value)
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
    el.value = String(clamped)
    if (clamped !== value) onValueChange(clamped)
  }

  return (
    <Input
      ref={inputRef}
      key={value}
      defaultValue={value}
      inputMode="numeric"
      className="font-mono tabular-nums"
      onChange={(e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, "")
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit()
      }}
    />
  )
}

function renderControl(
  field: ConfigField,
  raw: number | string | boolean,
  setNumber: (next: number) => void,
  setFlag: (next: boolean) => void,
  setText: (next: string) => void,
): ReactNode {
  if (field.control === "slider" && typeof raw === "number") {
    return (
      <Slider
        value={raw}
        min={field.min ?? 0}
        max={field.max ?? 100}
        step={field.step ?? 1}
        onValueChange={setNumber}
      />
    )
  }

  if (field.control === "switch") {
    return <Switch checked={raw === true} onCheckedChange={setFlag} />
  }

  if (field.control === "number" && typeof raw === "number") {
    return (
      <NumberParam
        value={raw}
        min={field.min ?? 0}
        max={field.max ?? 9999}
        onValueChange={setNumber}
      />
    )
  }

  if (field.control === "password") {
    return (
      <Input
        type="password"
        autoComplete="off"
        value={typeof raw === "string" ? raw : ""}
        className="font-mono"
        onChange={(e) => setText(e.target.value)}
      />
    )
  }

  return (
    <Input value={typeof raw === "string" ? raw : ""} onChange={(e) => setText(e.target.value)} />
  )
}

/** 按字段元数据渲染对应的控件，并直接写回 engine 的 config。 */
export function ConfigRow({ field }: { field: ConfigField }) {
  const { config, updateConfig } = useEngine()
  const raw = config[field.key]

  const setNumber = (next: number) => updateConfig({ [field.key]: next } as Partial<UniverseConfig>)
  const setFlag = (next: boolean) => updateConfig({ [field.key]: next } as Partial<UniverseConfig>)
  const setText = (next: string) => updateConfig({ [field.key]: next } as Partial<UniverseConfig>)

  return (
    <ParamRow
      label={field.label}
      desc={field.desc}
      control={renderControl(field, raw, setNumber, setFlag, setText)}
      display={formatFieldValue(field, raw)}
      defaultText={formatDefaultText(field)}
    />
  )
}
