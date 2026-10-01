/**
 * 开机动画层的公共件：开机层的 props 约定、量 Logo 中心、调色板、减弱动效判定。
 *
 * 被 boot-splash.tsx（挂载点）与 boot-three-fx.tsx（绘制方）共用。
 */
import { useEffect, useState, type RefObject } from "react"

export interface BootLayerProps {
  /** 覆盖整屏的开机层（坐标系原点） */
  hostRef: RefObject<HTMLDivElement | null>
  /** 中间的 Logo 盒子（环就是围着它画的，尺寸由 boot-splash 固定） */
  logoRef: RefObject<HTMLDivElement | null>
}

/** 与 index.css 的 :root 同一套值（canvas/WebGL 拿不到 CSS 变量，只能抄一份） */
export const BOOT_COLORS = {
  primary: "#00D4FF",
  telemetry: "#FFB800",
  border: "#1E3A5F",
} as const

/**
 * 系统里开了「减弱动效」就只画静止一帧，不做循环动画。
 * 实现只有一份，放在 lib/three-stage —— 开机动画与设置页的补给线面板共用。
 */
export { prefersReducedMotion } from "@/lib/three-stage"

export interface LogoCenter {
  x: number
  y: number
  /** 画环用的半径：Logo 盒子的一半再留一点缝 */
  r: number
}

/**
 * 量出 Logo 在开机层坐标系里的圆心与半径。
 * 不写死数值：窗口尺寸、DPI、布局改动都不会让环跑偏。
 */
export function useLogoCenter(
  logoRef: RefObject<HTMLDivElement | null>,
  hostRef: RefObject<HTMLDivElement | null>
): LogoCenter | null {
  const [center, setCenter] = useState<LogoCenter | null>(null)

  useEffect(() => {
    const measure = () => {
      const host = hostRef.current
      const logo = logoRef.current
      if (!host || !logo) return
      const box = host.getBoundingClientRect()
      const target = logo.getBoundingClientRect()
      setCenter({
        x: target.left - box.left + target.width / 2,
        y: target.top - box.top + target.height / 2,
        r: target.width / 2 + 10,
      })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [hostRef, logoRef])

  return center
}