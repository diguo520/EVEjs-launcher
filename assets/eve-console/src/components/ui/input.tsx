import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type TextareaHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

const FIELD =
  "w-full rounded-sm border border-input bg-background/60 px-2.5 py-1.5 text-sm text-foreground " +
  "placeholder:text-muted-foreground/60 transition-colors " +
  "focus:outline-none focus:border-primary/60 focus:shadow-[var(--focus-ring)] " +
  "disabled:cursor-not-allowed disabled:opacity-50"

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD, "h-8", className)} {...props} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD, "min-h-[64px] resize-y", className)} {...props} />
  },
)

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
    </div>
  )
}
