import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  FileCheck2,
  KeyRound,
  Loader2,
  Send,
  Signature,
  TriangleAlert,
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
  credentialLabel,
  hasOwnSignature,
  isCredentialLive,
  packageFileName,
  publishBlockers,
  publishStages,
  publishToastId,
  sourceRepo,
  type PublishCredential,
  type PublishStage,
  type PublishStageId,
} from "@/lib/mod-logic"
import { MOD_REVIEW_LABEL, REVIEW_WINDOW_MINUTES, formatMB, type ModEntry } from "@/lib/mock"
import { cn } from "@/lib/utils"

type Step = "pick" | "form" | "sending"

const STEP_LABEL: Record<Step, string> = {
  pick: "选择模组",
  form: "版本与声明",
  sending: "提交审核",
}

const STEP_ORDER: Step[] = ["pick", "form", "sending"]

const DECLARATIONS = [
  "该模组为本人原创，或已取得原作者授权转载。",
  "不包含恶意代码，不会读写模组目录以外的文件。",
  "已阅读并同意模组制作规范与市场上架条款。",
]

/** 各环节的演示时长（毫秒）：整条流程五秒上下，够看清每一步又不至于干等 */
const STAGE_MS: Record<PublishStageId, number> = {
  pack: 900,
  repo: 1200,
  upload: 1700,
  submit: 900,
}

/** 进度刷新间隔，抖动一点更像真的在跑 */
const TICK_MS = 90

/** 「提交完成」这句得让人看见，别一到终点就关窗 */
const CLOSE_DELAY_MS = 900

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

export interface ModSubmitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可提交的模组（本地创建且不在审核中） */
  candidates: ModEntry[]
  /** 从卡片直接进入时预选的模组 */
  preselectId: string | null
  /** 本地署名：空着就没法发布，弹窗里会当作一项前置条件拦下来 */
  authorName: string
  /** 发布凭据（GitHub 令牌），源码要推到作者自己名下的仓库，缺了就没法发布 */
  credential: PublishCredential | null
  /** 已经有源码仓库的模组 id：第一次提交要先建仓库，之后再提交只推新版本 */
  sourceRepos: string[]
  /** 缺署名或令牌时，就地打开「作者身份」去补 */
  onOpenAuthor: () => void
  onSubmitted: (mod: ModEntry, payload: { version: string; note: string }) => void
}

