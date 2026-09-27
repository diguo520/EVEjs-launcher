import { cn } from "@/lib/utils"
import { formatDbNumber, type DbValue } from "@/components/database/db-model"

/** 字段读数：NULL 斜体灰、数字琥珀遥测、文本近前景色 */
export function DbValueText({
  value,
  className,
}: {
  value: DbValue
  className?: string
}) {
  if (value == null) {
    return (
      <span className={cn("tabular text-[12px] italic text-tertiary", className)}>
        NULL
      </span>
    )
  }

  if (typeof value === "number") {
    return (
      <span className={cn("tabular text-[12px] text-telemetry", className)}>
        {formatDbNumber(value)}
      </span>
    )
  }

  return (
    <span className={cn("tabular text-[12px] text-foreground/85", className)}>{value}</span>
  )
}
