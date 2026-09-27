import { Gamepad2, Globe, Loader2, Play, Square, Trash2 } from "lucide-react"

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
import { cn } from "@/lib/utils"
import {
  GENDER_LABEL,
  IN_GAME_STEP_HINT,
  IN_GAME_STEP_LABEL,
  IN_GAME_STEP_ORDER,
  MAX_CHARACTERS_PER_ACCOUNT,
  canCreateInGame,
  canLogin,
  formatSp,
  onlineDuration,
  raceOf,
  type Account,
  type Character,
  type InGameStep,
} from "@/lib/launcher-logic"

/**
 * 一个角色槽：有角色就展示名片与登录操作；
 * 空槽只负责把人送进游戏——角色是在游戏里建的，启动器不提供捏人界面。
 */
export function CharacterSlot({
  account,
  character,
  index,
  creatingStep,
  now,
  onEnter,
  onExit,
  onDelete,
  onCreate,
}: {
  account: Account
  character: Character | null
  index: number
  /** 建号走到哪一步了；null 表示这个槽位没在等待 */
  creatingStep: InGameStep | null
  /** 页面统一往下发的当前时间，在线时长按它算，避免每个槽位各起一个定时器 */
  now: number
  onEnter: (accountId: string, character: Character) => void
  onExit: (accountId: string, character: Character) => void
  onDelete: (accountId: string, character: Character) => void
  onCreate: (accountId: string) => void
}) {
  if (!character) {
    const guard = canCreateInGame(account)
    const stepIndex = creatingStep ? IN_GAME_STEP_ORDER.indexOf(creatingStep) : -1
    return (
      <div
        className={cn(
          "flex min-h-[164px] flex-col items-center justify-center gap-2 rounded-md border border-dashed p-3 text-center",
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
          {creatingStep ? IN_GAME_STEP_LABEL[creatingStep] : "进入游戏建号"}
        </Button>

        {creatingStep ? (
          /* 建号要等客户端，把走到哪一步摊开：三段进度条 + 这一步在做什么 */
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
              ? `角色在游戏内创建 · 该账号还有 ${MAX_CHARACTERS_PER_ACCOUNT - account.characters.length} 个空槽`
              : guard.reason}
          </span>
        )}
      </div>
    )
  }

  const race = raceOf(character.race)
  const guard = canLogin(account, character)
  /** 在线的角色给出「在线多久了」，会随时间自己往上走 */
  const onlineFor = onlineDuration(character, now)

  return (
    <div
      className={cn(
        "flex min-h-[164px] flex-col rounded-md border p-3",
        character.online
          ? "border-success/40 bg-success/5"
          : "border-input bg-background/30"
      )}
    >
      <div className="flex items-start gap-2.5">
        <CharacterAvatar name={character.name} race={character.race} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            {/* 账号列表两列并排时槽位会窄到 ~150px，名字是主要标识，
                宁可折成两行也不截断 */}
            <span className="min-w-0 break-words text-[13px] font-semibold leading-tight text-foreground">
              {character.name}
            </span>
            {character.online ? (
              <StatusDot tone="success" pulse className="mt-[5px]" />
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {race.name} · {character.bloodline} · {GENDER_LABEL[character.gender]}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{character.ship}</Badge>
            <span className="tabular text-[11px] text-telemetry">
              {formatSp(character.sp)} SP
            </span>
            {onlineFor ? (
              <Badge variant="success" className="tabular">
                在线 {onlineFor}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-tertiary">
        <Globe className="size-3 shrink-0" />
        <span className="truncate">{character.location}</span>
      </div>

      <div className="mt-auto pt-3">
        <div className="flex items-center gap-1.5">
          {character.online ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onExit(account.id, character)}
            >
              <Square />
              下线
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="flex-1"
              disabled={!guard.ok}
              onClick={() => onEnter(account.id, character)}
            >
              <Play />
              进入游戏
            </Button>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hover:text-destructive"
                disabled={character.online}
              >
                <Trash2 />
                <span className="sr-only">删除角色 {character.name}</span>
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

        {character.online ? (
          <p className="mt-1.5 text-[10px] leading-relaxed text-tertiary">
            客户端运行中 · 建于 {character.bornAt}
          </p>
        ) : guard.ok ? (
          <p className="mt-1.5 text-[10px] leading-relaxed text-tertiary">
            建于 {character.bornAt}
          </p>
        ) : (
          <p className="mt-1.5 text-[10px] leading-relaxed text-tertiary">{guard.reason}</p>
        )}
      </div>
    </div>
  )
}
