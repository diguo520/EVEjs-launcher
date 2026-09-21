import { NavLink } from "react-router-dom"
import {
  Archive,
  Boxes,
  LayoutDashboard,
  ScrollText,
  SlidersHorizontal,
  Users,
} from "lucide-react"
import { useEngine } from "@/lib/engine"
import { cn } from "@/lib/utils"
import { ServerStatusPill } from "./ServerStatusPill"
import { Button } from "@/components/ui/button"
import { Play, RotateCw, Square } from "lucide-react"

interface NavItem {
  to: string
  label: string
  hint: string
  icon: typeof LayoutDashboard
  badge?: number
}

export function SideNav() {
  const { serverStatus, accounts, logs, mods, start, stop, restart } = useEngine()

  const onlineCount = accounts.filter((a) => a.status === "online").length
  const errorCount = logs.filter((l) => l.level === "ERROR").length
  const enabledMods = mods.filter((m) => m.enabled).length

  const items: NavItem[] = [
    { to: "/", label: "指挥台", hint: "启停与实时监控", icon: LayoutDashboard },
    { to: "/universe", label: "宇宙参数", hint: "世界、成长与经济", icon: SlidersHorizontal },
    { to: "/accounts", label: "账号与角色", hint: "玩家、ISK 与权限", icon: Users, badge: onlineCount },
    { to: "/logs", label: "日志中心", hint: "分级过滤与排查", icon: ScrollText, badge: errorCount },
    { to: "/backups", label: "存档与备份", hint: "快照与回滚", icon: Archive },
    { to: "/mods", label: "模组管理", hint: "启用与加载顺序", icon: Boxes, badge: enabledMods },
  ]

  const busy = serverStatus === "starting" || serverStatus === "stopping"

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-border bg-card/50">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/40 bg-primary/12">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-primary" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="currentColor" />
            <ellipse
              cx="12"
              cy="12"
              rx="10"
              ry="4.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              transform="rotate(-28 12 12)"
            />
            <ellipse
              cx="12"
              cy="12"
              rx="10"
              ry="4.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              opacity="0.5"
              transform="rotate(38 12 12)"
            />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">新伊甸 指挥台</p>
          <p className="hud-label truncate text-[10px] text-muted-foreground">local shard v14.22</p>
        </div>
      </div>

      <nav className="hud-scroll flex-1 overflow-y-auto px-2 py-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "group mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                  "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                  isActive
                    ? "bg-primary/12 text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn("h-4 w-4 shrink-0", isActive && "text-primary")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-tight">{item.label}</span>
                    <span className="block truncate text-[10px] leading-tight text-muted-foreground/70">
                      {item.hint}
                    </span>
                  </span>
                  {item.badge !== undefined && item.badge > 0 ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                        isActive
                          ? "bg-primary/20 text-primary"
                          : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <ServerStatusPill serverStatus={serverStatus} />
          <span className="hud-label text-[10px] text-muted-foreground/70">shard-01</span>
        </div>
        <div className="flex gap-1.5">
          {serverStatus === "running" || serverStatus === "starting" ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={stop}
            >
              <Square className="h-3 w-3" />
              停止
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={start}
            >
              <Play className="h-3 w-3" />
              启动
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={busy || serverStatus === "stopped"}
            onClick={restart}
            aria-label="重启服务端"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
