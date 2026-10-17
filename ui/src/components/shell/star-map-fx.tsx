/**
 * EVE 星图背景（three.js）。
 *
 * 移植自仓库里那份站点页面的 `html/scene.js` → `initStarMap()`：同一颗随机种子
 * （0xE7E5C0DE）、同一批几何 —— 1200 颗星尘 + 140 个星系 + 最近邻航路（只连最近的
 * 两条、距离 < 3.7）+ 5 个信标（含光环）+ 2 团星云。**种子固定是有意的**：每次开机
 * 看到的是同一片星域，不会今天长这样明天长那样。
 *
 * 与站点版只有两处差别：
 *   1. 去掉滚动联动（启动器没有整页滚动），换成极慢的镜头漂移；
 *   2. 尺寸跟**容器**走而不是 window —— 同一个组件既能当整屏背景，也能塞进开机画面。
 *
 * 三条纪律见 lib/three-stage（懒加载 / 先探上下文 / 显式归还 GL 上下文）。拿不到
 * WebGL（驱动黑名单 / 远程桌面 / 虚拟机）就整块不画，底下的纯色背景照常工作。
 */
import { useEffect, useRef } from "react"

import { disposeStage, hasWebGL, loadThree, prefersReducedMotion } from "@/lib/three-stage"
import { cn } from "@/lib/utils"

/**
 * three 这个包不带类型声明（见 components/shell/boot/three-module.d.ts），
 * 所以它就是 any。给它起个名字，读代码时至少知道手里拿的是 three 的东西 ——
 * 也免得每处都写一遍 `any` 触发 no-explicit-any。
 */
type Three = typeof import("three")

/** 取不到 CSS 变量时的兜底色：与 index.css 的 :root 同一套值 */
const FALLBACK = {
  accent: "#00D4FF",
  telemetry: "#FFB800",
  ink: "#8BA3C7",
} as const

const DUST_COUNT = 1800
const SYSTEM_COUNT = 140
/** 航路只连最近的两条，且两星距离不超过它 */
const EDGE_DISTANCE = 3.7
/** 信标取这几个星系（下标对 140 取模，写死是为了每次开机位置一致） */
const BEACONS = [4, 27, 61, 93, 127]
/** 背景动效 ~30fps 就够：省电，肉眼也看不出差别 */
const FRAME_MS = 33

/**
 * 俯视 45°（等距视角）：相机 y 与 z 相等，视线与盘面成 45°，星域被压成一张
 * 高度约为宽度 0.71 的椭圆 —— 比纯正交俯视有纵深，又比平视更像"地图"。
 *
 * 视距 ≈ 21.2（√(15²+15²)）：盘面半径 13.5，45° 下纵向投影约 9.5，16:10 的窗口正好铺满。
 * 点精灵按距离缩放（sizeAttenuation），所以点 / 光晕 / 星云要同步放大 POINT_SCALE 倍，
 * 屏幕上看起来才和原来一样大。
 */
const CAMERA_Y = 15
const CAMERA_Z = 15
const POINT_SCALE = 1.75
/** 同时最多几艘船在跃迁 */
const WARP_SHIPS = 6

/** 固定种子的随机数（mulberry32）：同一个种子永远长出同一片星域 */
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 取 index.css 里的 HSL 三元组（`--primary: 190 100% 50%`）换成 three 的颜色。
 *
 * 为什么不用硬编码色值：主题改了（换主色 / 加浅色主题）这里跟着走，不用改第二处。
 * 读不到就退回 FALLBACK —— 别让一个配色问题把整块背景干掉。
 */
function tokenColor(THREE: Three, name: string, fallback: string): Three {
  const color = new THREE.Color()
  let raw: string
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  } catch {
    raw = ""
  }
  const match = raw.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (match) {
    color.setHSL(
      Number(match[1]) / 360,
      Number(match[2]) / 100,
      Number(match[3]) / 100,
      THREE.SRGBColorSpace
    )
  } else {
    color.setStyle(fallback)
  }
  return color
}

