import { useMemo } from "react"
import { Ban, Coins, Sparkles, UserCheck, Users } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatIsk, formatSp } from "@/lib/format"
import { Panel } from "@/components/ui/panel"
import { MiniBars } from "@/components/ui/sparkline"
import type { Account } from "@/lib/types"

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users
  label: string
  value: string
  sub?: string
}) {
  return (
    <Panel className="flex min-w-0 flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="hud-label truncate text-[10px] text-muted-foreground/70">{label}</span>
      </div>
      <span className="font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
        {value}
      </span>
      {sub ? <span className="truncate font-mono text-[10px] text-muted-foreground/60">{sub}</span> : null}
    </Panel>
  )
}

export function AccountStats({ accounts }: { accounts: Account[] }) {
  const { config } = useEngine()

  const stats = useMemo(() => {
    const online = accounts.filter((a) => a.status === "online").length
    const banned = accounts.filter((a) => a.status === "banned").length
    const totalIsk = accounts.reduce((sum, a) => sum + a.isk, 0)
    const totalSp = accounts.reduce((sum, a) => sum + a.skillPoints, 0)
    return { online, banned, totalIsk, totalSp }
  }, [accounts])

  const factionBars = useMemo(() => {
    const counts = new Map<string, number>()
    accounts.forEach((a) => counts.set(a.faction, (counts.get(a.faction) ?? 0) + 1))
    return Array.from(counts, ([label, value]) => ({ label, value }))
  }, [accounts])

  const corpBars = useMemo(() => {
    const counts = new Map<string, number>()
    accounts.forEach((a) => counts.set(a.corp, (counts.get(a.corp) ?? 0) + 1))
    return Array.from(counts, ([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
  }, [accounts])

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          icon={Users}
          label="账号总数"
          value={String(accounts.length)}
          sub={`上限 ${config.maxPlayers} 人同时在线`}
        />
        <Stat
          icon={UserCheck}
          label="当前在线"
          value={String(stats.online)}
          sub={`${Math.round((stats.online / Math.max(1, config.maxPlayers)) * 100)}% 占用`}
        />
        <Stat icon={Ban} label="封禁中" value={String(stats.banned)} sub="不可登录世界" />
        <Stat icon={Coins} label="流通 isk" value={formatIsk(stats.totalIsk)} sub="全服角色资产合计" />
        <Stat icon={Sparkles} label="技能点总量" value={formatSp(stats.totalSp)} sub="含离线训练产出" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel className="p-4">
          <p className="hud-label mb-3 text-[10px] text-muted-foreground/70">势力分布</p>
          <MiniBars items={factionBars} />
        </Panel>
        <Panel className="p-4">
          <p className="hud-label mb-3 text-[10px] text-muted-foreground/70">军团人数 top 6</p>
          <MiniBars items={corpBars} />
        </Panel>
      </div>
    </div>
  )
}
