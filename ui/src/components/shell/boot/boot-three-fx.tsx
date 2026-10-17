/**
 * 开机动画的**前景**层：three.js（WebGL）画的、围着标识的三段弧。
 *
 * 星场已经从这里搬走了 —— 开机画面的背景现在就是主界面那块 EVE 星图
 * （components/shell/star-map-fx.tsx，同一个组件、同一颗种子），再叠一层上浮的星点
 * 只是把同一件事画两遍、多占一个绘制循环。
 *
 * 为什么弧线仍用 WebGL：要有辉光与呼吸，2D 画布做不出这个层次。正交相机按**像素坐标**
 * 摆放（left/right/top/bottom = 视口边缘），弧线半径跟窗口尺寸是同一套单位，不用换算。
 * 环几何只在「测量 / 缩放」时重建，逐帧动画只改 transform 与 opacity，不碰几何。
 *
 * 降级：拿不到 WebGL 上下文（驱动黑名单 / 远程桌面 / 虚拟机）就静默不渲染，
 * 底下的星图与 CSS 开机画面照常工作 —— 开机动画坏掉不该挡住启动器。
 */
import { useEffect, useRef } from "react"
import { disposeStage, hasWebGL, loadThree } from "@/lib/three-stage"
import { BOOT_COLORS, prefersReducedMotion, useLogoCenter, type BootLayerProps } from "./shared"

/** three 的材质颜色用 0xRRGGBB */
function hex(value: string): number {
  return Number.parseInt(value.slice(1), 16)
}

export function BootThreeFx({ hostRef, logoRef }: BootLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const center = useLogoCenter(logoRef, hostRef)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return

    // 先探一次上下文：three 的 WebGLRenderer 拿不到会抛，提前判掉免得留一条无意义的异常
    if (!hasWebGL(canvas)) return
    const stage = host

    const still = prefersReducedMotion()
    let disposed = false
    let raf = 0
    const cleanups: Array<() => void> = []

    void (async () => {
      // 懒加载：three 单独成一个分块，开机画面不必等它解析完才能显示
      // （入口 chunk 因此保持在 1.25 MB 量级；这一块随包嵌在 exe 里，不联网）
      const THREE = await loadThree()
      if (disposed || !THREE) return

      let renderer: any
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "low-power",
        })
      } catch {
        return
      }
      renderer.setClearAlpha(0)

      const scene = new THREE.Scene()
      // 像素坐标系：原点在屏幕中心，y 轴向上
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
      camera.position.z = 1

      const disposables: Array<{ dispose: () => void }> = []

      /* ------------- 弧线：围着 Logo 的三段环 ------------- */
      interface Arc {
        mesh: any
        radius: number
        /** 用单位环（半径 1、粗细 thickness）再整体缩放，几何只有半径档位变化时才重建 */
        resize: (radius: number) => void
      }

      function makeArc(color: string, opacity: number, thickness: number, span: number): Arc {
        const material = new THREE.MeshBasicMaterial({
          color: hex(color),
          transparent: true,
          opacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
        const arc: Arc = {
          mesh,
          radius: 0,
          resize(radius: number) {
            if (radius <= 0 || Math.abs(radius - arc.radius) < 0.5) return
            arc.radius = radius
            mesh.geometry.dispose()
            mesh.geometry = new THREE.RingGeometry(
              Math.max(0.0001, radius - thickness / 2),
              radius + thickness / 2,
              96,
              1,
              0,
              span,
            )
          },
        }
        disposables.push(material)
        return arc
      }

      const arcs = new THREE.Group()
      const mainArc = makeArc(BOOT_COLORS.primary, 0.9, 2, Math.PI * 0.55)
      const telemetryArc = makeArc(BOOT_COLORS.telemetry, 0.55, 1.25, Math.PI * 0.26)
      const scanArc = makeArc(BOOT_COLORS.border, 0.4, 1, Math.PI * 2)
      arcs.add(mainArc.mesh, telemetryArc.mesh, scanArc.mesh)
      scene.add(arcs)

      let width = 1
      let height = 1
      let logoRadius = 58

      /* 几何只在测量/resize 时重建；逐帧只动 transform 与 opacity */
      function layout() {
        const box = stage.getBoundingClientRect()
        width = Math.max(1, box.width)
        height = Math.max(1, box.height)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height, false)
        camera.left = -width / 2
        camera.right = width / 2
        camera.top = height / 2
        camera.bottom = -height / 2
        camera.updateProjectionMatrix()

        // Logo 圆心从「左上角原点」换到「屏幕中心原点」（y 反向）
        const cx = center ? center.x : width / 2
        const cy = center ? center.y : height / 2
        arcs.position.set(cx - width / 2, height / 2 - cy, 0)

        logoRadius = center ? center.r : 58
        mainArc.resize(logoRadius)
        telemetryArc.resize(logoRadius + 9)
        scanArc.resize(logoRadius + 26)

      }

      function render() {
        renderer.render(scene, camera)
      }

      function onResize() {
        layout()
        if (still) render()
      }

      function frame() {
        if (disposed) return
        const t = performance.now() / 1000

        const breathe = 1 + Math.sin(t * 1.6) * 0.03
        mainArc.mesh.scale.set(breathe, breathe, 1)
        mainArc.mesh.rotation.z = t * 0.9
        telemetryArc.mesh.rotation.z = -t * 0.62 + 1.2

        // 扫描环：只有缩放与透明度在动（半径涨落靠 scale，不重建几何）
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.1)
        const scanScale = 1 + pulse * 0.12
        scanArc.mesh.scale.set(scanScale, scanScale, 1)
        scanArc.mesh.material.opacity = Math.max(0.06, 0.5 - pulse * 0.32)

        render()
        raf = window.requestAnimationFrame(frame)
      }

      layout()
      window.addEventListener("resize", onResize)
      cleanups.push(() => window.removeEventListener("resize", onResize))

      if (still) render()
      else frame()

      cleanups.push(() => {
        for (const item of disposables) item.dispose()
        // 归还 GL 上下文：dispose() 只还 three 自己造的东西，上下文要显式丢掉
        disposeStage(renderer, canvas)
      })
    })()

    return () => {
      disposed = true
      if (raf) window.cancelAnimationFrame(raf)
      for (const item of cleanups) item()
    }
  }, [hostRef, logoRef, center])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-boot-fx="three"
    />
  )
}