/** 星点用的径向贴图：中心实、边缘透明，比纯色方块自然 */
function makeDotTexture(THREE: Three, size: number): Three {
  const textureCanvas = document.createElement("canvas")
  textureCanvas.width = size
  textureCanvas.height = size
  const context = textureCanvas.getContext("2d")
  if (!context) return new THREE.CanvasTexture(textureCanvas)
  const half = size / 2
  const gradient = context.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)")
  gradient.addColorStop(0.38, "rgba(255, 255, 255, 0.42)")
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(textureCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * 絮状噪声贴图：多倍频值噪声（fBm）+ 阈值化 + 径向淡出。
 *
 * 为什么不用径向渐变：径向渐变贴到精灵上就是一个发光圆盘，"雾"看起来就是一坨圆圈。
 * 这里叠四层不同密度的值噪声，把低值切掉、再乘一个边缘淡出 —— 得到的是形状不规则、
 * 边界自然消隐的絮状团；精灵再拉长、慢转，就是被气流扯开的尘雾。
 */
function makeFogTexture(THREE: Three, seed: number, size = 256): Three {
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext("2d")
  if (!context) return new THREE.CanvasTexture(canvas)

  const random = seededRandom(seed)
  const layers = [
    { cells: 5, weight: 0.46 },
    { cells: 11, weight: 0.28 },
    { cells: 23, weight: 0.17 },
    { cells: 47, weight: 0.09 },
  ].map((layer) => {
    const grid = new Float32Array((layer.cells + 1) * (layer.cells + 1))
    for (let index = 0; index < grid.length; index += 1) grid[index] = random()
    return { ...layer, grid }
  })

  const smooth = (value: number) => value * value * (3 - 2 * value)
  const sample = (layer: (typeof layers)[number], x: number, y: number) => {
    const { cells, grid } = layer
    const gx = x * cells
    const gy = y * cells
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const sx = smooth(gx - x0)
    const sy = smooth(gy - y0)
    const width = cells + 1
    const at = (ix: number, iy: number) => grid[iy * width + ix]
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
    return top + (bottom - top) * sy
  }

  const image = context.createImageData(size, size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      let value = 0
      for (const layer of layers) value += sample(layer, u, v) * layer.weight
      /*
       * 边缘淡出只负责"别露出贴图的方边"：中间一大块保持原样（falloff = 1），
       * 最后 1/4 半径才收边。早先写成 1 - r*2 那种整张图往中心收缩的衰减，
       * 结果每团雾的轮廓又是一个圆 —— 形状应该由上面的噪声决定，不是由遮罩决定。
       */
      const dx = u - 0.5
      const dy = v - 0.5
      const radius = Math.sqrt(dx * dx + dy * dy)
      const falloff = Math.min(1, Math.max(0, (0.5 - radius) * 3.2))
      // 阈值高一点 → 只留下噪声的高值区，絮状轮廓才明显；低值区直接透明
      const density = Math.max(0, value - 0.4) * falloff
      const index = (y * size + x) * 4
      image.data[index] = 255
      image.data[index + 1] = 255
      image.data[index + 2] = 255
      image.data[index + 3] = Math.min(255, Math.round(Math.pow(density, 1.25) * 640))
    }
  }
  context.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function StarMapFx({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return

    // 先探一次上下文：three 的 WebGLRenderer 拿不到会抛，提前判掉免得留一条无意义的异常
    if (!hasWebGL(canvas)) return

    const still = prefersReducedMotion()
    let disposed = false
    let raf = 0
    const cleanups: Array<() => void> = []

    void (async () => {
      const THREE = await loadThree()
      if (disposed || !THREE) return

      let renderer: Three
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          // 站点那份是一次性页面，用 high-performance；这里是常驻背景，
          // 走核显更省电，画面看不出区别
          powerPreference: "low-power",
        })
      } catch {
        return
      }
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80)
      camera.position.set(0, CAMERA_Y, CAMERA_Z)
      camera.lookAt(0, 0, 0)

      const root = new THREE.Group()
      // 盘面平躺在 xz 平面上，只绕 y 轴慢转 —— 俯视看下去就是一张会转的星图
      root.rotation.set(0, 0.4, 0)
      scene.add(root)

      const accent = tokenColor(THREE, "--primary", FALLBACK.accent)
      const amber = tokenColor(THREE, "--telemetry", FALLBACK.telemetry)
      const ink = tokenColor(THREE, "--muted-foreground", FALLBACK.ink)
      const dotTexture = makeDotTexture(THREE, 32)
      const random = seededRandom(0xe7e5c0de)
      const tint = new THREE.Color()
      const disposables: Array<{ dispose: () => void }> = [dotTexture]

      /* ---------------- 尘埃雾气：絮状噪声贴图 + 缓慢漂移的雾团 ---------------- */
      /*
       * 三层要点，都是为了让它「是背景的一部分」而不是盖在上面的一层：
       *   1. 建在最前面 —— 先画雾、再画星尘/星系/航路，星星是压在雾上面的；
       *   2. 叠加混合（Additive）—— 只加光、不遮挡，雾不会把底下的星点糊成一片灰；
       *   3. 低透明度 + 小尺寸 —— 单团 0.12~0.22、3.5~7.5 世界单位，铺 18 团。
       *      尺寸必须跟星图同一视角：相机在 21 单位外，雾团就该是「星系」的量级，
       *      不是几百像素宽、边缘糊成一片的大光斑（那看着就是贴在镜头前的一层）。
       * 贴图是启动时现生成的多倍频值噪声（见 makeFogTexture），形状不规则，不是圆。
       */
      const fogRandom = seededRandom(0x5eedf099)
      const fogTextures = [0x1a2b3c4d, 0x77889901, 0xdeadbeef].map((seed) => {
        const texture = makeFogTexture(THREE, seed)
        disposables.push(texture)
        return texture
      })
      interface FogWisp {
        sprite: Three
        baseX: number
        baseZ: number
        drift: number
        speed: number
        phase: number
        baseOpacity: number
        spin: number
      }
      const fogs: FogWisp[] = []
      /*
       * 18 团小雾，按「星系」的分布铺满整张盘面：半径 2~13（systemPoints 是 2.8~13.2，
       * 同一量级），单团 3.5~7.5 世界单位 —— 屏幕上 120~250px。
       * 之前是 6 团 16~27 单位的大雾（400~600px 宽、边缘一路糊到底），那是贴在镜头前的
       * 一层，跟 21 单位外的星图不是一个空间。
       */
      for (let index = 0; index < 18; index += 1) {
        const material = new THREE.SpriteMaterial({
          map: fogTextures[index % fogTextures.length],
          color: index % 5 === 4 ? amber : index % 2 === 0 ? accent : ink,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const sprite = new THREE.Sprite(material)
        // 往外铺：pow 0.7 让外圈稍稀，但不会挤在中心
        const radius = 2 + Math.pow(fogRandom(), 0.7) * 11
        const theta = fogRandom() * Math.PI * 2
        const baseX = Math.cos(theta) * radius
        const baseZ = Math.sin(theta) * radius
        // 扁一点：雾是被盘面压着铺开的，不是一颗球
        const scale = 3.5 + fogRandom() * 4
        sprite.position.set(baseX, (fogRandom() - 0.5) * 1.2, baseZ)
        sprite.scale.set(scale * 1.3, scale, 1)
        root.add(sprite)
        disposables.push(material)
        fogs.push({
          sprite,
          baseX,
          baseZ,
          drift: 0.4 + fogRandom() * 1,
          speed: 0.08 + fogRandom() * 0.14,
          phase: fogRandom() * Math.PI * 2,
          baseOpacity: 0.12 + fogRandom() * 0.1,
          spin: fogRandom() * Math.PI * 2,
        })
      }

      /* ---------------- 星尘：不成形的背景细砂 ---------------- */
      const dustPositions = new Float32Array(DUST_COUNT * 3)
      const dustColors = new Float32Array(DUST_COUNT * 3)
      for (let index = 0; index < DUST_COUNT; index += 1) {
        const radius = 3 + Math.pow(random(), 0.68) * 10.5
        const theta = random() * Math.PI * 2
        dustPositions[index * 3] = Math.cos(theta) * radius
        dustPositions[index * 3 + 1] = (random() - 0.5) * (1.4 + radius * 0.12)
        dustPositions[index * 3 + 2] = Math.sin(theta) * radius

        tint.copy(ink).lerp(accent, random() * 0.38)
        if (random() < 0.025) tint.lerp(amber, 0.5)
        dustColors[index * 3] = tint.r
        dustColors[index * 3 + 1] = tint.g
        dustColors[index * 3 + 2] = tint.b
      }
      const dustGeometry = new THREE.BufferGeometry()
      dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3))
      dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3))
      const dustMaterial = new THREE.PointsMaterial({
        map: dotTexture,
        size: 0.06 * POINT_SCALE,
        transparent: true,
        opacity: 0.54,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      const dust = new THREE.Points(dustGeometry, dustMaterial)
      root.add(dust)
      disposables.push(dustGeometry, dustMaterial)

      /* ---------------- 星系：亮一档的点，航路从它们之间长出来 ---------------- */
      const systemPoints: Three[] = []
      const systemPositionArray = new Float32Array(SYSTEM_COUNT * 3)
      const systemColors = new Float32Array(SYSTEM_COUNT * 3)
      for (let index = 0; index < SYSTEM_COUNT; index += 1) {
        const radius = 2.8 + Math.pow(random(), 0.66) * 10.4
        const theta = random() * Math.PI * 2
        const point = new THREE.Vector3(
          Math.cos(theta) * radius,
          (random() - 0.5) * (1.2 + radius * 0.1),
          Math.sin(theta) * radius
        )
        systemPoints.push(point)
        systemPositionArray[index * 3] = point.x
        systemPositionArray[index * 3 + 1] = point.y
        systemPositionArray[index * 3 + 2] = point.z

        tint.copy(ink).lerp(accent, 0.5 + random() * 0.45)
        if (random() < 0.07) tint.lerp(amber, 0.7)
        systemColors[index * 3] = tint.r
        systemColors[index * 3 + 1] = tint.g
        systemColors[index * 3 + 2] = tint.b
      }
      const systemGeometry = new THREE.BufferGeometry()
      systemGeometry.setAttribute("position", new THREE.BufferAttribute(systemPositionArray, 3))
      systemGeometry.setAttribute("color", new THREE.BufferAttribute(systemColors, 3))
      const systemMaterial = new THREE.PointsMaterial({
        map: dotTexture,
        size: 0.13 * POINT_SCALE,
        transparent: true,
        opacity: 0.86,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      const systems = new THREE.Points(systemGeometry, systemMaterial)
      root.add(systems)
      disposables.push(systemGeometry, systemMaterial)

      /* ---------------- 航路：每个星系只连最近的两条，避免一片乱麻 ---------------- */
      const edgeKeys = new Set<string>()
      const linePositions: number[] = []
      /** 航路两端（跃迁的船就从这些航路上挑目标） */
      const routeEdges: Array<{ a: Three; b: Three }> = []
      for (let index = 0; index < systemPoints.length; index += 1) {
        const neighbors: Array<{ other: number; distance: number }> = []
        for (let other = 0; other < systemPoints.length; other += 1) {
          if (other === index) continue
          const distance = systemPoints[index].distanceTo(systemPoints[other])
          if (distance < EDGE_DISTANCE) neighbors.push({ other, distance })
        }
        neighbors.sort((a, b) => a.distance - b.distance)
        for (const neighbor of neighbors.slice(0, 2)) {
          const low = Math.min(index, neighbor.other)
          const high = Math.max(index, neighbor.other)
          const key = `${low}-${high}`
          if (edgeKeys.has(key)) continue
          edgeKeys.add(key)
          linePositions.push(
            systemPoints[low].x,
            systemPoints[low].y,
            systemPoints[low].z,
            systemPoints[high].x,
            systemPoints[high].y,
            systemPoints[high].z
          )
          routeEdges.push({ a: systemPoints[low].clone(), b: systemPoints[high].clone() })
        }
      }
      const lineGeometry = new THREE.BufferGeometry()
      lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3))
      const lineMaterial = new THREE.LineBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      root.add(new THREE.LineSegments(lineGeometry, lineMaterial))
      disposables.push(lineGeometry, lineMaterial)

      /* ---------------- 信标：五个被标出来的星系，带光晕与航线 ---------------- */
      const beaconPositions = new Float32Array(BEACONS.length * 3)
      const beaconColors = new Float32Array(BEACONS.length * 3)
      const halos: Three[] = []
      BEACONS.forEach((systemIndex, beaconIndex) => {
        const point = systemPoints[systemIndex % systemPoints.length]
        const color = beaconIndex === 0 ? amber : accent
        beaconPositions[beaconIndex * 3] = point.x
        beaconPositions[beaconIndex * 3 + 1] = point.y
        beaconPositions[beaconIndex * 3 + 2] = point.z
        beaconColors[beaconIndex * 3] = color.r
        beaconColors[beaconIndex * 3 + 1] = color.g
        beaconColors[beaconIndex * 3 + 2] = color.b

        const haloMaterial = new THREE.SpriteMaterial({
          map: dotTexture,
          color,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const halo = new THREE.Sprite(haloMaterial)
        halo.position.copy(point)
        halo.scale.set(1.15 * POINT_SCALE, 1.15 * POINT_SCALE, 1)
        root.add(halo)
        halos.push(halo)
        disposables.push(haloMaterial)
      })

      const beaconGeometry = new THREE.BufferGeometry()
      beaconGeometry.setAttribute("position", new THREE.BufferAttribute(beaconPositions, 3))
      beaconGeometry.setAttribute("color", new THREE.BufferAttribute(beaconColors, 3))
      const beaconMaterial = new THREE.PointsMaterial({
        map: dotTexture,
        size: 0.3 * POINT_SCALE,
        transparent: true,
        opacity: 0.92,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      root.add(new THREE.Points(beaconGeometry, beaconMaterial))
      disposables.push(beaconGeometry, beaconMaterial)

      /* ---------------- 航线：信标之间连成一条路线，第一段用琥珀色点出来 ---------------- */
      const routePositions: number[] = []
      const amberRoutePositions: number[] = []
      for (let index = 0; index < BEACONS.length - 1; index += 1) {
        const from = systemPoints[BEACONS[index] % systemPoints.length]
        const to = systemPoints[BEACONS[index + 1] % systemPoints.length]
        const target = index === 0 ? amberRoutePositions : routePositions
        target.push(from.x, from.y, from.z, to.x, to.y, to.z)
      }
      const routeGeometry = new THREE.BufferGeometry()
      routeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(routePositions, 3))
      const routeMaterial = new THREE.LineBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      root.add(new THREE.LineSegments(routeGeometry, routeMaterial))
      disposables.push(routeGeometry, routeMaterial)

      const amberRouteGeometry = new THREE.BufferGeometry()
      amberRouteGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(amberRoutePositions, 3)
      )
      const amberRouteMaterial = new THREE.LineBasicMaterial({
        color: amber,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      root.add(new THREE.LineSegments(amberRouteGeometry, amberRouteMaterial))
      disposables.push(amberRouteGeometry, amberRouteMaterial)

      /* ---------------- 跃迁：沿着航路跳的船，船尾拉成一条光速尾迹 ---------------- */
      const warpRandom = seededRandom(0x1e55c0de)
      /** 尾迹顶点：每艘船两个点（尾、头），凑成一段 LineSegments */
      const shipTrailPositions = new Float32Array(WARP_SHIPS * 2 * 3)
      const shipTrailColors = new Float32Array(WARP_SHIPS * 2 * 3)
      const shipHeadPositions = new Float32Array(WARP_SHIPS * 3)
      const shipHeadColors = new Float32Array(WARP_SHIPS * 3)
      const trailTailColor = accent.clone().multiplyScalar(0.18)
      const shipWhite = new THREE.Color(0xffffff)
      /** 尾迹靠近船头那端发白：与航路区分开，一眼看出这是「在动的东西」 */
      const trailHeadColor = accent.clone().lerp(shipWhite, 0.45)
      /** 换航路时算尾迹用的临时向量，避免每帧 new */
      const warpTemp = new THREE.Vector3()

      const ships = Array.from({ length: WARP_SHIPS }, (_, index) => {
        const edge = routeEdges[Math.floor(warpRandom() * routeEdges.length)]
        const from = edge ? edge.a.clone() : new THREE.Vector3()
        const to = edge ? edge.b.clone() : new THREE.Vector3()
        // 尾迹用顶点色做渐变（LineBasicMaterial 没有逐顶点透明度）：尾端压暗、头部拉亮
        shipTrailColors.set(
          [
            trailTailColor.r,
            trailTailColor.g,
            trailTailColor.b,
            trailHeadColor.r,
            trailHeadColor.g,
            trailHeadColor.b,
          ],
          index * 6
        )
        const headColor = (index === 0 ? amber : accent).clone().lerp(shipWhite, 0.7)
        shipHeadColors.set([headColor.r, headColor.g, headColor.b], index * 3)
        return {
          from,
          to,
          head: to.clone(),
          /** 0 = 刚起跳，1 = 到站 */
          progress: 1,
          duration: 1,
          /** > 0 = 停在站上歇着，倒计时结束再跳下一跳 */
          idle: 1.2 + warpRandom() * 4,
        }
      })

      const shipTrailGeometry = new THREE.BufferGeometry()
      shipTrailGeometry.setAttribute("position", new THREE.BufferAttribute(shipTrailPositions, 3))
      shipTrailGeometry.setAttribute("color", new THREE.BufferAttribute(shipTrailColors, 3))
      const shipTrailMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      root.add(new THREE.LineSegments(shipTrailGeometry, shipTrailMaterial))
      disposables.push(shipTrailGeometry, shipTrailMaterial)

      const shipHeadGeometry = new THREE.BufferGeometry()
      shipHeadGeometry.setAttribute("position", new THREE.BufferAttribute(shipHeadPositions, 3))
      shipHeadGeometry.setAttribute("color", new THREE.BufferAttribute(shipHeadColors, 3))
      const shipHeadMaterial = new THREE.PointsMaterial({
        map: dotTexture,
        size: 0.26 * POINT_SCALE,
        transparent: true,
        opacity: 0.95,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      root.add(new THREE.Points(shipHeadGeometry, shipHeadMaterial))
      disposables.push(shipHeadGeometry, shipHeadMaterial)

      /** 挑一条航路跳过去：目标取这条航路上**离当前船位更远**的那端，保证这一跳有长度 */
      const launch = (ship: (typeof ships)[number]) => {
        const edge = routeEdges[Math.floor(warpRandom() * routeEdges.length)]
        if (!edge) return
        const farther = edge.b.distanceTo(ship.head) >= edge.a.distanceTo(ship.head) ? edge.b : edge.a
        ship.from.copy(ship.head)
        ship.to.copy(farther)
        ship.progress = 0
        // 远一点的航路飞得久一点，但都在半秒上下 —— 观感是「跃迁」而不是「漂移」
        ship.duration = 0.18 + ship.from.distanceTo(ship.to) * 0.09
      }

      const updateWarps = (delta: number) => {
        for (let index = 0; index < ships.length; index += 1) {
          const ship = ships[index]
          if (ship.idle > 0) {
            ship.idle -= delta
            if (ship.idle <= 0) launch(ship)
            // 停靠在站上：尾迹收成零长度，只留船头那个亮点
            warpTemp.copy(ship.head)
          } else {
            ship.progress = Math.min(1, ship.progress + delta / ship.duration)
            // smoothstep：起步慢、中段最快、到站柔和，尾迹才拉得出来
            const eased = ship.progress * ship.progress * (3 - 2 * ship.progress)
            ship.head.lerpVectors(ship.from, ship.to, eased)
            // 尾端落后头部大半个行程，看着就是一条被拉长的光
            warpTemp.copy(ship.from).lerp(ship.to, Math.max(0, eased - 0.62))
            if (ship.progress >= 1) ship.idle = 1.4 + warpRandom() * 4.4
          }

          const trail = index * 6
          shipTrailPositions[trail] = warpTemp.x
          shipTrailPositions[trail + 1] = warpTemp.y
          shipTrailPositions[trail + 2] = warpTemp.z
          shipTrailPositions[trail + 3] = ship.head.x
          shipTrailPositions[trail + 4] = ship.head.y
          shipTrailPositions[trail + 5] = ship.head.z

          const head = index * 3
          shipHeadPositions[head] = ship.head.x
          shipHeadPositions[head + 1] = ship.head.y
          shipHeadPositions[head + 2] = ship.head.z
        }
        shipTrailGeometry.attributes.position.needsUpdate = true
        shipHeadGeometry.attributes.position.needsUpdate = true
      }

      // 先摆一轮位置：停靠在站上的船也要有船头亮点，静止帧（减弱动效）同样要看得见
      updateWarps(0)
      /* ---------------- 指针视差：鼠标动，镜头跟着偏一点（背景不该抢注意力） ---------------- */
      const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 }
      const onPointerMove = (event: PointerEvent) => {
        const width = window.innerWidth
        const height = window.innerHeight
        if (!width || !height) return
        pointer.targetX = (event.clientX / width) * 2 - 1
        pointer.targetY = (event.clientY / height) * 2 - 1
      }
      if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
        window.addEventListener("pointermove", onPointerMove, { passive: true })
        cleanups.push(() => window.removeEventListener("pointermove", onPointerMove))
      }

      const render = () => renderer.render(scene, camera)
      const resize = () => {
        const box = host.getBoundingClientRect()
        const width = Math.max(1, Math.round(box.width))
        const height = Math.max(1, Math.round(box.height))
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        render()
      }

      let lastTime = 0
      let lastDraw = 0
      let elapsed = 0

      const drawStatic = () => {
        root.rotation.set(0, 0.4, 0)
        camera.position.set(0, CAMERA_Y, CAMERA_Z)
        camera.lookAt(0, 0, 0)
        dustMaterial.opacity = 0.54
        systemMaterial.opacity = 0.86
        for (const halo of halos) halo.material.opacity = 0.2
        render()
      }

      const frame = (now: number) => {
        if (disposed) return
        if (!lastTime) lastTime = now
        const delta = Math.min((now - lastTime) / 1000, 0.05)
        lastTime = now
        elapsed += delta

        /*
         * 指针缓动必须按**时间**算，不能按帧数算。
         * 原来那版是每帧固定 3%，帧率一低（核显 / 远程桌面 / 大窗口）就要好几秒才跟上，
         * 手已经在别处了画面还黏在原地 —— 看起来就像「这个轴没反应」。
         * 1 - exp(-delta * 5)：任何帧率下都是 0.5 秒左右跟到位。
         */
        const follow = 1 - Math.exp(-delta * 5)
        pointer.x += (pointer.targetX - pointer.x) * follow
        pointer.y += (pointer.targetY - pointer.y) * follow

        /*
         * 鼠标的两个轴都要有回应：
         *   左右 → 相机横向平移；
         *   上下 → 盘面仰起/俯下（rotation.x）+ 相机沿 z 平移（俯视时正好落在屏幕的上下方向）。
         * 早先只有「相机沿 y 挪」这一条，在近乎平视的机位里等于只改了视距，肉眼看不出上下，
         * 于是感觉只有左右互动（2026-10-18 报障）。
         *
         * 关键：这里**不能**再 `camera.lookAt(0, 0, 0)`。挪完机位再回看原点等于绕盘面公转，
         * 屏幕上只剩透视变化，感觉不到被拖动；朝向一开始定好、之后只平移，星图才会真的跟着滑。
         */
        root.rotation.y = 0.4 + elapsed * 0.008
        root.rotation.x = pointer.y * 0.12
        // 极慢的呼吸漂移：鼠标不动时画面也不会像张静图
        camera.position.x = pointer.x * 3
        camera.position.z = CAMERA_Z + pointer.y * 3 + Math.sin(elapsed * 0.05) * 0.5

        updateWarps(delta)

        dustMaterial.opacity = 0.5 + Math.sin(elapsed * 0.55) * 0.06
        systemMaterial.opacity = 0.82 + Math.sin(elapsed * 0.8 + 0.7) * 0.07
        halos.forEach((halo, index) => {
          halo.material.opacity =
            0.16 + 0.06 * (0.5 + 0.5 * Math.sin(elapsed * 0.9 + index * 1.4))
        })
        // 雾团：各自绕原位画小圈 + 慢转 + 呼吸，周期互不相同，叠起来就是流动的烟
        for (const fog of fogs) {
          const t = elapsed * fog.speed * 6 + fog.phase
          fog.sprite.position.x = fog.baseX + Math.sin(t) * fog.drift
          fog.sprite.position.z = fog.baseZ + Math.cos(t * 0.8) * fog.drift
          fog.sprite.material.rotation = fog.spin + t * 0.25
          fog.sprite.material.opacity = fog.baseOpacity * (0.62 + 0.38 * Math.sin(t * 0.7))
        }

        if (now - lastDraw >= FRAME_MS) {
          render()
          lastDraw = now
        }

        if (!document.hidden && !still) {
          raf = window.requestAnimationFrame(frame)
        } else {
          raf = 0
        }
      }

      const start = () => {
        if (raf || still || document.hidden) return
        lastTime = 0
        lastDraw = 0
        raf = window.requestAnimationFrame(frame)
      }

      const onVisibility = () => {
        if (document.hidden) {
          if (raf) window.cancelAnimationFrame(raf)
          raf = 0
        } else {
          start()
        }
      }

      // 容器尺寸变化（窗口缩放、侧栏折叠）都要重新量：这个背景跟着容器走，不跟 window 走
      const observer =
        typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null
      observer?.observe(host)
      cleanups.push(() => observer?.disconnect())

      document.addEventListener("visibilitychange", onVisibility)
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility))
      cleanups.push(() => {
        if (raf) window.cancelAnimationFrame(raf)
        raf = 0
      })
      cleanups.push(() => {
        for (const item of disposables) item.dispose()
        // 归还 GL 上下文：dispose() 只还 three 自己造的东西，上下文要显式丢掉
        disposeStage(renderer, canvas)
      })

      resize()
      if (still) drawStatic()
      else start()
    })()

    return () => {
      disposed = true
      for (const item of cleanups) item()
    }
  }, [])

  return (
    <div
      ref={hostRef}
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  )
}
