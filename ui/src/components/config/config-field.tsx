import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** 配置项输入：标签 + 右侧备注 + 等宽输入框 + 底部用途说明 */
export function ConfigField({
  label,
  value,
  onChange,
  hint,
  note,
  placeholder,
  readOnly,
  className,
}: {
  label: string
  value: string
  onChange?: (value: string) => void
  /** 输入框下方的用途说明 */
  hint?: string
  /** 标签右侧的短备注 */
  note?: string
  placeholder?: string
  /** 后端只读的字段（端口、来源文件）：摆出来给人看，但不假装能改 */
  readOnly?: boolean
  className?: string
}) {
  const id = React.useId()

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {note ? (
          <span className="shrink-0 text-[10px] text-tertiary">{note}</span>
        ) : null}
      </div>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className={cn("tabular", readOnly && "text-muted-foreground")}
      />
      {hint ? (
        <p className="text-[11px] leading-relaxed text-tertiary">{hint}</p>
      ) : null}
    </div>
  )
}