import type { ReactNode } from "react"
import { useMemo } from "react"
import { AlertTriangle, Loader2, PackageX, RefreshCw, ServerCrash } from "lucide-react"

import { Panel, SectionHeading } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import {
  useFactionData,
  useFaction,
  type FactionController,
  type FactionStreamOptions,
} from "@/hooks/use-faction"
import { rosterColors, rosterOf, type RosterEntry } from "@/lib/faction-logic"
import { cn } from "@/lib/utils"

export interface FactionShell {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
  /** 中文界面用面板自带的中文星系名，其余语言回落英文 */
  preferZh: boolean
}

/**
 * 群星（势力 / 星图 / KM）三个页面共用的连接层。
 *
 * 一份探针 + 一份名录：名录来自 `/api/control?size=1`（48 个「有实体」势力的 key / 名 / 色 / 层级，
 * 约 5 KB），三个页面各自复制一份既浪费带宽又会让配色在不同页之间漂移。
 * 各页面自己拉自己那份大接口（约定了各自的刷新间隔），切走就停。
 */
export function useFactionShell(streamOptions?: FactionStreamOptions): FactionShell {
  const { locale } = useLocale()
  const faction = useFaction(streamOptions)
  const rosterResource = useFactionData<{ factions?: RosterEntry[] }>(faction.api, "/api/control", {
    query: { size: 1 },
    intervalMs: 60_000,
    enabled: faction.available,
  })
  const roster = useMemo(
    () => rosterOf(rosterResource.data?.factions),
    [rosterResource.data?.factions]
  )
  const colorByKey = useMemo(() => rosterColors(roster), [roster])
  return { faction, roster, colorByKey, preferZh: locale === "zh" }
}

/** 顶栏那颗状态灯：读得到令牌 / 连得上面板 / 掉线，三种说法不一样 */
export function FactionStatusChip({ faction }: { faction: FactionController }) {
  const { t } = useLocale()
  const probe = faction.probe
  const available = probe?.available === true
  const reason = available ? "" : probe?.reason ?? ""
  const tone = available ? "text-success" : probe?.ok ? "text-warning" : "text-destructive"
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block size-1.5 rounded-full bg-current", tone)} />
      <span className={tone}>{available ? t("面板已连接") : t("面板不可用")}</span>
      {reason ? <span className="max-w-[280px] truncate text-tertiary">{reason}</span> : null}
    </span>
  )
}

/** 页头：标题 + 等宽副标 + 连接状态 + 刷新 */
export function FactionPageHeader({
  title,
  sub,
  faction,
  onRefresh,
}: {
  title: string
  sub: string
  faction: FactionController
  onRefresh?: () => void
}) {
  const { t } = useLocale()
  return (
    <SectionHeading
      title={title}
      sub={sub}
      actions={
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <FactionStatusChip faction={faction} />
          <button
            type="button"
            onClick={() => {
              faction.recheck()
              onRefresh?.()
            }}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            {faction.checking ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t("刷新")}
          </button>
        </div>
      }
    />
  )
}

/**
 * 面板不可用时的整页说明：把「模组没装」和「服务端没起」分开讲，
 * 三个页面共用同一套话术，用户在哪一页看到的都是同一件事。
 */
export function FactionUnavailable({ faction }: { faction: FactionController }) {
  const { t } = useLocale()
  const probe = faction.probe
  const missing = probe ? !probe.ok : false
  return (
    <Panel tag="// OFFLINE" title={t("势力推演面板不可用")}>
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        {missing ? (
          <PackageX className="size-6 text-muted-foreground" />
        ) : (
          <ServerCrash className="size-6 text-warning" />
        )}
        <div className="max-w-xl text-[12.5px] text-muted-foreground">
          {missing
            ? t(
                "读不到面板令牌：这台机器上还没装「NPC 势力模拟」模组，或者它还没启动过。装上并在游戏服务端里跑起来之后，这里会自动接上。"
              )
            : t(
                "拿到了面板令牌，但连不上面板地址 —— 多半是游戏服务端没在跑（面板由它带着起来）。点右上角「刷新」重试，或在主控台把主服务器启动起来。"
              )}
        </div>
        {probe?.reason ? (
          <div className="flex items-center gap-2 rounded border border-warning/40 px-3 py-1.5 text-[11.5px] text-warning">
            <AlertTriangle className="size-3.5" />
            {probe.reason}
          </div>
        ) : null}
        <div className="text-[11px] text-tertiary">
          {t("面板地址")}：<span className="tabular">{probe?.url ?? "—"}</span>
        </div>
        <button
          type="button"
          onClick={faction.recheck}
          className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          {faction.checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {t("重新检测")}
        </button>
      </div>
    </Panel>
  )
}

/**
 * 页头 + 「面板不可用就整页换成说明」这一层：三个页面都用它包一层，
 * 免得每页各写一遍 `checked && !available` 的分支。
 */
export function FactionScreen({
  title,
  sub,
  shell,
  onRefresh,
  children,
}: {
  title: string
  sub: string
  shell: FactionShell
  onRefresh?: () => void
  children: ReactNode
}) {
  const { faction } = shell
  return (
    <div className="space-y-4">
      <FactionPageHeader title={title} sub={sub} faction={faction} onRefresh={onRefresh} />
      {faction.checked && !faction.available ? (
        <FactionUnavailable faction={faction} />
      ) : (
        children
      )}
    </div>
  )
}
