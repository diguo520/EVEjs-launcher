import { useMemo } from "react"

import { Panel, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionData, type FactionController } from "@/hooks/use-faction"
import { nameOf, type RosterEntry } from "@/lib/faction-logic"
import { formatIskShort, formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import { FactionTag, MiniBar, PanelState } from "./faction-shared"

interface EconomyPayload {
  now: number
  industry: {
    ores: number
    blueprints: number
    types: number
    structures: number
    rigs: number
    profiles: number
    fits: number
    mining: number
    sde: number
    builtAt: string
  }
  belts: {
    beltID: number
    systemID: number
    name: string
    remainingM3: number
    capacityM3: number
    minedM3: number
    ores: { typeID: number; name: string; remainingM3: number }[]
  }[]
  index: [string, string, string, number][]
  paging: { total: number; page: number; pages: number; size: number }
  tiers: Record<string, number>
}

interface LogisticsOutpost {
  structureID: number
  key: string
  name: string
  systemName: string
  security: number
  stage: string
  state: string
  up: boolean
  unpaid: boolean
  lowPower: boolean
  fuel?: { blocks: number; perHour: number; hoursLeft: number } | null
}

interface LogisticsConvoy {
  fleetID: number
  key: string
  name: string
  templateID: string
  active: number
  ships: number
  capacityM3: number
  freighter: boolean
  systemName: string
  targetName: string | null
  shipmentID: number | null
}

interface LogisticsShipment {
  shipmentID: number
  key: string
  status: string
  fleetID: number | null
  requested: { typeID: number; qty: number; name?: string }[]
  held: { typeID: number; qty: number; name?: string }[]
  reserved: boolean
}

interface LogisticsPayload {
  now: number
  summary: { byFaction?: Record<string, { delivered?: number; queued?: number; moving?: number }> }
  outposts: LogisticsOutpost[]
  convoys: LogisticsConvoy[]
  shipments: LogisticsShipment[]
  purchases: unknown[]
}

/**
 * P4 经济与物流：工业规模 / 经济排行 / 矿带存量 / 前哨与货运。
 *
 * 这两份数据是面板里**最大**的（`/api/economy` 约 250 KB、`/api/logistics` 约 300 KB），
 * 所以刷新间隔明显放宽（45 秒），页签关掉就整条停掉 —— 不像军事页那样 12 秒一刷。
 */
export function FactionEconomy({
  faction,
  roster,
  colorByKey,
}: {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const economy = useFactionData<EconomyPayload>(faction.api, "/api/economy", {
    intervalMs: 45_000,
    enabled: faction.available,
  })
  const logistics = useFactionData<LogisticsPayload>(faction.api, "/api/logistics", {
    intervalMs: 45_000,
    enabled: faction.available,
  })

  const eco = economy.data
  const log = logistics.data

  const ranking = useMemo(() => {
    const rows = (eco?.index ?? []).map((row) => ({
      key: row[0],
      name: row[1],
      tier: row[2],
      value: Number(row[3]) || 0,
    }))
    rows.sort((left, right) => right.value - left.value)
    return rows
  }, [eco?.index])
  const topValue = ranking[0]?.value ?? 0

  const totals = useMemo(() => {
    let delivered = 0
    let queued = 0
    let moving = 0
    for (const item of Object.values(log?.summary.byFaction ?? {})) {
      delivered += item.delivered ?? 0
      queued += item.queued ?? 0
      moving += item.moving ?? 0
    }
    return { delivered, queued, moving }
  }, [log?.summary.byFaction])

  const belts = useMemo(() => {
    const rows = [...(eco?.belts ?? [])]
    rows.sort((left, right) => right.remainingM3 - left.remainingM3)
    return rows
  }, [eco?.belts])

  const outposts = useMemo(() => {
    const rows = [...(log?.outposts ?? [])]
    rows.sort((left, right) => (left.fuel?.hoursLeft ?? 0) - (right.fuel?.hoursLeft ?? 0))
    return rows
  }, [log?.outposts])

  const convoys = useMemo(() => {
    const rows = [...(log?.convoys ?? [])]
    rows.sort((left, right) => right.active - left.active)
    return rows
  }, [log?.convoys])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label={t("矿石")} value={eco?.industry.ores ?? 0} tone="telemetry" />
        <StatTile label={t("蓝图")} value={formatQty(eco?.industry.blueprints ?? 0)} tone="primary" />
        <StatTile label={t("物品")} value={formatQty(eco?.industry.types ?? 0)} tone="foreground" />
        <StatTile label={t("已送达")} value={formatQty(totals.delivered)} tone="success" />
        <StatTile label={t("运输中")} value={formatQty(totals.moving)} tone="warning" />
        <StatTile label={t("待发运单")} value={formatQty(totals.queued)} tone="destructive" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// ECONOMY" title={t("经济排行")} meta={t("共 {n} 家", { n: ranking.length })}>
          <PanelState
            loading={economy.loading && !eco}
            error={economy.error}
            onRetry={economy.reload}
          >
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
              {ranking.slice(0, 20).map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <FactionTag name={row.name} color={colorByKey.get(row.key)} className="w-[110px]" />
                  <MiniBar value={row.value} max={topValue} color={colorByKey.get(row.key)} className="flex-1" />
                  <span className="tabular w-[64px] shrink-0 text-right text-[11px] text-muted-foreground">
                    {formatIskShort(row.value)}
                  </span>
                </div>
              ))}
              {ranking.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有经济数据")}</div>
              ) : null}
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// BELTS" title={t("矿带存量")} meta={t("显示前 {n} 条", { n: belts.length })}>
          <PanelState loading={economy.loading && !eco} error={economy.error} onRetry={economy.reload}>
            <div className="max-h-[320px] overflow-y-auto pr-1">
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-[10px] uppercase text-tertiary">
                  <tr>
                    <th className="pb-1.5 font-normal">{t("矿带")}</th>
                    <th className="pb-1.5 font-normal">{t("剩余")}</th>
                    <th className="pb-1.5 font-normal">{t("矿石")}</th>
                    <th className="pb-1.5 font-normal">{t("主要矿石")}</th>
                  </tr>
                </thead>
                <tbody>
                  {belts.slice(0, 25).map((belt) => {
                    const ratio = belt.capacityM3 > 0 ? belt.remainingM3 / belt.capacityM3 : 0
                    const main = [...(belt.ores ?? [])].sort(
                      (left, right) => right.remainingM3 - left.remainingM3
                    )[0]
                    return (
                      <tr key={belt.beltID} className="border-t border-border/60">
                        <td className="py-1 pr-2 max-w-[190px] truncate text-muted-foreground">{belt.name}</td>
                        <td className="py-1 pr-2">
                          <span className="tabular text-foreground">{Math.round(ratio * 100)}%</span>
                          <span className="ml-1 text-[10px] text-tertiary">
                            {formatQty(Math.round(belt.remainingM3 / 1000))}k
                          </span>
                        </td>
                        <td className="py-1 pr-2 tabular text-muted-foreground">{belt.ores?.length ?? 0}</td>
                        <td className="py-1 max-w-[120px] truncate text-muted-foreground">{main?.name ?? "—"}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {belts.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有矿带数据")}</div>
              ) : null}
            </div>
          </PanelState>
        </Panel>
      </div>

      <Panel tag="// OUTPOSTS" title={t("前哨与建筑")} meta={t("共 {n} 座", { n: outposts.length })}>
        <PanelState loading={logistics.loading && !log} error={logistics.error} onRetry={logistics.reload}>
          <div className="max-h-[280px] overflow-y-auto pr-1">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10px] uppercase text-tertiary">
                <tr>
                  <th className="pb-1.5 font-normal">{t("名称")}</th>
                  <th className="pb-1.5 font-normal">{t("势力")}</th>
                  <th className="pb-1.5 font-normal">{t("星系")}</th>
                  <th className="pb-1.5 font-normal">{t("安保")}</th>
                  <th className="pb-1.5 font-normal">{t("状态")}</th>
                  <th className="pb-1.5 font-normal">{t("燃料")}</th>
                </tr>
              </thead>
              <tbody>
                {outposts.slice(0, 40).map((row) => {
                  const fuel = row.fuel
                  const low = fuel ? fuel.hoursLeft < 24 : false
                  return (
                    <tr key={row.structureID} className="border-t border-border/60">
                      <td className="py-1 pr-2 max-w-[220px] truncate text-foreground">{row.name}</td>
                      <td className="py-1 pr-2">
                        <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                      </td>
                      <td className="py-1 pr-2 max-w-[120px] truncate text-muted-foreground">{row.systemName}</td>
                      <td
                        className={cn(
                          "py-1 pr-2 tabular",
                          row.security < 0 ? "text-destructive" : "text-muted-foreground"
                        )}
                      >
                        {row.security.toFixed(2)}
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        {row.stage}
                        {row.lowPower ? <span className="ml-1 text-warning">{t("低能量")}</span> : null}
                        {row.unpaid ? <span className="ml-1 text-destructive">{t("欠费")}</span> : null}
                      </td>
                      <td className={cn("py-1 tabular", low ? "text-warning" : "text-muted-foreground")}>
                        {fuel ? t("{hours} 小时", { hours: Math.round(fuel.hoursLeft) }) : "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {outposts.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有前哨")}</div>
            ) : null}
          </div>
        </PanelState>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// CONVOYS" title={t("货运舰队")} meta={t("共 {n} 支", { n: convoys.length })}>
          <PanelState loading={logistics.loading && !log} error={logistics.error} onRetry={logistics.reload}>
            <div className="max-h-[300px] overflow-y-auto pr-1">
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-[10px] uppercase text-tertiary">
                  <tr>
                    <th className="pb-1.5 font-normal">{t("舰队")}</th>
                    <th className="pb-1.5 font-normal">{t("势力")}</th>
                    <th className="pb-1.5 font-normal">{t("位置")}</th>
                    <th className="pb-1.5 font-normal">{t("货舱")}</th>
                    <th className="pb-1.5 font-normal">{t("在运")}</th>
                  </tr>
                </thead>
                <tbody>
                  {convoys.slice(0, 30).map((row) => (
                      <tr key={row.fleetID} className="border-t border-border/60">
                        <td className="py-1 pr-2 max-w-[140px] truncate text-foreground">
                          {row.name}
                          {row.freighter ? (
                            <span className="ml-1 text-[10px] text-tertiary">{t("货舰")}</span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-2">
                          <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                        </td>
                        <td className="py-1 pr-2 max-w-[140px] truncate text-muted-foreground">
                          {row.targetName ? `${row.systemName} → ${row.targetName}` : row.systemName}
                        </td>
                        <td className="py-1 pr-2 tabular text-muted-foreground">
                          {formatQty(Math.round(row.capacityM3 / 1000))}k
                        </td>
                        <td className="py-1 tabular text-foreground">
                          {row.active}
                          {row.shipmentID ? (
                            <span className="ml-1 text-tertiary">#{row.shipmentID}</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {convoys.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有货运舰队")}</div>
              ) : null}
            </div>
          </PanelState>
        </Panel>

        <Panel
          tag="// SHIPMENTS"
          title={t("运输单")}
          meta={t("共 {n} 张", { n: log?.shipments?.length ?? 0 })}
        >
          <PanelState loading={logistics.loading && !log} error={logistics.error} onRetry={logistics.reload}>
            <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
              {(log?.shipments ?? []).slice(0, 25).map((row) => {
                const goods = row.requested ?? []
                const first = goods[0]
                const kinds = goods.length
                return (
                  <div key={row.shipmentID} className="rounded border border-border bg-card/60 p-2">
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <FactionTag name={nameOf(roster, row.key)} color={colorByKey.get(row.key)} />
                      <span className="text-tertiary">#{row.shipmentID}</span>
                      <span className="text-muted-foreground">{row.status}</span>
                      {row.fleetID ? (
                        <span className="text-tertiary">{t("舰队 #{id}", { id: row.fleetID })}</span>
                      ) : null}
                      <span className="ml-auto tabular text-tertiary">
                        {t("{n} 种", { n: kinds })}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {first
                        ? `${first.name ?? `#${first.typeID}`} × ${formatQty(first.qty)}${kinds > 1 ? " …" : ""}`
                        : t("空运单")}
                    </div>
                  </div>
                )
              })}
              {(log?.shipments ?? []).length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t("没有运输单")}</div>
              ) : null}
            </div>
          </PanelState>
        </Panel>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-tertiary">
        <span>
          {t("静态数据")}：
          <span className="tabular text-muted-foreground">{eco?.industry.builtAt ?? "—"}</span>
        </span>
        <span>
          {t("结构 {n}", { n: (eco?.industry.structures ?? 0) + (eco?.industry.rigs ?? 0) })}
        </span>
        <span>{t("装配方案 {n}", { n: eco?.industry.fits ?? 0 })}</span>
      </div>
    </div>
  )
}
