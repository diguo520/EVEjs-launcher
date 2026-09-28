import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  FileCheck2,
  GitBranch,
  KeyRound,
  Loader2,
  Send,
  Signature,
  Timer,
  TriangleAlert,
  UploadCloud,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import {
  bumpVersion,
  cooldownText,
  credentialLabel,
  hasOwnSignature,
  isCredentialLive,
  packageFileName,
  publishBlockers,
  publishStages,
  sourceRepo,
  type PublishCredential,
  type PublishStage,
  type PublishStageId,
} from "@/lib/mod-logic"
import { MOD_REVIEW_LABEL, formatMB, type ModEntry } from "@/lib/mock"
import type { PublishOutcome, PublishPhase } from "@/hooks/use-mod-source"
import type { RawPublishProgress } from "@/lib/ipc"
import { cn } from "@/lib/utils"

type Step = "pick" | "form" | "sending"

const STEP_LABEL: Record<Step, string> = {
  pick: "选择模组",
  form: "版本与声明",
  sending: "发布到你的仓库",
}

const STEP_ORDER: Step[] = ["pick", "form", "sending"]

const DECLARATIONS = [
  "该模组为本人原创，或已取得原作者授权转载。",
  "不包含恶意代码，不会读写模组目录以外的文件。",
  "已阅读并同意模组制作规范与市场上架条款。",
]

/** 「发布完成」这句得让人看见，别一到终点就关窗 */
const CLOSE_DELAY_MS = 1200

