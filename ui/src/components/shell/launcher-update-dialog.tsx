import * as React from "react"
import {
  ArrowRight,
  CircleCheck,
  Dot,
  Download,
  Gauge,
  Loader2,
  Plus,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react"

import { useLauncherVersion } from "@/components/shell/launcher-version"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { hasIpc } from "@/lib/ipc"
import { LAUNCHER_RELEASE } from "@/lib/mock"

/** 更新说明的分组图标，认不出的分组退回一个圆点 */
const GROUP_ICON: Record<string, LucideIcon> = {
  新增: Plus,
  优化: Gauge,
  修复: Wrench,
}

/** 清单里的 publishedAt 是 ISO 时间，界面上只到日 */
function dateText(iso: string): string {
  return iso ? iso.slice(0, 10) : "—"
}

/**
 * 启动器自更新弹窗：先把这一版改了什么逐条列清楚，再让人决定装不装。
 * 下载进度与版本状态都在版本状态里，关掉弹窗侧栏照样接着显示。
 *
 * 「这一版改了什么」一律取自真清单（update:check 回包的 changelog），
 * 打开弹窗时后台查一次；查不到（或更新通道未配置）就照实说，不摆原型里的示例条目。
 * 排版与分组（新增 / 优化 / 修复 + 图标）沿用原型，不另起一套。
 */
export function LauncherUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const {
    version,
    latestVersion,
    outdated,
    updating,
    progress,
    check,
    checking,
    notes,
    sizeText,
    releaseDate,
    channel,
    checkForUpdate,
    startUpdate,
  } = useLauncherVersion()
  const live = hasIpc()

  // 每次打开都重新查一次：版本状态与更新说明都得有真数据支撑
  React.useEffect(() => {
    if (open && live) void checkForUpdate()
  }, [open, live, checkForUpdate])

  /** 还没拿到结果（首次打开的那一瞬）：先别急着说「已是最新」 */
  const pending = live && checking && !check
  /** 已经是最新版本：弹窗变成「更新内容回顾」，动作只剩关闭 */
  const done = !outdated && !updating && !pending
  /** 可以装：真查到了新版本 */
  const canInstall = outdated && !pending && !updating
  /** 说明来源：优先真清单；浏览器里跑原型（没有桥）才用原型自带示例 */
  const groups = notes.length > 0 ? notes : live ? [] : LAUNCHER_RELEASE.notes
  const failed = check && !check.ok

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>启动器更新</DialogTitle>
          <DialogDescription>
            {pending
              ? "正在检查更新通道…"
              : done
                ? `当前已是最新版本，下面是这一版带来的改动。`
                : `安装包 ${sizeText}，装完后替换旧版本，配置与世界存档不受影响。`}
          </DialogDescription>
        </DialogHeader>

        {/* 从哪一版升到哪一版，连带通道与发布时间，先交代清楚 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-tertiary">当前</span>
            <span className="tabular text-[12px] text-muted-foreground">{version}</span>
            {done ? (
              <Badge variant="success">已是最新</Badge>
            ) : pending ? (
              <Badge variant="secondary">检查中</Badge>
            ) : (
              <>
                <ArrowRight className="size-3.5 shrink-0 text-tertiary" />
                <span className="text-[10px] text-tertiary">最新</span>
                <span className="tabular text-[12px] font-semibold text-primary">
                  {latestVersion}
                </span>
              </>
            )}
          </div>
          <span className="tabular text-[10px] text-tertiary">通道 {channel || "—"}</span>
          <span className="tabular text-[10px] text-tertiary">
            发布于 {dateText(releaseDate)}
          </span>
          <span className="tabular text-[10px] text-tertiary">安装包 {sizeText}</span>
        </div>

        {/* 更新内容：分组列条，长了就滚，别把弹窗撑出屏幕 */}
        <div className="max-h-[44vh] space-y-3.5 overflow-y-auto pr-1">
          {groups.map((g) => {
            const Icon = GROUP_ICON[g.group] ?? Dot
            return (
              <div key={g.group} className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-primary" />
                  <span className="panel-label">{g.group}</span>
                </div>
                <ul className="space-y-1.5">
                  {g.items.map((item) => (
                    <li
                      key={item}
                      className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground"
                    >
                      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-primary/60" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}

          {groups.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[12px] text-tertiary">
              {pending ? (
                <>
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  正在向更新通道取这一版的说明…
                </>
              ) : failed ? null : (
                "这一版没有单独的更新说明。"
              )}
            </p>
          ) : null}
        </div>

        {failed ? (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/45 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>没查到更新信息：{check.reason ?? "更新通道没有给出原因"}</span>
          </p>
        ) : null}

        {done ? (
          <div className="flex items-center gap-2 rounded-md border border-success/35 bg-success/10 px-3 py-2 text-[12px] text-success">
            <CircleCheck className="size-4 shrink-0" />
            已是最新的 {latestVersion}，上面这些改动已经生效。
          </div>
        ) : updating ? (
          <div className="space-y-1.5">
            <Progress value={progress} />
            <div className="tabular flex items-center justify-between text-[10px] text-tertiary">
              <span>正在下载更新包</span>
              <span>{Math.floor(progress)}%</span>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : updating ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              后台下载
            </Button>
          ) : canInstall ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                稍后再说
              </Button>
              <Button onClick={startUpdate}>
                <Download />
                立即更新
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
