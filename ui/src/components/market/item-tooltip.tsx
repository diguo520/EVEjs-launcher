import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import {
  BatteryCharging,
  Bomb,
  BookOpen,
  Bot,
  Box,
  Boxes,
  Brain,
  ChevronDown,
  ChevronsRight,
  Cpu,
  Crosshair,
  FileCode2,
  Flame,
  Gem,
  Layers,
  Magnet,
  Orbit,
  Package,
  Palette,
  Radar,
  Radio,
  Rocket,
  Shield,
  Shirt,
  Sparkles,
  Target,
  Wrench,
  Zap,
} from "lucide-react"

import { EmptyHint } from "@/components/commands/command-shared"
import { useLocale } from "@/components/shell/locale-provider"
import type { RawMarketTypeInfo, RawMarketTypeInfoAttr } from "@/lib/ipc"
import {
  attributeSections,
  damageAttrSlot,
  formatAttrNumber,
  formatAttrValue,
  tooltipPlan,
  SENSOR_ATTR_ORDER,
  SECTION_SENSOR,
  type TypeInfoDefence,
  type TypeInfoQuad,
  type TypeInfoSectionView,
} from "@/lib/type-info-logic"
import { cn } from "@/lib/utils"

/** 悬停多久出卡：与 App.tsx 那个全局 TooltipProvider 的 180 ms 观感一致 */
const HOVER_DELAY = 180
/** 卡片相对光标的偏移 */
const CURSOR_GAP = 16
/** 卡片离窗口边缘至少留这么多空白 */
const VIEWPORT_MARGIN = 12

/** 图标组件：lucide 的图标只吃 className 与 style（四抗要按伤害类型上色） */
type Icon = ComponentType<{ className?: string; style?: CSSProperties }>

/**
 * 分区图标：SDE 里每个属性只有 iconID，图标本体在客户端资源包里，启动器拿不到 ——
 * 按分区挑一个形状相近的图标顶上（游戏里每行一个小图标，这里整段共用一个）。
 */
const SECTION_ICON: Record<number, Icon> = {
  1: Wrench, // Fitting
  2: Shield, // 护盾
  3: Layers, // 装甲
  4: Box, // 结构
  5: BatteryCharging, // 电容器
  6: Crosshair, // 目标锁定系统
  10: Bot, // 无人机
  17: Rocket, // 导航
  36: Zap, // 电子抗性
  37: Sparkles, // 加成
  40: Package, // 仓库
  // 装备 / 无人机 / 舰载机那几段：以前都落进 Boxes 那个通用方块，一眼看不出差别
  20: Radio, // 远程协助
  21: Palette, // 目标标记
  22: BatteryCharging, // 能量中和
  24: Radar, // 感应抑阻
  25: Magnet, // 目标干扰
  26: Target, // 跟踪干扰
  27: Orbit, // 跃迁扰频
  28: Orbit, // 停滞缠绕
  29: Target, // 炮台
  30: Rocket, // 导弹
  34: Bot, // 舰载机能力
  38: Bot, // 舰载机属性
  39: Bomb, // 超级武器
  51: Gem, // 采矿
  52: Flame, // 过热
  [SECTION_SENSOR]: Radar, // 感应强度
}

/**
 * 悬停卡缩略图里的类别图标：客户端画的是物品图片（也在资源包里），这里按 SDE 物品
 * 类别挑一个近义图标；认不出的类别用市场清单里那个包裹图标，与列表保持一致。
 */
const CATEGORY_ICON: Record<number, Icon> = {
  4: Gem, // 材料（矿石 / 矿物）
  6: Rocket, // 舰船
  7: Cpu, // 装备
  8: Bomb, // 弹药
  9: FileCode2, // 蓝图
  16: BookOpen, // 技能
  17: Boxes, // 常用物品
  18: Bot, // 无人机
  20: Brain, // 植入体
  25: Gem, // 小行星
  30: Shirt, // 服饰
  87: Rocket, // 铁骑舰载机
  91: Palette, // 涂装
}

/** 四抗色块：电磁蓝 / 热能红 / 动能灰 / 爆炸橙 —— 与伤害类型一一对应 */
const DAMAGE_COLORS = ["#4a9fe0", "#e05a5a", "#9aa4b2", "#e09a4a"]

