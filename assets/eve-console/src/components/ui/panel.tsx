import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "@/lib/utils"

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("relative rounded-lg border border-border bg-card shadow-md", className)}
      {...props}
    />
  )
}

export interface PanelHeaderProps {
  title: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PanelHeader({ title, eyebrow, actions, className }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border px-4 py-2.5",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function PanelBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />
}

/** 空态占位：面板里没数据时统一走这里，避免每个页面各写一套。 */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="font-mono text-xs text-muted-foreground/70">{hint}</p> : null}
    </div>
  )
}
