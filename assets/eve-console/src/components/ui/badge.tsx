import type { HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

type Tone = "neutral" | "primary" | "success" | "warn" | "danger" | "outline"

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  primary: "border-primary/40 bg-primary/15 text-primary",
  success: "border-emerald-500/40 bg-emerald-500/12 text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/12 text-amber-300",
  danger: "border-destructive/45 bg-destructive/15 text-red-300",
  outline: "border-border bg-transparent text-muted-foreground",
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-xs leading-none whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  )
}

/** 状态指示灯：服务端 / 玩家在线状态共用。 */
export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color =
    tone === "success"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "danger"
          ? "bg-red-400"
          : tone === "primary"
            ? "bg-primary"
            : "bg-muted-foreground"

  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse ? (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-70", color)} />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", color)} />
    </span>
  )
}
