import { useState } from "react"
import { t } from "@/lib/i18n"
import { ArrowUpCircle, Download, Loader2 } from "lucide-react"

import { LauncherUpdateDialog } from "@/components/shell/launcher-update-dialog"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * 图标条上的圆形进度：一圈按 percent 走。
 *
 * 2026-10-29 报障：收起侧栏后左下角一直是个 `Loader2` 转圈 —— 转圈表示「在忙」，
 * 不表示「下了多少」，而且 `ready`（包已下好待安装）也算「在忙」，于是下完了还继续转。
 * 图标条放不下进度条，就用这圈把百分比画出来；文案细节交给 tooltip。
 */
function RingProgress({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dash = (clamped / 100) * circumference
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2" stroke="currentColor" className="text-primary/25" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        className="text-primary"
        strokeDasharray={`${dash} ${circumference - dash}`}
      />
    </svg>
  )
}

/**
 * 侧栏底部的启动器自更新入口。
 * 有新版时先看更新内容再决定装不装；装的时候这里接着显示进度。
 * 窄窗侧栏只有一条图标的位置，给 compact：同一个弹窗、同一份状态，只换个入口长相。
 */
export function LauncherUpdate({ compact = false }: { compact?: boolean }) {
  const { version, latestVersion, outdated, updating, progress, sizeText, phase, installUpdate } =
    useLauncherVersion()
  const [open, setOpen] = useState(false)

  if (compact) {
    // 没有新版本、也没在更新就什么都不显示：底部不该常驻一个「已是最新」的勾
    if (!outdated && !updating) return null

    const downloading = updating && phase === "downloading"
    const applying = updating && phase === "applying"
    const ready = updating && phase === "ready"

    /** 图标条上放不下版本号，悬停提示里把这一步到底在干什么写清楚 */
    const hint = updating
      ? ready
        ? t("新版本已下载完成，点「重启并安装」后替换旧版本。")
        : applying
          ? t("正在安装启动器更新…")
          : t("正在更新启动器 {percent}%", { percent: Math.floor(progress) })
      : t("启动器有新版本 {from} → {to}", { from: version, to: latestVersion })

    /**
     * 下载中：点开看细节；**已下好：点一下就装** ——
     * 这是用户的明确要求（「新的启动器下载好后点一下就能即时更新」），别再让人去找弹窗。
     */
    const onClick = () => {
      if (ready) {
        installUpdate()
        return
      }
      setOpen(true)
    }

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClick}
              aria-label={hint}
              className={cn(
                "relative flex w-full items-center justify-center rounded-md py-2 transition-colors",
                "focus-visible:outline-none focus-visible:shadow-focus",
                "text-primary hover:bg-primary/10"
              )}
            >
              {/* 图标条上没有文字：环形进度（下载中）、脉冲光环（等你点）就是全部提示 */}
              <span className="relative inline-flex">
                {downloading ? (
                  <RingProgress percent={progress} />
                ) : applying ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUpCircle className="size-4" />
                )}
                {outdated && (!updating || ready) ? (
                  <span
                    aria-hidden="true"
                    className="update-pulse-ring absolute -inset-1 rounded-full"
                  />
                ) : null}
              </span>
              {/* 图标条上没有文字，用一个小点提示有新版本 */}
              {outdated && !updating ? (
                <span className="absolute right-2.5 top-1.5 size-1.5 rounded-full bg-primary" />
              ) : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10}>
            {hint}
          </TooltipContent>
        </Tooltip>
        <LauncherUpdateDialog open={open} onOpenChange={setOpen} />
      </>
    )
  }

  return (
    <>
      {outdated ? (
        <div className="rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            {/* 侧栏展开时这行卡片本身就是提示，但图标上也套同一圈光环，两态看起来是一件事 */}
            <span className="relative inline-flex shrink-0">
              <ArrowUpCircle className="size-3.5 text-primary" />
              <span
                aria-hidden="true"
                className="update-pulse-ring absolute -inset-1 rounded-full"
              />
            </span>
            <span className="text-[11px] font-semibold text-primary">
              {t("启动器有新版本")}
            </span>
          </div>

          <div className="tabular mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{version}</span>
            <span className="text-tertiary">→</span>
            <span className="font-semibold text-primary">{latestVersion}</span>
          </div>

          {updating ? (
            <>
              <Progress value={progress} className="mt-2" />
              <div className="tabular mt-1 flex items-center justify-between text-[10px] text-tertiary">
                {/* 进度条走完之后是「等用户点重启并安装」这一步，别一直写「下载中」 */}
                {/* 这些字也必须走 t()：以前是裸中文，非中文界面会露中文（门禁只查「是不是键」，查不出「有没有包 t()」） */}
                <span>
                  {phase === "ready"
                    ? t("已下载")
                    : phase === "applying"
                      ? t("安装中")
                      : t("下载中")}
                </span>
                <span>{Math.floor(progress)}%</span>
              </div>
              {/* 下载完成 ≠ 装好：把「重启并安装」直接摆在卡片上（以前只有弹窗里点得到） */}
              {phase === "ready" ? (
                <Button size="sm" className="mt-2 w-full" onClick={installUpdate}>
                  {t("重启并安装")}
                </Button>
              ) : null}
            </>
          ) : (
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" className="flex-1" onClick={() => setOpen(true)}>
                <Download />
                {t("查看更新")}
              </Button>
              <span className="tabular shrink-0 text-[10px] text-tertiary">
                {sizeText}
              </span>
            </div>
          )}
        </div>
      ) : null}

      {/* 更新装完侧栏会收成一行，弹窗得留在外面才能接着显示「已更新」 */}
      <LauncherUpdateDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
