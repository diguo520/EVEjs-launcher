import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { AccountCard } from "@/components/accounts/account-card"
import { AccountsToolbar } from "@/components/accounts/accounts-toolbar"
import { SimulationAccountsPanel } from "@/components/accounts/simulation-accounts-panel"
import {
  CreateAccountDialog,
  type NewAccountPayload,
} from "@/components/accounts/create-account-dialog"
import { PasswordPromptDialog } from "@/components/accounts/password-prompt-dialog"
import { Panel, SectionHeading, StatTile } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLocale } from "@/components/shell/locale-provider"
import { useNow } from "@/hooks/use-now"
import type { LauncherAccountsState } from "@/hooks/use-launcher-accounts"
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  accountStats,
  accountsInScope,
  filterAccounts,
  type Account,
  type AccountScope,
  type Character,
  type SimulationGroup,
  type StatusFilter,
} from "@/lib/launcher-logic"

/** 账号页打开时的在线状态刷新节拍；服务端 host 每 2 秒写一次，这里 5 秒读一次足够实时也不刷屏。 */
const ONLINE_REFRESH_MS = 5000
const PAGE_SIZE = 24

/**
 * 账号数据来自外壳：建号要等客户端几秒，这期间切走去别页也不该把角色弄丢。
 * 搜索与状态筛选是这一页自己的事，留在这里算。
 */
