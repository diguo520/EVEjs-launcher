import { Link } from "react-router-dom"
import { ChevronRight, LogOut } from "lucide-react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import { formatRelative, formatSp } from "@/lib/format"
import { Badge, StatusDot } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { cn } from "@/lib/utils"

export function PresencePanel({ className }: { className?: string }) {
  const { accounts, now, setAccountStatus } = useEngine()
  const online = accounts.filter((a) => a.status === "online")

  return (
    <Panel className={cn("flex min-h-0 flex-col", className)}>
      <PanelHeader
        eyebrow="online pilots"
        title={`当前在线 ${online.length}`}
        actions={
          <Link
            to="/accounts"
            className="inline-flex items-center gap-0.5 font-mono text-xs text-primary hover:underline"
          >
            全部账号
            <ChevronRight className="h-3 w-3" />
          </Link>
        }
      />
      <div className="hud-scroll min-h-[220px] flex-1 overflow-y-auto">
        {online.length === 0 ? (
          <p className="py-10 text-center font-mono text-xs text-muted-foreground/60">
            暂无舰长在线
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {online.map((account) => (
              <li
                key={account.id}
                className="group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-secondary/40"
              >
                <StatusDot tone="success" pulse />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-foreground">{account.character}</span>
                    {account.role === "管理员" ? (
                      <Badge tone="primary" className="px-1 py-0 text-[10px]">
                        管理
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-[10px] text-muted-foreground/70">
                    {account.shipName} · {account.solarSystem} · {formatSp(account.skillPoints)} SP
                  </p>
                </div>
                <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/60 sm:inline">
                  {formatRelative(account.lastSeen, now)}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`踢 ${account.character} 下线`}
                  onClick={() => {
                    setAccountStatus([account.id], "offline")
                    toast.warning(`${account.character} 已被踢下线`)
                  }}
                >
                  <LogOut className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}
