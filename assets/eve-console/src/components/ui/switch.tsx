import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
}

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors",
        "data-[state=checked]:border-primary/60 data-[state=checked]:bg-primary/25",
        "data-[state=unchecked]:bg-secondary",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block h-3.5 w-3.5 rounded-full bg-muted-foreground shadow-sm transition-transform",
          "data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary",
          "data-[state=unchecked]:translate-x-[3px]",
        )}
      />
    </SwitchPrimitive.Root>
  )
}
