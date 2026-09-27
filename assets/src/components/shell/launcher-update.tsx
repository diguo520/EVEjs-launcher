import { useState } from "react"
import { ArrowUpCircle, Check, Download, Loader2 } from "lucide-react"

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
import { LAUNCHER_META } from "@/lib/mock"

/**
 * 侧栏底部的启动器自更新入口。
 * 有新版时先看更新内容再决定装不装；装的时候这里接着显示进度。
 * 窄窗侧栏只有一条图标的位置，给 compact：同一个弹窗、同一份状态，只换个入口长相。
 */
export function LauncherUpdate({ compact = false }: { compact?: boolean }) {
  const { version, latestVersion, outdated, updating, progress } = useLauncherVersion()
  const [open, setOpen] = useState(false)

  if (compact) {
    /** 图标条上放不下版本号，悬停提示里把两个版本都写出来 */
    const hint = updating
      ? `正在更新启动器 ${Math.floor(progress)}%`
      : outdated
        ? `启动器有新版本 ${version} → ${latestVersion}`
        : `启动器已是最新 ${version}`

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={hint}
              className={cn(
                "relative flex w-full items-center justify-center rounded-md py-2 transition-colors",
                "focus-visible:outline-none focus-visible:shadow-focus",
                outdated
                  ? "text-primary hover:bg-primary/10"
                  : "text-success hover:bg-secondary"
              )}
            >
              {updating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : outdated ? (
                <ArrowUpCircle className="size-4" />
              ) : (
                <Check className="size-4" />
              )}
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
      {!outdated ? (
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-success">
          <Check className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">启动器已是最新 {version}</span>
        </div>
      ) : (
        <div className="rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <ArrowUpCircle className="size-3.5 shrink-0 text-primary" />
            <span className="text-[11px] font-semibold text-primary">
              启动器有新版本
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
                <span>下载中</span>
                <span>{Math.floor(progress)}%</span>
              </div>
            </>
          ) : (
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" className="flex-1" onClick={() => setOpen(true)}>
                <Download />
                查看更新
              </Button>
              <span className="tabular shrink-0 text-[10px] text-tertiary">
                {LAUNCHER_META.size}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 更新装完侧栏会收成一行，弹窗得留在外面才能接着显示「已更新」 */}
      <LauncherUpdateDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
