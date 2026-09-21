import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger"
type Size = "sm" | "md" | "lg" | "icon"

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75 font-semibold",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary/70 shadow-sm border border-border",
  ghost: "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
  outline: "border border-border bg-transparent text-foreground hover:bg-secondary/60",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/85 font-semibold",
}

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-12 px-6 text-lg gap-2.5",
  icon: "h-8 w-8 text-sm",
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
})
