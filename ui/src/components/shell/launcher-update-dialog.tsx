import {
  ArrowRight,
  CircleCheck,
  Dot,
  Download,
  Gauge,
  Plus,
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
import { LAUNCHER_RELEASE } from "@/lib/mock"

/** 更新说明的分组图标，认不出的分组退回一个圆点 */
const GROUP_ICON: Record<string, LucideIcon> = {
  新增: Plus,
  优化: Gauge,
  修复: Wrench,
}

/**
 * 启动器自更新弹窗：先把这一版改了什么逐条列清楚，再让人决定装不装。
 * 下载进度与版本状态都在版本状态里，关掉弹窗侧栏照样接着显示。
 */
export function LauncherUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { version, latestVersion, outdated, updating, progress, startUpdate } =
    useLauncherVersion()
  /** 已经是最新版本：弹窗变成「更新内容回顾」，动作只剩关闭 */
  const done = !outdated && !updating

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>启动器更新</DialogTitle>
          <DialogDescription>
            {done
              ? `当前已是最新版本，下面是这一版带来的改动。`
              : `安装包 ${LAUNCHER_RELEASE.size}，装完后替换旧版本，配置与世界存档不受影响。`}
          </DialogDescription>
        </DialogHeader>

        {/* 从哪一版升到哪一版，连带通道与发布时间，先交代清楚 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-input bg-background/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-tertiary">当前</span>
            <span className="tabular text-[12px] text-muted-foreground">{version}</span>
            {done ? (
              <Badge variant="success">已是最新</Badge>
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
          <span className="tabular text-[10px] text-tertiary">
            通道 {LAUNCHER_RELEASE.channel}
          </span>
          <span className="tabular text-[10px] text-tertiary">
            发布于 {LAUNCHER_RELEASE.date}
          </span>
          <span className="tabular text-[10px] text-tertiary">
            安装包 {LAUNCHER_RELEASE.size}
          </span>
        </div>

        {/* 更新内容：分组列条，长了就滚，别把弹窗撑出屏幕 */}
        <div className="max-h-[44vh] space-y-3.5 overflow-y-auto pr-1">
          {LAUNCHER_RELEASE.notes.map((g) => {
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
        </div>

        {done ? (
          <div className="flex items-center gap-2 rounded-md border border-success/35 bg-success/10 px-3 py-2 text-[12px] text-success">
            <CircleCheck className="size-4 shrink-0" />
            已更新到 {latestVersion}，上面这些改动已经生效。
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
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                稍后再说
              </Button>
              <Button onClick={startUpdate}>
                <Download />
                立即更新
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
