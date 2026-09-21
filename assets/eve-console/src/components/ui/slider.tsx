import * as SliderPrimitive from "@radix-ui/react-slider"
import { cn } from "@/lib/utils"

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  onValueChange: (value: number) => void
  disabled?: boolean
  className?: string
}

export function Slider({ className, value, min, max, step = 1, onValueChange, ...props }: SliderProps) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex h-4 w-full touch-none select-none items-center",
        props.disabled && "opacity-40",
        className,
      )}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => onValueChange(next[0])}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          "block h-3.5 w-3.5 rounded-full border-2 border-primary bg-background transition-colors",
          "hover:bg-primary/30 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        )}
      />
    </SliderPrimitive.Root>
  )
}
