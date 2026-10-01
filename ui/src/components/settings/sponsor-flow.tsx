/**
 * 补给线：设置页最底下那块「由远到近飘过」的赞助人星图。
 *
 * 为什么用 WebGL 而不是 CSS / 2D 画布 / 预渲染视频：
 *   1) 要的是「由远到近、原地放大、越来越糊」。糊的本质是**各向同性散焦**：视频做死了
 *      名单一改就得重渲染、包体还得多背两兆；CSS 的 blur() 逐帧改会整层重绘。
 *   2) three 已经在包里（开机动画那块，随 exe 嵌入不联网），第二处复用的**增量成本是 0**：
 *      分块按需解析，解析过一次就常驻。
 *
 * 拍法（用户原话：由远到近，飘过放大，慢慢模糊消失）：
 *   正交相机 + 像素坐标系，每个标签自己管**缩放**，同时沿它自己的方向缓缓外移 ——
 *   缩放让它「原地变大」，外移让它「从身边掠过」。屏幕位置取「锚点 × 缓动后的倍率」，
 *   越近离画面中心越远，观感与透视飞过一致，却不必真做透视投影（透视会把标签拽向
 *   消失点，反而丢了「原地放大」）。
 *
 * 两个刻意的选择：
 *   - **纹理 2 倍超采样**：显示倍率 1.0 时正好落在 mip 第 1 级（＝原生 1 倍的字素），
 *     所以「最清晰那一刻」是原生分辨率，不糊也不闪。
 *   - **散焦在片元里算**（9 抽样径向模糊）：three 的 mip 只在**缩小**时生效，放大到
 *     3 倍时 mip 只会更清楚；要让「放大」与「变糊」同时发生，只能自己抽。
 *
 * 性能：设置页本来就不在启动路径上，再加一道视口门 —— 不在可视区就整块停掉
 * （cancelAnimationFrame + 冻结时钟），滚走或最小化都不占 CPU，也不吃 GPU。
 * 拿不到 WebGL 就退成静态标签列表，面板不会开天窗。
 */
import * as React from "react"

import { useSponsors } from "@/hooks/use-sponsors"
import { t } from "@/lib/i18n"
import { formatMoney, type SponsorEntry } from "@/lib/sponsors"
import { disposeStage, hasWebGL, loadThree, prefersReducedMotion } from "@/lib/three-stage"

/** 舞台最矮就这么高：再矮就没地方飘了。正常情况下它由设置页的剩余高度决定 */
const MIN_STAGE_HEIGHT = 130
/** 最高封顶：大屏上也不让它长过半屏 */
const MAX_STAGE_HEIGHT = 220
/** 纹理按 2 倍画、按 1 倍显示，等于自带一次盒式抗锯齿 */
const SUPERSAMPLE = 2
/** 纵深 → 显示倍率：最远 0.42 倍，最近 3.4 倍 */
const SCALE_FAR = 0.5
const SCALE_NEAR = 2.4
/** 向外漂移比缩放温和（位置按 scale^0.4），大标签不会刚变大就被甩出画面 */
const DRIFT_EXP = 0.4
/** 最糊时的散焦半径（屏幕像素） */
const MAX_DEFOCUS = 6
/** 纵深越过这两条线才开始糊、开始淡出 */
const DEFOCUS_FROM = 0.58
const FADE_FROM = 0.78
const FADE_TO = 0.99
/** 纵深多少开始淡入（避免凭空冒出来） */
const RISE_TO = 0.18
/** 每 SLOT 秒放一枚进场：面板就这么矮，同时在场的必须少，否则一定互相压 */
const ENTRY_SLOT = 2.6
/** 摆位用的低差异序列系数（黄金比 / 塑胶数）：同一批标签永远不会挤成一堆 */
const SPREAD_X = 0.6180339887498949
const SPREAD_Y = 0.7548776662466927

const FONT_STACK =
  '"Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif'
const NAME_FONT = "600 13px " + FONT_STACK
const AMOUNT_FONT = "700 13px " + FONT_STACK
const NAME_COLOR = "#DCE7F5"
const AMOUNT_COLOR = "#FFB800"
const LABEL_FILL = "rgba(9,17,31,0.82)"
const LABEL_BORDER = "rgba(63,116,170,0.85)"

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

/**
 * 径向散焦：中心 1 抽样 + 16 抽样黄金角螺旋。
 *
 * 为什么不用「四个方向 × 两个半径」那种 8 抽样：那 8 个点正好落在十字与对角线上，
 * 糊出来是**八个看得见的重影**（边框尤其明显，一圈描边被复制成八圈）。
 * 黄金角螺旋的点不成环也不成十字，叠出来才是一团均匀的糊。
 *
 * `uTexel` 把偏移从「纹素」换算到 uv，所以模糊在屏幕空间是各向同性的 —— 不这么写，
 * 长条标签的糊会横向拖成一条。
 */
