import { useMemo, useState } from "react"
import type { ReactNode } from "react"
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
                />
                <ShipLossTable report={active} shipNames={shipNames} />
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

/** 图 1 的主体：两侧汇总 + 参战方逐行 */
function BattleSummary({
  report,
  battle,
  systemName,
  roster,
  colorByKey,
}: {
  report: BattleReport
  battle: BattleView | undefined
  systemName: string
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const maxValue = Math.max(1, ...report.sides.map((side) => Math.max(side.killValue, side.lostValue)))
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
        {report.sides.map((side) => (
          <div key={side.key} className="rounded border border-border bg-card/60 p-3">
            <div className="flex items-center gap-2">
              <FactionTag name={nameOf(roster, side.key)} color={colorByKey.get(side.key)} />
              {battle?.result?.winner === side.key ? (
                <span className="rounded-sm border border-success/50 px-1 text-[10px] text-success">
                  {t("胜方")}
                </span>
              ) : null}
              <span className="ml-auto tabular text-[11px] text-muted-foreground">
                {t("效率 {n}%", { n: Math.round(side.efficiency * 1000) / 10 })}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Mini label={t("击毁")} value={battleNum(side.kills)} tone={side.kills > 0 ? "success" : "muted"} />
              <Mini
                label={t("承受")}
                value={battleNum(side.lost)}
                tone={side.lost > 0 ? "destructive" : "muted"}
              />
              <Mini label={t("造成 ISK")} value={isk(side.killValue)} tone="foreground" />
              <Mini label={t("承受 ISK")} value={isk(side.lostValue)} tone="destructive" />
            </div>
            <div className="mt-2 space-y-1">
              <MiniBar value={side.killValue} max={maxValue} color={colorByKey.get(side.key)} />
              <div className="flex items-center justify-between text-[10px] text-tertiary">
                <span>{t("造成的损失")}</span>
                <span className="tabular">
                  {t("参战舰队 {n} 支", { n: side.fleets.length })}
                  {side.fleets.length > 0 ? ` · ${side.fleets.map((id) => `#${id}`).join(" ")}` : ""}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-start gap-1.5 text-[10.5px] text-tertiary">
        <Crosshair className="mt-0.5 size-3 shrink-0" />
        {t("模组不记录伤害（没有 DMG/DMG%），也没有飞行员——NPC 势力的作战单位是抽象出来的舰船。")}
      </div>
    </Panel>
  )
}

/** 图 1 下半：按舰型的损失明细 */
function ShipLossTable({
  report,
  shipNames,
}: {
  report: BattleReport
  shipNames: Map<number, string>
}) {
  const { t } = useLocale()
  return (
    <Panel
      tag="// SHIPS"
      title={t("按舰型")}
      meta={t("{n} 型 · 共 {m} 艘", {
        n: report.shipLosses.length,
        m: report.shipLosses.reduce((sum, row) => sum + row.dead, 0),
      })}
    >
      {report.shipLosses.length === 0 ? (
        // 有损失、但一条都没有舰型：那是悬赏没结算（模组只在结算时记 hullTypeID），
        // 跟「这一场没打」是两回事，不能混成一句话。
        <div className="py-6 text-center text-[11.5px] text-tertiary">
          {report.kills.length > 0
            ? t("这一场掉了 {n} 艘，但都没有舰型记录（悬赏没结算）", { n: report.kills.length })
            : t("这一场没有逐舰记录")}
        </div>
      ) : (
        <table className="w-full text-left text-[11.5px]">
          <thead className="text-[10px] uppercase text-tertiary">
            <tr>
              <th className="pb-1.5 pr-2 font-normal">{t("舰型")}</th>
              <th className="pb-1.5 pr-2 font-normal">{t("击毁")}</th>
              <th className="pb-1.5 pr-2 font-normal">{t("价值")}</th>
              <th className="pb-1.5 font-normal">{t("备注")}</th>
            </tr>
          </thead>
          <tbody>
            {report.shipLosses.map((row) => (
              <tr key={row.typeID} className="border-t border-border/60">
                <td className="py-1 pr-2 text-foreground">
                  {shipNames.get(row.typeID) ?? t("类型 #{id}", { id: row.typeID })}
                </td>
                <td className="py-1 pr-2 tabular text-destructive">{row.dead}</td>
                <td className="py-1 pr-2 tabular text-muted-foreground">{isk(row.value)}</td>
                <td className="py-1 text-[10.5px] text-tertiary">
                  {row.unknown > 0 ? t("其中 {n} 艘没有价值记录", { n: row.unknown }) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
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
