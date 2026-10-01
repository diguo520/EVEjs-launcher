/**
 * three.js 的公共入口与收尾。
 *
 * 启动器里有两处要画 WebGL：开机动画（components/shell/boot/boot-three-fx.tsx）与
 * 设置页的「补给线」面板（components/settings/sponsor-flow.tsx）。两处必须守同样三条
 * 纪律，所以抽到这里 —— 免得哪一处漏掉，尤其是最后那条归还上下文。
 *
 *   1) **懒加载**。three 单独一块（719 KB，随 exe 嵌入，不联网），只有真要画的时候才
 *      `import("three")`；解析过一次之后模块常驻，第二次是缓存命中（所以第二处用它
 *      的真实增量成本是 0，而不是再吃一次 719 KB）。
 *   2) **先探上下文**。three 的 WebGLRenderer 拿不到上下文会抛，提前判掉，别在控制台
 *      留一条无意义的异常；探不到就整块不画，交给上层降级。
 *   3) **显式归还 GL 上下文**。`dispose()` 只还掉 three 自己创建的东西（几何、纹理、
 *      着色器程序），GL 上下文要等 GC 才真正还给系统 —— 面板一卸载就得
 *      `forceContextLoss()`，否则内存会悄悄涨上去，而这正是换框架时最在意的东西。
 */
export type ThreeModule = typeof import("three")

let pending: Promise<ThreeModule | null> | null = null

/** 懒加载 three；同一份 promise 复用，失败记成 null（坏环境不反复重试） */
export function loadThree(): Promise<ThreeModule | null> {
  if (!pending) {
    pending = import("three").then(
      (mod) => mod as unknown as ThreeModule,
      () => null
    )
  }
  return pending
}

/** 能不能拿到 WebGL 上下文。拿不到就整块不画，不要硬撑 */
export function hasWebGL(canvas: HTMLCanvasElement): boolean {
  try {
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"))
  } catch {
    return false
  }
}

/** 系统里开了「减弱动效」就只画静止一帧，不做循环动画 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** WebGLRenderer 的最小形状：只用到这几个方法，不必把 three 的类型拖进调用方 */
interface DisposableStage {
  dispose: () => void
  forceContextLoss?: () => void
}

/**
 * 拆舞台：先 dispose 掉 three 的对象，再强制归还 GL 上下文，最后把 canvas 的后备缓冲
 * 置 0。三步都要做 —— 少最后一步，那块画布尺寸的显存要一直挂到下次 GC。
 */
export function disposeStage(
  renderer: DisposableStage | null | undefined,
  canvas?: HTMLCanvasElement | null
): void {
  try {
    renderer?.dispose()
  } catch {
    // 上下文已经丢了就别再折腾
  }
  try {
    renderer?.forceContextLoss?.()
  } catch {
    // 同上
  }
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
}