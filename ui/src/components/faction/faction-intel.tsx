import { useMemo, useState } from "react"

import { Panel, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionData, type FactionController } from "@/hooks/use-faction"
import {
  OP_KIND_LABEL,
  OP_PHASE_LABEL,
  relationKind,
  relationsFor,
  labelOf,
  nameOf,
  type RelationPair,
  type RosterEntry,
} from "@/lib/faction-logic"
import { formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import { FactionSelect, Field, FactionTag, PanelState, TierChip } from "./faction-shared"

type PickerRow = [string, string, string, string]

interface IntelKnown {
  fleets?: number
  armedFleets?: number
  ships?: number
  strength?: number
  armedStrength?: number
}

interface IntelEnemy {
  key: string
  name: string
  color: string
  relation?: string
  homeSystemName?: string
  jumpsHome?: number
  known?: IntelKnown
}

interface IntelFactionRow {
  key: string
  name: string
  tier: string
  color: string
  homeSystemName?: string
  morale?: number
  fresh?: number
  enemyTotal?: number
  sightings?: unknown[]
}

interface IntelAssetOp {
  opID: number
  kind: string
  status: string
  phase: string
  fleetName?: string
  ships?: number
  systemName?: string
  targetName?: string | null
}

interface IntelPayload {
  now: number
  highsec?: string
  factions: IntelFactionRow[]
  detail?: (IntelFactionRow & { enemies?: IntelEnemy[]; assets?: Record<string, IntelAssetOp[]> }) | null
  picker: PickerRow[]
  paging: { total: number; page: number; pages: number; size: number }
  tiers: Record<string, number>
}

interface ControlPayload {
  now: number
  factions: RosterEntry[]
  rows: { key: string; name: string; color: string; tier: string; paused: boolean }[]
  relations: RelationPair[]
  relFocus: string | null
}

const RELATION_CLASS: Record<string, string> = {
  hostile: "border-destructive/50 text-destructive",
  friendly: "border-success/50 text-success",
  neutral: "border-border text-muted-foreground",
}

/**
 * P3 情报与外交：谁在盯着谁、各家对外关系、以及被关注势力的资产清单。
 *
 * 敌人表来自 `/api/intel` 的 `detail.enemies`（模组已经把「这个势力知道些什么」算好了，
 * 包括跳数和已知兵力），关系表来自 `/api/control?rel=<势力>` —— 两边的口径都由模组定，
 * 启动器只负责排版。
 */
export function FactionIntel({
  faction,
  roster,
  colorByKey,
}: {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const [focus, setFocus] = useState("")

  const intel = useFactionData<IntelPayload>(faction.api, "/api/intel", {
    query: { size: 40, ...(focus ? { f: focus } : {}) },
    intervalMs: 15_000,
    enabled: faction.available,
  })
  const control = useFactionData<ControlPayload>(faction.api, "/api/control", {
    query: { size: 40, ...(focus ? { rel: focus } : {}) },
    intervalMs: 15_000,
    enabled: faction.available,
  })

  const data = intel.data
  const detail = data?.detail ?? null
  const activeKey = focus || detail?.key || data?.factions?.[0]?.key || ""

  const lookup = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>()
    for (const [key, entry] of roster) map.set(key, { name: entry.name, color: entry.color })
    for (const row of data?.factions ?? []) map.set(row.key, { name: row.name, color: row.color })
    for (const row of control.data?.factions ?? []) {
      if (!map.has(row.key)) map.set(row.key, { name: row.name, color: row.color })
    }
    return map
  }, [roster, data?.factions, control.data?.factions])

  const relations = useMemo(
    () => relationsFor(activeKey, control.data?.relations ?? [], lookup),
    [activeKey, control.data?.relations, lookup]
  )
  const enemies = detail?.enemies ?? []
  const assets = useMemo(() => {
    const out: IntelAssetOp[] = []
    for (const list of Object.values(detail?.assets ?? {})) {
      if (Array.isArray(list)) out.push(...list)
    }
    out.sort((left, right) => (left.ships ?? 0) - (right.ships ?? 0))
    return out
  }, [detail?.assets])

  const options = useMemo(() => {
    const rows = data?.picker ?? []
    return rows.map((row) => ({ key: row[0], name: row[1], tier: row[2] }))
  }, [data?.picker])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={t("势力")} value={data?.paging.total ?? options.length} tone="primary" />
        <StatTile
          label={t("当前关注")}
          value={nameOf(roster, activeKey)}
          tone="foreground"
          delta={detail?.homeSystemName ?? undefined}
        />
        <StatTile
          label={t("敌人")}
          value={detail?.enemyTotal ?? enemies.length}
          tone="destructive"
          delta={t("已知 {n}", { n: enemies.length })}
        />
        <StatTile
          label={t("士气")}
          value={detail?.morale != null ? `${Math.round(detail.morale * 100)}%` : "—"}
          tone={(detail?.morale ?? 1) < 0.9 ? "warning" : "success"}
        />
      </div>

      {data?.highsec ? (
        <div className="rounded border border-warning/30 bg-card px-3 py-2 text-[11.5px] text-warning">
          {data.highsec}
        </div>
      ) : null}

      <Panel
        tag="// INTEL"
        title={t("势力情报")}
        meta={t("共 {n} 家", { n: data?.factions?.length ?? 0 })}
        actions={
          <FactionSelect
            value={activeKey}
            onChange={setFocus}
            ariaLabel={t("当前关注")}
            placeholder={t("选择势力")}
            className="w-[180px]"
            options={options.map((item) => ({ value: item.key, label: item.name }))}
          />
        }
      >
        <PanelState
          loading={intel.loading && !data}
          error={intel.error || control.error}
          onRetry={() => {
            intel.reload()
            control.reload()
          }}
        >
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <FactionTag name={detail?.name ?? nameOf(roster, activeKey)} color={detail?.color} />
                {detail?.tier ? <TierChip tier={detail.tier} /> : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Field label={t("战力")} value={formatQty(detail?.fresh ?? 0)} hint={t("情报新鲜度")} />
                <Field label={t("敌人")} value={detail?.enemyTotal ?? 0} tone="destructive" />
                <Field label={t("家园")} value={detail?.homeSystemName ?? "—"} />
                <Field label={t("资产行动")} value={assets.length} />
              </div>

              <div className="mt-3 text-[11px] uppercase tracking-[0.08em] text-tertiary">
                {t("被关注势力的资产")}
              </div>
              <div className="mt-1 max-h-[200px] overflow-y-auto pr-1">
                {assets.length === 0 ? (
                  <div className="py-4 text-center text-[11px] text-tertiary">{t("没有对外行动")}</div>
                ) : (
                  <table className="w-full text-left text-[11.5px]">
                    <tbody>
                      {assets.slice(0, 25).map((op) => (
                        <tr key={op.opID} className="border-t border-border/60">
                          <td className="py-1 pr-2 text-muted-foreground">{labelOf(OP_KIND_LABEL, op.kind, t)}</td>
                          <td className="py-1 pr-2 max-w-[130px] truncate text-foreground">{op.fleetName ?? "—"}</td>
                          <td className="py-1 pr-2 tabular text-muted-foreground">{op.ships ?? 0}</td>
                          <td className="py-1 pr-2 max-w-[120px] truncate text-muted-foreground">
                            {op.systemName ?? op.targetName ?? "—"}
                          </td>
                          <td className="py-1 tabular text-tertiary">{labelOf(OP_PHASE_LABEL, op.phase, t)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-tertiary">
                {t("关系（{n} 条）", { n: relations.length })}
              </div>
              <div className="max-h-[150px] overflow-y-auto pr-1">
                {relations.length === 0 ? (
                  <div className="py-4 text-center text-[11px] text-tertiary">{t("没有关系记录")}</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {relations.map((row) => (
                      <span
                        key={row.key}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]",
                          RELATION_CLASS[relationKind(row.relation)]
                        )}
                      >
                        <span
                          className="inline-block size-1.5 rounded-full"
                          style={{ backgroundColor: row.color }}
                        />
                        {row.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 text-[11px] uppercase tracking-[0.08em] text-tertiary">
                {t("敌人与已知兵力")}
              </div>
              <div className="mt-1 max-h-[220px] overflow-y-auto pr-1">
                {enemies.length === 0 ? (
                  <div className="py-4 text-center text-[11px] text-tertiary">{t("情报里没有敌人")}</div>
                ) : (
                  <table className="w-full text-left text-[11.5px]">
                    <thead className="text-[10px] uppercase text-tertiary">
                      <tr>
                        <th className="pb-1.5 font-normal">{t("势力")}</th>
                        <th className="pb-1.5 font-normal">{t("关系")}</th>
                        <th className="pb-1.5 font-normal">{t("跳数")}</th>
                        <th className="pb-1.5 font-normal">{t("已知舰船")}</th>
                        <th className="pb-1.5 font-normal">{t("已知战力")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enemies.map((enemy) => (
                        <tr key={enemy.key} className="border-t border-border/60">
                          <td className="py-1 pr-2">
                            <FactionTag name={enemy.name} color={enemy.color} />
                          </td>
                          <td className="py-1 pr-2 text-muted-foreground">
                            {labelOf(
                              { hostile: "敌对", friendly: "友好", neutral: "中立" },
                              relationKind(enemy.relation ?? "neutral"),
                              t
                            )}
                          </td>
                          <td className="py-1 pr-2 tabular text-muted-foreground">{enemy.jumpsHome ?? "—"}</td>
                          <td className="py-1 pr-2 tabular text-foreground">
                            {formatQty(enemy.known?.ships ?? 0)}
                          </td>
                          <td className="py-1 tabular text-muted-foreground">
                            {formatQty(enemy.known?.armedStrength ?? enemy.known?.strength ?? 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </PanelState>
      </Panel>

      <Panel tag="// ROSTER" title={t("势力一览")} meta={t("共 {n} 家", { n: data?.paging.total ?? 0 })}>
        <PanelState loading={intel.loading && !data} error={intel.error} onRetry={intel.reload}>
          <div className="max-h-[420px] overflow-y-auto pr-1">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10px] uppercase text-tertiary">
                <tr>
                  <th className="pb-1.5 font-normal">{t("势力")}</th>
                  <th className="pb-1.5 font-normal">{t("层级")}</th>
                  <th className="pb-1.5 font-normal">{t("家园")}</th>
                  <th className="pb-1.5 font-normal">{t("士气")}</th>
                  <th className="pb-1.5 font-normal">{t("敌人")}</th>
                  <th className="pb-1.5 font-normal">{t("目击")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.factions ?? []).map((row) => (
                  <tr key={row.key} className="border-t border-border/60">
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        onClick={() => setFocus(row.key)}
                        className="text-left transition-colors hover:text-primary"
                      >
                        <FactionTag name={row.name} color={colorByKey.get(row.key) ?? row.color} />
                      </button>
                    </td>
                    <td className="py-1 pr-2">
                      <TierChip tier={row.tier} />
                    </td>
                    <td className="py-1 pr-2 max-w-[160px] truncate text-muted-foreground">
                      {row.homeSystemName ?? "—"}
                    </td>
                    <td className="py-1 pr-2 tabular text-muted-foreground">
                      {row.morale != null ? `${Math.round(row.morale * 100)}%` : "—"}
                    </td>
                    <td className="py-1 pr-2 tabular text-destructive">{row.enemyTotal ?? 0}</td>
                    <td className="py-1 tabular text-muted-foreground">{row.sightings?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelState>
      </Panel>

      <div className="text-[11px] text-tertiary">
        {t("面板")}：
        <span className="tabular text-muted-foreground">{faction.probe?.url ?? "—"}</span>
        {control.data?.relFocus ? (
          <span className="ml-3">
            {t("外交焦点")}：<span className="text-muted-foreground">{nameOf(roster, control.data.relFocus)}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