/**
 * 爆炸伤害的图标：客户端那个「中心炸开、四周一排尖角」的星爆。lucide 里没有对应的 ——
 * 最接近的 Sparkles 是两个四角闪光，12px 下看着像撒了把星星，不像爆炸（实测反馈过）。
 * 所以手画一个 8 角星爆：外径 10.4 / 内径 4.3（尖角够长、又不至于细成一根针），
 * 用 currentColor 填充，跟另外三个图标一样吃 DAMAGE_COLORS 的配色。
 */
function BurstIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 1.6 13.65 8.03 19.35 4.65 15.97 10.35 22.4 12 15.97 13.65 19.35 19.35 13.65 15.97 12 22.4 10.35 15.97 4.65 19.35 8.03 13.65 1.6 12 8.03 10.35 4.65 4.65 10.35 8.03Z" />
    </svg>
  )
}

/** 四抗图标：电磁（电）/ 热能（火）/ 动能（动力）/ 爆炸（爆），与 DAMAGE_COLORS 同序 */
const DAMAGE_ICONS: Icon[] = [Zap, Flame, ChevronsRight, BurstIcon]

/** 四格感应强度的图标：雷达 / 光雷达 / 磁力 / 引力，与 SENSOR_ATTR_ORDER 一一对应 */
const SENSOR_ICONS: Icon[] = [Radar, Radio, Magnet, Orbit]

const sectionIcon = (id: number): Icon => SECTION_ICON[id] ?? Boxes

/**
 * 中栏清单里一行的悬停卡：照客户端那张物品提示排版 —— 左边缩略图与名字，
 * 下面是技能加成 / 特有加成（「拦截舰操作每升一级：15% 护盾值加成」），
 * 再往下才是简介与前几条属性。
 *
 * 卡片出现在光标右下角并跟着光标走（跟随按帧节流），所以不能用 Radix 的锚点定位 ——
 * 这里自己追 mousemove，再用 createPortal 挂到 body 上做 fixed 定位；贴边时自动翻到
 * 光标另一侧，不会被窗口切掉。卡片自身 pointer-events: none，不会把鼠标从行上抢走；
 * 键盘 Tab 聚焦到行上时按行框右下角当锚点，立刻打开。
 *
 * 简介与加成来自 `market:typeInfo`（侧车扫 SDE 折出来的索引，常驻启动器内存）。
 * 悬停是毫秒级交互，所以**只在卡片第一次打开时才发 IPC**，之后同一物品吃缓存
 * （缓存按界面语言失效，见 use-market.ts）。名字 / 价格 / 体积清单里本来就有，
 * 先画出来，简介与属性到了再补 —— 卡片不会先空着。
 */
