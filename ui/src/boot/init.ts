/**
 * dsh 启动动画接入：在 React 挂载前设置 EVEJS 品牌配置、挂星图背景层。
 * dsh-splash.js 是自运行 IIFE（main.tsx 里动态 import），导入即接管首屏，
 * 揭幕时移除自身并派发 dsh-startup:done —— 这里监听同一事件撤掉星图。
 */
import "./dsh-splash.css"

const startupConfig = {
  enabled: true,
  mode: "session",
  theme: "dark",
  speed: 1,
  requireInteraction: false,
  allowSkip: false,
  glass: false,
  sound: true,
  soundVolume: 0.5,
  voice: true,
  voiceSource: "asset",
  sfx: "audio",
  identity: "COMMAND",
  identityId: "042",
  accessLevel: "3",
  brand1: "EVEJS",
  brand2: "COMMAND CONSOLE",
  brand3a: "LAUNCHER",
  brand3b: "",
  // i18n-exempt: 启动动画内置品牌文案，跟随动画一起显示，不走翻译桥
  orgZh: "指挥台",
  orgEn: "EVEJS",
  orgSub: "EVEJS LAUNCHER",
  welcomeBox: "EVEJS LAUNCHER",
  welcomeSay: "Welcome to EVEJS Launcher.",
  footer: "EVEJS COMMAND",
}

;(window as unknown as Record<string, unknown>).__DSH_STARTUP__ = startupConfig

/** 星图网络背景：压在 splash 之下、应用之上（z-index 见 dsh-splash.css），揭幕即撤 */
function mountStarField(): () => void {
  const canvas = document.createElement("canvas")
  canvas.id = "dj-stars"
  document.body.appendChild(canvas)
  const context = canvas.getContext("2d")
  if (!context) {
    canvas.remove()
    return () => {}
  }
  const ctx: CanvasRenderingContext2D = context

  let W = 0
  let H = 0
  const DPR = Math.min(window.devicePixelRatio || 1, 2)
  const ACC = "#00d4ff"
  const TEL = "#ffb800"
  const INK = "#8ba3c7"
  const stars: Array<{ x: number; y: number; r: number; a: number; tw: number; sp: number; c: string }> = []
  const nodes: Array<{ x: number; y: number; r: number; a: number; tw: number; c: string }> = []
  const links: Array<{ a: number; b: number; d: number }> = []
  const neb: Array<{ x: number; y: number; r: number; c: string; a: number }> = []
  let rafId = 0
  let stopped = false

  function resize() {
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.round(W * DPR)
    canvas.height = Math.round(H * DPR)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  }

  function mulberry(a: number) {
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function build() {
    stars.length = 0
    nodes.length = 0
    links.length = 0
    neb.length = 0
    const rnd = mulberry(0xe7e5c0de)
    let i: number
    let x: number
    let y: number
    let r: number
    for (i = 0; i < 1800; i++) {
      x = rnd() * W
      y = rnd() * H
      r = rnd() * 1.1 + 0.2
      stars.push({ x, y, r, a: 0.2 + rnd() * 0.6, tw: rnd() * 6.28, sp: 0.5 + rnd() * 1.5, c: rnd() < 0.15 ? TEL : INK })
    }
    const n = Math.round(Math.min(160, (W * H) / 16000))
    for (i = 0; i < n; i++) {
      x = rnd() * W
      y = rnd() * H
      nodes.push({ x, y, r: 1.4 + rnd() * 1.6, a: 0.5 + rnd() * 0.5, tw: rnd() * 6.28, c: rnd() < 0.8 ? ACC : TEL })
    }
    const th = Math.min(W, H) * 0.22
    for (i = 0; i < nodes.length; i++) {
      const best: Array<{ j: number; d: number }> = []
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue
        const dx = nodes[i].x - nodes[j].x
        const dy = nodes[i].y - nodes[j].y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < th) best.push({ j, d })
      }
      best.sort((a, b) => a.d - b.d)
      for (let k = 0; k < Math.min(2, best.length); k++) links.push({ a: i, b: best[k].j, d: best[k].d })
    }
    neb.push({ x: 0.2 + rnd() * 0.6, y: 0.15 + rnd() * 0.4, r: 0.2 + rnd() * 0.15, c: ACC, a: 0.06 })
    neb.push({ x: 0.6 + rnd() * 0.3, y: 0.55 + rnd() * 0.35, r: 0.18 + rnd() * 0.12, c: TEL, a: 0.05 })
  }

  let rot = 0
  let last = 0
  function frame(t: number) {
    if (stopped) return
    const dt = last ? (t - last) / 1000 : 0
    last = t
    rot += dt * 0.02
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = "#0b1120"
    ctx.fillRect(0, 0, W, H)
    const cx = W / 2
    const cy = H / 2
    const co = Math.cos(rot)
    const si = Math.sin(rot)
    const rot2 = (p: { x: number; y: number }) => {
      const dx = p.x - cx
      const dy = p.y - cy
      return { x: cx + dx * co - dy * si, y: cy + dx * si + dy * co }
    }
    ctx.globalCompositeOperation = "lighter"
    for (const b of neb) {
      const nx = b.x * W
      const ny = b.y * H
      const nr = b.r * Math.min(W, H)
      const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr)
      g.addColorStop(0, b.c)
      g.addColorStop(1, "rgba(0,0,0,0)")
      ctx.globalAlpha = b.a
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = "source-over"
    ctx.lineWidth = 1
    for (const l of links) {
      const pa = rot2(nodes[l.a])
      const pb = rot2(nodes[l.b])
      const al = Math.max(0, 1 - l.d / (Math.min(W, H) * 0.22))
      ctx.strokeStyle = `rgba(0,212,255,${(0.18 * al).toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
    }
    for (const s of stars) {
      const sp = rot2(s)
      const tw = 0.5 + 0.5 * Math.sin(t * 0.001 * s.sp + s.tw)
      ctx.globalAlpha = s.a * tw
      ctx.fillStyle = s.c
      ctx.fillRect(sp.x - s.r / 2, sp.y - s.r / 2, s.r, s.r)
    }
    ctx.globalAlpha = 1
    for (const nd of nodes) {
      const np = rot2(nd)
      const tw = 0.6 + 0.4 * Math.sin(t * 0.0012 + nd.tw)
      ctx.globalAlpha = nd.a * tw
      ctx.fillStyle = nd.c
      ctx.beginPath()
      ctx.arc(np.x, np.y, nd.r, 0, 6.2832)
      ctx.fill()
      ctx.globalAlpha = 0.12 * nd.a * tw
      ctx.beginPath()
      ctx.arc(np.x, np.y, nd.r * 3.2, 0, 6.2832)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    rafId = requestAnimationFrame(frame)
  }

  resize()
  build()
  window.addEventListener("resize", () => {
    resize()
    build()
  })
  rafId = requestAnimationFrame(frame)

  return () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(rafId)
    canvas.remove()
  }
}

const unmountStarField = mountStarField()

// splash 揭幕（根节点被移除的同一 tick）→ 星图一并撤掉，露出主界面
window.addEventListener("dsh-startup:done", unmountStarField, { once: true })
// 兜底：splash 因故没跑起来也不能让星图永久盖着主界面
window.setTimeout(() => {
  if (!document.getElementById("dsh-startup-root")) unmountStarField()
}, 3000)

/** 供 main.tsx 在 splash 模块加载失败时手动撤星图 */
export function clearStartupOverlay() {
  unmountStarField()
}
