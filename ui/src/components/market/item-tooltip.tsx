import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  Cpu,
  Crosshair,
  FileCode2,
  Gem,
  Layers,
  Package,
  Palette,
  Radar,
  Rocket,
  Shield,
  Shirt,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react"

import { EmptyHint } from "@/components/commands/command-shared"
import { useLocale } from "@/components/shell/locale-provider"
import type { RawMarketTypeInfo, RawMarketTypeInfoAttr } from "@/lib/ipc"
import {
  attributeSections,
  formatAttrNumber,
  formatAttrValue,
  tooltipPlan,
  SECTION_SENSOR,
  type TypeInfoDefence,
  type TypeInfoSectionView,
} from "@/lib/type-info-logic"
import { cn } from "@/lib/utils"

/** 悬停多久出卡：与 App.tsx 那个全局 TooltipProvider 的 180 ms 观感一致 */
const HOVER_DELAY = 180
/** 卡片相对光标的偏移 */
const CURSOR_GAP = 16
/** 卡片离窗口边缘至少留这么多空白 */
const VIEWPORT_MARGIN = 12

type Icon = ComponentType<{ className?: string }>

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
 * 右栏「简介 / 属性」页签：按客户端的「属性」面板排版 —— 每个分区一张卡片，
 * 标题栏是「图标 + 分区名」，护盾 / 装甲 / 结构 再给一行「有效 HP」与四抗色块，
 * 属性行是「图标 + 名字 + 右对齐的值」。整段可折叠（点标题栏）。
 *
 * 分区顺序、有效 HP 算法与标题都在 type-info-logic 里，这里只画。
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

  const description = (info.description ?? "").trim()
  const attributeRows = sections.reduce((sum, section) => sum + section.rows.length, 0)
  if (!description && attributeRows === 0) {
    return (
      <div className={cn("p-3", className)}>
        <EmptyHint text={t("这个物品没有简介与属性数据")} />
      </div>
    )
  }

  return (
    <div className={cn("space-y-2 p-3", className)}>
      {description ? (
        <div className="rounded-md border border-input bg-background/40 px-2.5 py-2">
          <div className="panel-label">{t("物品简介")}</div>
          <p
            data-i18n-skip
            className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90"
          >
            {description}
          </p>
        </div>
      ) : null}
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
  )
}

/** 一个属性分区：标题栏（可折叠）+ 四抗 / 属性行 */
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
  return (
    <section className="overflow-hidden rounded-md border border-input bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 border-b border-input/60 bg-muted/20 px-2 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <Icon className="size-3.5 shrink-0 text-primary" />
        {/* 分区名是界面文案（护盾 / 装甲…）走翻译桥；SDE 那个英文分类名查不到就原样显示 */}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-primary">
          {section.title}
        </span>
        {section.defence ? (
          <span className="tabular shrink-0 text-[10px] text-tertiary">
            {t("有效 HP：{value}", { value: formatAttrNumber(section.defence.effective) })}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-tertiary transition-transform",
            folded ? "" : "rotate-180"
          )}
        />
      </button>
      {folded ? null : section.defence ? <ResistStrip defence={section.defence} /> : null}
      {folded ? null : (
        <div className="divide-y divide-input/30">
          {section.rows.map((attr) => (
            <div key={attr.id} className="flex items-baseline gap-2 px-2 py-[3px]">
              <Icon className="size-3 shrink-0 translate-y-[1px] text-tertiary/60" />
              <span
                data-i18n-skip
                className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              >
                {attr.name}
              </span>
              <span data-i18n-skip className="tabular shrink-0 text-[11px] text-foreground">
                {formatAttrValue(attr)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** 四抗一行：色块 + 百分比；指针停在色块上给出这条抗性的 SDE 全名（护盾电磁伤害抗性…） */
function ResistStrip({ defence }: { defence: TypeInfoDefence }) {
  return (
    <div className="flex items-center gap-3 border-b border-input/60 px-2 py-1">
      {defence.resists.map((resist, index) => (
        <span key={resist.id} title={resist.name} className="flex items-center gap-1">
          <span
            className="size-2 rounded-[2px]"
            style={{ background: DAMAGE_COLORS[index % DAMAGE_COLORS.length] }}
          />
          <span data-i18n-skip className="tabular text-[10px] text-foreground">
            {formatAttrNumber(Math.round(resist.percent)) + "%"}
          </span>
        </span>
      ))}
    </div>
  )
}
