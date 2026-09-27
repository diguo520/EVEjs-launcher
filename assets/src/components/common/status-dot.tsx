import { cn } from "@/lib/utils"

export type DotTone = "primary" | "success" | "warning" | "destructive" | "idle"

const toneClass: Record<DotTone, string> = {
  primary: "bg-primary shadow-[0_0_6px_hsl(var(--primary))]",
  success: "bg-success shadow-[0_0_6px_hsl(var(--success))]",
  warning: "bg-warning shadow-[0_0_6px_hsl(var(--warning))]",
  destructive: "bg-destructive shadow-[0_0_6px_hsl(var(--destructive))]",
  idle: "bg-tertiary",
}

export function StatusDot({
  tone = "idle",
  pulse = false,
  className,
}: {
  tone?: DotTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        toneClass[tone],
        pulse && "mc-pulse",
        className
      )}
    />
  )
}
