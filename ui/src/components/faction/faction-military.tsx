import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import { Panel, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionData, type FactionController } from "@/hooks/use-faction"
import {
  BATTLE_OUTCOME_LABEL,
  FLEET_ROLE_LABEL,
  OP_KIND_LABEL,
  OP_PHASE_LABEL,
  OP_STATUS_LABEL,
  UMBRELLA_STATE_LABEL,
  labelOf,
  nameOf,
  umbrellaBuckets,
  umbrellaRange,
  umbrellaRows,
  type RosterEntry,
  type UmbrellaView,
} from "@/lib/faction-logic"
import { formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import { EventFeed, FactionTag, PanelState, umbrellaToneClass } from "./faction-shared"

interface MilitaryOp {
  opID: number
  key: string
  kind: string
  status: string
  phase: string
  fleetID: number | null
  fleetName: string
  ships: number
  systemName: string | null
  base?: { name?: string; systemName?: string } | null
  target?: { name?: string; systemName?: string } | null
  stops?: { systemID: number; name: string }[] | null
  stopIndex?: number | null
  createdAt: number
}

interface MilitaryBattle {
  battleID: number
  systemID: number
  systemName: string
  status: string
  rounds: number
  highsec: boolean
  siteLabel?: string | null
  startedAt: number
  endedAt?: number | null
  sides?: { key: string; lost: number; lastPower: number; retreated?: boolean }[]
  result?: {
    outcome: string
    winner: string | null
    rounds: number
    lost: Record<string, number>
    durationSeconds: number
  } | null
}

interface Sighting {
  sightingID: number
  key: string
  seenKey: string
  systemName: string
  fleetID: number
  role: string
  ships: number
  strength: number
  seenAt: number
  byFleetID: number
  detail?: { name?: string; by?: string; escortPower?: number } | null
  fresh: boolean
  ageMinutes: number
}

interface MilitaryPayload {
  now: number
  summary: {
    factions: Record<string, { patrols: number; scouts: number; strikes: number; sightings: number; alarms: number }>
    battles: number
    alarms?: { raised: number; answered: number }
    highsec?: { blocked: number; punished: number; ships: number }
    gank?: { plans: number; kills: number; resolved: number }
  }
  ops: MilitaryOp[]
  battles: MilitaryBattle[]
  sightings: Record<string, Sighting[]>
  umbrella: Record<string, UmbrellaView>
}

/**
 * P2 军事：行动 / 交战 / 目击 / 旗舰保护伞 + 实时动态。
 *
 * 「进行中」这个判断跟模组保持一致：`status === "active"`（模组自己的 `STATUS` 字典就是这么分的），
 * 相位名直接用模组 `militaryCommands.js` 的词典，避免同一件事在两处叫两个名字。
 */
export function FactionMilitary({
  faction,
  roster,
  colorByKey,
}: {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const resource = useFactionData<MilitaryPayload>(faction.api, "/api/military", {
    intervalMs: 12_000,
    enabled: faction.available,
  })
  const data = resource.data

  const ops = data?.ops ?? []
  const activeOps = useMemo(() => ops.filter((op) => op.status === "active"), [ops])
  const sightings = useMemo(() => {
    const all: Sighting[] = []
    for (const list of Object.values(data?.sightings ?? {})) all.push(...list)
    all.sort((left, right) => right.seenAt - left.seenAt)
    return all
  }, [data?.sightings])
  const battles = data?.battles ?? []

  const totalSightings = sightings.length
  const totalAlarms = useMemo(
    () => Object.values(data?.summary.factions ?? {}).reduce((sum, item) => sum + item.alarms, 0),
    [data?.summary.factions]
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={t("进行中行动")} value={activeOps.length} tone="primary" delta={t("共 {n} 次", { n: ops.length })} />
        <StatTile label={t("进行中交战")} value={data?.summary.battles ?? 0} tone="destructive" delta={t("近期 {n} 场", { n: battles.length })} />
        <StatTile label={t("目击")} value={formatQty(totalSightings)} tone="warning" />
        <StatTile
          label={t("求援")}
          value={formatQty(totalAlarms)}
          tone="warning"
          delta={data?.summary.alarms ? t("已应答 {n}", { n: data.summary.alarms.answered }) : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// OPERATIONS" title={t("进行中行动")} meta={t("共 {n} 项", { n: activeOps.length })}>
          <PanelState loading={resource.loading && !data} error={resource.error} onRetry={resource.reload}>
            <div className="max-h-[340px] overflow-y-auto pr-1">
              {activeOps.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有进行中的行动")}</div>
              ) : (
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-[10px] uppercase text-tertiary">
                    <tr>
                      <th className="pb-1.5 font-normal">{t("类型")}</th>
                      <th className="pb-1.5 font-normal">{t("势力")}</th>
                      <th className="pb-1.5 font-normal">{t("舰队")}</th>
                      <th className="pb-1.5 font-normal">{t("舰船")}</th>
                      <th className="pb-1.5 font-normal">{t("位置")}</th>
                      <th className="pb-1.5 font-normal">{t("阶段")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeOps.slice(0, 40).map((op) => (
                      <tr key={op.opID} className="border-t border-border/60 align-top">
                        <td className="py-1 pr-2 text-muted-foreground">{labelOf(OP_KIND_LABEL, op.kind, t)}</td>
                        <td className="py-1 pr-2">
                          <FactionTag name={nameOf(roster, op.key)} color={colorByKey.get(op.key)} />
                        </td>
                        <td className="py-1 pr-2 max-w-[130px] truncate text-muted-foreground">{op.fleetName}</td>
                        <td className="py-1 pr-2 tabular text-foreground">{op.ships}</td>
                        <td className="py-1 pr-2 max-w-[150px] truncate text-muted-foreground">
                          {op.systemName ?? nameOf(roster, null)}
                          {op.target?.systemName || op.target?.name ? (
                            <span className="text-tertiary"> → {op.target.systemName ?? op.target.name}</span>
                          ) : null}
                        </td>
                        <td className="py-1 text-muted-foreground">{labelOf(OP_PHASE_LABEL, op.phase, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// LIVE" title={t("势力动态")}>
          <EventFeed
            events={faction.events}
            colorByKey={colorByKey}
            connected={faction.connected}
            streamReason={faction.streamReason}
            className="max-h-[340px]"
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// BATTLES" title={t("近期交战")} meta={t("共 {n} 场", { n: battles.length })}>
          <PanelState loading={resource.loading && !data} error={resource.error} onRetry={resource.reload}>
            <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {battles.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有交战记录")}</div>
              ) : (
                battles.slice(0, 20).map((battle) => {
                  const sides = battle.sides ?? []
                  const outcome = battle.result?.outcome
                  return (
                    <div key={battle.battleID} className="rounded border border-border bg-card/60 p-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                        <span className="text-foreground">{battle.systemName}</span>
                        {battle.highsec ? (
                          <span className="rounded-sm border border-warning/40 px-1 text-[10px] text-warning">
                            {t("高安")}
                          </span>
                        ) : null}
                        <span className="text-tertiary">{labelOf(OP_STATUS_LABEL, battle.status, t)}</span>
                        <span className="ml-auto tabular text-tertiary">
                          {new Date(battle.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        {sides.map((side) => (
                          <span key={side.key} className="inline-flex items-center gap-1">
                            <FactionTag name={nameOf(roster, side.key)} color={colorByKey.get(side.key)} />
                            <span className="tabular text-tertiary">
                              {t("损失 {n}", { n: side.lost })}
                            </span>
                          </span>
                        ))}
                        {outcome ? (
                          <span className="text-warning">{labelOf(BATTLE_OUTCOME_LABEL, outcome, t)}</span>
                        ) : null}
                        {battle.result?.winner ? (
                          <span className="text-success">
                            {t("胜 {name}", { name: nameOf(roster, battle.result.winner) })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// SIGHTINGS" title={t("目击")} meta={t("共 {n} 条", { n: totalSightings })}>
          <PanelState loading={resource.loading && !data} error={resource.error} onRetry={resource.reload}>
            <div className="max-h-[320px] overflow-y-auto pr-1">
              {sightings.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有目击记录")}</div>
              ) : (
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-[10px] uppercase text-tertiary">
                    <tr>
                      <th className="pb-1.5 font-normal">{t("看见")}</th>
                      <th className="pb-1.5 font-normal">{t("由谁发现")}</th>
                      <th className="pb-1.5 font-normal">{t("位置")}</th>
                      <th className="pb-1.5 font-normal">{t("角色")}</th>
                      <th className="pb-1.5 font-normal">{t("舰船")}</th>
                      <th className="pb-1.5 font-normal">{t("战力")}</th>
                      <th className="pb-1.5 font-normal">{t("多久前")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sightings.slice(0, 30).map((row) => (
                      <tr key={row.sightingID} className="border-t border-border/60">
                        <td className="py-1 pr-2">
                          <FactionTag name={nameOf(roster, row.seenKey)} color={colorByKey.get(row.seenKey)} />
                        </td>
                        <td className="py-1 pr-2">
                          <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                        </td>
                        <td className="py-1 pr-2 max-w-[120px] truncate text-muted-foreground">{row.systemName}</td>
                        <td className="py-1 pr-2 text-muted-foreground">{labelOf(FLEET_ROLE_LABEL, row.role, t)}</td>
                        <td className="py-1 pr-2 tabular text-foreground">{row.ships}</td>
                        <td className="py-1 pr-2 tabular text-muted-foreground">{formatQty(row.strength)}</td>
                        <td className="py-1 tabular text-tertiary">{t("{n} 分钟前", { n: row.ageMinutes })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </PanelState>
        </Panel>
      </div>

      <UmbrellaPanel
        record={data?.umbrella}
        roster={roster}
        colorByKey={colorByKey}
        loading={resource.loading && !data}
        error={resource.error}
        onRetry={resource.reload}
      />
    </div>
  )
}

/**
 * 旗舰保护伞：**一张表**，不是卡片墙。
 *
 * 实测 48 家势力全部 `enabled: true`，绝大多数是「待命就绪 / 疲劳 0 分」的同一张卡 ——
 * 铺成卡片没有信息量。这里把每家的关键事实（状态 / 艘数 / 基地 / 疲劳 / 跳跃冷却 /
 * 覆盖星系 / 船体到位数 / 出不了动或上次没去的原因）摊成一行，
 * 并**默认只列需要看一眼的**（参战、冷却、出不了动、上次没去、正在替人待命），
 * 其余折成一行计数，需要时再展开。
 *
 * 状态词与判据见 `faction-logic.ts` 的 UMBRELLA_STATE_LABEL —— 与模组同一套词，
 * 唯一一处刻意不同：模组把「出不了动」也标成待命就绪（它拿 `group.ready` 这个**对象**做真值判断），
 * 这里看 `ready.ok`，并把 `why` 原样写在「原因」列里。
 */
function UmbrellaPanel({
  record,
  roster,
  colorByKey,
  loading,
  error,
  onRetry,
}: {
  record: Record<string, UmbrellaView> | undefined
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  loading: boolean
  error: string
  onRetry: () => void
}) {
  const { t } = useLocale()
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => umbrellaRows(record), [record])
  const { attention, rest } = useMemo(() => umbrellaBuckets(rows), [rows])
  const visible = showAll ? [...attention, ...rest] : attention

  return (
    <Panel
      tag="// UMBRELLA"
      title={t("旗舰保护伞")}
      meta={
        rows.length === 0
          ? t("共 {n} 家", { n: 0 })
          : t("共 {n} 家 · 需要关注 {m} 家", { n: rows.length, m: attention.length })
      }
    >
      <PanelState loading={loading} error={error} onRetry={onRetry}>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有启用保护伞的势力")}</div>
        ) : (
          <>
            {/* 一家都不需要关注时不出空表格（只剩表头很难看），直接给一句话 */}
            {attention.length === 0 && !showAll ? (
              <div className="text-[12px] text-muted-foreground">
                {t("所有旗舰队都待命就绪，没有需要关注的。")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-[10px] uppercase text-tertiary">
                    <tr>
                      <th className="pb-1.5 pr-2 font-normal">{t("势力")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("状态")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("艘数")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("基地")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("疲劳")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("跳跃冷却")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("覆盖星系")}</th>
                      <th className="pb-1.5 pr-2 font-normal">{t("船体")}</th>
                      <th className="pb-1.5 font-normal">{t("原因")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => {
                    const view = record?.[row.key]
                    const note = row.blockedReason
                      ? t("不能出动：{why}", { why: row.blockedReason })
                      : row.lastRefusal
                        ? t("上次没去：{why}", { why: row.lastRefusal })
                        : row.backing
                          ? t("替 {name} 防守待命", { name: row.backing })
                          : row.demand ?? ""
                    return (
                      <tr
                        key={row.key}
                        className="border-t border-border/60 align-top hover:bg-card/60"
                        title={umbrellaRange(view, t)}
                      >
                        <td className="py-1 pr-2">
                          <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                        </td>
                        <td className="py-1 pr-2">
                          <span
                            className={cn(
                              "whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[10px]",
                              umbrellaToneClass(row.state)
                            )}
                          >
                            {labelOf(UMBRELLA_STATE_LABEL, row.state, t)}
                          </span>
                          {row.engagedIn ? (
                            <span className="ml-1 text-[10px] text-destructive">{row.engagedIn}</span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-2 tabular text-foreground">{row.ships}</td>
                        <td className="py-1 pr-2 max-w-[130px] truncate text-muted-foreground">
                          {row.baseName ?? "—"}
                        </td>
                        <td
                          className={cn(
                            "py-1 pr-2 tabular",
                            row.fatigueMinutes > 0 ? "text-warning" : "text-muted-foreground"
                          )}
                        >
                          {row.fatigueMinutes > 0 ? t("{n} 分", { n: row.fatigueMinutes }) : "—"}
                        </td>
                        <td
                          className={cn(
                            "py-1 pr-2 tabular",
                            row.activationMinutes > 0 ? "text-warning" : "text-muted-foreground"
                          )}
                        >
                          {row.activationMinutes > 0 ? t("{n} 分", { n: row.activationMinutes }) : "—"}
                        </td>
                        <td className="py-1 pr-2 tabular text-muted-foreground">{row.coverage}</td>
                        <td className="py-1 pr-2 tabular text-muted-foreground">
                          {row.hullsNeeded > 0 ? `${row.hullsHave} / ${row.hullsNeeded}` : "—"}
                        </td>
                        <td
                          className={cn(
                            "py-1 max-w-[280px] truncate",
                            row.blockedReason || row.lastRefusal ? "text-warning" : "text-tertiary"
                          )}
                        >
                          {note || "—"}
                        </td>
                      </tr>
                    )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {rest.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll((previous) => !previous)}
                className="mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                {showAll ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {showAll
                  ? t("收起 {n} 家", { n: rest.length })
                  : t("另外 {n} 家不需要关注", { n: rest.length })}
              </button>
            ) : null}

          </>
        )}
      </PanelState>
    </Panel>
  )
}
