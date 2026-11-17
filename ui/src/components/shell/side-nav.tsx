import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronsLeft, ChevronsRight, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"
import { Sparkline } from "@/components/common/sparkline"
import {
  NAV_GROUPS,
  visibleNavGroups,
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
import { t } from "@/lib/i18n"
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

/**
 * 新功能引导：整屏背景模糊，**卡片本身就是清晰洞**（尺寸与卡片一致，无第二个框/箭头）。
 * 步骤：0) 屏幕中央聚焦 → 5s 后自动移到齿轮（设置）→ 点「知道了」切设置页，3s 后聚焦
 * EVEJS 升级版本行 → 点最后一个「知道了」才算看完、恢复正常。
 * 按启动器版本号记 localStorage，每版只提示一次；「已看」只在用户点最后一个「知道了」时写入。
 */
const GUIDE_CARD_W = 240
const GUIDE_CARD_H = 44

export function ServerUpgradeHint({
  onNavigate,
  onActive,
  version,
  ready,
}: {
  onNavigate: (id: ViewId) => void
  onActive: (active: boolean) => void
  version: string
  ready: boolean
}) {
  // 引导用独立 key：早期开机脉冲提示用过 `evejs_server_upgrade_hint_<版本>`，
  // 沿用会被它标记的「已看」压制，导致引导弹不出来。
  const key = `evejs_server_upgrade_guide_${version}`
  const [done, setDone] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1"
    } catch {
      return false
    }
  })
  /** 0 = 屏幕中央，1 = 齿轮（设置），2 = EVEJS 升级版本行 */
  const [step, setStep] = useState(0)
  /** 已点「知道了」切到设置页（第二步），用来触发 3s 后聚焦 EVEJS 版本行 */
  const [navigated, setNavigated] = useState(false)
  /** 清晰洞（= 克隆的目标节点）的位置与尺寸（视口坐标）；step0 无目标，rect 为 null */
  const [hole, setHole] = useState<{
    x: number
    y: number
    w: number
    h: number
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null
  } | null>(null)
  /** 克隆的目标节点：挖清晰洞时塞进洞层，让目标在模糊背景中保持清晰 */
  const cloneRef = useRef<HTMLElement | null>(null)
  /** 清晰洞层：挂载后接收克隆节点 */
  const holeRef = useRef<HTMLDivElement | null>(null)

  /** 量出当前步骤目标，把卡片大小的清晰洞居中对准它；中央步直接算坐标，不查 DOM */
  useLayoutEffect(() => {
    if (!ready || done) return
    const measure = () => {
      if (step === 0) {
        // 中央：卡片水平垂直居中，无目标洞
        cloneRef.current = null
        setHole({
          x: (window.innerWidth - GUIDE_CARD_W) / 2,
          y: (window.innerHeight - GUIDE_CARD_H) / 2,
          w: GUIDE_CARD_W,
          h: GUIDE_CARD_H,
          rect: null,
        })
        return
      }
      const sel =
        step === 1 ? '[data-guide-target="settings"]' : '[data-guide-target="evEJS-version"]'
      const el = document.querySelector<HTMLElement>(sel)
      if (!el) return
      const r = el.getBoundingClientRect()
      // 克隆目标节点，挖清晰洞时显示，让目标在模糊背景中保持清晰
      const clone = el.cloneNode(true) as HTMLElement
      clone.removeAttribute("data-guide-target")
      cloneRef.current = clone
      setHole({
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      })
    }
    measure()
    // 第二、三步要等目标渲染出来才能量到，多试几次
    const t1 = window.setTimeout(measure, 150)
    const t2 = window.setTimeout(measure, 500)
    const onResize = () => measure()
    window.addEventListener("resize", onResize)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.removeEventListener("resize", onResize)
    }
  }, [step, ready, done])

  // 第一步（中央聚焦）停留 2 秒后自动移到齿轮
  useEffect(() => {
    if (!ready || done || step !== 0) return
    const t = window.setTimeout(() => setStep(1), 2000)
    return () => window.clearTimeout(t)
  }, [ready, done, step])

  // 第二步点「知道了」→ 切设置页，3 秒后聚焦 EVEJS 升级版本行
  useEffect(() => {
    if (!ready || done || step !== 1 || !navigated) return
    onNavigate("settings")
    const t = window.setTimeout(() => setStep(2), 3000)
    return () => window.clearTimeout(t)
  }, [ready, done, step, navigated, onNavigate])

  // 引导进行中时通知外壳给内容层加模糊；看完后撤掉
  useEffect(() => {
    onActive(ready && !done)
  }, [ready, done, onActive])

  // 把克隆的目标节点塞进清晰洞层，让目标在模糊背景中保持清晰
  useLayoutEffect(() => {
    if (holeRef.current && cloneRef.current) {
      holeRef.current.replaceChildren(cloneRef.current)
    }
  }, [hole])

  // 点「知道了」：第一步→移到齿轮，第二步→切设置页，第三步→看完并记「已看」
  const onOk = () => {
    if (step === 0) {
      setStep(1)
    } else if (step === 1) {
      setNavigated(true)
    } else {
      setDone(true)
      try {
        window.localStorage.setItem(key, "1")
      } catch {
        // 存不下只影响下次是否再提示，这次照常结束
      }
    }
  }

  // 提前返回必须放在所有 hooks 之后：否则 ready 从 false→true 时 hook 数量变化，
  // React 会抛「渲染的 hooks 比上一次多」整树崩溃白屏。
  if (!ready || done) return null

  // 卡片位置：放在清晰洞旁边，优先右侧，右侧放不下放左侧，不遮挡目标
  const cardX = hole?.rect
    ? hole.rect.right + 12 > window.innerWidth - GUIDE_CARD_W - 8
      ? Math.max(8, hole.rect.left - GUIDE_CARD_W - 12)
      : hole.rect.right + 12
    : (window.innerWidth - GUIDE_CARD_W) / 2
  const cardY = hole?.rect
    ? Math.max(8, Math.min(hole.rect.top + hole.rect.height / 2 - GUIDE_CARD_H / 2, window.innerHeight - GUIDE_CARD_H - 8))
    : (window.innerHeight - GUIDE_CARD_H) / 2

  return (
    <div className="guide-overlay">
      {/* 全屏模糊层：覆盖整个启动器，背景全部模糊 */}
      <div className="guide-blur" />
      {/* 清晰洞：克隆的目标节点，让齿轮 / EVEJS 版本在模糊背景中保持清晰 */}
      {hole && hole.rect ? (
        <div
          ref={holeRef}
          className="guide-hole"
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
        />
      ) : null}
      {/* 引导卡片：放在清晰洞旁边，不遮挡目标 */}
      {hole ? (
        <div
          className="guide-card"
          style={{
            left: cardX,
            top: cardY,
            width: GUIDE_CARD_W,
            height: GUIDE_CARD_H,
          }}
          role="dialog"
          aria-label={t("新增服务端在线升级")}
        >
          <Sparkles className="size-4 shrink-0 text-primary" />
          <span className="text-[12px] font-medium">{t("新增服务端在线升级")}</span>
          <button
            type="button"
            onClick={onOk}
            aria-label={t("知道了")}
            className="guide-card-ok"
          >
            {t("知道了")}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function SideNav({
  active,
  onNavigate,
  metrics,
  badges,
  installedMods,
}: {
  active: ViewId
  onNavigate: (id: ViewId) => void
  metrics: Metric[]
  /** 真计数徽标：后端还没接过来的那一项就不画，不拿演示数字凑 */
  badges?: NavBadges
  /**
   * 本机装了的模组 id；`null` = 拿不到清单（浏览器预览）。
   * 用来决定「群星」这类**依赖模组**的分组显不显示，见 `visibleNavGroups`。
   */
  installedMods?: ReadonlySet<string> | null
}) {
  const miniMetrics = metrics.filter((m) => MINI_KEYS.includes(m.key))
  /** 没装对应模组的分组整组不画（连标题一起），而不是画出来再点进去看空页 */
  const groups = visibleNavGroups(NAV_GROUPS, installedMods ?? null)
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
        {groups.map((group) => (
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
                    data-guide-target={item.id === "settings" ? "settings" : undefined}
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
