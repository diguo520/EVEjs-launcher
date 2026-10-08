import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Gamepad2, Loader2, Square, Trash2 } from "lucide-react"

import { CharacterAvatar } from "@/components/accounts/character-avatar"
import { StatusDot } from "@/components/common/status-dot"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLocale } from "@/components/shell/locale-provider"
import { cn } from "@/lib/utils"
import {
  GENDER_LABEL,
  IN_GAME_STEP_HINT,
  IN_GAME_STEP_LABEL,
  IN_GAME_STEP_ORDER,
  MAX_CHARACTERS_PER_ACCOUNT,
  canCreateInGame,
  canLogin,
  formatIsk,
  logotypeKey,
  logotypeTick,
  onlineDuration,
  raceOf,
  type Account,
  type Character,
  type InGameStep,
} from "@/lib/launcher-logic"

/** 长按头像进入游戏所需时间 */
const HOLD_MS = 700
/** SVG 进度环几何：与 `size-14` 头像保持同尺寸。 */
const HOLD_RING_RADIUS = 26
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * HOLD_RING_RADIUS

/**
 * 军团 / 联盟徽标。
 *
 * 专属徽标由外壳直接从服务端图片目录读盘（服务端关着也画得出来）。url 为空时
 * **不画服务端那张兜底图**：军团兜底（evejscorp.png）与联盟兜底（alliance-default.png）
 * 是同一张画，只差底部一行小字，缩到 20px 就是两个一模一样的图标。
 * 这时改画短标识（军团 ticker / 联盟简称），形状与配色也分开。
 */
function LogoBadge({
  kind,
  label,
  short,
  url,
}: {
  kind: "corporations" | "alliances"
  label: string
  short: string
  url: string | null | undefined
}) {
  if (url) {
    return (
      <img
        src={url}
        alt={label}
        title={label}
        className="size-6 shrink-0 rounded-[4px] border border-input bg-background/40 object-cover"
      />
    )
  }
  const tick = logotypeTick(short)
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "tabular flex h-6 min-w-6 shrink-0 items-center justify-center border px-1 text-[9px] font-semibold leading-none",
        kind === "corporations"
          ? "rounded-[4px] border-primary/35 bg-primary/10 text-primary"
          : "rounded-full border-warning/40 bg-warning/10 text-warning"
      )}
    >
      {tick}
    </span>
  )
}

/**
 * 头像长按入口：按住时沿头像边缘画进度环，走满后才真正登录。
 * pointer 事件同时覆盖鼠标、触控笔与触屏；离开、抬起或取消都会立即回零。
 */
