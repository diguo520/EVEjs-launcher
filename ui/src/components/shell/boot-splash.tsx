import { useRef } from "react"
import { LogoMark } from "@/components/shell/logo-mark"
import { cn } from "@/lib/utils"
import { BootThreeFx } from "./boot/boot-three-fx"
import { StarMapFx } from "./star-map-fx"

/**
 * 开机画面：窗口一显示就盖满整屏，等后端第一次握手回来再淡出。
 *
 * 纯前端覆盖层，挂在 React 根节点（data-evejs-renderer="react"）下面 ——
 * G1 运行时自检只看那个根节点「有子树」，这层在不在都不影响它判定渲染层已挂载。
 * 读不到真实进度就不摆百分比，只走一条不定量信号带。
 *
 * 背景分两层：
 *   - 底层是 EVE 星图（star-map-fx.tsx）—— 与主界面用的是同一个组件、同一颗随机种子，
 *     所以淡出时星域位置不会跳一下；
 *   - 上层是围着标识的三段弧（boot/boot-three-fx.tsx）。
 * 两块都是 WebGL，且都走 import() 懒加载：开机画面先用纯 CSS 那层立刻显示，
 * three 就绪后再叠上去，不让 736 KB 的解析挡在首帧前面（入口 chunk 因此保持在 1.25 MB 量级）。
 * 拿不到 WebGL 上下文（驱动黑名单 / 远程桌面 / 虚拟机）就静默不渲染，
 * 外环与信号带照常工作，开机画面不会因为动效挂掉。
 *
 * 标识（LogoMark）、文字、信号带、外环在这一层之上，不参与动效绘制。
 */
export function BootSplash({
  visible,
  status,
}: {
  /** false = 数据到了，开始淡出（淡出时长由调用方与 CSS 对齐） */
  visible: boolean
  /** 下面那行小字：正在接入 / 已就绪 */
  status: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const logoRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      ref={hostRef}
      className={cn(
        "boot-splash",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      aria-hidden={visible ? undefined : true}
    >
      {/* 动效层贴在底：先星图（背景），再三段弧（围着标识），标识与文字盖在最上面 */}
      <StarMapFx />
      <BootThreeFx hostRef={hostRef} logoRef={logoRef} />

      <div className="relative flex flex-col items-center gap-6">
        {/* 外环呼吸 + 标识本身脉动：一眼看出是「正在接入」而不是卡死 */}
        <div ref={logoRef} className="relative grid size-24 place-items-center">
          <span
            className="boot-orbit absolute inset-0 rounded-full border border-primary/25"
            aria-hidden="true"
          />
          <LogoMark className="mc-pulse size-14" />
        </div>

        <div className="text-center">
          <div className="text-[15px] font-bold tracking-[0.34em] text-foreground">
            EVEJS COMMAND
          </div>
          <div className="tabular mt-2 text-[10px] tracking-[0.26em] text-primary/85">
            SERVER LAUNCHER
          </div>
        </div>

        <div className="boot-track" aria-hidden="true">
          <span className="boot-scan" />
        </div>

        <div className="tabular text-[10px] tracking-[0.18em] text-tertiary">{status}</div>
      </div>
    </div>
  )
}
