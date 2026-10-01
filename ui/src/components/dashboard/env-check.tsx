import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleOff,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"

import { cn, copyText } from "@/lib/utils"
import { listSeparator } from "@/lib/i18n"
import { Panel } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { EnvCheckState } from "@/hooks/use-env-check"

const levelIcon = {
  ok: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
  missing: CircleOff,
} as const

const levelClass = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
  missing: "text-destructive",
} as const

/** 报告里给每项加个前缀，纯文本粘贴出去也能看出结论（文案过词典） */
const LEVEL_MARK = {
  ok: "[通过]",
  warn: "[提醒]",
  error: "[失败]",
  missing: "[未检测到]",
} as const

export function EnvCheck({ env }: { env: EnvCheckState }) {
  const { t } = useLocale()
  const {
    items,
    checking,
    done,
    checkedAt,
    busy,
    passCount,
    warnCount,
    missingCount,
    blockers,
    runtime,
    ramGB,
    threads,
    recheck,
    retryOne,
    fixOne,
    clearWarnings,
  } = env

  const R = 30
  const CIRC = 2 * Math.PI * R
  const blocked = missingCount > 0
  /** 缺的这几项能不能挡住启动，说法完全不一样，得分开讲 */
  const gateNote =
    blockers.length > 0
      ? t("缺少 {list}，一键启动已被挡住；照下面每项的指引补上就会放行。", {
          list: blockers.join(listSeparator()),
        })
      : "缺的是本地编译模组用的工具链，不影响启动服务器，但建模组时会编译失败。"

  /** 进度环与进度条共用一个数：检测中是「跑了几项」，平时是「通过几项」 */
  // 真自检是一轮回来的，开始时 items 还是空的 —— 空列表一律按 0 画，别算出 NaN
  const ringPct = items.length === 0 ? 0 : checking ? done / items.length : passCount / items.length
  const ringText = checking ? done : passCount
  const ringTone = checking
    ? "hsl(var(--primary))"
    : blocked
      ? "hsl(var(--destructive))"
      : warnCount
        ? "hsl(var(--warning))"
        : "hsl(var(--success))"

  /** 一键把结果复制成纯文本，方便贴给帮忙排查的人；未检测到的项连修复办法一起带上 */
  async function copyReport() {
    const lines = [t("EveJS 环境自检 · {time}", { time: checkedAt })]
    for (const item of items) {
      lines.push(
        t("{mark} {name} — {detail}", {
          mark: t(LEVEL_MARK[item.level]),
          name: item.name,
          detail: item.detail,
        })
      )
      if (item.level === "missing" && item.fix) {
        lines.push("    " + t("修复：{hint}", { hint: item.fix.hint }))
        if (item.fix.cmd) lines.push("    " + t("命令：{command}", { command: item.fix.cmd }))
      }
    }
    lines.push(t("结果：{pass}/{total} 通过", { pass: passCount, total: items.length }))
    const ok = await copyText(lines.join("\n"))
    if (ok) {
      toast.success("环境报告已复制", { description: "可直接粘贴给协助排查的人。" })
    } else {
      toast.error("复制失败，请手动选择文本")
    }
  }

  return (
    <Panel
      tag="// HEALTH"
      title="环境自检"
      meta={t("{pass}/{total} 通过{extra}", {
        pass: passCount,
        total: items.length,
        extra:
          (missingCount ? t(" · {count} 项未检测到", { count: missingCount }) : "") +
          (warnCount ? t(" · {count} 项提醒", { count: warnCount }) : ""),
      })}
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={copyReport}>
            <Copy />
            复制报告
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={recheck}
            disabled={checking || busy !== null}
          >
            <RefreshCw className={checking ? "animate-spin" : undefined} />
            重新检测
          </Button>
        </div>
      }
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-5 rounded-lg border p-4",
          blocked && !checking
            ? "border-destructive/40 bg-destructive/[0.07]"
            : "border-input bg-background/40"
        )}
      >
        <div className="relative grid size-[72px] shrink-0 place-items-center">
          <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
            <circle
              cx="36"
              cy="36"
              r={R}
              stroke={ringTone}
              strokeOpacity="0.15"
              strokeWidth="5"
              fill="none"
            />
            <circle
              cx="36"
              cy="36"
              r={R}
              stroke={ringTone}
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - ringPct)}
            />
          </svg>
          <span
            className={cn(
              "tabular absolute text-[13px] font-bold",
              checking
                ? "text-primary"
                : blocked
                  ? "text-destructive"
                  : warnCount
                    ? "text-warning"
                    : "text-success"
            )}
          >
            {ringText}/{items.length}
          </span>
        </div>

        <div className="min-w-[220px] flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-foreground">
              {checking
                ? "正在逐项检测环境…"
                : blocked
                  ? "环境不完整，有依赖没检测到"
                  : warnCount
                    ? "环境可用，有提醒项"
                    : "环境自检全部通过"}
            </span>
            <Badge
              variant={
                checking
                  ? "default"
                  : blocked
                    ? "destructive"
                    : warnCount
                      ? "warning"
                      : "success"
              }
            >
              {checking
                ? "CHECKING"
                : blocked
                  ? "NOT READY"
                  : warnCount
                    ? "DEGRADED"
                    : "READY"}
            </Badge>
          </div>
          <p className="tabular mt-1.5 text-[11px] text-muted-foreground">
            {runtime} · {ramGB} RAM · {threads} 线程 · 检测于{" "}
            {checkedAt}
          </p>
          {/* 检测中才有进度条：哪一项在跑、还剩几项没测，一眼能看出来。
              真自检是一轮回来的，检测期间 items 还是空的 —— 没有项就别画（空列表会取到 undefined） */}
          {checking && items.length > 0 ? (
            <div className="mt-2.5 space-y-1.5">
              <Progress value={(done / items.length) * 100} />
              <p className="tabular text-[11px] text-primary">
                正在检测 {items[Math.min(done, items.length - 1)]?.name ?? ""} · {done}/
                {items.length}
              </p>
            </div>
          ) : null}
          {/* 未检测到的时候把后果讲明白：挡的是启动还是只挡编译 */}
          {blocked && !checking ? (
            <p className="mt-2.5 text-[11px] leading-relaxed text-destructive">
              {gateNote}
            </p>
          ) : null}
          {warnCount && !checking ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2.5"
              onClick={clearWarnings}
            >
              <Download />
              一键修复提醒项
            </Button>
          ) : null}
        </div>
      </div>

      {/* 两列：这块面板在主控台里只占半栏（约 580px），三列会把版本号劈成两行 */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {items.map((item, index) => {
          // 检测中每项有三种样子：已经出结果、正在跑、还没轮到
          const phase = !checking
            ? "settled"
            : index < done
              ? "settled"
              : index === done
                ? "running"
                : "queued"
          const itemBusy = busy?.id === item.id
          const Icon =
            phase === "running"
              ? Loader2
              : phase === "queued"
                ? CircleDashed
                : levelIcon[item.level]
          const missing = item.level === "missing" && phase === "settled"
          /** 提醒项里也有能修的（二进制版本落后），同样把修复动作摆出来 */
          const stale =
            item.level === "warn" && phase === "settled" && item.fix !== undefined
          /** 带修复指引的项：半栏放不下，独占一行 */
          const expanded = missing || stale
          const fix = item.fix
          const fixCmd = fix?.cmd

          return (
            <div
              key={item.id}
              className={cn(
                "flex items-start gap-2.5 rounded-md border px-3 py-2.5",
                expanded && "sm:col-span-2",
                // 未检测到就一直是红的，正在补它的时候也别变回中性色，不然像已经好了
                missing
                  ? "border-destructive/45 bg-destructive/[0.07]"
                  : stale
                    ? "border-warning/45 bg-warning/[0.07]"
                    : phase === "running" || itemBusy
                      ? "border-primary/45 bg-primary/10"
                      : "border-input bg-card/60",
                phase === "queued" && "opacity-55"
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  phase === "running" || itemBusy
                    ? "animate-spin text-primary"
                    : phase === "queued"
                      ? "text-tertiary"
                      : levelClass[item.level]
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "text-[13px]",
                      phase === "running" || itemBusy
                        ? "font-semibold text-primary"
                        : missing
                          ? "font-semibold text-destructive"
                          : "text-foreground"
                    )}
                  >
                    {item.name}
                  </span>
                  {missing ? (
                    <Badge variant="destructive">未检测到</Badge>
                  ) : null}
                  {stale ? <Badge variant="warning">版本落后</Badge> : null}
                </div>
                <div
                  className={cn(
                    "tabular mt-0.5 break-words text-[11px] leading-relaxed",
                    missing ? "text-destructive/85" : "text-muted-foreground"
                  )}
                >
                  {itemBusy
                    ? t(busy.label)
                    : phase === "running"
                      ? "检测中…"
                      : phase === "queued"
                        ? "未检测 · 排队中"
                        : item.detail}
                </div>

                {/* 没通过或带待处理的提醒才展开：为什么会这样、怎么补、以及单独重测这一项 */}
                {expanded && fix ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {fix.hint}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {fix.action ? (
                        <Button
                          size="sm"
                          className="h-7 px-2.5 text-[11px]"
                          disabled={busy !== null}
                          onClick={() => fixOne(item.id)}
                        >
                          <Wrench />
                          {fix.action}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={busy !== null}
                        onClick={() => retryOne(item.id)}
                      >
                        <RotateCw />
                        重测这一项
                      </Button>
                      {fixCmd ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2.5 text-[11px]"
                          onClick={async () => {
                            const ok = await copyText(fixCmd)
                            if (ok) {
                              toast.success("修复命令已复制", {
                                description: "在项目根目录执行，或者直接用左边的按钮。",
                              })
                            } else {
                              toast.error("复制失败，请手动选择文本")
                            }
                          }}
                        >
                          <Copy />
                          复制命令
                        </Button>
                      ) : null}
                    </div>
                    {fixCmd ? (
                      /* 命令比卡片宽，让它折行而不是横向滚动：窄窗口里滚动条基本看不见。
                         break-words 而不是 break-all，好让 -days 这种参数别被劈成两半 */
                      <pre className="tabular whitespace-pre-wrap break-words rounded-sm border border-input bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-tertiary">
                        {fixCmd}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
