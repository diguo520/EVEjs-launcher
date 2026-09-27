import { cn } from "@/lib/utils"
import { initialsOf, raceOf, type RaceEntry, type RaceId } from "@/lib/launcher-logic"

const TONE: Record<RaceEntry["tone"], string> = {
  primary: "border-primary/40 bg-primary/10 text-primary",
  warning: "border-warning/40 bg-warning/10 text-warning",
  success: "border-success/40 bg-success/10 text-success",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
}

/**
 * 角色头像：后端给了游戏内肖像位图就画位图，没给就退回「姓名缩写 + 种族色调」。
 * 种族色只在老启动器的本地数据里才有，拿不到就用中性边框，不硬套一个族。
 */
export function CharacterAvatar({
  name,
  race,
  avatar,
  size = "md",
  className,
}: {
  name: string
  race?: RaceId
  /** 游戏内肖像 data URL（后端 accounts:list 提供） */
  avatar?: string | null
  size?: "sm" | "md"
  className?: string
}) {
  const box = cn(
    "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-md border font-semibold",
    size === "md" ? "size-10 text-[13px]" : "size-8 text-[11px]",
    className
  )

  if (avatar) {
    return (
      <span className={cn(box, "border-border bg-secondary/40")} aria-hidden>
        <img src={avatar} alt="" className="size-full object-cover" />
      </span>
    )
  }

  return (
    <span
      className={cn(
        "tabular",
        box,
        race ? TONE[raceOf(race).tone] : "border-border bg-secondary/40 text-tertiary"
      )}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  )
}
