import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { Crosshair, Skull } from "lucide-react"

import { Panel, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionData } from "@/hooks/use-faction"
import { useManualData } from "@/hooks/use-manual-data"
import { FactionScreen, useFactionShell } from "@/components/faction/faction-shell"
import {
  BATTLE_OUTCOME_LABEL,
  SITE_KIND_LABEL,
  battleOutcomeTone,
  battleReports,
  battleRows,
  formatSimClock,
  labelOf,
  nameOf,
  type BattleReport,
  type BattleSideLosses,
  type BattleSideReport,
  type BattleView,
  type KillRow,
  type RosterEntry,
} from "@/lib/faction-logic"
import { formatIskShort, formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import { FactionTag, MiniBar, PanelState } from "@/components/faction/faction-shared"

interface MilitaryPayload {
  now: number
  battles: BattleView[]
}

const TONE_CLASS: Record<"success" | "warning" | "destructive" | "muted", string> = {
  success: "border-success/50 text-success",
  warning: "border-warning/50 text-warning",
  destructive: "border-destructive/50 text-destructive",
  muted: "border-border text-muted-foreground",
}

/** 相对时间：`12 分钟前` / `3 小时前` / `刚刚` */
function agoText(
  at: number,
  now: number,
  t: (text: string, vars?: Record<string, string | number>) => string
): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes <= 0) return t("刚刚")
  if (minutes < 60) return t("{n} 分钟前", { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t("{n} 小时前", { n: hours })
  return t("{n} 天前", { n: Math.round(hours / 24) })
}

/** 数字读数：战报里 0 是有意义的（一方没掉船），不能像物品市场那样写成「—」 */
function battleNum(value: number): string {
  return value > 0 ? formatQty(value) : "0"
}

function isk(value: number): string {
  return value > 0 ? formatIskShort(value) : "0"
}

/**
 * 双阵营求和自检：两侧分型明细的损失数 / 损失额，必须等于全场那一份。
 *
 * 数据层的 `sideShipLosses` 是**唯一**的展示来源，两侧加起来对不上就说明有损失
 * 掉在了阵营之外 —— 这种账目错乱必须当场暴露，不能靠两张卡各自看起来都"正常"蒙混过去。
 * 抽成纯函数是为了让测试直接对着它断言（组件本身太重，测不了）。
 */
export function sideTotalsCheck(report: BattleReport): {
  ships: number
  value: number
  shipsMatch: boolean
  valueMatch: boolean
} {
  const ships = report.sideShipLosses.reduce((sum, row) => sum + row.lost, 0)
  const value = report.sideShipLosses.reduce((sum, row) => sum + row.lostValue, 0)
  return {
    ships,
    value,
    shipsMatch: ships === report.totalLost,
    valueMatch: value === report.totalValue,
  }
}

/**
 * 阵营卡的展示顺序：损失舰船多的在前，平手比 ISK，再平手比 key。
 * 平手时的兜底比较**不能省** —— 少了它，同分两方会随 Map 迭代顺序换位，界面每刷新一次就翻个面。
 */
export function orderSidesForDisplay(sides: BattleSideReport[]): BattleSideReport[] {
  return [...sides].sort(
    (left, right) =>
      right.lost - left.lost || right.lostValue - left.lostValue || left.key.localeCompare(right.key)
  )
}

/**
 * KM（交战详情）。
 *
 * 两个层次的视图，对应玩家熟悉的两张图：
 *   · **战斗报表**：一场战斗的双方汇总（击毁 / 承受 / ISK 效率 / 参战舰队）、参战方逐行、按舰型的损失明细；
 *   · **单条 KM**：点开一处损失，看被击毁的是哪条船、值多少、谁打掉的、在哪、属不属于整队覆没。
 *
 * 数据来源分两层，都在面板 API 之内：
 *   · `/api/events/stream?group=combat&backlog=500`（Rust 侧订阅后推成 `faction:event`）——**逐舰**记录：
 *     `loss`（谁被打掉 + killer + battleID）与 `killReward`（同一 unitID 的舰型与 ISK），按 unitID 对起来；
 *   · `/api/military` —— 交战的元信息（星系名、结果、回合、时长）。
 *
 * **模组没有的东西就不编**：没有伤害数字（不打伤害明细）、没有飞行员（NPC 单位是抽象舰船）、
 * 没有逐舰装配、也有一部分损失没有悬赏记录（舰型与价值只能留空）。界面上逐条写明。
 */
export function KmPage() {
  const { t } = useLocale()
  // 只要战斗组、回补 500 条：逐舰损失在混合流里太稀疏，不过滤就一条都捞不到
  const shell = useFactionShell({ backlog: 500, group: "combat" })
  const { faction, roster, colorByKey } = shell
  const [selectedBattle, setSelectedBattle] = useState<number | null>(null)
  const [selectedKill, setSelectedKill] = useState<number | null>(null)

  const military = useFactionData<MilitaryPayload>(faction.api, "/api/military", {
    intervalMs: 12_000,
    enabled: faction.available,
  })
  const { rows: items } = useManualData("items")

  const shipNames = useMemo(
    () => new Map(items.map((row) => [Number(row.typeID), row.nameCn] as const)),
    [items]
  )
  const reports = useMemo(() => battleReports(faction.events), [faction.events])
  const meta = useMemo(() => {
    const map = new Map<number, BattleView>()
    for (const battle of military.data?.battles ?? []) {
      if (battle) map.set(Number(battle.battleID), battle)
    }
    return map
  }, [military.data?.battles])
  const settled = useMemo(() => battleRows(military.data?.battles), [military.data?.battles])

  const now = military.data?.now ?? Date.now()
  const active = reports.find((report) => report.battleID === selectedBattle) ?? reports[0] ?? null
  const kill = active?.kills.find((row) => row.id === selectedKill) ?? null

  const kills = reports.reduce((sum, report) => sum + report.totalLost, 0)
  const value = reports.reduce((sum, report) => sum + report.totalValue, 0)
  const lastAt = reports[0]?.lastAt ?? 0
  /** 有交战结算、但没有逐舰记录的场次（多半落在事件流窗口之外） */
  const noDetail = settled.filter((row) => !reports.some((report) => report.battleID === row.battleID))

  const systemNameOf = (systemID: number): string => {
    for (const battle of meta.values()) {
      if (Number(battle.systemID) === systemID && battle.systemName) return battle.systemName
    }
    return `#${systemID}`
  }

  return (
    <FactionScreen title="KM" sub="// KILL & BATTLE LOG" shell={shell} onRefresh={military.reload}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={t("有逐舰记录的战斗")} value={reports.length} tone="primary" />
        <StatTile label={t("击毁舰船")} value={formatQty(kills)} tone="destructive" />
        <StatTile label={t("战损价值")} value={isk(value)} tone="warning" />
        <StatTile
          label={t("最近一场")}
          value={lastAt ? agoText(lastAt, now, t) : "—"}
          tone="telemetry"
          delta={lastAt ? formatSimClock(lastAt) : undefined}
        />
      </div>

      <PanelState loading={military.loading && !military.data} error={military.error} onRetry={military.reload}>
        {reports.length === 0 ? (
          <Panel tag="// BATTLES" title={t("交战记录")}>
            <div className="py-10 text-center text-[12px] text-muted-foreground">
              {t("事件流窗口里还没有逐舰战损记录（面板只回补最近一段）")}
            </div>
          </Panel>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_1fr]">
            <Panel
              tag="// BATTLES"
              title={t("交战记录")}
              meta={t("共 {n} 场", { n: reports.length })}
              className="min-h-0"
            >
              <div className="max-h-[680px] space-y-1.5 overflow-y-auto pr-1">
                {reports.map((report) => (
                  <ReportListItem
                    key={report.battleID}
                    report={report}
                    battle={meta.get(report.battleID)}
                    systemName={systemNameOf(report.systemID)}
                    active={active?.battleID === report.battleID}
                    now={now}
                    roster={roster}
                    colorByKey={colorByKey}
                    onSelect={() => {
                      setSelectedBattle(report.battleID)
                      setSelectedKill(null)
                    }}
                  />
                ))}
              </div>
            </Panel>

            {active ? (
              <div className="space-y-4">
                <BattleSummary
                  report={active}
                  battle={meta.get(active.battleID)}
                  systemName={systemNameOf(active.systemID)}
                  roster={roster}
                  colorByKey={colorByKey}
                  shipNames={shipNames}
                />
                <KillList
                  report={active}
                  shipNames={shipNames}
                  roster={roster}
                  colorByKey={colorByKey}
                  selected={selectedKill}
                  onSelect={setSelectedKill}
                />
                {kill ? (
                  <KillDetail
                    kill={kill}
                    report={active}
                    shipNames={shipNames}
                    systemName={systemNameOf(kill.systemID)}
                    roster={roster}
                    colorByKey={colorByKey}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </PanelState>

      {noDetail.length > 0 ? (
        <div className="text-[11px] text-tertiary">
          {t("另有 {n} 场交战有结算但没有逐舰记录（落在事件流窗口之外）", { n: noDetail.length })}
        </div>
      ) : null}
    </FactionScreen>
  )
}

function ReportListItem({
  report,
  battle,
  systemName,
  active,
  now,
  roster,
  colorByKey,
  onSelect,
}: {
  report: BattleReport
  battle: BattleView | undefined
  systemName: string
  active: boolean
  now: number
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  onSelect: () => void
}) {
  const { t } = useLocale()
  const outcome = battle?.result?.outcome ?? ""
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "block w-full rounded border px-2 py-1.5 text-left transition-colors",
        active ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[12px] text-foreground">{systemName}</span>
        <span className="shrink-0 tabular text-[10px] text-tertiary">#{report.battleID}</span>
        <span className="ml-auto shrink-0 text-[10px] text-tertiary">
          {agoText(report.lastAt, now, t)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {report.sides.map((side) => (
          <span key={side.key} className="inline-flex items-center gap-1">
            <FactionTag name={nameOf(roster, side.key)} color={colorByKey.get(side.key)} />
            <span className={cn("tabular", side.lost > 0 ? "text-destructive" : "text-tertiary")}>
              −{side.lost}
            </span>
          </span>
        ))}
        {outcome ? (
          <span
            className={cn(
              "ml-auto rounded-sm border px-1 py-0.5 text-[10px]",
              TONE_CLASS[battleOutcomeTone(outcome)]
            )}
          >
            {labelOf(BATTLE_OUTCOME_LABEL, outcome, t)}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 tabular text-[10px] text-tertiary">
        {t("{n} 艘 · {isk}", { n: report.totalLost, isk: isk(report.totalValue) })}
      </div>
    </button>
  )
}

/**
 * 图 1 的主体：**双阵营对战**。
 *
 * 上方左右两张阵营卡，各自代表一个参战联盟，卡内自上而下是：
 *   势力色点 + 势力名（+ 胜方徽标）→ 大号损失总额 → 四格统计 → 阵营色进度条 → **本阵营自己**的舰型损失。
 *
 * 两侧顺序按**损失舰船数量**从多到少（平手比 ISK，再平手比 key）：
 * 谁在挨打一眼就看出来，而且平手时有确定的顺序，不会每个 tick 换一次位。
 */
function BattleSummary({
  report,
  battle,
  systemName,
  roster,
  colorByKey,
  shipNames,
}: {
  report: BattleReport
  battle: BattleView | undefined
  systemName: string
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  shipNames: Map<number, string>
}) {
  const { t } = useLocale()
  // 按 key 建索引，**不靠数组顺序对齐**：数据层保证两侧同源，但依赖位置太脆；取不到就退化成空卡。
  const lossesByKey = new Map(report.sideShipLosses.map((row) => [row.key, row] as const))
  const ordered = orderSidesForDisplay(report.sides)
  // 两侧舰型数量之和 == 全场损失船数。数据层保证相等；不等就是有损失没归到任何一方，
  // 界面上要**明说**，而不是把两张卡拼成一个看似圆满的报表。
  const totals = sideTotalsCheck(report)
  const sideLost = totals.ships
  const sideLostValue = totals.value
  const sideMismatch = !totals.shipsMatch || !totals.valueMatch
  const site =
    battle?.siteLabel || (battle?.site?.kind ? labelOf(SITE_KIND_LABEL, battle.site.kind, t) : "")
  const duration = battle?.result?.durationSeconds ?? 0

  return (
    <Panel
      tag="// BATTLE"
      title={systemName}
      meta={[site, t("战斗 #{id}", { id: report.battleID })].filter(Boolean).join(" · ")}
      actions={
        <span className="tabular text-[10px] text-tertiary">
          {formatSimClock(report.firstAt)}
          {duration > 0 ? t(" · {n} 秒", { n: duration }) : ""}
          {battle?.result?.rounds ? t(" · {n} 回合", { n: battle.result.rounds }) : ""}
        </span>
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        {ordered.map((side) => (
          <SideBattleCard
            key={side.key}
            report={report}
            side={side}
            losses={lossesByKey.get(side.key)}
            winner={battle?.result?.winner === side.key}
            color={colorByKey.get(side.key)}
            roster={roster}
            colorByKey={colorByKey}
            shipNames={shipNames}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-tertiary">
        <span className="inline-flex min-w-0 items-start gap-1.5">
          <Crosshair className="mt-0.5 size-3 shrink-0" />
          <span>{t("模组不记录伤害（没有 DMG/DMG%），也没有飞行员——NPC 势力的作战单位是抽象出来的舰船。")}</span>
        </span>
        <span className="tabular">
          {t("两侧合计 {ships} 艘 · {isk}，全场 {total} 艘 · {value}", {
            ships: sideLost,
            isk: isk(sideLostValue),
            total: report.totalLost,
            value: isk(report.totalValue),
          })}
        </span>
        {sideMismatch ? (
          <span className="text-warning">
            {t("侧别合计 {ships} 艘与全场 {total} 艘对不上，有损失没有归到任何一方。", {
              ships: sideLost,
              total: report.totalLost,
            })}
          </span>
        ) : null}
      </div>
    </Panel>
  )
}

/**
 * 单个阵营的对阵卡。
 *
 * 四格读数是这一方的战果：损失舰船 / 损失额 / 造成 ISK / 击杀。
 * 进度条走**舰船损失数量占比**（`lostShare`，0–1），不是 ISK 占比 ——
 * 一条泰坦的 ISK 抵得过几十条护卫，按 ISK 画会把「谁被压着打」画反。
 * 下面那张表是**这一方自己**的舰型损失：两边各看各的，比一张全场混排表更容易看出对位关系。
 *
 * 表里**每一行都是一条明细的入口**：悬停或聚焦某型，浮层里给出这一型在本场里的逐条损失
 * （时间 / 被击毁的舰队 / 谁的功劳 / 这条值多少 / 悬赏实付）。行保留 Tab 焦点，
 * Radix 的 tooltip 在聚焦时同样打开、Esc 关闭 —— 只用鼠标能看的信息等于没做。
 */
function SideBattleCard({
  report,
  side,
  losses,
  winner,
  color,
  roster,
  colorByKey,
  shipNames,
}: {
  report: BattleReport
  side: BattleSideReport
  losses: BattleSideLosses | undefined
  winner: boolean
  color: string | undefined
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  shipNames: Map<number, string>
}) {
  const { t } = useLocale()
  // 用 useMemo 钉住引用：这个数组既进渲染，又是下方明细 useMemo 的依赖，
  // 每次渲染新建一份会让依赖永远变化，React Compiler 会直接放弃优化这个组件。
  const rows = useMemo(() => (losses?.losses ?? []).filter((row) => row.dead > 0), [losses])
  const share = losses?.lostShare ?? 0
  const sharePercent = Math.round(share * 1000) / 10
  const modelCount = rows.reduce((sum, row) => sum + row.dead, 0)
  const unknownRows = rows.filter((row) => row.typeID === null).length
  // 悬停 / 聚焦到某一型时，浮层给的是「这一型在本场里逐条损失」——按 (本阵营, 舰型) 过滤。
  // typeID 为 null 的那一档单独比，不靠 falsy 判断（0 号舰型是合法值）。
  // openKey 记「哪一型开着」（行高亮与 +/- 指示也用它）；
  // anchor 是浮层的锚点 —— 指针在动就用指针坐标，键盘聚焦时没有指针，退回用行的右上角。
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const panelId = useId()
  const details = useMemo(() => {
    const map = new Map<number | null, { kills: KillRow[]; fleetLost: number }>()
    for (const row of rows) {
      const kills = report.kills.filter(
        (kill) => kill.victimKey === side.key && kill.shipTypeID === row.typeID
      )
      // 整队覆没按**这一型**数：同一场里别的舰型被打光，不该算到这一行头上
      map.set(row.typeID, { kills, fleetLost: kills.filter((kill) => kill.fleetLost).length })
    }
    return map
  }, [report, side.key, rows])
  // 浮层只渲染一份：找到当前开着的那一行，内容从这里取
  const openRow = rows.find(
    (row) => (row.typeID === null ? "unknown" : String(row.typeID)) === openKey
  )
  const openDetail = openRow ? details.get(openRow.typeID) : undefined

  return (
    <div className="flex min-w-0 flex-col rounded border border-border bg-card/60 p-3">
      <div className="flex items-center gap-2">
        <FactionTag name={nameOf(roster, side.key)} color={color} />
        {winner ? (
          <span className="shrink-0 rounded-sm border border-success/50 px-1 text-[10px] text-success">
            {t("胜方")}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular text-[10px] text-tertiary">
          {t("效率 {n}%", { n: Math.round(side.efficiency * 1000) / 10 })}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="panel-label">{t("损失总额")}</div>
          <div className="tabular mt-0.5 truncate text-xl font-bold leading-none text-destructive">
            {isk(side.lostValue)}
          </div>
        </div>
        <div className="shrink-0 text-right text-[10px] text-tertiary">
          <div className="tabular">
            {t("参战舰队 {n} 支", { n: side.fleets.length })}
            {side.fleets.length > 0 ? ` · ${side.fleets.map((id) => `#${id}`).join(" ")}` : ""}
          </div>
          <div className="tabular mt-0.5">{t("占双方损失 {n}%", { n: sharePercent })}</div>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini
          label={t("损失舰船")}
          value={battleNum(side.lost)}
          tone={side.lost > 0 ? "destructive" : "muted"}
        />
        <Mini
          label={t("损失额")}
          value={isk(side.lostValue)}
          tone={side.lostValue > 0 ? "destructive" : "muted"}
        />
        <Mini label={t("造成 ISK")} value={isk(side.killValue)} tone="foreground" />
        <Mini
          label={t("击杀")}
          value={battleNum(side.kills)}
          tone={side.kills > 0 ? "success" : "muted"}
        />
      </div>

      <div className="mt-2.5 space-y-1">
        {/* 进度条 = 舰船损失数量占比（0–1），颜色取本阵营的势力色 */}
        <MiniBar value={share} max={1} color={color} />
        <div className="flex items-center justify-between text-[10px] text-tertiary">
          <span>{t("舰船损失数量占比")}</span>
          <span className="tabular">{t("本阵营 {n}%", { n: sharePercent })}</span>
        </div>
      </div>

      <div className="mt-2.5 border-t border-border/60 pt-2">
        <div className="flex items-center gap-2 text-[10px] text-tertiary">
          <span className="uppercase tracking-[0.08em]">{t("本阵营舰型损失")}</span>
          <span className="ml-auto tabular">
            {t("{n} 型 · 共 {m} 艘", { n: rows.length, m: modelCount })}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="py-3 text-center text-[11px] text-tertiary">{t("这一方没有舰船损失")}</div>
        ) : (
          <div className="mt-1 max-h-[240px] overflow-y-auto pr-1">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10px] uppercase text-tertiary">
                <tr>
                  <th className="pb-1 pr-2 font-normal">{t("舰型")}</th>
                  <th className="pb-1 pr-2 text-right font-normal">{t("数量")}</th>
                  <th className="pb-1 pr-2 text-right font-normal">{t("损失数")}</th>
                  <th className="pb-1 text-right font-normal">{t("损失价值")}</th>
                  <th className="w-6 pb-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = row.typeID === null ? "unknown" : String(row.typeID)
                  const open = openKey === key
                  return (
                    <tr
                      key={key}
                      tabIndex={0}
                      aria-describedby={open ? panelId : undefined}
                      onPointerEnter={(event) => {
                        setOpenKey(key)
                        setAnchor({ x: event.clientX, y: event.clientY })
                      }}
                      // 指针移一格就更新一次锚点：浮层跟着鼠标走，不钉在行的一侧
                      onPointerMove={(event) => setAnchor({ x: event.clientX, y: event.clientY })}
                      onPointerLeave={() => {
                        setOpenKey(null)
                        setAnchor(null)
                      }}
                      onFocus={(event) => {
                        // 键盘进来时没有指针坐标，用行的右上角当锚点
                        const rect = event.currentTarget.getBoundingClientRect()
                        setOpenKey(key)
                        setAnchor({ x: rect.right, y: rect.top })
                      }}
                      onBlur={() => {
                        setOpenKey(null)
                        setAnchor(null)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setOpenKey(null)
                          setAnchor(null)
                        }
                      }}
                      className={cn(
                        "border-t border-border/60 outline-none transition-colors",
                        "hover:bg-card/60 focus-visible:bg-primary/10",
                        open && "bg-primary/5"
                      )}
                    >
                        <td className="py-1 pr-2 text-foreground">
                          {row.typeID === null ? (
                            <span className="text-tertiary">{t("未知舰型")}</span>
                          ) : (
                            shipNames.get(row.typeID) ?? t("类型 #{id}", { id: row.typeID })
                          )}
                        </td>
                        <td className="py-1 pr-2 text-right tabular text-muted-foreground">
                          {battleNum(row.dead)}
                        </td>
                        <td className="py-1 pr-2 text-right tabular text-destructive">
                          {row.dead > 0 ? "−" + formatQty(row.dead) : "—"}
                        </td>
                        <td className="py-1 text-right tabular text-destructive">
                          {row.value > 0 ? "−" + formatIskShort(row.value) : "—"}
                          {row.unknown > 0 ? (
                            <span className="ml-1 text-[10px] text-tertiary">
                              {t("（{n} 艘无记录）", { n: row.unknown })}
                            </span>
                          ) : null}
                        </td>
                      <td
                        className="py-1 pl-1 text-right text-[10px] text-tertiary"
                        aria-hidden="true"
                      >
                        {open ? "−" : "+"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {unknownRows > 0 ? (
          <div className="mt-1 text-[10.5px] text-tertiary">
            {t("末行「未知舰型」是悬赏没结算的损失：舰型与价值都取不到，但损失确实发生过。")}
          </div>
        ) : null}
      </div>
      {/* 浮层只渲染一份，位置来自指针坐标 —— 不是每行各挂一个固定位置的弹层 */}
      {openDetail && openRow ? (
        <CursorPanel anchor={anchor} sizeKey={openKey} panelId={panelId}>
          <ShipLossDetail
            sideKey={side.key}
            typeID={openRow.typeID}
            kills={openDetail.kills}
            fleetLost={openDetail.fleetLost}
            roster={roster}
            colorByKey={colorByKey}
            shipTypeName={(id) => shipNames.get(id) ?? t("类型 #{id}", { id })}
          />
        </CursorPanel>
      ) : null}
    </div>
  )
}

/**
 * 跟随指针的浮层容器。
 *
 * Portal 到 body + `position: fixed`，锚点是**指针坐标**而不是触发元素，
 * 所以浮层贴着鼠标走；指针一离开触发行就消失。
 *
 * 三个刻意的选择：
 * - `pointer-events-none`：浮层就贴在指针旁边，若能命中，指针一进浮层就会让触发行
 *   收到 pointerleave，形成「关→开→关」的闪烁；禁用命中测试后指针事件直接穿透。
 * - 贴边翻转：右下放不下就翻到锚点左上，避免被窗口裁掉。
 * - 键盘路径没有指针坐标：调用方用行的右上角当锚点，行为保持一致。
 *   代价是浮层里的表格**不参与滚动命中**（指针和键盘都不行），内容超长应改回行下展开区。
 */
function CursorPanel({
  anchor,
  sizeKey,
  panelId,
  children,
}: {
  anchor: { x: number; y: number } | null
  sizeKey: string | null
  panelId: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  // 量一次尺寸：换一型才重量，指针在行内移动不重量。
  // 放在 layout effect 里 —— 量完引发的那次重渲染发生在浏览器绘制之前，看不到跳动。
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    setSize({ width: rect.width, height: rect.height })
  }, [sizeKey])

  if (!anchor) return null

  const pad = 12
  const gapX = 16
  const gapY = 18
  let left = anchor.x + gapX
  let top = anchor.y + gapY
  if (size) {
    if (left + size.width > window.innerWidth - pad) {
      left = Math.max(pad, anchor.x - size.width - gapX)
    }
    if (top + size.height > window.innerHeight - pad) {
      top = Math.max(pad, anchor.y - size.height - gapY)
    }
  }

  return createPortal(
    <div
      ref={ref}
      id={panelId}
      role="tooltip"
      style={{ position: "fixed", left, top }}
      className="pointer-events-none z-50 w-[380px] max-w-[80vw] rounded-md border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-md"
    >
      {children}
    </div>,
    document.body
  )
}

/**
 * 某一型舰船在**本阵营**的逐条损失（阵营卡里悬停/聚焦一行时，跟着指针弹出的浮层）。
 *
 * 2026-10-13 两次改动记录在此：
 * ① 由「行下展开区」改为浮层 tooltip（用户要求）；
 * ② 浮层由「钉在行的一侧」改为「跟随指针坐标」（用户要求），锚点与翻转见 `CursorPanel`。
 *
 * 取舍：
 * - 保留的：行仍有 `tabIndex`，键盘聚焦同样弹、Esc 可关，内容通过 `aria-describedby` 与行关联。
 * - 付出的：浮层是 `pointer-events-none`，里面的表格不能滚动、也不能用键盘进入
 *   （这是「跟着指针走」的必然代价：可命中的浮层会把指针从触发行上抢走并造成闪烁）。
 *   内容继续变大（超过一屏）时应改回行下展开区。
 * 仍然刻意不把整套 `KillDetail`（Panel 级）搬进来：一个悬停塞一张大面板太重。
 */
function ShipLossDetail({
  sideKey,
  typeID,
  kills,
  fleetLost,
  roster,
  colorByKey,
  shipTypeName,
}: {
  sideKey: string
  typeID: number | null
  kills: KillRow[]
  fleetLost: number
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  shipTypeName: (id: number) => string
}) {
  const { t } = useLocale()
  const value = kills.reduce((sum, row) => sum + row.value, 0)
  const reward = kills.reduce((sum, row) => sum + row.reward, 0)

  return (
    <div className="min-w-[340px]">
      <div className="tabular text-[10px] text-tertiary">
        {t("损失方")} {nameOf(roster, sideKey)} · {t("本场同型损失 {n} 条", { n: kills.length })}
        {kills.length > 0 ? ` · ${t("合计 {isk}", { isk: isk(value) })}` : ""}
        {reward > 0 ? ` · ${t("悬赏实付 {isk}", { isk: isk(reward) })}` : ""}
        {fleetLost > 0 ? ` · ${t("{n} 条整队覆没", { n: fleetLost })}` : ""}
      </div>
      {typeID === null ? (
        <div className="mt-1 text-[10px] text-tertiary">
          {t("这 {n} 条损失的悬赏没有结算，舰型与价值都取不到；它们仍然计入战损。", {
            n: kills.length,
          })}
        </div>
      ) : null}
      <div className="mt-1.5 max-h-[180px] overflow-y-auto pr-1">
        <table className="w-full text-left text-[11px]">
          <thead className="text-[10px] uppercase text-tertiary">
            <tr>
              <th className="pb-1 pr-2 font-normal">{t("时间")}</th>
              <th className="pb-1 pr-2 font-normal">{t("被击毁")}</th>
              <th className="pb-1 pr-2 font-normal">{t("击杀者")}</th>
              <th className="pb-1 pr-2 font-normal">{t("舰型")}</th>
              <th className="pb-1 text-right font-normal">{t("价值")}</th>
            </tr>
          </thead>
          <tbody>
            {kills.map((kill) => (
              <tr key={kill.id} className="border-t border-border/40">
                <td className="py-0.5 pr-2 tabular text-tertiary">{formatSimClock(kill.at)}</td>
                <td className="py-0.5 pr-2">
                  <FactionTag
                    name={nameOf(roster, kill.victimKey)}
                    color={colorByKey.get(kill.victimKey)}
                  />
                  {kill.victimFleetID !== null ? (
                    <span className="ml-1 tabular text-[10px] text-tertiary">#{kill.victimFleetID}</span>
                  ) : null}
                  {kill.fleetLost ? (
                    <span className="ml-1 rounded-sm border border-destructive/50 px-1 text-[10px] text-destructive">
                      {t("整队覆没")}
                    </span>
                  ) : null}
                </td>
                <td className="py-0.5 pr-2">
                  {kill.killerKey ? (
                    <>
                      <FactionTag
                        name={nameOf(roster, kill.killerKey)}
                        color={colorByKey.get(kill.killerKey)}
                      />
                      {kill.killerFleetID !== null ? (
                        <span className="ml-1 tabular text-[10px] text-tertiary">
                          #{kill.killerFleetID}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </td>
                <td className="py-0.5 pr-2 text-muted-foreground">
                  {kill.shipTypeID === null ? (
                    <span className="text-tertiary">{t("未知舰型")}</span>
                  ) : (
                    shipTypeName(kill.shipTypeID)
                  )}
                </td>
                {/* 0 是「没有价值记录」，不是「不值钱」：写「无记录」，不写 0 */}
                <td className="py-0.5 text-right tabular text-muted-foreground">
                  {kill.value > 0 ? (
                    isk(kill.value)
                  ) : (
                    <span className="text-tertiary">{t("无价值记录")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex items-start gap-1.5 text-[10px] text-tertiary">
        <Crosshair className="mt-0.5 size-3 shrink-0" />
        {t("模组只记「谁打掉了谁」：没有伤害分摊、没有最后一击武器、也没有逐舰装配。")}
      </div>
    </div>
  )
}

/** 逐舰 KM 列表：点一条看详情（图 2） */
function KillList({
  report,
  shipNames,
  roster,
  colorByKey,
  selected,
  onSelect,
}: {
  report: BattleReport
  shipNames: Map<number, string>
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  selected: number | null
  onSelect: (id: number) => void
}) {
  const { t } = useLocale()
  return (
    <Panel
      tag="// KILLS"
      title={t("逐舰记录")}
      meta={t("共 {n} 条", { n: report.kills.length })}
    >
      <div className="max-h-[300px] overflow-y-auto pr-1">
        <table className="w-full text-left text-[11.5px]">
          <thead className="text-[10px] uppercase text-tertiary">
            <tr>
              <th className="pb-1.5 pr-2 font-normal">{t("时间")}</th>
              <th className="pb-1.5 pr-2 font-normal">{t("舰型")}</th>
              <th className="pb-1.5 pr-2 font-normal">{t("被击毁")}</th>
              <th className="pb-1.5 pr-2 font-normal">{t("击杀者")}</th>
              <th className="pb-1.5 font-normal">{t("价值")}</th>
            </tr>
          </thead>
          <tbody>
            {report.kills.map((row) => (
              <tr
                key={row.id}
                onClick={() => onSelect(row.id)}
                className={cn(
                  "cursor-pointer border-t border-border/60 transition-colors",
                  selected === row.id ? "bg-primary/5" : "hover:bg-card/60"
                )}
              >
                <td className="py-1 pr-2 tabular text-tertiary">
                  {new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false })}
                </td>
                <td className="py-1 pr-2 text-foreground">
                  {row.shipTypeID === null
                    ? t("未知舰型")
                    : shipNames.get(row.shipTypeID) ?? t("类型 #{id}", { id: row.shipTypeID })}
                  {row.fleetLost ? (
                    <span className="ml-1 rounded-sm border border-destructive/50 px-1 text-[10px] text-destructive">
                      {t("整队覆没")}
                    </span>
                  ) : null}
                </td>
                <td className="py-1 pr-2">
                  <FactionTag name={nameOf(roster, row.victimKey)} color={colorByKey.get(row.victimKey)} />
                  {row.victimFleetID !== null ? (
                    <span className="ml-1 tabular text-[10px] text-tertiary">#{row.victimFleetID}</span>
                  ) : null}
                </td>
                <td className="py-1 pr-2">
                  {row.killerKey ? (
                    <>
                      <FactionTag name={nameOf(roster, row.killerKey)} color={colorByKey.get(row.killerKey)} />
                      {row.killerFleetID !== null ? (
                        <span className="ml-1 tabular text-[10px] text-tertiary">#{row.killerFleetID}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </td>
                <td className="py-1 tabular text-muted-foreground">
                  {row.value > 0 ? isk(row.value) : t("无价值记录")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** 图 2：单条 KM 的详情 */
function KillDetail({
  kill,
  report,
  shipNames,
  systemName,
  roster,
  colorByKey,
}: {
  kill: KillRow
  report: BattleReport
  shipNames: Map<number, string>
  systemName: string
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const ship =
    kill.shipTypeID === null
      ? t("未知舰型")
      : shipNames.get(kill.shipTypeID) ?? t("类型 #{id}", { id: kill.shipTypeID })
  const sameBattle = report.kills.filter((row) => row.id !== kill.id)
  const sameShip = kill.shipTypeID === null ? 0 : report.kills.filter((row) => row.shipTypeID === kill.shipTypeID).length

  return (
    <Panel
      tag="// KILLMAIL"
      title={ship}
      meta={t("损失 #{id}", { id: kill.id })}
      actions={
        <span className="tabular text-[10px] text-tertiary">
          {formatSimClock(kill.at)} · {systemName}
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini
              label={t("舰船价值")}
              value={kill.value > 0 ? isk(kill.value) : t("无记录")}
              tone={kill.value > 0 ? "foreground" : "muted"}
            />
            <Mini label={t("悬赏实付")} value={kill.reward > 0 ? isk(kill.reward) : "—"} tone="warning" />
            <Mini label={t("损失方")} value={nameOf(roster, kill.victimKey)} tone="destructive" />
            <Mini
              label={t("同型损失")}
              value={t("{n} 艘", { n: sameShip })}
              tone={sameShip > 1 ? "destructive" : "muted"}
            />
          </div>
          <div className="space-y-1.5 text-[11.5px]">
            <Row label={t("被击毁")}>
              <FactionTag name={nameOf(roster, kill.victimKey)} color={colorByKey.get(kill.victimKey)} />
              {kill.victimFleetID !== null ? (
                <span className="ml-1 tabular text-tertiary">#{kill.victimFleetID}</span>
              ) : null}
              {kill.fleetLost ? (
                <span className="ml-2 rounded-sm border border-destructive/50 px-1 text-[10px] text-destructive">
                  <Skull className="mr-0.5 inline size-3" />
                  {t("整队覆没")}
                </span>
              ) : null}
            </Row>
            <Row label={t("击杀者")}>
              {kill.killerKey ? (
                <>
                  <FactionTag name={nameOf(roster, kill.killerKey)} color={colorByKey.get(kill.killerKey)} />
                  {kill.killerFleetID !== null ? (
                    <span className="ml-1 tabular text-tertiary">#{kill.killerFleetID}</span>
                  ) : null}
                  {kill.killerKind ? (
                    <span className="ml-2 text-[10px] text-tertiary">{kill.killerKind}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-tertiary">—</span>
              )}
            </Row>
            <Row label={t("星系")}>
              <span className="text-muted-foreground">{systemName}</span>
            </Row>
            <Row label={t("所属战斗")}>
              <span className="tabular text-muted-foreground">#{report.battleID}</span>
              <span className="ml-2 text-[10px] text-tertiary">
                {t("同场还有 {n} 条记录", { n: sameBattle.length })}
              </span>
            </Row>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-tertiary">{t("同一场战斗的其它损失")}</div>
          <div className="mt-1 max-h-[220px] space-y-1 overflow-y-auto pr-1">
            {sameBattle.length === 0 ? (
              <div className="py-4 text-center text-[11px] text-tertiary">{t("这一场只有这一条记录")}</div>
            ) : (
              sameBattle.map((row) => (
                <div key={row.id} className="flex items-center gap-2 text-[11px]">
                  <span className="tabular shrink-0 text-tertiary">
                    {new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {row.shipTypeID === null
                      ? t("未知舰型")
                      : shipNames.get(row.shipTypeID) ?? t("类型 #{id}", { id: row.shipTypeID })}
                  </span>
                  <FactionTag name={nameOf(roster, row.victimKey)} color={colorByKey.get(row.victimKey)} />
                </div>
              ))
            )}
          </div>
          <div className="mt-2 flex items-start gap-1.5 text-[10.5px] text-tertiary">
            <Crosshair className="mt-0.5 size-3 shrink-0" />
            {t("模组不记录逐舰装配与伤害分摊，所以没有装备槽、最后一击武器和伤害占比。")}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function Mini({
  label,
  value,
  tone = "foreground",
}: {
  label: string
  value: string
  tone?: "foreground" | "muted" | "success" | "warning" | "destructive"
}) {
  const toneClass = {
    foreground: "text-foreground",
    muted: "text-muted-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone]
  return (
    <div className="min-w-0">
      <div className="panel-label truncate">{label}</div>
      <div className={cn("tabular mt-0.5 truncate text-[13px] font-semibold", toneClass)}>{value}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-tertiary">
        {label}
      </span>
      <span className="flex min-w-0 flex-wrap items-center">{children}</span>
    </div>
  )
}