const FRAGMENT_SHADER = `
uniform sampler2D uMap;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uLod;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec4 color = textureLod( uMap, vUv, uLod );

  if ( uRadius > 0.3 ) {
    vec4 accum = color;
    for ( int i = 0; i < 16; i ++ ) {
      float step = ( float( i ) + 0.5 ) / 16.0;
      float angle = float( i ) * 2.399963229728653;
      // 半径按 step 线性铺开（不是 sqrt）：抽样点往中心略密，糊得更像高斯、边缘更柔
      vec2 offset = vec2( cos( angle ), sin( angle ) ) * step * uRadius;
      accum += textureLod( uMap, vUv + offset * uTexel, uLod );
    }
    color = accum / 17.0;
  }

  gl_FragColor = vec4( color.rgb, color.a * uOpacity );
}
`

/** 指数分布的伪随机：同一个 index 每次都落在同一处，仅用于摆位与节奏，不做安全用途 */
function noise(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const p = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return p * p * (3 - 2 * p)
}

/** 低差异序列摆位：把第 index 枚摊到 [-1, 1]（乘数取无理数，序列才不会折回同一个点） */
function spread(index: number, multiplier: number): number {
  const value = (index * multiplier + 0.13) % 1
  return value * 2 - 1
}

/** 纵深 → 显示倍率（相对标签 1 倍原始尺寸） */
function scaleAt(z: number): number {
  return SCALE_FAR * Math.pow(SCALE_NEAR / SCALE_FAR, Math.pow(Math.max(0, z), 1.5))
}

/** 纵深 → 散焦半径（屏幕像素）。中段之前一直是锐的 */
function defocusAt(z: number): number {
  if (z <= DEFOCUS_FROM) return 0
  const p = (z - DEFOCUS_FROM) / (1 - DEFOCUS_FROM)
  return Math.pow(p, 1.7) * MAX_DEFOCUS
}

/** 纵深 → 不透明度：淡入 → 常亮 → 一边糊一边散掉 */
function opacityAt(z: number): number {
  return smoothstep(0, RISE_TO, z) * (1 - smoothstep(FADE_FROM, FADE_TO, z))
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

interface LabelTile {
  canvas: HTMLCanvasElement
  /** 逻辑尺寸（1 倍，未算超采样） */
  width: number
  height: number
}

/** 画一枚「名字 + 金色金额」的圆角标签。样式逐项照原型，不做发挥 */
function makeLabelTile(entry: SponsorEntry): LabelTile {
  const amountText = formatMoney(entry)
  const probe = document.createElement("canvas").getContext("2d")
  const measure = (font: string, text: string) => {
    if (!probe) return text.length * 13
    probe.font = font
    return probe.measureText(text).width
  }
  const nameWidth = measure(NAME_FONT, entry.name)
  const amountWidth = measure(AMOUNT_FONT, amountText)

  const padX = 11
  const padY = 7
  const gap = 8
  const width = Math.ceil(padX * 2 + nameWidth + gap + amountWidth)
  const height = Math.ceil(padY * 2 + 16)

  const canvas = document.createElement("canvas")
  canvas.width = width * SUPERSAMPLE
  canvas.height = height * SUPERSAMPLE

  const ctx = canvas.getContext("2d")
  if (!ctx) return { canvas, width, height }
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE)
  ctx.textBaseline = "middle"
  ctx.direction = "ltr"

  ctx.save()
  ctx.shadowColor = "rgba(0,0,0,0.55)"
  ctx.shadowBlur = 7
  ctx.shadowOffsetY = 2
  roundRectPath(ctx, 0.5, 0.5, width - 1, height - 1, 4)
  ctx.fillStyle = LABEL_FILL
  ctx.fill()
  ctx.restore()

  roundRectPath(ctx, 0.5, 0.5, width - 1, height - 1, 4)
  ctx.strokeStyle = LABEL_BORDER
  ctx.lineWidth = 1
  ctx.stroke()

  const centerY = height / 2 + 0.5
  ctx.font = NAME_FONT
  ctx.fillStyle = NAME_COLOR
  ctx.fillText(entry.name, padX, centerY)
  ctx.font = AMOUNT_FONT
  ctx.fillStyle = AMOUNT_COLOR
  ctx.fillText(amountText, padX + nameWidth + gap, centerY)

  return { canvas, width, height }
}

interface FlyingLabel {
  mesh: any
  material: any
  texture: any
  tile: LabelTile
  seed: number
  /** 锚点（屏幕中心为原点，y 向上），随舞台尺寸换算 */
  anchorX: number
  anchorY: number
  /** 单次掠过的秒数，与含空窗的整套循环长度 */
  active: number
  cycle: number
  offset: number
}

