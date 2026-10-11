import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react"

import { Panel, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionOverview, type FactionController } from "@/hooks/use-faction"
import {
  factionTotals,
  filterFactions,
  formatSimClock,
  formatSpeed,
  formatUptime,
  tierCounts,
  UMBRELLA_STATE_LABEL,
  labelOf,
  umbrellaStateOf,
  type FactionBrief,
  type FactionSort,
} from "@/lib/faction-logic"
import { formatIskShort, formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import {
  EventFeed,
  Field,
  FactionSelect,
  FactionDot,
  Isk,
  MiniBar,
  PanelState,
  TierChip,
  tierLabelOf,
  umbrellaToneClass,
} from "./faction-shared"

const PAGE_SIZE = 24

const SORTS: { id: FactionSort; label: string }[] = [
  { id: "power", label: "战力" },
  { id: "ships", label: "舰船" },
  { id: "money", label: "资金" },
  { id: "territory", label: "领地" },
  { id: "name", label: "名称" },
]

/** 一张势力卡：面板「势力」页那张卡的启动器版本 */
function FactionCard({ item }: { item: FactionBrief }) {
  const { t } = useLocale()
  const fleetRole = useMemo(() => {
    const map = new Map<string, number>()
    for (const role of item.fleets.byRole) map.set(role.role, role.ships)
    return map
  }, [item.fleets.byRole])
  const armed = fleetRole.get("strike") ?? 0
  const umbrella = item.umbrella
  const umbrellaState = umbrella ? umbrellaStateOf(umbrella) : null
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <FactionDot color={item.color} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-foreground">{item.name}</span>
            <TierChip tier={item.tier} />
            {item.paused ? (
              <span className="text-[10px] text-warning">{t("已暂停")}</span>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-tertiary">
            {item.home.systemName} · {item.key}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label={t("战力")} value={formatQty(item.power)} />
        <Field
          label={t("士气")}
          value={`${Math.round(item.morale * 100)}%`}
          tone={item.morale < 0.9 ? "warning" : "default"}
        />
        <Field label={t("资金")} value={<Isk value={item.economy.treasury} />} />
      </div>

      <MiniBar value={item.morale} max={1} color={item.color} />

      <div className="grid grid-cols-3 gap-2">
        <Field
          label={t("舰队")}
          value={`${item.fleets.total}`}
          hint={item.fleets.inFlight > 0 ? t("在飞 {n}", { n: item.fleets.inFlight }) : undefined}
        />
        <Field label={t("舰船")} value={formatQty(item.fleets.ships)} hint={armed > 0 ? t("打击 {n}", { n: armed }) : undefined} />
        <Field label={t("领地")} value={`${item.territory.owned}`} hint={item.territory.front > 0 ? t("前线 {n}", { n: item.territory.front }) : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {/* 旗舰保护伞：模组自己的五个状态词（未启用 / 未组建 / 待命就绪 / 冷却中 / 参战中）；
            未组建时把「手里几艘 / 需要几艘」一并写出来，那正是它为什么还没组起来 */}
        {umbrellaState ? (
          <span
            className={cn(
              "whitespace-nowrap rounded-sm border px-1.5 py-0.5",
              umbrellaToneClass(umbrellaState)
            )}
            title={[umbrella?.baseName, umbrella?.backing].filter(Boolean).join(" · ")}
          >
            {t("旗舰")} {labelOf(UMBRELLA_STATE_LABEL, umbrellaState, t)}
            {umbrellaState === "ready" || umbrellaState === "engaged" || umbrellaState === "cooling"
              ? ` ${umbrella?.ships ?? 0}`
              : ""}
            {umbrella?.engagedIn ? ` · ${umbrella.engagedIn}` : ""}
            {umbrellaState === "none" && (umbrella?.hullsNeeded ?? 0) > 0
              ? ` ${umbrella?.hullsHave ?? 0}/${umbrella?.hullsNeeded}`
              : ""}
          </span>
        ) : null}
        {item.economy.gapCount > 0 ? (
          <span className="rounded-sm border border-warning/40 px-1.5 py-0.5 text-warning">
            {t("库存缺口 {n}", { n: item.economy.gapCount })}
          </span>
        ) : null}
        {item.economy.tight ? (
          <span className="rounded-sm border border-warning/40 px-1.5 py-0.5 text-warning">{t("缺钱")}</span>
        ) : null}
        {item.relationCounts.hostile > 0 ? (
          <span className="rounded-sm border border-destructive/40 px-1.5 py-0.5 text-destructive">
            {t("敌对 {n}", { n: item.relationCounts.hostile })}
          </span>
        ) : null}
        {item.structures.total > 0 ? (
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground">
            {t("建筑 {n}", { n: item.structures.total })}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * P1 总览：推演读数 + 世界近况 + 实时动态 + 势力一览。
 *
 * 读数与卡片都来自 `/api/overview` 一次调用（面板自己就是这么打包的），
 * 所以这一页只有一个轮询，不会出现「几个角标各自不同步」。
 */
export function FactionOverview({ faction }: { faction: FactionController }) {
  const { t } = useLocale()
  const [tier, setTier] = useState("all")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<FactionSort>("power")
  const [page, setPage] = useState(1)

  const resource = useFactionOverview(faction.api, faction.available)
  const overview = resource.data
  const status = faction.probe?.status ?? null
  const factionList = overview?.factions ?? []

  const colorByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of factionList) map.set(item.key, item.color)
    return map
  }, [factionList])

  const totals = useMemo(() => factionTotals(factionList), [factionList])
  const filtered = useMemo(
    () => filterFactions(factionList, { tier, query, sort }),
    [factionList, tier, query, sort]
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const slice = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  const alerts = overview?.alerts ?? []
  const badAlerts = alerts.filter((item) => item.level === "bad")
  const otherAlerts = alerts.filter((item) => item.level !== "bad")

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={t("推演时钟")}
          value={formatSimClock(status?.now ?? overview?.now ?? 0)}
          delta={
            <span className={status?.paused ? "text-warning" : "text-success"}>
              {status?.paused ? t("已暂停") : t("运行中")}
            </span>
          }
        />
        <StatTile
          label={t("倍速")}
          value={formatSpeed(status?.speed ?? overview?.speed ?? 0)}
          tone="foreground"
          delta={overview ? t("运行 {time}", { time: formatUptime(overview.uptimeMs) }) : undefined}
        />
        <StatTile
          label={t("危险")}
          value={status?.alertCounts.bad ?? overview?.alertCounts.bad ?? 0}
          tone="destructive"
          delta={badAlerts[0]?.text ? <span className="line-clamp-1">{badAlerts[0].text}</span> : undefined}
        />
        <StatTile
          label={t("注意")}
          value={status?.alertCounts.warn ?? overview?.alertCounts.warn ?? 0}
          tone="warning"
        />
        <StatTile
          label={t("势力")}
          value={overview?.paging.total ?? factionList.length}
          tone="primary"
          delta={overview ? t("人口 {n}", { n: formatQty(overview.population?.count ?? 0) }) : undefined}
        />
        <StatTile
          label={t("领地")}
          value={formatQty(totals.owned)}
          tone="telemetry"
          delta={t("前线 {n}", { n: totals.front })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel
          tag="// SITUATION"
          title={t("世界近况")}
          meta={overview?.scenario?.name ?? ""}
          className="min-h-[260px]"
        >
          <PanelState
            loading={resource.loading && !overview}
            error={resource.error}
            onRetry={resource.reload}
          >
            <div className="space-y-3">
              <div className="space-y-1 text-[11.5px] text-muted-foreground">
                <div>
                  {t("剧本")}：<span className="text-foreground">{overview?.scenario?.name ?? "—"}</span>
                  {overview?.crisis?.era ? (
                    <span className="ml-2 text-tertiary">{t("阶段 {era}", { era: overview.crisis.era })}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular text-tertiary">
                  <span>{t("战力合计 {n}", { n: formatQty(totals.power) })}</span>
                  <span>{t("武装舰船 {n}", { n: formatQty(totals.armedShips) })}</span>
                  <span>{t("资金合计 {n}", { n: formatIskShort(totals.treasury) })}</span>
                  <span>{t("在产任务 {n}", { n: formatQty(totals.jobs) })}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tierCounts(overview?.tiers).map((entry) => (
                  <TierChip key={entry.tier} tier={entry.tier} count={entry.count} />
                ))}
              </div>
              <div className="max-h-[150px] space-y-1 overflow-y-auto pr-1">
                {[...badAlerts, ...otherAlerts].slice(0, 24).map((alert, index) => (
                  <div key={`${alert.at}-${index}`} className="flex items-baseline gap-2 text-[11.5px]">
                    <span
                      className={cn(
                        "shrink-0",
                        alert.level === "bad" ? "text-destructive" : "text-warning"
                      )}
                    >
                      {alert.level === "bad" ? t("危险") : t("注意")}
                    </span>
                    <span className="truncate text-muted-foreground">{alert.text}</span>
                  </div>
                ))}
                {alerts.length === 0 ? (
                  <div className="py-4 text-center text-[11px] text-tertiary">{t("没有告警")}</div>
                ) : null}
              </div>
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// LIVE" title={t("势力动态")} className="min-h-[260px]">
          <EventFeed
            events={faction.events}
            colorByKey={colorByKey}
            connected={faction.connected}
            streamReason={faction.streamReason}
            className="max-h-[300px]"
          />
        </Panel>
      </div>

      <Panel
        tag="// FACTIONS"
        title={t("势力一览")}
        meta={t("{n} / {m} 家", {
          n: factionList.length,
          m: overview?.paging.total ?? factionList.length,
        })}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
              placeholder={t("搜索势力")}
              className="h-6 w-36 rounded border border-input bg-transparent px-2 text-[11px] text-foreground placeholder:text-tertiary focus:border-primary focus:outline-none"
            />
            <FactionSelect
              value={sort}
              onChange={(next) => {
                setSort(next as FactionSort)
                setPage(1)
              }}
              ariaLabel={t("排序")}
              className="w-[96px]"
              options={SORTS.map((item) => ({ value: item.id, label: t(item.label) }))}
            />
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setTier("all")
              setPage(1)
            }}
            className={cn(
              "rounded-sm border px-2 py-0.5 text-[10px] transition-colors",
              tier === "all"
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:border-primary/60"
            )}
          >
            {t("全部")} {factionList.length}
          </button>
          {tierCounts(overview?.tiers).map((entry) => (
            <button
              key={entry.tier}
              type="button"
              onClick={() => {
                setTier(entry.tier)
                setPage(1)
              }}
              className={cn(
                "rounded-sm border px-2 py-0.5 text-[10px] transition-colors",
                tier === entry.tier
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:border-primary/60"
              )}
            >
              {tierLabelOf(entry.tier, t)} {entry.count}
            </button>
          ))}
        </div>

        {/* 面板自己声明 121 家政体，但只给有实体的那几十家发卡片（第 3、4 页是空的，实测）；
            这里如实说明，免得用户以为是启动器漏了 —— 与面板抬头那句「另有 N 个只有记录的政体」同一口径 */}
        {overview && factionList.length < (overview.paging.total ?? 0) ? (
          <div className="mb-2 text-[11px] text-tertiary">
            {t("面板只给有实体的 {n} 家发卡片；另有 {d} 个只有记录的政体，面板不提供它们的卡片。", {
              n: factionList.length,
              d: Math.max(0, (overview.paging.total ?? 0) - factionList.length),
            })}
          </div>
        ) : null}

        <PanelState
          loading={resource.loading && !overview}
          error={resource.error}
          empty={filtered.length === 0}
          emptyHint={t("没有符合条件的势力")}
          onRetry={resource.reload}
        >
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {slice.map((item) => (
              <FactionCard key={item.key} item={item} />
            ))}
          </div>
          {pages > 1 ? (
            <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-muted-foreground">
              <button
                type="button"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 disabled:opacity-40"
              >
                <ChevronLeft className="size-3" />
                {t("上一页")}
              </button>
              <span className="tabular">
                {t("第 {page} / {pages} 页", { page: current, pages })}
              </span>
              <button
                type="button"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 disabled:opacity-40"
              >
                {t("下一页")}
                <ChevronRight className="size-3" />
              </button>
            </div>
          ) : null}
        </PanelState>
      </Panel>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-tertiary">
        <span className="inline-flex items-center gap-1">
          {status?.paused ? <Pause className="size-3" /> : <Play className="size-3" />}
          {status?.paused ? t("推演已暂停") : t("推演运行中")}
        </span>
        <span>
          {t("面板")}：<span className="tabular text-muted-foreground">{faction.probe?.url ?? "—"}</span>
        </span>
        <span>
          {t("数据更新")}：
          <span className="tabular text-muted-foreground">
            {resource.updatedAt
              ? new Date(resource.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
              : "—"}
          </span>
        </span>
      </div>
    </div>
  )
}

