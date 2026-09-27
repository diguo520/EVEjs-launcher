import {
  Command,
  Database,
  LayoutDashboard,
  Package,
  Settings,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export type ViewId =
  | "dashboard"
  | "console"
  | "accounts"
  | "commands"
  | "database"
  | "modules"
  | "config"
  | "settings"

export interface NavItem {
  id: ViewId
  label: string
  sub: string
  icon: LucideIcon
}

/** 各项右上角的计数徽标：由外壳喂真数据（0 / 缺省 = 不画） */
export type NavBadges = Partial<Record<ViewId, number>>

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "控制",
    items: [
      { id: "dashboard", label: "主控台", sub: "CORE SERVICE CONTROL", icon: LayoutDashboard },
      { id: "console", label: "服务器日志", sub: "SERVER LOGS", icon: Terminal },
    ],
  },
  {
    title: "管理",
    items: [
      { id: "accounts", label: "账号管理", sub: "ACCOUNTS & CHARACTERS", icon: Users },
      { id: "commands", label: "指令手册", sub: "GM COMMAND REFERENCE", icon: Command },
      { id: "database", label: "数据库", sub: "PERSISTENCE LAYER", icon: Database },
      { id: "modules", label: "模组市场", sub: "MOD MARKETPLACE", icon: Package },
    ],
  },
  {
    title: "系统",
    items: [
      { id: "config", label: "配置中心", sub: "SERVER & CLIENT CONFIG", icon: Wrench },
      { id: "settings", label: "设置", sub: "LAUNCHER PREFERENCES", icon: Settings },
    ],
  },
]

export const VIEW_META: Record<ViewId, { title: string; sub: string }> = NAV_GROUPS.reduce(
  (acc, group) => {
    group.items.forEach((item) => {
      acc[item.id] = { title: item.label, sub: item.sub }
    })
    return acc
  },
  {} as Record<ViewId, { title: string; sub: string }>
)