export function SponsorFlow() {
  const stageRef = React.useRef<HTMLElement | null>(null)
  const [plainList, setPlainList] = React.useState(false)
  // 名单优先读远端（`sponsors:snapshot`），拿不到才用随包那份 —— 见 use-sponsors.ts
  const entries = useSponsors()

  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    // 显式标注类型：下面在异步闭包里用，别让「非空」的收窄在闭包里失效
    const host: HTMLElement = stage

    // 画布**自己建**，不交给 React：三处都要一张干净画布 ——
    //   1) dispose 里会 forceContextLoss()，而这会让这张画布上的 GL 上下文永久失效；
    //   2) 同一个 canvas 元素再挂一个 WebGLRenderer 只会拿到那个已失效的上下文（白板）；
    //   3) React 复用 DOM 节点，组件重挂（StrictMode 双挂 / 来回切页）时元素还是同一个。
    // 自建自删就没有这回事：每次挂载都是一张全新画布。
    const canvas = document.createElement("canvas")
    canvas.className = "absolute inset-0 block h-full w-full"
    canvas.setAttribute("aria-hidden", "true")
    host.appendChild(canvas)

    if (!hasWebGL(canvas)) {
      canvas.remove()
      setPlainList(true)
      return
    }

    const still = prefersReducedMotion()
    let disposed = false
    let frame = 0
    let running = false
    let onScreen = true
    const cleanups: Array<() => void> = []

    const stop = () => {
      running = false
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
    }

    void (async () => {
      const THREE = await loadThree()
      if (disposed) return
      if (!THREE) {
        setPlainList(true)
        return
      }

      let renderer: any
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "low-power",
        })
      } catch {
        setPlainList(true)
        return
      }
      renderer.setClearAlpha(0)

      const scene = new THREE.Scene()
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000)
      const geometry = new THREE.PlaneGeometry(1, 1)

      const labels: FlyingLabel[] = entries.map((entry, index) => {
        const tile = makeLabelTile(entry)
        const texture = new THREE.CanvasTexture(tile.canvas)
        texture.minFilter = THREE.LinearMipmapLinearFilter
        texture.magFilter = THREE.LinearFilter
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.generateMipmaps = true

        const material = new THREE.ShaderMaterial({
          uniforms: {
            uMap: { value: texture },
            uTexel: { value: new THREE.Vector2(1 / texture.image.width, 1 / texture.image.height) },
            uRadius: { value: 0 },
            uLod: { value: 0 },
            uOpacity: { value: 0 },
          },
          vertexShader: VERTEX_SHADER,
          fragmentShader: FRAGMENT_SHADER,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        scene.add(mesh)

        // 节奏：**等间隔进场** + 在场 7.5~9.5 秒 —— 任意时刻只在场三四枚，必然错开。
        // 编号即进场顺序，所以同一时刻在场的永远是相邻几个编号，摆位再按低差异序列散开。
        const active = 7.5 + noise(index, 3) * 2
        return {
          mesh,
          material,
          texture,
          tile,
          seed: index,
          anchorX: 0,
          anchorY: 0,
          active,
          cycle: entries.length * ENTRY_SLOT,
          offset: -index * ENTRY_SLOT,
        }
      })

      let width = 1
      let height = 1

      function layout() {
        const box = host.getBoundingClientRect()
        width = Math.max(1, box.width)
        height = Math.max(1, box.height)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height, false)
        camera.left = -width / 2
        camera.right = width / 2
        camera.top = height / 2
        camera.bottom = -height / 2
        camera.updateProjectionMatrix()
        // 低差异序列摆位：横竖各一套互不相关的系数，标签散得开、也不会两枚叠在一起
        for (const label of labels) {
          label.anchorX = spread(label.seed, SPREAD_X) * width * 0.44
          label.anchorY = spread(label.seed, SPREAD_Y) * height * 0.34
        }
      }

      /** 把一个标签放到纵深 z 上：缩放、外移、糊度、透明度一次算完 */
      function place(label: FlyingLabel, z: number, time: number) {
        const scale = scaleAt(z)
        const drift = Math.pow(scale, DRIFT_EXP)
        const swayX = Math.sin(time * 0.37 + label.seed) * 9
        const swayY = Math.cos(time * 0.29 + label.seed * 1.7) * 4

        label.mesh.position.set(label.anchorX * drift + swayX, label.anchorY * drift + swayY, 0)
        label.mesh.scale.set(label.tile.width * scale, label.tile.height * scale, 1)
        label.mesh.renderOrder = Math.round(z * 1000)
        label.mesh.visible = true

        const uniforms = label.material.uniforms
        uniforms.uLod.value = Math.max(0, Math.log2(SUPERSAMPLE / scale))
        uniforms.uRadius.value = (defocusAt(z) * SUPERSAMPLE) / scale
        uniforms.uOpacity.value = opacityAt(z)
      }

      function render() {
        renderer.render(scene, camera)
      }

      function tick(stamp: number) {
        if (disposed) return
        const seconds = stamp / 1000
        for (const label of labels) {
          const phase = (((seconds + label.offset) % label.cycle) + label.cycle) % label.cycle
          if (phase >= label.active) {
            label.mesh.visible = false
            continue
          }
          place(label, phase / label.active, seconds)
        }
        render()
        frame = window.requestAnimationFrame(tick)
      }

      function start() {
        if (disposed || still || running || !onScreen) return
        running = true
        frame = window.requestAnimationFrame(tick)
      }

      const onResize = () => {
        layout()
        if (still) {
          labels.forEach((label, index) => place(label, 0.34 + noise(index, 7) * 0.5, 0))
          render()
        }
      }

      layout()

      if (still) {
        // 减弱动效：只画一帧静止的纵深切片（大小与糊度都保留，只是不动）
        labels.forEach((label, index) => place(label, 0.34 + noise(index, 7) * 0.5, 0))
        render()
      }

      // 视口门：滚出可视区或窗口最小化就整块停 — 设置页不在启动路径上，这里再省一道
      const observer = new IntersectionObserver(
        (records) => {
          onScreen = Boolean(records[0]?.isIntersecting)
          if (onScreen && !document.hidden) start()
          else stop()
        },
        { rootMargin: "160px" }
      )
      observer.observe(host)

      const resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(host)

      const onVisibility = () => {
        if (document.hidden) stop()
        else start()
      }
      document.addEventListener("visibilitychange", onVisibility)

      start()

      cleanups.push(() => {
        observer.disconnect()
        resizeObserver.disconnect()
        document.removeEventListener("visibilitychange", onVisibility)
        for (const label of labels) {
          label.texture.dispose()
          label.material.dispose()
        }
        geometry.dispose()
        disposeStage(renderer, canvas)
      })
    })()

    return () => {
      disposed = true
      stop()
      for (const item of cleanups) item()
      canvas.remove()
    }
    // entries 进依赖：标签纹理是建场景时一次性画好的，名单换了只能整块重建。
    // 实际只发生一次（随包 → 远端那次），不是每帧的开销。
  }, [entries])

  /**
   * 面板外形**照原型**：没有边框、没有标题、不铺底色 —— 底就是启动器全局那层深空背景，
   * 这里只在中间补一块淡淡的辉光。所以别把它改回 `<Panel>`：那会多出一圈边框和一行标题。
   *
   * 高度交给 `flex-1`：设置页把它排在最后一块，**剩余多少就占多少** —— 整页永远一屏装下、
   * 不出现滚动条；窗口变矮时先压到 `MIN_STAGE_HEIGHT`，窗口很高时封顶在 `MAX_STAGE_HEIGHT`
   * （不然大屏上这块会一路长到半屏，那就不是「就这么大」了）。
   * `-mx-5` 是抵消设置页容器的 `p-5`：原型里这块比上下的面板更宽，一直铺到窗口边。
   */
  return (
    <section
      ref={stageRef}
      className="relative -mx-5 min-h-[130px] max-h-[220px] flex-1 overflow-hidden"
      style={{ minHeight: MIN_STAGE_HEIGHT, maxHeight: MAX_STAGE_HEIGHT }}
      data-i18n-skip
    >
      {/* 中段那一块亮一点：借的是全局环境光的画法，不自己铺底 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 42% 58% at 50% 50%, rgba(0,212,255,0.05), transparent 68%)",
        }}
        aria-hidden="true"
      />

      {/*
        左下角这块牌子的**位置是量出来的**：这一块挂 `-mx-5`、比上面的面板多出 20px，
        所以 `left-9` = 20 + 16 正好落在面板内容那条线上（面板 `p-4`）。
        文案走显式 `t()` 而不是翻译桥 —— 整段挂的是 `data-i18n-skip`（名单是用户数据），
        桥会连这块牌子一起跳过。
      */}
      <span className="pointer-events-none absolute bottom-3 left-9 text-[11px] uppercase tracking-[0.06em] text-tertiary">
        {t("赞助人名单")}
      </span>

      {plainList ? (
        <ul className="absolute inset-0 flex flex-wrap content-center justify-center gap-2 p-4">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded border border-border bg-card px-2.5 py-1 text-[12px] text-foreground"
            >
              <span>{entry.name}</span>
              <span className="tabular font-semibold text-telemetry">{formatMoney(entry)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