export function ItemTooltip({
  typeId,
  name,
  sub,
  price,
  volume,
  catId,
  group,
  load,
  children,
}: {
  typeId: number
  /** 正行：按界面语言取的名字 */
  name: string
  /** 副行：另一个语言的名字（同名或没有时为空） */
  sub: string
  /** 最优卖价（与清单那一列同一份数据） */
  price: string
  /** 体积（SDE） */
  volume: number
  /** SDE 物品类别 id：只用来给缩略图挑图标 */
  catId: number
  /** 物品组名（如「拦截舰」）：缩略图的悬停说明，也顺便告诉用户这是什么 */
  group: string
  /** 取简介与属性；同语言的重复调用由缓存挡掉 */
  load: (typeId: number) => Promise<RawMarketTypeInfo | null>
  children: ReactNode
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  // 光标位置：没打开时只写 ref（不触发渲染），打开后按帧节流写进 state 让卡片跟着走
  const [point, setPoint] = useState({ x: 0, y: 0 })
  const pointRef = useRef({ x: 0, y: 0 })
  const suppressRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  // 卡片实测尺寸：算贴边翻转用；尺寸没变就返回原对象，免得每帧重渲染
  const [size, setSize] = useState({ w: 0, h: 0 })
  // 存「哪个物品的答案」而不是一个 loading 布尔：晚到的回包自己带上 typeId，
  // 用户已经扫到下一行时旧包自然不算数，不用在 effect 里同步写一次状态
  const [answer, setAnswer] = useState<{
    typeId: number
    info: RawMarketTypeInfo | null
  } | null>(null)

  // 卸载时把挂起的一次性任务收干净
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    },
    []
  )

  // 打开才拉：挂在 60 行上一起发 60 条 IPC 是要出事的
  useEffect(() => {
    if (!open) return
    let alive = true
    void load(typeId).then((reply) => {
      if (!alive) return
      setAnswer({ typeId, info: reply })
    })
    return () => {
      alive = false
    }
  }, [open, typeId, load])

  // 卡片会从「正在读取 SDE…」长成加成 / 简介 / 属性，尺寸一变就得重算一次贴边
  useLayoutEffect(() => {
    if (!open) return
    const el = cardRef.current
    if (!el) return
    const sync = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    sync()
    window.addEventListener("resize", sync)
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", sync)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [open])

  const hide = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setOpen(false)
  }

  // 点一下行（选中物品）就把卡收掉；手没离开这一行之前不再弹回来
  const dismiss = () => {
    suppressRef.current = true
    hide()
  }

  // 移出行：收起并解除「刚点过」的抑制
  const leave = () => {
    suppressRef.current = false
    hide()
  }

  const track = (event: { clientX: number; clientY: number }) => {
    pointRef.current = { x: event.clientX, y: event.clientY }
    if (open) {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        setPoint(pointRef.current)
      })
      return
    }
    if (suppressRef.current) return
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setPoint(pointRef.current)
      setOpen(true)
    }, HOVER_DELAY)
  }

  // 键盘 Tab 到行上时没有光标位置，拿行框右下角当锚点，立刻开
  const trackFocus = (event: { target: EventTarget | null }) => {
    if (suppressRef.current) return
    const el = event.target as HTMLElement | null
    if (!el || typeof el.getBoundingClientRect !== "function") return
    const rect = el.getBoundingClientRect()
    pointRef.current = { x: rect.right, y: rect.bottom }
    setPoint(pointRef.current)
    setOpen(true)
  }

  // 贴边翻转再夹取：右下角放不下就翻到光标左上角，最后夹回窗口内
  let left = point.x + CURSOR_GAP
  let top = point.y + CURSOR_GAP
  if (size.w > 0 && left + size.w > window.innerWidth - VIEWPORT_MARGIN) {
    left = point.x - size.w - CURSOR_GAP
  }
  if (size.h > 0 && top + size.h > window.innerHeight - VIEWPORT_MARGIN) {
    top = point.y - size.h - CURSOR_GAP
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - size.w - VIEWPORT_MARGIN))
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - size.h - VIEWPORT_MARGIN))

  const settled = answer !== null && answer.typeId === typeId
  const info = settled ? answer.info : null
  const waiting = open && !settled
  const plan = tooltipPlan(info)
  const Glyph = CATEGORY_ICON[catId] ?? Package

  return (
    <>
      {/* display: contents 的壳只为收事件，不参与布局 */}
      <div
        className="contents"
        onMouseEnter={track}
        onMouseMove={track}
        onMouseLeave={leave}
        onPointerDown={dismiss}
        onFocus={trackFocus}
        onBlur={hide}
      >
        {children}
      </div>
      {open
        ? createPortal(
            <div
              ref={cardRef}
              role="tooltip"
              style={{ left, top }}
              className="pointer-events-none fixed z-50 w-[19rem] max-w-[calc(100vw-24px)] animate-in space-y-1.5 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-md fade-in-0 zoom-in-95"
            >
              <div className="flex items-start gap-2">
                <span
                  title={group || undefined}
                  className="grid size-12 shrink-0 place-items-center rounded-sm border border-input/70 bg-black/30 text-tertiary"
                >
                  <Glyph className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    data-i18n-skip
                    className="block truncate text-[13px] font-semibold text-foreground"
                  >
                    {name}
                  </span>
                  <span data-i18n-skip className="tabular block truncate text-[10px] text-tertiary">
                    {sub ? typeId + " · " + sub : typeId}
                  </span>
                  <span className="mt-0.5 block truncate">
                    <span data-i18n-skip className="tabular font-semibold text-success">
                      {price}
                    </span>
                    <span className="ml-1 text-[10px] text-tertiary">{t("最优卖价")}</span>
                    <span className="ml-2 text-[10px] text-tertiary">{t("体积")}</span>
                    <span data-i18n-skip className="tabular ml-1 text-[10px] text-foreground">
                      {volume.toLocaleString("en-US")}
                    </span>
                  </span>
                </span>
              </div>

              {plan.bonuses.length > 0 ? (
                <div className="space-y-1 border-t border-input/60 pt-1.5">
                  {plan.bonuses.map((section, index) => (
                    <div key={index}>
                      <div className="text-[11px] font-semibold text-primary">
                        {section.role
                          ? t("特有加成：")
                          : t("{skill}每升一级：", { skill: section.skill || t("技能加成：") })}
                      </div>
                      <ul className="mt-0.5 space-y-0.5">
                        {section.entries.map((entry, at) => (
                          <li key={at} className="flex items-baseline gap-2 pl-2">
                            <span
                              className={cn(
                                "w-9 shrink-0 text-right",
                                entry.value ? "tabular font-semibold text-foreground" : "text-tertiary"
                              )}
                            >
                              {entry.value ?? "•"}
                            </span>
                            <span data-i18n-skip className="min-w-0 flex-1 text-foreground/90">
                              {entry.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}

              {waiting ? (
                <div className="border-t border-input/60 pt-1.5 text-[10px] text-tertiary">
                  {t("正在读取 SDE…")}
                </div>
              ) : info === null || info.ok !== true ? (
                <div className="border-t border-input/60 pt-1.5 text-[10px] text-warning">
                  {t(info?.reason || "读不到物品简介与属性")}
                </div>
              ) : (
                <>
                  {plan.description ? (
                    <div className="border-t border-input/60 pt-1.5">
                      <div className="panel-label">{t("物品简介")}</div>
                      <p data-i18n-skip className="mt-0.5 text-foreground/90">
                        {plan.description}
                      </p>
                    </div>
                  ) : null}
                  {plan.attributes.length > 0 ? (
                    <div className="border-t border-input/60 pt-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="panel-label">{t("属性")}</span>
                        <span className="tabular text-[10px] text-tertiary">
                          {t("共 {count} 项", { count: plan.total })}
                        </span>
                      </div>
                      <div className="mt-0.5 space-y-0.5">
                        {plan.attributes.map((attr) => (
                          <AttributeRow key={attr.id} attr={attr} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {!plan.description &&
                  plan.attributes.length === 0 &&
                  plan.bonuses.length === 0 ? (
                    <div className="border-t border-input/60 pt-1.5 text-[10px] text-tertiary">
                      {t("这个物品没有简介与属性数据")}
                    </div>
                  ) : null}
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/** 属性名与值是数据（SDE 已按语言本地化），必须跳过翻译桥 */
function AttributeRow({ attr }: { attr: RawMarketTypeInfoAttr }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span data-i18n-skip className="min-w-0 flex-1 truncate text-tertiary">
        {attr.name}
      </span>
      <span data-i18n-skip className="tabular shrink-0 text-foreground">
        {formatAttrValue(attr)}
      </span>
    </div>
  )
}

/**
 * 右栏「属性」页签：照客户端「属性」面板排版 —— 整段是一张长表，每个分区一条标题带
 * （图标 + 分区名 + 右侧概要 + 折叠箭头），下面接属性行（图标 + 名字 + 右对齐的值）。
 *
 * 三种分区在属性行之外还有一行：
 *   - 护盾 / 装甲 / 结构：标题带右侧给「有效 HP」，下面一条四抗色块；
 *   - 导航：标题带右侧给「朝向时间」；
 *   - 感应强度：四格读数（雷达 / 光雷达 / 磁力 / 引力），没填的那几格留「—」。
 *
 * 分区顺序、有效 HP 与朝向时间的算法都在 type-info-logic 里，这里只画。
 * 物品简介不在这里 —— 它挪到右栏标题栏那个书页图标上，点开是弹窗。
 */
export function TypeInfoPanel({
  info,
  loading,
  className,
}: {
  info: RawMarketTypeInfo | null
  loading: boolean
  className?: string
}) {
  const { t } = useLocale()
  const sections = useMemo(
    () => attributeSections(info?.attributes, info?.categories),
    [info]
  )
  const [folded, setFolded] = useState<number[]>([])

  if (loading && !info) {
    return (
      <div className={cn("p-3", className)}>
        <div className="rounded-md border border-input bg-background/40 px-4 py-6 text-center text-[12px] text-tertiary">
          {t("正在读取 SDE…")}
        </div>
      </div>
    )
  }
  if (!info || info.ok !== true) {
    return (
      <div className={cn("p-3", className)}>
        <EmptyHint text={t(info?.reason || "读不到物品简介与属性")} />
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className={cn("p-3", className)}>
        <EmptyHint text={t("这个物品没有属性数据")} />
      </div>
    )
  }

  return (
    <div className={cn("p-3", className)}>
      <div className="overflow-hidden rounded-md border border-input bg-background/40">
        {sections.map((section) => (
          <SectionCard
            key={section.id}
            section={section}
            folded={folded.includes(section.id)}
            onToggle={() =>
              setFolded((prev) =>
                prev.includes(section.id)
                  ? prev.filter((id) => id !== section.id)
                  : [...prev, section.id]
              )
            }
          />
        ))}
      </div>
    </div>
  )
}

/** 一个属性分区：标题带（可折叠）+ 四抗 / 感应强度 / 属性行 */
function SectionCard({
  section,
  folded,
  onToggle,
}: {
  section: TypeInfoSectionView
  folded: boolean
  onToggle: () => void
}) {
  const { t } = useLocale()
  const Icon = sectionIcon(section.id)
  // 标题带右侧那一小段概要：护盾 / 装甲 / 结构给「有效 HP」，导航给「朝向时间」
  // 「有效 HP」要有值属性才算得出来：装备只有四抗、没有护盾容量 / 装甲值那几条，
  // 那就只画四抗条，读数留空（免得写一个 0 出来）
  const summary = section.defence?.effective != null
    ? t("有效 HP：{value}", { value: formatAttrNumber(section.defence.effective) })
    : section.alignSeconds !== undefined
      ? t("朝向时间：{value}秒", { value: formatAttrNumber(section.alignSeconds) })
      : null
  return (
    <section className="border-b border-input/50 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 bg-muted/25 px-2 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <Icon className="size-3.5 shrink-0 text-tertiary" />
        {/* 分区名是界面文案（护盾 / 装甲…）走翻译桥；SDE 那个英文分类名查不到就原样显示 */}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
          {section.title}
        </span>
        {summary ? <span className="tabular shrink-0 text-[10px] text-tertiary">{summary}</span> : null}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-tertiary transition-transform",
            folded ? "" : "rotate-180"
          )}
        />
      </button>
      {folded ? null : section.defence ? (
        <ResistStrip defence={section.defence} />
      ) : section.id === SECTION_SENSOR ? (
        <SensorStrip rows={section.rows} />
      ) : (
        <div className="py-0.5">
          {section.items.map((item) =>
            item.kind === "quad" ? (
              <QuadRow key={"quad-" + item.quad.label} quad={item.quad} />
            ) : (
              <AttributeLine key={item.attr.id} attr={item.attr} fallback={Icon} />
            )
          )}
        </div>
      )}
    </section>
  )
}

/** 一条属性行：图标 + 名字 + 右对齐的值；伤害量那几条换成对应的伤害类型图标与配色 */
function AttributeLine({ attr, fallback }: { attr: RawMarketTypeInfoAttr; fallback: Icon }) {
  const slot = damageAttrSlot(attr)
  const RowIcon = slot === null ? fallback : DAMAGE_ICONS[slot % DAMAGE_ICONS.length]
  return (
    <div className="flex items-baseline gap-2 px-2 py-[3px]">
      <RowIcon
        className="size-3 shrink-0 translate-y-[1px] text-tertiary/60"
        style={slot === null ? undefined : { color: DAMAGE_COLORS[slot % DAMAGE_COLORS.length] }}
      />
      <span data-i18n-skip className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {attr.name}
      </span>
      <span data-i18n-skip className="tabular shrink-0 text-[11px] text-foreground">
        {formatAttrValue(attr)}
      </span>
    </div>
  )
}

/**
 * 折成一行四格的属性组（伤害 / 伤害抗性加成）：跟客户端一样占两行 —— 上行只有行名
 * （客户端这行不带图标），下行四等分列，电 / 火 / 动 / 爆四个伤害类型各占一列，
 * 列内左对齐「图标 + 值」，这个物品没有的那格照客户端写一个「—」。列宽与上面那条
 * 四抗色块同一套 grid，所以四个伤害类型上下对得齐。
 *
 * 弹药、无人机、炮台的主伤害，以及护盾 / 装甲抗性装备的「伤害抗性加成」在游戏里就是
 * 这么显示的 —— 不是一行一条属性。
 *
 * 行名是界面文案走 `t()`；四格里的值是 SDE 数据，跳过翻译桥。
 */
function QuadRow({ quad }: { quad: TypeInfoQuad }) {
  const { t } = useLocale()
  return (
    <div className="px-2 py-[3px]">
      {/* 整段只有这一行四格时（末日武器、部分弹药）行名由标题带出，这里不再重复一遍 */}
      {quad.only ? null : (
        <div className="text-[11px] text-muted-foreground">{t(quad.label)}</div>
      )}
      <div className={cn("grid grid-cols-4 gap-2", quad.only ? "" : "mt-1")}>
        {quad.cells.map((attr, index) => {
          const CellIcon = DAMAGE_ICONS[index % DAMAGE_ICONS.length]
          return (
            <span key={index} className="flex min-w-0 items-center gap-1">
              <CellIcon
                className="size-3 shrink-0"
                style={{ color: DAMAGE_COLORS[index % DAMAGE_COLORS.length] }}
              />
              <span data-i18n-skip className="tabular truncate text-[10px] text-foreground">
                {attr ? formatAttrValue(attr) : "—"}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 四抗一行：伤害类型图标 + 百分比 + 一条进度条（条长就是抗性百分比），与客户端一致。
 *
 * 指针停在整格上给出这条抗性的 SDE 全名（护盾电磁伤害抗性…）—— 四个图标是近义字形，
 * 光看图标分不出是哪条属性。
 */
function ResistStrip({ defence }: { defence: TypeInfoDefence }) {
  return (
    <div className="grid grid-cols-4 gap-2 border-b border-input/40 px-2 py-1.5">
      {defence.resists.map((resist, index) => {
        // 抗性理论上落在 0-100，但静态表里手改过的值可能越界：夹一下，别让条跑出格子
        const percent = Math.max(0, Math.min(100, Math.round(resist.percent)))
        const color = DAMAGE_COLORS[index % DAMAGE_COLORS.length]
        const Glyph = DAMAGE_ICONS[index % DAMAGE_ICONS.length]
        return (
          <span key={resist.id} title={resist.name} className="flex flex-col gap-1">
            <span className="flex items-center gap-1">
              <Glyph className="size-3 shrink-0" style={{ color }} />
              <span data-i18n-skip className="tabular text-[11px] font-semibold text-foreground">
                {percent}%
              </span>
            </span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full"
                style={{ width: percent + "%", background: color }}
              />
            </span>
          </span>
        )
      })}
    </div>
  )
}

/**
 * 感应强度一行：雷达 / 光雷达 / 磁力 / 引力四格读数，一格一个图标。
 *
 * 服务端静态表里值为 0 的感应强度根本不会列出来（与客户端同一条 displayWhenZero 规则），
 * 所以四格是**按固定顺序补出来的**：查不到的那格写「—」，而不是把剩下几格挤在一起。
 */
function SensorStrip({ rows }: { rows: RawMarketTypeInfoAttr[] }) {
  const byId = new Map(rows.map((attr) => [attr.id, attr]))
  return (
    <div className="grid grid-cols-4 gap-1 border-b border-input/40 px-2 py-1">
      {SENSOR_ATTR_ORDER.map((id, index) => {
        const attr = byId.get(id)
        const Icon = SENSOR_ICONS[index % SENSOR_ICONS.length]
        return (
          <span
            key={id}
            title={attr?.name}
            className="flex items-center justify-center gap-1"
          >
            <Icon className="size-3 shrink-0 text-tertiary/70" />
            <span
              data-i18n-skip
              className={cn(
                "tabular text-[11px]",
                attr ? "font-semibold text-foreground" : "text-tertiary"
              )}
            >
              {attr ? formatAttrValue(attr) : "—"}
            </span>
          </span>
        )
      })}
    </div>
  )
}
