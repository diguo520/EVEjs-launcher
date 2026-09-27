import { useEffect, useState } from "react"
import { ChevronsLeft, ChevronsRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Sparkline } from "@/components/common/sparkline"
import {
  NAV_GROUPS,
  type NavBadges,
  type ViewId,
} from "@/components/shell/nav-config"
import { LauncherUpdate } from "@/components/shell/launcher-update"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useMediaQuery } from "@/hooks/use-media-query"
import type { Metric } from "@/lib/mock"

const MINI_KEYS = ["cpu", "mem", "net"]
/** 与 tailwind 的 md 断点保持一致 */
const WIDE_QUERY = "(min-width: 768px)"
/** 展开状态记在本地；没记过就是收起，只看图标 */
const STORAGE_KEY = "evejs_sidenav_open"

/** 图标条只有 56px，完整指标名塞不下，用三个字母的短名 */
const SHORT_LABEL: Record<string, string> = {
  cpu: "CPU",
  mem: "MEM",
  net: "NET",
}

function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

/** 图标条上只排得下当前值，完整说法（含单位、总量）交给悬停提示 */
function metricTitle(m: Metric): string {
  return m.unit === "%"
    ? `${m.label} ${m.display}%`
    : `${m.label} ${m.display} ${m.unit}`
}

/**
 * 图标条里的一行读数：短名 + 当前值 + 走势。
 * 悬停出完整说法，别让收起状态变成"看得见数字看不懂是什么"。
 */
function RailMetric({
  short,
  value,
  tone,
  series,
  valueClassName,
  title,
}: {
  short: string
  value: string
  tone: Metric["tone"]
  series: number[]
  valueClassName: string
  title: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default">
          <div className="tabular flex items-baseline justify-between gap-1 text-[9px] leading-none">
            <span className="text-tertiary">{short}</span>
            <span className={cn("font-semibold", valueClassName)}>{value}</span>
          </div>
          <Sparkline points={series} tone={tone} className="mt-1 h-2.5" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

export function SideNav({
  active,
  onNavigate,
  metrics,
  badges,
}: {
  active: ViewId
  onNavigate: (id: ViewId) => void
  metrics: Metric[]
  /** 真计数徽标：后端还没接过来的那一项就不画，不拿演示数字凑 */
  badges?: NavBadges
}) {
  const miniMetrics = metrics.filter((m) => MINI_KEYS.includes(m.key))
  /** 窗口太窄时侧栏一展开就把内容区挤扁，那里固定成图标条，连开关都不给 */
  const wide = useMediaQuery(WIDE_QUERY)
  const [open, setOpen] = useState(readStoredOpen)
  /** 窗口够宽 + 用户选过展开，才是完整侧栏 */
  const expanded = wide && open
  /** 只有真的有新版 / 正在更新，底部才多出一条分割线（没有更新就别空占一格） */
  const { outdated, updating } = useLauncherVersion()
  const showUpdate = outdated || updating

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0")
    } catch {
      // 存不下只影响下次打开，这次的展开状态照常
    }
  }, [open])

  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-card/60",
        expanded ? "w-[216px]" : "w-14"
      )}
    >
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto py-3",
          expanded ? "px-2.5" : "px-2"
        )}
      >
        {NAV_GROUPS.map((group) => (
          <div
            key={group.title}
            className={cn("last:mb-0", expanded ? "mb-4" : "mb-3")}
          >
            {expanded ? (
              <div className="tabular px-2 pb-2 text-[10px] font-semibold tracking-[0.16em] text-tertiary">
                {group.title}
              </div>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon
                const isActive = active === item.id
                const badge = badges?.[item.id] ?? 0
                /** 收起时要套一层悬停提示，展开时直接放按钮，key 由调用处给 */
                const button = (key: string) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-label={item.label}
                    className={cn(
                      "relative flex w-full items-center rounded-md text-left text-[13px] transition-colors",
                      "focus-visible:outline-none focus-visible:shadow-focus",
                      expanded ? "gap-2.5 px-2.5 py-2" : "justify-center py-2.5",
                      isActive
                        ? "bg-primary/10 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    {isActive ? (
                      <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                    ) : null}
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        isActive ? "text-primary" : "text-tertiary"
                      )}
                    />
                    {expanded ? (
                      <>
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {badge ? (
                          <span className="tabular shrink-0 rounded-sm border border-telemetry/30 bg-telemetry/10 px-1.5 text-[10px] font-semibold text-telemetry">
                            {badge}
                          </span>
                        ) : null}
                      </>
                    ) : badge ? (
                      /* 图标条上放不下数字，用一个圆点说明这一项有事要处理 */
                      <span className="absolute right-3 top-2 size-1.5 rounded-full bg-telemetry" />
                    ) : null}
                  </button>
                )

                if (expanded) return button(item.id)

                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{button(item.id)}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={10}>
                      {badge ? `${item.label} · ${badge}` : item.label}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 收起时这块换成窄条读数：短名 + 当前值 + 走势，悬停补全信息 */}
      <div
        className={cn(
          "shrink-0 border-t border-input",
          expanded ? "px-3 py-3" : "px-2 py-2.5"
        )}
      >
        {expanded ? (
          <>
            <div className="panel-label mb-2">资源监控</div>
            <div className="space-y-2">
              {miniMetrics.map((m) => (
                <div key={m.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {m.label}
                    </span>
                    <span className="tabular text-[11px] font-semibold text-telemetry">
                      {m.display}
                      <span className="ml-0.5 text-[10px] font-normal text-tertiary">
                        {m.unit}
                      </span>
                    </span>
                  </div>
                  <Sparkline points={m.series} tone={m.tone} className="mt-0.5" />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="tabular pb-2 text-center text-[9px] font-semibold tracking-[0.12em] text-tertiary">
              资源
            </div>
            <div className="space-y-2">
              {miniMetrics.map((m) => (
                <RailMetric
                  key={m.key}
                  short={SHORT_LABEL[m.key] ?? m.key.toUpperCase()}
                  value={m.display}
                  tone={m.tone}
                  series={m.series}
                  valueClassName="text-telemetry"
                  title={metricTitle(m)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {showUpdate ? (
        <div
          className={cn(
            "shrink-0 border-t border-input py-2",
            expanded ? "px-2.5" : "px-2"
          )}
        >
          <LauncherUpdate compact={!expanded} />
        </div>
      ) : null}

      {/* 窄窗不给开关：那种宽度下展开会把内容区挤扁 */}
      {wide ? (
        <div
          className={cn(
            "shrink-0 border-t border-input py-2",
            expanded ? "px-2.5" : "px-2"
          )}
        >
          {expanded ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-muted-foreground transition-colors",
                "hover:bg-secondary hover:text-foreground",
                "focus-visible:outline-none focus-visible:shadow-focus"
              )}
            >
              <ChevronsLeft className="size-4 shrink-0 text-tertiary" />
              收起侧边栏
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  aria-label="展开侧边栏"
                  className={cn(
                    "flex w-full items-center justify-center rounded-md py-2 text-muted-foreground transition-colors",
                    "hover:bg-secondary hover:text-foreground",
                    "focus-visible:outline-none focus-visible:shadow-focus"
                  )}
                >
                  <ChevronsRight className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>
                展开侧边栏
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ) : null}
    </nav>
  )
}
