import { Badge } from "@/components/ui/badge"
import { Panel } from "@/components/common/panel"
import { t } from "@/lib/i18n"
import { simulationGroup, type Account } from "@/lib/launcher-logic"
import { cn } from "@/lib/utils"

const GROUP_LABEL: Record<ReturnType<typeof simulationGroup>, string> = {
  pool: "公共驾驶员池",
  "faction-pool": "势力驾驶员池",
  "faction-main": "势力主账号",
}

/** 模拟账号的紧凑视图：保留账号级汇总，在线模拟角色单独列出来。 */
export function SimulationAccountsPanel({ accounts }: { accounts: Account[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
      {accounts.map((account) => {
        const online = account.characters.filter((character) => character.online)
        const shown = online.slice(0, 24)
        const group = simulationGroup(account)
        return (
          <Panel
            key={account.id}
            flush
            tag={`// ${GROUP_LABEL[group]}`}
            title={account.name}
            actions={
              <div className="flex items-center gap-1.5">
                <Badge variant="outline">{t("{count} 个角色", { count: account.characters.length })}</Badge>
                <Badge variant={online.length > 0 ? "success" : "secondary"}>
                  {t("在线 {count}", { count: online.length })}
                </Badge>
              </div>
            }
          >
            <div className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-tertiary">
                <span>{GROUP_LABEL[group]}</span>
                <span className="tabular">
                  {t("角色 {characters} · 在线 {online}", {
                    characters: account.characters.length,
                    online: online.length,
                  })}
                </span>
              </div>
              {online.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {shown.map((character) => (
                    <span
                      key={character.id}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-sm border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] text-success",
                        "tabular"
                      )}
                      title={`${character.name} · ${character.id}`}
                    >
                      {character.name}
                      <span className="text-success/65">{character.id}</span>
                    </span>
                  ))}
                  {online.length > shown.length ? (
                    <span className="px-1.5 py-0.5 text-[10px] text-tertiary">
                      {t("另有 {count} 个在线角色", { count: online.length - shown.length })}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="text-[11px] text-tertiary">{t("当前无在线模拟角色。")}</p>
              )}
            </div>
          </Panel>
        )
      })}
    </div>
  )
}