import { cn } from "@/lib/utils"
import { initialsOf, raceOf, type RaceEntry, type RaceId } from "@/lib/launcher-logic"

const TONE: Record<RaceEntry["tone"], string> = {
  primary: "border-primary/40 bg-primary/10 text-primary",
  warning: "border-warning/40 bg-warning/10 text-warning",
  success: "border-success/40 bg-success/10 text-success",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
}

/** 角色头像：用姓名缩写 + 种族色调，替代真实头像位图 */
export function CharacterAvatar({
  name,
  race,
  size = "md",
  className,
}: {
  name: string
  race: RaceId
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <span
      className={cn(
        "tabular flex shrink-0 select-none items-center justify-center rounded-md border font-semibold",
        size === "md" ? "size-10 text-[13px]" : "size-8 text-[11px]",
        TONE[raceOf(race).tone],
        className
      )}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  )
}
