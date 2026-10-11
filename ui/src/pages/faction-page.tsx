import { useState } from "react"

import { useLocale } from "@/components/shell/locale-provider"
import { FactionScreen, useFactionShell } from "@/components/faction/faction-shell"
import { FactionOverview } from "@/components/faction/faction-overview"
import { FactionMilitary } from "@/components/faction/faction-military"
import { FactionIntel } from "@/components/faction/faction-intel"
import { FactionEconomy } from "@/components/faction/faction-economy"
import { FactionControl } from "@/components/faction/faction-control"
import { cn } from "@/lib/utils"

/**
 * 五个页签 = 五个实施阶段（总览 / 军事 / 情报与外交 / 经济与物流 / GM 控制）。
 *
 * 星图原先也挂在这里，2026-10-11 起**单独提成一页**（侧栏「群星 → 星图」）：
 * 它自己有缩放、图层、选点这一套交互，塞在页签里跟其它四页的「读表」节奏不一样；
 * 与它配套的 KM（交战详情）同理，各自一页。
 */
const TABS = [
  { id: "overview", label: "总览", sub: "OVERVIEW" },
  { id: "military", label: "军事", sub: "MILITARY" },
  { id: "intel", label: "情报与外交", sub: "INTEL & DIPLOMACY" },
  { id: "economy", label: "经济与物流", sub: "ECONOMY & LOGISTICS" },
  { id: "control", label: "GM 控制", sub: "GM CONTROL" },
] as const

type TabId = (typeof TABS)[number]["id"]

/**
 * 势力页：用启动器自己的界面重画 `evejs-faction-sim` 模组的面板。
 *
 * 数据全部来自模组开在本机的面板（127.0.0.1:26410），由 `faction:api` 代理读取，
 * 令牌只在 Rust 侧使用（见 src-tauri/src/faction.rs）；启动器**不修改**服务端或模组的任何文件。
 * 连接与名录由 `useFactionShell()` 统一提供（星图页、KM 页共用同一份）。
 */
export function FactionPage() {
  const { t } = useLocale()
  const shell = useFactionShell()
  const [tab, setTab] = useState<TabId>("overview")

  return (
    <FactionScreen title={t("势力")} sub="// NPC FACTIONS" shell={shell}>
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "rounded-sm border px-2.5 py-1 text-[12px] transition-colors",
              tab === item.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/60 hover:text-foreground"
            )}
          >
            {t(item.label)}
            <span className="ml-1.5 hidden text-[10px] tracking-[0.08em] text-tertiary lg:inline">
              {item.sub}
            </span>
          </button>
        ))}
      </div>

      {tab === "overview" ? <FactionOverview faction={shell.faction} /> : null}
      {tab === "military" ? (
        <FactionMilitary faction={shell.faction} roster={shell.roster} colorByKey={shell.colorByKey} />
      ) : null}
      {tab === "intel" ? (
        <FactionIntel faction={shell.faction} roster={shell.roster} colorByKey={shell.colorByKey} />
      ) : null}
      {tab === "economy" ? (
        <FactionEconomy faction={shell.faction} roster={shell.roster} colorByKey={shell.colorByKey} />
      ) : null}
      {tab === "control" ? (
        <FactionControl faction={shell.faction} roster={shell.roster} colorByKey={shell.colorByKey} />
      ) : null}
    </FactionScreen>
  )
}
