import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react"
import { Crosshair, Minus, Plus, RotateCcw } from "lucide-react"

import { Panel } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import {
  useFactionData,
  useSovereignty,
  useTerritory,
  type FactionController,
} from "@/hooks/use-faction"
import {
  FLEET_ROLE_LABEL,
  fitTransform,
  labelOf,
  nameOf,
  projectPoint,
  starmapView,
  type RealmPolity,
  type RosterEntry,
  type StarmapRaw,
} from "@/lib/faction-logic"
import { cn } from "@/lib/utils"
import { Field, FactionTag, PanelState } from "./faction-shared"

interface FleetRow {
  fleetID: number
  key: string
  name: string
  role: string
  state: string
  ships: number
  total: number
  place?: { kind?: string; systemID?: number; systemName?: string; stationID?: number } | null
  whereLabel?: string | null
  crossing?: { toSystemID?: number; toName?: string; progress?: number } | null
  battleID?: number | null
  order?: { type?: string; targetName?: string; hops?: number } | null
}

interface FleetsPayload {
  now: number
  factions: { key: string; name: string; homeSystemID: number; color: string }[]
  fleets: FleetRow[]
}

interface ViewState {
  zoom: number
  panX: number
  panY: number
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 24

/** 无主星系的底色（领土上色模式下用；比安全等级的蓝更暗，一眼能分出「没主」） */
const UNOWNED_COLOR = "#2a3444"

/** 玩家主权声明的环色（与任何势力色都不撞的金） */
const SOVEREIGNTY_COLOR = "#f5c542"

/** 星系的两种上色口径：按安全等级，或按领土归属 */
type ColorMode = "territory" | "security"

/** 安全等级配色（与游戏里星图一致的三档：高安 / 低安 / 零安） */
function securityColor(sec: number): string {
  if (sec >= 0.45) return "#5aa9ff"
  if (sec >= 0.05) return "#e0b23a"
  return "#e0453a"
}

/**
 * P5 星图：把模组的 5000+ 星系 2D 布局画成一张可缩放 / 拖动的星图，并叠加实时舰队。
 *
 * 为什么自己画而不是内嵌模组页面：模组那张星图是它自己的前端资源（130 KB 交互脚本 + 主题），
 * 嵌进来就是「启动器壳里套模组界面」，与整合的初衷相反。这里只用它的数据（`/api/starmap`
 * 的列式布局 + `/api/fleets` 的实时位置），渲染与交互都走启动器自己的画布。
 *
 * 星图布局是静态的（模组算一次缓存住，带 ETag），所以 5 分钟才拉一次；舰队位置 10 秒一拉。
 */
export function FactionStarmap({
  faction,
  roster,
  colorByKey,
  preferZh,
}: {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  preferZh: boolean
}) {
  const { t } = useLocale()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 800, height: 460 })
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 })
  const [layers, setLayers] = useState({
    links: true,
    systems: true,
    fleets: true,
    labels: false,
    sovereignty: true,
  })
  /** 默认按领土上色：这张图最想回答的就是「谁的地盘大、在哪扩」，安全等级是备选口径 */
  const [colorMode, setColorMode] = useState<ColorMode>("territory")
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null)

  const mapResource = useFactionData<StarmapRaw>(faction.api, "/api/starmap", {
    intervalMs: 300_000,
    enabled: faction.available,
  })
  const fleetResource = useFactionData<FleetsPayload>(faction.api, "/api/fleets", {
    intervalMs: 10_000,
    enabled: faction.available,
  })
  const star = useMemo(() => starmapView(mapResource.data, preferZh), [mapResource.data, preferZh])
  const fleets = fleetResource.data?.fleets ?? []
  /**
   * 领土：归属列与政体清单**成对**取（10 秒一拉）—— 势力扩地 / 丢星系时这张图跟着变色。
   * 配对校验在 hook 里（见 useTerritory），不成立就退回上一份，绝不用错编号上色。
   */
  const territory = useTerritory(faction.api, faction.available, star.points.length, 10_000)
  const ownerByIndex = territory?.owner ?? null
  const polities = useMemo(() => territory?.polities ?? [], [territory])
  /**
   * 玩家主权（游戏侧）：模组的政体版图看不到玩家军团 / 联盟的地盘，这份单独从游戏库读。
   * 与政体版图**并行显示**：政体色是「模拟出来的势力范围」，主权环是「游戏里真有主权声明」。
   */
  const sovereignty = useSovereignty(faction.available, 30_000)
  /** 版图最大的几个政体，图例用（按持有星系数排） */
  const topPolities = useMemo(
    () => [...polities].sort((left, right) => right.systems - left.systems).slice(0, 8),
    [polities]
  )
  const ownedCount = useMemo(
    () => (ownerByIndex ? ownerByIndex.reduce((sum, value) => sum + (value >= 0 ? 1 : 0), 0) : 0),
    [ownerByIndex]
  )
  const colorOfIndex = useCallback(
    (index: number): string => {
      const polity = polities[index]
      return polity ? polity.color : UNOWNED_COLOR
    },
    [polities]
  )
  const territoryReady = colorMode === "territory" && ownerByIndex !== null && polities.length > 0

  /** 舰队按所在星系分组（选中的星系要列出它们） */
  const fleetsBySystem = useMemo(() => {
    const map = new Map<number, FleetRow[]>()
    for (const row of fleets) {
      const id = row.place?.systemID
      if (!id) continue
      const list = map.get(id)
      if (list) list.push(row)
      else map.set(id, [row])
    }
    return map
  }, [fleets])

  // 画布尺寸跟随容器
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  const baseTransform = useMemo(
    () => (star.points.length > 0 ? fitTransform(star.bounds, size.width, size.height, 18) : null),
    [star.bounds, star.points.length, size.width, size.height]
  )

  /** 世界坐标 → 屏幕坐标（基础铺满之后再叠用户的缩放 / 平移） */
  const project = useCallback(
    (x: number, y: number) => {
      if (!baseTransform) return { px: 0, py: 0 }
      const base = projectPoint(baseTransform, x, y)
      return {
        px: base.px * view.zoom + view.panX,
        py: base.py * view.zoom + view.panY,
      }
    },
    [baseTransform, view]
  )

  const screenToIndex = useCallback(
    (clientX: number, clientY: number, radius: number): number | null => {
      const canvas = canvasRef.current
      if (!canvas || star.points.length === 0) return null
      const rect = canvas.getBoundingClientRect()
      const px = clientX - rect.left
      const py = clientY - rect.top
      let best: number | null = null
      let bestDistance = radius * radius
      for (let i = 0; i < star.points.length; i += 1) {
        const point = star.points[i]
        const { px: sx, py: sy } = project(point.x, point.y)
        const dx = sx - px
        const dy = sy - py
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) {
          bestDistance = distance
          best = i
        }
      }
      return best
    },
    [project, star.points]
  )

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || star.points.length === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(size.width * dpr))
    canvas.height = Math.max(1, Math.floor(size.height * dpr))
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const screen = star.points.map((point) => project(point.x, point.y))
    const inView = (px: number, py: number) => px >= -40 && py >= -40 && px <= size.width + 40 && py <= size.height + 40

    if (layers.links) {
      ctx.strokeStyle = "rgba(148,163,184,0.16)"
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const [left, right] of star.links) {
        const a = screen[left]
        const b = screen[right]
        if (!a || !b || !inView(a.px, a.py) || !inView(b.px, b.py)) continue
        ctx.moveTo(a.px, a.py)
        ctx.lineTo(b.px, b.py)
      }
      ctx.stroke()
    }

    if (layers.systems) {
      const radius = view.zoom >= 3 ? 2.2 : 1.3
      for (let i = 0; i < star.points.length; i += 1) {
        const point = star.points[i]
        const { px, py } = screen[i]
        if (!inView(px, py)) continue
        // 领土模式：有主按势力色，无主压暗；数据没到位就退回安全等级，别把整张图画成灰
        const owner = territoryReady && ownerByIndex ? ownerByIndex[i] : -1
        ctx.fillStyle = territoryReady
          ? owner >= 0
            ? colorOfIndex(owner)
            : UNOWNED_COLOR
          : securityColor(point.sec)
        ctx.globalAlpha = selected === i ? 1 : 0.85
        ctx.beginPath()
        ctx.arc(px, py, selected === i ? radius + 1.6 : radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // 玩家主权：给有主权声明的星系套一圈金环（无论当前按领土还是按安全等级上色都画）。
    // 这一圈回答的是「游戏里真有主权结构」，跟上面的政体色是两件事，所以两者并存。
    if (layers.sovereignty && sovereignty.claims.size > 0) {
      ctx.strokeStyle = SOVEREIGNTY_COLOR
      ctx.lineWidth = 1.2
      for (let i = 0; i < star.points.length; i += 1) {
        if (!sovereignty.claims.has(star.points[i].id)) continue
        const { px, py } = screen[i]
        if (!inView(px, py)) continue
        ctx.beginPath()
        ctx.arc(px, py, view.zoom >= 3 ? 5.2 : 4, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    if (layers.fleets) {
      for (const row of fleets) {
        const systemID = row.place?.systemID
        if (!systemID) continue
        const index = star.index.get(systemID)
        if (index === undefined) continue
        const { px, py } = screen[index]
        if (!inView(px, py)) continue
        ctx.fillStyle = colorByKey.get(row.key) ?? "#94a3b8"
        ctx.strokeStyle = "rgba(2,6,23,0.9)"
        ctx.lineWidth = 1
        const half = row.ships >= 10 ? 4 : 3
        ctx.beginPath()
        ctx.moveTo(px, py - half)
        ctx.lineTo(px + half, py + half)
        ctx.lineTo(px - half, py + half)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }

    if (layers.labels && view.zoom >= 4) {
      ctx.font = "10px ui-monospace, monospace"
      ctx.fillStyle = "rgba(226,232,240,0.85)"
      for (let i = 0; i < star.points.length; i += 1) {
        const point = star.points[i]
        if (point.stations <= 0 && point.sec < 0.45) continue
        const { px, py } = screen[i]
        if (!inView(px, py)) continue
        ctx.fillText(point.name, px + 4, py + 3)
      }
    }
  }, [
    star,
    fleets,
    colorByKey,
    layers,
    project,
    selected,
    size,
    view.zoom,
    territoryReady,
    ownerByIndex,
    colorOfIndex,
    sovereignty,
  ])

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
    setView((previous) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, previous.zoom * factor))
      const ratio = zoom / previous.zoom
      return {
        zoom,
        panX: cx - (cx - previous.panX) * ratio,
        panY: cy - (cy - previous.panY) * ratio,
      }
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY, moved: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
      setView((previous) => ({ ...previous, panX: drag.panX + dx, panY: drag.panY + dy }))
      setHover(null)
      return
    }
    const index = screenToIndex(event.clientX, event.clientY, Math.max(6, view.zoom * 3))
    if (index === null) {
      setHover(null)
      return
    }
    const point = star.points[index]
    const { px, py } = project(point.x, point.y)
    setHover({ index, x: px, y: py })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.moved) return
    const index = screenToIndex(event.clientX, event.clientY, Math.max(6, view.zoom * 3))
    setSelected(index)
  }

  const hoverPoint = hover ? star.points[hover.index] : null
  const selectedPoint = selected !== null ? star.points[selected] : null
  const selectedFleets = selectedPoint ? fleetsBySystem.get(selectedPoint.id) ?? [] : []
  /** 选中星系的归属（领土模式下与画布同源；没数据就是无主） */
  const selectedOwner: RealmPolity | null = (() => {
    if (selected === null || !territoryReady || !ownerByIndex) return null
    const index = ownerByIndex[selected]
    return index >= 0 ? polities[index] ?? null : null
  })()
  /** 选中星系的玩家主权声明（游戏侧；与政体版图是两件事，可以同时有） */
  const selectedClaim = selectedPoint ? sovereignty.claims.get(selectedPoint.id) ?? null : null
  const selectedClaimName = selectedClaim
    ? sovereignty.alliances.get(selectedClaim.allianceID)?.name ??
      t("联盟 #{id}", { id: selectedClaim.allianceID })
    : ""
  const selectedClaimCorp = selectedClaim
    ? sovereignty.corporations.get(selectedClaim.corporationID) ?? ""
    : ""

  const resetView = () => setView({ zoom: 1, panX: 0, panY: 0 })

  return (
    <div className="space-y-4">
      <Panel
        tag="// STARMAP"
        title={t("星图")}
        meta={[
          t("{n} 个星系", { n: star.points.length }),
          // 政体版图（模组的 NPC 势力范围）与玩家主权（游戏侧的真实声明）分开报数，
          // 免得把「模拟出来的范围」和「真有主权结构」混成一个数字。
          territoryReady ? t("政体版图 {n}", { n: ownedCount }) : t("按安全等级"),
          sovereignty.claims.size > 0 ? t("玩家主权 {n}", { n: sovereignty.claims.size }) : null,
          t("{m} 支舰队", { m: fleets.length }),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {/* 上色口径：领土（谁的地盘）或安全等级。两个互斥，用同一套胶囊样式 */}
            {(
              [
                ["territory", t("按领土")],
                ["security", t("按安全等级")],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setColorMode(mode)}
                disabled={mode === "territory" && ownerByIndex === null}
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-40",
                  colorMode === mode
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground hover:border-primary/60"
                )}
              >
                {label}
              </button>
            ))}
            <span className="mx-0.5 h-3.5 w-px bg-border" />
            {(
              [
                ["links", t("星门")],
                ["systems", t("星系")],
                ["fleets", t("舰队")],
                ["sovereignty", t("主权")],
                ["labels", t("名字")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLayers((previous) => ({ ...previous, [id]: !previous[id] }))}
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors",
                  layers[id]
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground hover:border-primary/60"
                )}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setView((previous) => ({ ...previous, zoom: Math.min(MAX_ZOOM, previous.zoom * 1.4) }))}
              className="inline-flex size-5 items-center justify-center rounded-sm border border-border text-muted-foreground hover:border-primary hover:text-primary"
              title={t("放大")}
            >
              <Plus className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => setView((previous) => ({ ...previous, zoom: Math.max(MIN_ZOOM, previous.zoom / 1.4) }))}
              className="inline-flex size-5 items-center justify-center rounded-sm border border-border text-muted-foreground hover:border-primary hover:text-primary"
              title={t("缩小")}
            >
              <Minus className="size-3" />
            </button>
            <button
              type="button"
              onClick={resetView}
              className="inline-flex size-5 items-center justify-center rounded-sm border border-border text-muted-foreground hover:border-primary hover:text-primary"
              title={t("复位")}
            >
              <RotateCcw className="size-3" />
            </button>
          </div>
        }
      >
        <PanelState
          loading={mapResource.loading && star.points.length === 0}
          error={mapResource.error}
          onRetry={mapResource.reload}
        >
          <div
            ref={wrapRef}
            className="relative h-[520px] w-full overflow-hidden rounded border border-border bg-[#050810]"
          >
            <canvas
              ref={canvasRef}
              className="size-full cursor-crosshair touch-none"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                dragRef.current = null
                setHover(null)
              }}
            />
            {hoverPoint ? (
              <div
                className="pointer-events-none absolute z-10 rounded border border-border bg-card/95 px-2 py-1 text-[11px] shadow-lg"
                style={{
                  left: Math.min(hover!.x + 10, Math.max(0, size.width - 170)),
                  top: Math.max(0, hover!.y - 34),
                }}
              >
                <div className="text-foreground">{hoverPoint.name}</div>
                <div className="tabular text-tertiary">
                  {hoverPoint.sec.toFixed(2)} · {hoverPoint.stations} {t("空间站")}
                </div>
              </div>
            ) : null}
            <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-3 text-[10px] text-tertiary">
              {territoryReady ? (
                <>
                  {/* 领土模式：版图最大的几家 + 无主。颜色就是画布上用的那一份，不是另配的 */}
                  {topPolities.map((polity) => (
                    <span key={polity.key} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: polity.color }}
                      />
                      {polity.name}
                      <span className="tabular text-tertiary">{polity.systems}</span>
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: UNOWNED_COLOR }}
                    />
                    {t("无主")}
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full bg-[#5aa9ff]" />
                    {t("高安")}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full bg-[#e0b23a]" />
                    {t("低安")}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2 rounded-full bg-[#e0453a]" />
                    {t("零安")}
                  </span>
                </>
              )}
              {sovereignty.claims.size > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <span
                    className="inline-block size-2 rounded-full border"
                    style={{ borderColor: SOVEREIGNTY_COLOR }}
                  />
                  {t("玩家主权")}
                  <span className="tabular text-tertiary">{sovereignty.claims.size}</span>
                </span>
              ) : null}
              <span className="ml-2 inline-flex items-center gap-1">
                <Crosshair className="size-3" />
                {t("拖动平移 · 滚轮缩放 · 点击选星系")}
              </span>
            </div>
          </div>
        </PanelState>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// SYSTEM" title={t("选中的星系")}>
          {selectedPoint ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label={t("名称")} value={selectedPoint.name} />
              <Field
                label={t("归属")}
                value={selectedOwner ? selectedOwner.name : t("无主")}
                hint={selectedOwner ? t("{n} 个星系", { n: selectedOwner.systems }) : undefined}
              />
              <Field label={t("安保")} value={selectedPoint.sec.toFixed(2)} />
              <Field label={t("空间站")} value={selectedPoint.stations} />
              <Field label={t("星系 ID")} value={selectedPoint.id} />
              {selectedClaim ? (
                <div className="col-span-2 sm:col-span-4">
                  <div className="panel-label">{t("主权声明")}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                    <span className="text-warning">{selectedClaimName}</span>
                    {selectedClaimCorp ? (
                      <span className="text-muted-foreground">{selectedClaimCorp}</span>
                    ) : null}
                    <span className="tabular text-tertiary">
                      {t("建筑 {n} 座", { n: sovereignty.structureCounts.get(selectedPoint.id) ?? 0 })}
                    </span>
                  </div>
                </div>
              ) : null}
              <div className="col-span-2 sm:col-span-4">
                <div className="panel-label">{t("在此的舰队（{n} 支）", { n: selectedFleets.length })}</div>
                <div className="mt-1 max-h-[160px] space-y-1 overflow-y-auto pr-1">
                  {selectedFleets.length === 0 ? (
                    <div className="py-3 text-[11px] text-tertiary">{t("这里没有推演出来的舰队")}</div>
                  ) : (
                    selectedFleets.map((row) => (
                      <div key={row.fleetID} className="flex items-center gap-2 text-[11.5px]">
                        <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                        <span className="truncate text-muted-foreground">{row.name}</span>
                        <span className="tabular text-tertiary">{row.ships}</span>
                        <span className="ml-auto text-tertiary">
                          {labelOf(FLEET_ROLE_LABEL, row.role, t)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-[12px] text-muted-foreground">
              {t("在星图上点一个星系看它有什么")}
            </div>
          )}
        </Panel>

        <Panel tag="// FLEETS" title={t("舰队位置")} meta={t("{n} 支", { n: fleets.length })}>
          <PanelState
            loading={fleetResource.loading && fleets.length === 0}
            error={fleetResource.error}
            onRetry={fleetResource.reload}
          >
            <div className="max-h-[260px] overflow-y-auto pr-1">
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-[10px] uppercase text-tertiary">
                  <tr>
                    <th className="pb-1.5 font-normal">{t("势力")}</th>
                    <th className="pb-1.5 font-normal">{t("舰队")}</th>
                    <th className="pb-1.5 font-normal">{t("角色")}</th>
                    <th className="pb-1.5 font-normal">{t("舰船")}</th>
                    <th className="pb-1.5 font-normal">{t("位置")}</th>
                  </tr>
                </thead>
                <tbody>
                  {fleets.slice(0, 60).map((row) => (
                    <tr key={row.fleetID} className="border-t border-border/60">
                      <td className="py-1 pr-2">
                        <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                      </td>
                      <td className="py-1 pr-2 max-w-[130px] truncate text-foreground">{row.name}</td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        {labelOf(FLEET_ROLE_LABEL, row.role, t)}
                      </td>
                      <td className="py-1 pr-2 tabular text-muted-foreground">
                        {row.ships}/{row.total}
                      </td>
                      <td className="py-1 max-w-[180px] truncate text-muted-foreground">
                        {row.whereLabel ?? row.place?.systemName ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PanelState>
        </Panel>
      </div>

      <div className="text-[11px] text-tertiary">
        {t("星图布局来自面板（{layout}），舰队位置每 10 秒刷新一次", {
          layout: mapResource.data ? StarLayoutLabel(mapResource.data, t) : "—",
        })}
      </div>
    </div>
  )
}

/** 布局来源：模组用 SDE 坐标（sde-2d）或自己算的坐标 */
function StarLayoutLabel(raw: StarmapRaw & { layout?: string }, t: (source: string) => string): string {
  return t(raw.layout === "sde-2d" ? "SDE 坐标" : "面板布局")
}