export function ModSubmitDialog({
  open,
  onOpenChange,
  candidates,
  preselectId,
  authorName,
  credential,
  sourceRepos,
  onOpenAuthor,
  onSubmitted,
}: ModSubmitDialogProps) {
  const [step, setStep] = useState<Step>("pick")
  const [targetId, setTargetId] = useState<string | null>(null)
  const [version, setVersion] = useState("")
  const [note, setNote] = useState("")
  const [agreed, setAgreed] = useState([false, false, false])
  /** 开跑前定下的环节清单：跑到一半凭据过期也不该改中途的步骤 */
  const [stages, setStages] = useState<PublishStage[]>([])
  const [stageIndex, setStageIndex] = useState(0)
  /** 当前这一环自己的进度 0-100 */
  const [stageProgress, setStageProgress] = useState(0)
  /** 临时凭据随时会过期，这一行的说法得跟着时间走 */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 20000)
    return () => window.clearInterval(timer)
  }, [open])

  const credLive = isCredentialLive(credential, now)
  const credExpired = credential !== null && !credLive
  const credText = credential ? credentialLabel(credential, now) : ""

  const signed = hasOwnSignature(authorName)
  /** 缺哪样挡哪样：署名与令牌都是硬门槛，两样齐了才放行 */
  const blockers = publishBlockers({ credential, name: authorName, now })
  const ready = blockers.length === 0
  const blockerHint = (id: "signature" | "token") =>
    blockers.find((item) => item.id === id)?.hint

  const target = useMemo(
    () => candidates.find((mod) => mod.id === targetId) ?? null,
    [candidates, targetId]
  )

  /** 回调用 ref 兜住，避免父级每秒重渲染时打断提交进度 */
  const latest = useRef({ onSubmitted, onOpenChange, version, note })
  latest.current = { onSubmitted, onOpenChange, version, note }

  // 只在「打开」这一瞬间重置：带预选直接进第二步，否则从选择开始
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStageIndex(0)
      setStageProgress(0)
      setNote("")
      setAgreed([false, false, false])
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

  /** 当前这一环以及它右边的进度读数 */
  const current = stages[stageIndex]
  const currentStage: PublishStageId | null = current?.id ?? null
  /** 整条流程的总进度：每一环等权，环内按自己的百分比走 */
  const overall =
    stages.length === 0
      ? 0
      : ((stageIndex + stageProgress / 100) / stages.length) * 100

  /**
   * 某一环右边的读数：打包报包名与体积，建仓库和上传报仓库，交审核报等待时间。
   * phase 单独传：没轮到的只报去向（别显示 0.0 MB 这种还没发生的进度），
   * 收尾提示要报最终结果，也不能拿渲染那一刻的进度去算。
   */
  function stageDetail(
    stage: PublishStage,
    phase: "pending" | "active" | "done",
    sent = stageProgress
  ): string {
    if (!target) return ""
    if (stage.id === "pack") {
      return `${packageFileName(target.id, version)} · ${formatMB(target.sizeMB)}`
    }
    if (stage.id === "repo") return sourceRepo(target.id)
    if (stage.id === "upload") {
      const repo = sourceRepo(target.id)
      const total = formatMB(target.sizeMB)
      if (phase === "pending") return repo
      return phase === "done" || sent >= 100
        ? `${repo} · ${total}`
        : `${repo} · ${formatMB((target.sizeMB * sent) / 100)} / ${total}`
    }
    return phase === "done"
      ? "已进入审核队列"
      : `${REVIEW_WINDOW_MINUTES} 分钟内出结果`
  }

  // 提交：一环一环往下走，每环开头挂「正在进行」、走完换成「完成」，
  // 最后一环交给外面收尾（它才知道要不要记仓库、怎么提示审核时长）
  useEffect(() => {
    if (step !== "sending" || !target) return
    const stage = stages[stageIndex]
    if (!stage) return

    const toastId = publishToastId(stage.id)
    toast.loading(`${stage.running} · ${target.name} ${version}`, {
      id: toastId,
      description: stageDetail(stage, "active", 0),
    })

    const perTick = (100 / STAGE_MS[stage.id]) * TICK_MS
    let value = 0
    const timer = window.setInterval(() => {
      // 抖动一下，进度别走得像秒表
      value = Math.min(100, value + perTick * (0.7 + Math.random() * 0.6))
      setStageProgress(value)
      if (value < 100) return
      window.clearInterval(timer)

      if (stage.id === "submit") {
        // 最后一环的完成提示由外面发，它带着这次提交的结果一起说
        const { onSubmitted: done, version: v, note: n } = latest.current
        window.setTimeout(() => {
          done(target, { version: v.trim(), note: n.trim() })
          latest.current.onOpenChange(false)
        }, CLOSE_DELAY_MS)
        return
      }

      toast.success(stage.done, {
        id: toastId,
        description: stageDetail(stage, "done", 100),
      })
      setStageIndex(stageIndex + 1)
      setStageProgress(0)
    }, TICK_MS)
    return () => window.clearInterval(timer)
    // stageDetail 读的是本次渲染的 target/version，二者在提交期间不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, target, stages, stageIndex, version])

  /**
   * 预填的版本号：已上架的才往上推一位；草稿和驳回后重提，报的就是作者在表单里
   * 写的那个版本，替它加一反而会悄悄改掉他刚填好的号。
   */
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

  function submit() {
    // 按钮已经是禁用态，这里再挡一道：署名与令牌没补齐就绝不能往下走
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
    // 按这次提交的实际情况定环节：凭据能不能用、这个模组的仓库建过没有
    setStages(
      publishStages({
        credLive,
        repoReady: target ? sourceRepos.includes(target.id) : false,
      })
    )
    setStageIndex(0)
    setStageProgress(0)
    setStep("sending")
  }

  const stepIndex = STEP_ORDER.indexOf(step)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && step !== "sending" && onOpenChange(next)}>
      {/* 声明与凭据加起来比矮窗口还高，限高滚动，免得标题被顶出屏幕 */}
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>提交模组到市场</DialogTitle>
          <DialogDescription>
            提交后进入人工审核，通常 {REVIEW_WINDOW_MINUTES} 分钟内出结果。
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
                value={credLive ? credText : credExpired ? "已过期" : "未配置"}
                hint={blockerHint("token")}
                actionLabel={credExpired ? "重新授权" : "去配置"}
                onAction={onOpenAuthor}
              />
            </div>

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
              提交后当前已上架版本会暂时下架，审核通过后自动恢复；期间已安装的玩家不受影响。
            </p>

            {/* 按钮为什么是灰的，得写在按钮正上方，别让人对着灰按钮猜 */}
            {ready ? null : (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>
                  还差{blockers.map((item) => item.label).join("、")}
                  ，补齐后才能提交审核。
                </span>
              </p>
            )}
          </div>
        ) : null}

        {step === "sending" && target ? (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-[13px] font-semibold text-foreground">
                {current?.running ?? "正在提交"}
              </span>
              <div className="min-w-2 flex-1" />
              <span className="tabular text-[12px] font-bold text-primary">
                {Math.floor(overall)}%
              </span>
            </div>
            <div className="tabular text-[11px] text-muted-foreground">
              {target.name} · {version} · {formatMB(target.sizeMB)}
            </div>
            <Progress value={overall} />

            {/* 环节清单：走完的留在上面，正在跑的转圈，没轮到的只报名字 */}
            <ol className="space-y-1.5">
              {stages.map((stage, index) => {
                const done = index < stageIndex || stage.id === "submit" && stageProgress >= 100
                const active = index === stageIndex && !(stage.id === "submit" && stageProgress >= 100)
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
                      {stageDetail(
                        stage,
                        done ? "done" : active ? "active" : "pending",
                        done ? 100 : stageProgress
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>

            {/* 走到这里凭据一定是能用的（提交前拦过了），所以直接报推到哪个仓库 */}
            <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
              {credLive ? (
                <KeyRound className="size-3.5 shrink-0 text-success" />
              ) : (
                <TriangleAlert className="size-3.5 shrink-0 text-warning" />
              )}
              {credLive
                ? `源码用 ${credText} 推送到 ${sourceRepo(target.id)}${
                    currentStage === "repo" ? "（这个模组还是第一次提交，先把仓库建好）" : ""
                  }`
                : `凭据不可用，源码没推上去，只交审核`}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-warning">
              <FileCheck2 className="size-3.5 shrink-0" />
              提交完成后进入人工审核，通常 {REVIEW_WINDOW_MINUTES} 分钟内出结果。
            </p>
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
                提交审核
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled>
              提交中…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