export function AccountsPage({ store }: { store: LauncherAccountsState }) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("ALL")
  const [scope, setScope] = useState<AccountScope>("player")
  const [simulationFilter, setSimulationFilter] = useState<SimulationGroup>("all")
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [accountOpen, setAccountOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const allAccounts = store.accounts
  const playerAccounts = useMemo(
    () => accountsInScope(allAccounts, "player"),
    [allAccounts]
  )
  const simulationAccounts = useMemo(
    () => accountsInScope(allAccounts, "simulation"),
    [allAccounts]
  )
  const scopedAccounts = useMemo(
    () => accountsInScope(allAccounts, scope, simulationFilter),
    [allAccounts, scope, simulationFilter]
  )
  const stats = useMemo(() => accountStats(scopedAccounts), [scopedAccounts])
  const filtered = useMemo(
    () => filterAccounts(scopedAccounts, query, status),
    [scopedAccounts, query, status]
  )
  const visibleAccounts = filtered.slice(0, visibleCount)
  /** 在线时长要自己往上走，页面给一个统一的节拍，卡片只管读 */
  const now = useNow()

  // 账号页可见时只刷新轻量在线状态；切走后 interval 自动清掉，不在后台反复查库。
  useEffect(() => {
    const timer = window.setInterval(() => store.reloadOnline(), ONLINE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [store.reloadOnline])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [scope, simulationFilter, query, status])

  function refresh() {
    setRefreshing(true)
    store.reload()
    // 真数据是异步回来的：给一点点时间让列表刷完再收起转圈
    window.setTimeout(() => {
      setRefreshing(false)
      toast.success("账号列表已从服务端同步")
    }, 700)
  }

  function createAccount(payload: NewAccountPayload) {
    return store.addAccount(payload)
  }

  /** 空槽只有一个动作：把客户端拉起来，角色在游戏里捏 */
  function createInGame(accountId: string) {
    const guard = store.createInGame(accountId)
    if (!guard.ok) {
      toast.error("无法进入角色创建界面", { description: guard.reason })
    }
    // needsPassword：数据层挂起了这次操作，交给补密码弹窗接手，别再提示"正在拉起客户端"
  }

  function enterGame(accountId: string, character: Character) {
    const guard = store.enterGame(accountId, character.id)
    if (!guard.ok) {
      toast.error("无法登录", { description: guard.reason })
      return
    }
    // needsPassword：本机没存过这个号的密码，弹窗接管（见 PasswordPromptDialog）；
    // 成功提示由数据层在真正拉起客户端之后发，这里不再提示（否则静默补密码那条路会先说一句废话）。
  }

  function exitGame(accountId: string, character: Character) {
    store.exitGame(accountId, character.id)
    toast.success(t("{name} 已下线", { name: character.name }), {
      description: "角色槽已释放，可登录同账号的其他角色。",
    })
  }

  function deleteCharacter(accountId: string, character: Character) {
    const guard = store.deleteCharacter(accountId, character.id)
    if (!guard.ok) {
      toast.error("无法删除角色", { description: guard.reason })
      return
    }
    toast.success(t("正在删除角色 {name}", { name: character.name }), {
      description: "该角色的舰船与资产记录会一并清除，槽位随即空出。",
    })
  }

  function deleteAccount(account: Account) {
    const guard = store.deleteAccount(account.id)
    if (!guard.ok) {
      toast.error("无法删除账号", { description: guard.reason })
      return
    }
    toast.success(t("已删除账号 {name}", { name: account.name }), {
      description: account.characters.length
        ? t("{count} 个角色及其资产记录已一并清除。", { count: account.characters.length })
        : "该账号下没有角色。",
    })
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="账号管理"
        sub="// ACCOUNTS & CHARACTERS"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            每个账号 {MAX_CHARACTERS_PER_ACCOUNT} 个角色槽 · 角色在游戏内创建 ·
            同账号同时仅一个角色在线
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={scope}
          onValueChange={(value) => {
            setScope(value as AccountScope)
            setSimulationFilter("all")
          }}
        >
          <TabsList>
            <TabsTrigger value="player">
              {t("玩家账号")}
              <span className="tabular text-[10px] text-tertiary">{playerAccounts.length}</span>
            </TabsTrigger>
            <TabsTrigger value="simulation">
              {t("模拟账号")}
              <span className="tabular text-[10px] text-tertiary">{simulationAccounts.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {scope === "simulation" ? (
          <Select
            value={simulationFilter}
            onValueChange={(value) => setSimulationFilter(value as SimulationGroup)}
          >
            <SelectTrigger className="w-[180px]" aria-label={t("模拟账号分组")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("全部模拟账号")}</SelectItem>
              <SelectItem value="pool">{t("公共驾驶员池")}</SelectItem>
              <SelectItem value="faction-pool">{t("势力驾驶员池")}</SelectItem>
              <SelectItem value="faction-main">{t("势力主账号")}</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <span className="tabular text-[11px] text-muted-foreground">
          {t("当前分组 {accounts} 个账号 · {characters} 个角色", {
            accounts: scopedAccounts.length,
            characters: stats.characters,
          })}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={scope === "player" ? t("玩家账号") : t("模拟账号")}
          value={stats.accounts}
          tone="primary"
          delta={
            stats.accounts === 0
              ? "尚无账号"
              : stats.suspended
                ? t("其中 {count} 个已停用", { count: stats.suspended })
                : "全部可用"
          }
        />
        <StatTile
          label={scope === "player" ? t("玩家角色") : t("模拟角色")}
          value={stats.characters}
          delta={
            stats.characters === 0
              ? "尚无角色"
              : t("平均每账号 {count} 个角色", { count: stats.avg })
          }
        />
        <StatTile
          label="在线角色"
          value={stats.online}
          tone="success"
          delta={t("{count} 个离线", { count: stats.characters - stats.online })}
        />
        <StatTile
          label="空余槽位"
          value={stats.freeSlots}
          tone="warning"
          delta={t("总容量 {count} 个", { count: stats.accounts * MAX_CHARACTERS_PER_ACCOUNT })}
        />
      </div>

      <AccountsToolbar
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        refreshing={refreshing}
        onRefresh={refresh}
        onCreate={() => setAccountOpen(true)}
        showCreate={scope === "player"}
      />

      {filtered.length > 0 ? (
        scope === "simulation" ? (
          <SimulationAccountsPanel accounts={visibleAccounts} />
        ) : (
          /* 玩家账号保持原来的卡片视图；模拟账号走紧凑视图，避免几百个角色被截成前三个。 */
          <div className="grid gap-3 xl:grid-cols-2">
            {visibleAccounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                creating={store.creating}
                now={now}
                logotypes={store.logotypes}
                onEnter={enterGame}
                onExit={exitGame}
                onDelete={deleteCharacter}
                onDeleteAccount={deleteAccount}
                onCreate={createInGame}
              />
            ))}
          </div>
        )
      ) : (
        <Panel tag="// ACCOUNTS" title="账号列表">
          <p className="py-8 text-center text-[12px] text-tertiary">
            {allAccounts.length === 0
              ? "还没有账号，点右上角「新建账号」开始"
              : "没有匹配的账号或角色"}
          </p>
        </Panel>
      )}

      {filtered.length > visibleAccounts.length ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            {t("加载更多（剩余 {count} 个账号）", {
              count: filtered.length - visibleAccounts.length,
            })}
          </Button>
        </div>
      ) : null}

      <CreateAccountDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        accounts={allAccounts}
        onSubmit={createAccount}
      />

      {/* 别的启动器建的号：本机没有 DPAPI 密文，补一次密码后照旧一键进 */}
      <PasswordPromptDialog
        pending={store.pendingCredential}
        accountName={
          allAccounts.find((a) => a.id === store.pendingCredential?.accountId)?.name ?? ""
        }
        open={store.pendingCredential !== null}
        onOpenChange={(v) => {
          if (!v) store.cancelCredential()
        }}
        onSubmit={store.submitCredential}
      />
    </div>
  )
}
