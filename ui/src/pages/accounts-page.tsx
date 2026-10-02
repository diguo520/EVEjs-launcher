import { useMemo, useState } from "react"
import { toast } from "sonner"

import { AccountCard } from "@/components/accounts/account-card"
import { AccountsToolbar } from "@/components/accounts/accounts-toolbar"
import {
  CreateAccountDialog,
  type NewAccountPayload,
} from "@/components/accounts/create-account-dialog"
import { PasswordPromptDialog } from "@/components/accounts/password-prompt-dialog"
import { Panel, SectionHeading, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { useNow } from "@/hooks/use-now"
import type { LauncherAccountsState } from "@/hooks/use-launcher-accounts"
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  filterAccounts,
  type Account,
  type Character,
  type StatusFilter,
} from "@/lib/launcher-logic"

/**
 * 账号数据来自外壳：建号要等客户端几秒，这期间切走去别页也不该把角色弄丢。
 * 搜索与状态筛选是这一页自己的事，留在这里算。
 */
export function AccountsPage({ store }: { store: LauncherAccountsState }) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("ALL")
  const [accountOpen, setAccountOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const { accounts, stats } = store
  const filtered = useMemo(
    () => filterAccounts(accounts, query, status),
    [accounts, query, status]
  )
  /** 在线时长要自己往上走，页面给一个统一的节拍，卡片只管读 */
  const now = useNow()

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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="账号总数"
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
          label="角色总数"
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
      />

      {filtered.length > 0 ? (
        /* 账号卡片两列并排：一屏能看全更多账号。
           1280 以下每张卡放不下三个角色槽，回落到单列 */
        <div className="grid gap-3 xl:grid-cols-2">
          {filtered.map((account) => (
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
      ) : (
        <Panel tag="// ACCOUNTS" title="账号列表">
          <p className="py-8 text-center text-[12px] text-tertiary">
            {accounts.length === 0
              ? "还没有账号，点右上角「新建账号」开始"
              : "没有匹配的账号或角色"}
          </p>
        </Panel>
      )}

      <CreateAccountDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        accounts={accounts}
        onSubmit={createAccount}
      />

      {/* 别的启动器建的号：本机没有 DPAPI 密文，补一次密码后照旧一键进 */}
      <PasswordPromptDialog
        pending={store.pendingCredential}
        accountName={
          accounts.find((a) => a.id === store.pendingCredential?.accountId)?.name ?? ""
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
