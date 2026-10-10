/**
 * 补给线：设置页最底下那块赞助人弹幕。
 *
 * 每个名字是一条独立弹幕：统一从右向左，但入场时刻按「目标同时可见数」均匀错开，
 * 纵向位置与横穿速度带确定性抖动。这样名字连续出场、没有整屏空白，也不会挤成一团。
 *
 * 动效交给 Web Animations API，浏览器合成层负责跑；`prefers-reduced-motion` 或
 * 环境不支持时退回静态名单。
 */
import * as React from "react"

import { useSponsors } from "@/hooks/use-sponsors"
import { sponsorDanmakuSchedule } from "@/lib/sponsor-danmaku"
import { t } from "@/lib/i18n"
import { formatMoney, type SponsorEntry } from "@/lib/sponsors"
import { prefersReducedMotion } from "@/lib/three-stage"

/** 舞台最矮就这么高：再矮就没地方飘了。正常情况下它由设置页的剩余高度决定 */
const MIN_STAGE_HEIGHT = 130
/** 最高封顶：大屏上也不让它长过半屏 */
const MAX_STAGE_HEIGHT = 220

function DanmakuItem({ entry }: { entry: SponsorEntry }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border/80 bg-card/85 px-3 py-1 text-[12px] text-foreground shadow-[0_0_16px_rgba(0,212,255,0.06)]">
      <span className="whitespace-nowrap">{entry.name}</span>
      <span className="tabular whitespace-nowrap font-semibold text-telemetry">
        {formatMoney(entry)}
      </span>
    </span>
  )
}

function startTransform(driftY: number, rotateDeg: number): string {
  return `translate3d(100vw, ${driftY}px, 0) rotate(${rotateDeg}deg)`
}

function endTransform(driftY: number, rotateDeg: number): string {
  return `translate3d(-100%, ${driftY * -0.45}px, 0) rotate(${rotateDeg}deg)`
}

export function SponsorFlow() {
  const hostRef = React.useRef<HTMLElement | null>(null)
  const entries = useSponsors()
  const schedule = React.useMemo(
    () => sponsorDanmakuSchedule(entries.length),
    [entries.length]
  )
  const [plainList, setPlainList] = React.useState(() => prefersReducedMotion())
  const showDanmaku = !plainList && entries.length > 0

  React.useLayoutEffect(() => {
    if (!showDanmaku) return
    const host = hostRef.current
    if (!host || typeof host.animate !== "function") {
      setPlainList(true)
      return
    }

    const nodes = Array.from(
      host.querySelectorAll<HTMLElement>("[data-sponsor-bullet]")
    )
    const animations = nodes
      .map((node, index) => {
        const bullet = schedule[index]
        if (!bullet) return null
        const travelOffset = Math.max(
          0.004,
          Math.min(0.72, bullet.travelSeconds / bullet.cycleSeconds)
        )
        const fadeOffset = Math.max(0.001, Math.min(0.02, travelOffset * 0.22))
        const from = startTransform(bullet.driftY, bullet.rotateDeg)
        const to = endTransform(bullet.driftY, bullet.rotateDeg)

        return node.animate(
          [
            { transform: from, opacity: 0 },
            { offset: fadeOffset, transform: from, opacity: 1 },
            { offset: travelOffset, transform: to, opacity: 1 },
            {
              offset: Math.min(1, travelOffset + fadeOffset),
              transform: to,
              opacity: 0,
            },
            { offset: 1, transform: to, opacity: 0 },
          ],
          {
            duration: bullet.cycleSeconds * 1000,
            delay: bullet.delaySeconds * 1000,
            iterations: Infinity,
            easing: "linear",
            fill: "both",
          }
        )
      })
      .filter((animation): animation is Animation => Boolean(animation))

    let onScreen = true
    const sync = () => {
      const running = onScreen && !document.hidden
      for (const animation of animations) {
        if (running) animation.play()
        else animation.pause()
      }
    }

    const observer = new IntersectionObserver(
      (records) => {
        onScreen = Boolean(records[0]?.isIntersecting)
        sync()
      },
      { rootMargin: "120px" }
    )
    observer.observe(host)
    const onVisibility = () => sync()
    document.addEventListener("visibilitychange", onVisibility)
    sync()

    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      for (const animation of animations) animation.cancel()
    }
  }, [schedule, showDanmaku])

  /**
   * 面板外形照原型：没有边框、没有标题、不铺底色 —— 底就是启动器全局那层深空背景。
   *
   * 高度交给 `flex-1`：设置页把它排在最后一块，剩余多少就占多少；窗口很矮时压到
   * MIN_STAGE_HEIGHT，窗口很高时封顶在 MAX_STAGE_HEIGHT。
   */
  return (
    <section
      ref={hostRef}
      className="relative -mx-5 min-h-[130px] max-h-[220px] flex-1 overflow-hidden"
      style={{ minHeight: MIN_STAGE_HEIGHT, maxHeight: MAX_STAGE_HEIGHT }}
      aria-label={t("赞助人名单")}
      data-i18n-skip
    >
      {/* 中段那一块亮一点：借的是全局环境光的画法，不自己铺底 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 52% 62% at 50% 50%, rgba(0,212,255,0.055), transparent 70%)",
        }}
        aria-hidden="true"
      />

      {showDanmaku ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-7 top-1"
          aria-hidden="true"
        >
          {entries.map((entry, index) => {
            const bullet = schedule[index]
            if (!bullet) return null
            return (
              <div
                key={entry.id}
                data-sponsor-bullet
                className="sponsor-danmaku-bullet"
                style={{
                  top: `${bullet.topPercent}%`,
                  transform: startTransform(bullet.driftY, bullet.rotateDeg),
                }}
              >
                <DanmakuItem entry={entry} />
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="absolute inset-x-0 bottom-7 top-0 flex flex-wrap content-center justify-center gap-2 px-5">
          {entries.map((entry) => (
            <li key={entry.id}>
              <DanmakuItem entry={entry} />
            </li>
          ))}
        </ul>
      )}

      {/*
        左下角这块牌子的位置是量出来的：这一块挂 `-mx-5`、比上面的面板多出 20px，
        所以 `left-9` = 20 + 16 正好落在面板内容那条线上（面板 `p-4`）。
      */}
      <span className="pointer-events-none absolute bottom-3 left-9 text-[11px] uppercase tracking-[0.06em] text-tertiary">
        {t("赞助人名单")}
      </span>
    </section>
  )
}