/** 发布前置的一行：够了打勾，不够亮黄并给出补救的入口 */
function GateRow({
  icon: Icon,
  label,
  ok,
  value,
  hint,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon
  label: string
  ok: boolean
  value: string
  /** 只在不够的时候给：说清缺什么、去哪补 */
  hint?: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed">
      {/* 够了就摆这一项自己的图标（绿），不够换成三角警告，一眼能分出哪行要处理 */}
      {ok ? (
        <Icon className="size-3.5 shrink-0 text-success" />
      ) : (
        <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      )}
      <span className="w-16 shrink-0 text-tertiary">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate",
          ok ? "tabular text-foreground" : "font-semibold text-warning"
        )}
      >
        {value}
      </span>
      {hint ? (
        <span className="min-w-0 flex-1 text-tertiary">{hint}</span>
      ) : (
        <span className="min-w-2 flex-1" />
      )}
      {ok ? null : (
        <button
          type="button"
          onClick={onAction}
          className={cn(
            "shrink-0 rounded-sm border border-warning/45 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning transition-colors",
            "hover:border-warning/70 hover:bg-warning/15 focus-visible:outline-none focus-visible:shadow-focus"
          )}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

/** 进度清单里点哪一行：把「发布阶段 + 真进度百分比」映射到环节 id */
function stageIndexOf(
  stages: PublishStage[],
  phase: PublishPhase,
  percent: number
): number {
  const at = (id: PublishStageId, fallback: PublishStageId): number => {
    const direct = stages.findIndex((stage) => stage.id === id)
    if (direct >= 0) return direct
    const other = stages.findIndex((stage) => stage.id === fallback)
    return other >= 0 ? other : 0
  }
  if (phase === "prepare") return at("pack", "pack")
  if (phase === "register") return at("register", "upload")
  // 后端阶段：准备仓库 20 / 写清单 40 / 建 Release 60 / 上传 ZIP 75 → 上传从 65% 起算
  return percent >= 65 ? at("upload", "upload") : at("repo", "upload")
}

export interface ModSubmitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可提交的模组（本地创建且不在审核中） */
  candidates: ModEntry[]
  /** 从卡片直接进入时预选的模组 */
  preselectId: string | null
  /** 本地署名：空着就没法发布，弹窗里会当作一项前置条件拦下来 */
  authorName: string
  /** 发布凭据（GitHub 令牌）：源码要推到作者自己名下的仓库，缺了就没法发布 */
  credential: PublishCredential | null
  /** 这个模组距上次提交还差多少毫秒（0＝可以提交）：同一模组两次提交至少间隔 30 分钟 */
  cooldownRemaining: (modId: string) => number
  /** 已经有源码仓库的模组 id：第一次提交要先建仓库，之后只推新版本 */
  sourceRepos: string[]
  /** 缺署名或令牌时，就地打开「作者身份」去补 */
  onOpenAuthor: () => void
  /** 真发布：本地打包 → 推到作者自己的仓库 → 提交版本审核 PR */
  onPublish: (
    mod: ModEntry,
    payload: { version: string; note: string }
  ) => Promise<PublishOutcome>
  /** 后端推来的实时进度（mod:publishProgress） */
  progress: RawPublishProgress | null
  /** 发布流水线当前环节 */
  phase: PublishPhase
  onSubmitted: (mod: ModEntry, payload: { version: string; note: string }, outcome: PublishOutcome) => void
}

/**
 * 提交模组到市场。
 *
 * 三步：① 本地打包；② 把包推到**作者自己名下的仓库**（建仓库 → 写 evejs-mod.json →
 * 建 Release → 传 ZIP）；③ 往索引仓库提一条**版本审核 PR**（`mods/<id>.json` 分片，
 * 首次还多一份 `sources.json` 收录登记）。
 * ③ 每一版都走：合并之后索引 CI 重建，市场才换到这一版。
 */
export function ModSubmitDialog({
  open,
  onOpenChange,
  candidates,
  preselectId,
  authorName,
  credential,
  sourceRepos,
  cooldownRemaining,
  onOpenAuthor,
  onPublish,
  progress,
  phase,
  onSubmitted,
}: ModSubmitDialogProps) {
  const [step, setStep] = useState<Step>("pick")
  const [targetId, setTargetId] = useState<string | null>(null)
  const [version, setVersion] = useState("")
  const [note, setNote] = useState("")
  const [agreed, setAgreed] = useState([false, false, false])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 20000)
    return () => window.clearInterval(timer)
  }, [open])

  const credLive = isCredentialLive(credential, now)
  const credText = credential ? credentialLabel(credential, now) : ""

  const signed = hasOwnSignature(authorName)
  /** 缺哪样挡哪样：署名与令牌都是硬门槛，两样齐了才放行 */
  // 同一模组两次提交至少间隔 30 分钟：计时起点是上次**成功**开出审核 PR 的时间
  const cooldownMs = targetId ? cooldownRemaining(targetId) : 0
  const blockers = publishBlockers({
    credential,
    name: authorName,
    now,
    cooldownMs,
  })
  const ready = blockers.length === 0
  const blockerHint = (id: "signature" | "token" | "cooldown") =>
    blockers.find((item) => item.id === id)?.hint
  /** 「还差 X、Y」只提需要用户去补的项：冷却只能等，不能补 */
  const gateLabels = blockers.filter((item) => item.id !== "cooldown").map((item) => item.label)

  const target = useMemo(
    () => candidates.find((mod) => mod.id === targetId) ?? null,
    [candidates, targetId]
  )

  const repoReady = target ? sourceRepos.includes(target.id) : false

  /** 回调用 ref 兜住，避免父级每秒重渲染时打断提交 */
  const latest = useRef({ onSubmitted, onOpenChange, version, note })
  latest.current = { onSubmitted, onOpenChange, version, note }

  // 只在「打开」这一瞬间重置：带预选直接进第二步，否则从选择开始
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setNote("")
      setAgreed([false, false, false])
      setError(null)
      const preset = preselectId
        ? candidates.find((item) => item.id === preselectId)
        : candidates.length === 1
          ? candidates[0]
          : null
      setTargetId(preset?.id ?? null)
      setVersion(preset ? suggestVersion(preset) : "")
      setStep(preset && preselectId ? "form" : "pick")
    }
    wasOpen.current = open
  }, [open, preselectId, candidates])

  const stages = useMemo(
    () => (step === "sending" ? publishStages({ credLive, repoReady }) : []),
    [step, credLive, repoReady]
  )
  const percent = typeof progress?.percent === "number" ? progress.percent : 0
  const stageIndex = stageIndexOf(stages, phase, percent)
  const finished = phase === "done"

  /** 预填的版本号：已上架的才往上推一位；草稿和驳回后重提报作者自己填的那个号 */
  function suggestVersion(mod: ModEntry): string {
    return mod.review === "approved" ? bumpVersion(mod.version) : mod.version
  }

  function pick(mod: ModEntry) {
    setTargetId(mod.id)
    setVersion(suggestVersion(mod))
  }

  function goForm() {
    if (!target) {
      toast.error("请先选择要提交的模组")
      return
    }
    if (!version.trim()) {
      toast.error("请填写提交的版本号")
      return
    }
    setStep("form")
  }

  async function submit() {
    const blocking = blockers[0]
    if (blocking) {
      toast.error(blocking.title, { description: blocking.hint })
      return
    }
    if (!version.trim()) {
      toast.error("请填写提交的版本号")
      return
    }
    if (agreed.some((item) => !item)) {
      toast.error("请先勾选全部三项声明")
      return
    }
    const mod = target
    if (!mod) return
    setError(null)
    setStep("sending")
    const payload = { version: version.trim(), note: note.trim() }
    const outcome = await onPublish(mod, payload)
    if (!outcome.ok) {
      setError(outcome.reason ?? "发布失败")
      setStep("form")
      toast.error("发布没有走完", { description: outcome.reason ?? "见弹窗里的原因" })
      return
    }
    window.setTimeout(() => {
      latest.current.onSubmitted(mod, payload, outcome)
      latest.current.onOpenChange(false)
    }, CLOSE_DELAY_MS)
  }

  const stepIndex = STEP_ORDER.indexOf(step)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && step !== "sending" && onOpenChange(next)}
    >
      {/* 声明与凭据加起来比矮窗口还高，限高滚动，免得标题被顶出屏幕 */}
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>发布模组到市场</DialogTitle>
          <DialogDescription>
            包会推到你自己名下的 GitHub 仓库并生成 Release，再往索引仓库提一条版本审核 PR；合并后市场更新到这一版。
          </DialogDescription>
        </DialogHeader>

        {/* 步骤指示 */}
        <ol className="flex items-center gap-2">
          {STEP_ORDER.map((item, index) => {
            const done = index < stepIndex
            const active = index === stepIndex
            return (
              <li key={item} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-sm border text-[10px] font-semibold",
                    done
                      ? "border-success/40 bg-success/10 text-success"
                      : active
                        ? "border-primary/45 bg-primary/10 text-primary"
                        : "border-input text-tertiary"
                  )}
                >
                  {done ? <Check className="size-3" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "text-[11px]",
                    active ? "text-foreground" : "text-tertiary"
                  )}
                >
                  {STEP_LABEL[item]}
                </span>
                {index < STEP_ORDER.length - 1 ? (
                  <span className="h-px flex-1 bg-border" />
                ) : null}
              </li>
            )
          })}
        </ol>

        {step === "pick" ? (
          <div className="space-y-2">
            {candidates.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-tertiary">
                没有可提交的模组，请先在本地创建。
              </p>
            ) : (
              candidates.map((mod) => {
                const active = mod.id === targetId
                return (
                  <button
                    key={mod.id}
                    type="button"
                    onClick={() => pick(mod)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-primary/50 bg-primary/10"
                        : "border-input hover:border-border hover:bg-secondary/60"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        active ? "border-primary" : "border-border"
                      )}
                    >
                      {active ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">
                          {mod.name}
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-tertiary">
                          {mod.version}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {mod.desc}
                      </span>
                    </span>
                    <Badge variant="secondary">{MOD_REVIEW_LABEL[mod.review ?? "draft"]}</Badge>
                  </button>
                )
              })
            )}
          </div>
        ) : null}

        {step === "form" && target ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-input bg-background/40 px-2.5 py-2">
              <span className="text-[12px] font-semibold text-foreground">{target.name}</span>
              <span className="tabular text-[11px] text-tertiary">{target.id}</span>
              <div className="min-w-2 flex-1" />
              <span className="tabular text-[11px] text-muted-foreground">
                {target.version} → <span className="font-semibold text-primary">{version || "—"}</span>
              </span>
              <span className="tabular text-[11px] text-tertiary">{formatMB(target.sizeMB)}</span>
            </div>

            {/* 发布前置：署名和 GitHub 令牌缺一不可，缺哪样哪样亮黄，提交按钮跟着锁上 */}
            <div
              className={cn(
                "space-y-1.5 rounded-md border px-2.5 py-2",
                ready ? "border-input bg-background/40" : "border-warning/40 bg-warning/10"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="panel-label text-tertiary">发布前置</span>
                <span className="min-w-2 flex-1" />
                <span
                  className={cn(
                    "text-[10px]",
                    ready ? "text-success" : "text-warning"
                  )}
                >
                  {ready ? "都已就绪" : `还差 ${blockers.length} 项`}
                </span>
              </div>

              <GateRow
                icon={Signature}
                label="署名"
                ok={signed}
                value={signed ? authorName.trim() : "未填写"}
                hint={blockerHint("signature")}
                actionLabel="去填署名"
                onAction={onOpenAuthor}
              />
              <GateRow
                icon={KeyRound}
                label="发布凭据"
                ok={credLive}
                value={credLive ? credText : "未配置"}
                hint={blockerHint("token")}
                actionLabel="去配置"
                onAction={onOpenAuthor}
              />
              {repoReady ? (
                <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-tertiary">
                  <GitBranch className="mt-px size-3 shrink-0 text-success" />
                  <span>
                    这个模组已经有源码仓库：本次往 {sourceRepo(target.id)} 推新版本，
                    再往索引仓库提一条版本审核 PR（更新这个模组的版本分片）。
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-tertiary">
                  <UploadCloud className="mt-px size-3 shrink-0 text-primary" />
                  <span>
                    首次发布：会建好 {sourceRepo(target.id)}、发布 Release，
                    再把收录登记和本次版本记录放进同一条 PR。
                  </span>
                </p>
              )}
              {cooldownMs > 0 ? (
                <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-warning">
                  <Timer className="mt-px size-3 shrink-0" />
                  <span>
                    距上次提交不到 30 分钟：同一个模组两次提交至少间隔 30 分钟，
                    {cooldownText(cooldownMs)}再试。
                  </span>
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="flex items-start gap-1.5 rounded-md border border-warning/45 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="mod-submit-version">提交版本号 *</Label>
              <Input
                id="mod-submit-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="1.5.0"
                className="tabular"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-submit-note">本版更新说明</Label>
              <Textarea
                id="mod-submit-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="新增多军团共享视图；修复跨日倒计时显示为负。"
              />
            </div>

            <div className="space-y-2 rounded-md border border-input bg-background/40 p-3">
              <div className="panel-label">提交声明</div>
              {DECLARATIONS.map((text, index) => (
                <label
                  key={text}
                  className="flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
                >
                  <Checkbox
                    checked={agreed[index]}
                    onCheckedChange={(next) =>
                      setAgreed((prev) =>
                        prev.map((item, i) => (i === index ? next === true : item))
                      )
                    }
                    className="mt-0.5"
                  />
                  {text}
                </label>
              ))}
            </div>

            <p className="text-[11px] leading-relaxed text-tertiary">
              发布后 ZIP 走 GitHub Release 分发；索引仓库那条 PR 里记录本次版本，
              维护者合并后 CI 重建索引，玩家端就能装到这一版。
            </p>

            {/* 按钮为什么是灰的，得写在按钮正上方，别让人对着灰按钮猜 */}
            {ready ? null : (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>
                  {gateLabels.length > 0
                    ? `还差${gateLabels.join("、")}，补齐后才能发布。`
                    : "提交太频繁了：同一个模组两次提交至少间隔 30 分钟，稍后再来。"}
                </span>
              </p>
            )}
          </div>
        ) : null}

        {step === "sending" && target ? (
          <div className="space-y-3">
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2.5">
              <div className="flex items-center gap-2">
                {finished ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-primary" />
                )}
                <span className="text-[13px] font-semibold text-foreground">
                  {finished ? "发布完成" : progress?.stage ?? "正在准备发布"}
                </span>
                <div className="min-w-2 flex-1" />
                <span className="tabular text-[12px] font-bold text-primary">
                  {Math.floor(percent)}%
                </span>
              </div>
              <div className="tabular text-[11px] text-muted-foreground">
                {target.name} · {version} · {formatMB(target.sizeMB)}
              </div>
              <Progress value={percent} />

              {/* 环节清单：走完的留在上面，正在跑的转圈，没轮到的只报名字 */}
              <ol className="space-y-1.5">
                {stages.map((stage, index) => {
                  const done = finished || index < stageIndex
                  const active = !finished && index === stageIndex
                  return (
                    <li key={stage.id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex size-3.5 shrink-0 items-center justify-center">
                        {done ? (
                          <Check className="size-3.5 text-success" />
                        ) : active ? (
                          <Loader2 className="size-3.5 animate-spin text-primary" />
                        ) : (
                          <span className="size-1.5 rounded-full border border-border" />
                        )}
                      </span>
                      <span
                        className={cn(
                          done
                            ? "text-success"
                            : active
                              ? "font-semibold text-foreground"
                              : "text-tertiary"
                        )}
                      >
                        {done ? stage.done : active ? stage.running : stage.pending}
                      </span>
                      <span className="min-w-2 flex-1" />
                      <span className="tabular truncate text-[10px] text-tertiary">
                        {stage.id === "pack"
                          ? `${packageFileName(target.id, version)}`
                          : stage.id === "repo"
                            ? sourceRepo(target.id)
                            : stage.id === "upload"
                              ? "GitHub Release"
                              : "sources.json + mods/<id>.json"}
                      </span>
                    </li>
                  )
                })}
              </ol>

              <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
                <KeyRound className="size-3.5 shrink-0 text-success" />
                {`源码用 ${credText} 推送到 ${sourceRepo(target.id)}`}
              </p>
              <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
                <FileCheck2 className="size-3.5 shrink-0" />
                推送完会重载市场索引；这次也会往索引仓库提一条版本审核 PR，合并后市场才换到新版本。
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {step === "pick" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={goForm} disabled={!target}>
                下一步
              </Button>
            </>
          ) : step === "form" ? (
            <>
              <Button variant="outline" onClick={() => setStep("pick")}>
                上一步
              </Button>
              <Button
                onClick={submit}
                disabled={!ready}
                title={ready ? undefined : blockers[0]?.hint}
              >
                <Send />
                发布
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled>
              {finished ? "发布完成" : "发布中…"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