function HoldAvatar({
  character,
  disabled,
  label,
  onComplete,
}: {
  character: Character
  disabled: boolean
  label: string
  onComplete: () => void
}) {
  const [holding, setHolding] = useState(false)
  const [progress, setProgress] = useState(0)
  const frame = useRef<number | null>(null)
  const active = useRef(false)

  const cancel = () => {
    active.current = false
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
    setHolding(false)
    setProgress(0)
  }

  useEffect(
    () => () => {
      active.current = false
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    },
    []
  )

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || active.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    active.current = true
    setHolding(true)
    const startedAt = performance.now()

    const tick = (now: number) => {
      if (!active.current) return
      const next = Math.min(1, (now - startedAt) / HOLD_MS)
      setProgress(next)
      if (next >= 1) {
        active.current = false
        frame.current = null
        setHolding(false)
        setProgress(0)
        onComplete()
        return
      }
      frame.current = window.requestAnimationFrame(tick)
    }
    frame.current = window.requestAnimationFrame(tick)
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      className={cn(
        "relative grid size-14 shrink-0 place-items-center rounded-full p-0.5",
        disabled ? "cursor-not-allowed" : "cursor-pointer active:scale-[0.98]"
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 56 56"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx="28"
          cy="28"
          r={HOLD_RING_RADIUS}
          fill="none"
          stroke="hsl(var(--input))"
          strokeWidth="2.5"
        />
        <circle
          cx="28"
          cy="28"
          r={HOLD_RING_RADIUS}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={HOLD_RING_CIRCUMFERENCE}
          strokeDashoffset={HOLD_RING_CIRCUMFERENCE * (1 - progress)}
          className={cn("transition-opacity", holding ? "opacity-100" : "opacity-0")}
          style={{ filter: holding ? "drop-shadow(0 0 4px hsl(var(--primary) / 0.65))" : undefined }}
        />
      </svg>
      <CharacterAvatar
        name={character.name}
        race={character.race}
        avatar={character.avatar}
        size="lg"
        shape="circle"
        className="relative z-10 size-[52px]"
      />
    </button>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="panel-label text-[9px]">{label}</div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={value}>
        {value}
      </div>
    </div>
  )
}

/**
 * 一个角色槽：有角色就展示长条角色卡；空槽只负责把人送进游戏。
 */
export function CharacterSlot({
  account,
  character,
  index,
  creatingStep,
  now,
  logotypes,
  onEnter,
  onExit,
  onDelete,
  onCreate,
}: {
  account: Account
  character: Character | null
  index: number
  creatingStep: InGameStep | null
  logotypes: Record<string, string | null>
  now: number
  onEnter: (accountId: string, character: Character) => void
  onExit: (accountId: string, character: Character) => void
  onDelete: (accountId: string, character: Character) => void
  onCreate: (accountId: string) => void
}) {
  const { t } = useLocale()
  if (!character) {
    const guard = canCreateInGame(account)
    const stepIndex = creatingStep ? IN_GAME_STEP_ORDER.indexOf(creatingStep) : -1
    return (
      <div
        className={cn(
          "flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-center",
          creatingStep
            ? "border-primary/45 bg-primary/10"
            : guard.ok
              ? "border-input bg-background/30"
              : "border-input/60 bg-background/10"
        )}
      >
        <span className="tabular text-[10px] tracking-[0.1em] text-tertiary">
          SLOT {index + 1} · 空
        </span>
        <Button
          variant={creatingStep ? "outline" : "default"}
          size="sm"
          disabled={!guard.ok || creatingStep !== null}
          onClick={() => onCreate(account.id)}
        >
          {creatingStep ? <Loader2 className="animate-spin" /> : <Gamepad2 />}
          {creatingStep ? IN_GAME_STEP_LABEL[creatingStep] : "进入游戏创建角色"}
        </Button>

        {creatingStep ? (
          <div className="w-full space-y-1.5 px-1">
            <div className="flex items-center gap-1">
              {IN_GAME_STEP_ORDER.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    "h-0.5 flex-1 rounded-full",
                    i <= stepIndex ? "bg-primary" : "bg-input"
                  )}
                />
              ))}
            </div>
            <p className="text-[10px] leading-relaxed text-tertiary">
              {IN_GAME_STEP_HINT[creatingStep]}
            </p>
          </div>
        ) : (
          <span className="px-1 text-[10px] leading-relaxed text-tertiary">
            {guard.ok
              ? t("角色在游戏内创建 · 该账号还有 {count} 个空槽", {
                  count: MAX_CHARACTERS_PER_ACCOUNT - account.characters.length,
                })
              : guard.reason}
          </span>
        )}
      </div>
    )
  }

  const race = character.race ? raceOf(character.race) : null
  const traits = [
    race?.name,
    character.bloodline,
    character.gender ? GENDER_LABEL[character.gender] : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => t(part))
  const coordinate = character.system ?? character.location ?? "—"
  const guard = canLogin(account, character)
  const onlineFor = onlineDuration(character, now)
  const isk = typeof character.isk === "number" ? formatIsk(character.isk) : "—"
  const ship = character.ship || "—"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "relative overflow-hidden rounded-xl border bg-background/40 transition-colors",
            character.online
              ? "border-success/40 bg-success/5"
              : "border-input hover:border-primary/35"
          )}
        >
          {/* 卡片操作固定在右上角；在线角色多一个纯图标下线按钮，不占名字行宽度。 */}
          <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5">
            {character.online ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label={t("下线")}
                onClick={() => onExit(account.id, character)}
              >
                <Square />
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 hover:text-destructive"
                  disabled={character.online}
                  aria-label={`${t("删除角色")} ${character.name}`}
                >
                  <Trash2 />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除角色</AlertDialogTitle>
                  <AlertDialogDescription>
                    将永久删除角色「{character.name}」及其舰船、资产与技能记录，
                    该操作不可撤销，删除后槽位会空出来。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDelete(account.id, character)}>
                    删除角色
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex min-h-[96px] items-center gap-3 p-3 pr-20">
            <HoldAvatar
              character={character}
              disabled={!guard.ok || character.online}
              label={character.online ? t("在线") : guard.ok ? t("长按进入") : guard.reason}
              onComplete={() => onEnter(account.id, character)}
            />

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                  {character.name}
                </span>
                {character.online ? <StatusDot tone="success" pulse /> : null}
                {character.corporationId ? (
                  <LogoBadge
                    key={`corp-${character.corporationId}`}
                    kind="corporations"
                    label={character.corporationName ?? t("军团 {id}", { id: character.corporationId })}
                    short={character.corporationTicker ?? character.corporationName ?? ""}
                    url={logotypes[logotypeKey("corporations", character.corporationId)]}
                  />
                ) : null}
                {character.allianceId ? (
                  <LogoBadge
                    key={`alliance-${character.allianceId}`}
                    kind="alliances"
                    label={character.allianceName ?? t("联盟 {id}", { id: character.allianceId })}
                    short={character.allianceTicker ?? character.allianceName ?? ""}
                    url={logotypes[logotypeKey("alliances", character.allianceId)]}
                  />
                ) : null}
              </div>

              <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[10px] text-tertiary">
                  {traits.length > 0 ? traits.join(" · ") : t("种族资料未记录")}
                </span>
                {onlineFor ? (
                  <Badge variant="success" className="tabular shrink-0 text-[9px]">
                    {t("在线 {duration}", { duration: onlineFor })}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="min-w-[260px] p-3">
        <div className="grid grid-cols-3 gap-4">
          <Detail label={t("ISK")} value={isk} />
          <Detail label={t("坐标")} value={coordinate} />
          <Detail label={t("舰船")} value={ship} />
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
