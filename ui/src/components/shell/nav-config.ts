import {
  Command,
  Database,
  FileJson,
  LayoutDashboard,
  Crosshair,
  Package,
  Radar,
  Swords,
  Settings,
  SlidersHorizontal,
  Store,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export type ViewId =
  | "dashboard"
  | "console"
  | "gameconfig"
  | "staticdata"
  | "accounts"
  | "commands"
  | "database"
  | "market"
  | "modules"
  | "faction"
  | "starmap"
  | "km"
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
  /**
   * 需要装了哪个模组才显示这一组（模组清单 `evejs-launcher.mod.json` 里的 `id`）。
   * 判据见 `visibleNavGroups`。
   */
  requiresMod?: string
}

/** 群星那一组依赖的模组：势力 / 星图 / KM 三个页面的数据都出自它 */
export const FACTION_MOD_ID = "evejs-faction-sim"

/**
 * 按「装了哪些模组」过滤导航分组。
 *
 * 三条规则，顺序即优先级：
 *   1. 没有 `requiresMod` 的分组永远显示；
 *   2. `installed === null` 表示拿不到模组清单（浏览器里预览、桥不可用）——
 *      这种情况一律显示，否则 `npm run dev` 的预览会平白少掉一整组，开发时反而看不见；
 *   3. 有清单就按 id 判：装了就显示，没装就整组隐藏（连分组标题一起）。
 */
export function visibleNavGroups(
  groups: NavGroup[],
  installed: ReadonlySet<string> | null
): NavGroup[] {
  if (installed === null) return groups
  return groups.filter((group) => !group.requiresMod || installed.has(group.requiresMod))
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "控制",
    items: [
      { id: "dashboard", label: "主控台", sub: "CORE SERVICE CONTROL", icon: LayoutDashboard },
      { id: "console", label: "服务器日志", sub: "SERVER LOGS", icon: Terminal },
      {
        id: "gameconfig",
        label: "宇宙配置",
        sub: "UNIVERSE CONFIGURATION",
        icon: SlidersHorizontal,
      },
      {
        id: "staticdata",
        label: "静态数据",
        sub: "STATIC DATA HOT RELOAD",
        icon: FileJson,
      },
    ],
  },
  {
    title: "群星",
    requiresMod: FACTION_MOD_ID,
    items: [
      {
        id: "faction",
        label: "势力",
        sub: "NPC FACTIONS",
        icon: Radar,
      },
      {
        id: "starmap",
        label: "星图",
        sub: "STAR MAP",
        icon: Crosshair,
      },
      {
        // KM 是 EVE 玩家的固定叫法（kill mail / 战报），不翻译
        id: "km",
        label: "KM",
        sub: "KILL & BATTLE LOG",
        icon: Swords,
      },
    ],
  },
  {
    title: "管理",
    items: [
      { id: "accounts", label: "账号管理", sub: "ACCOUNTS & CHARACTERS", icon: Users },
      { id: "commands", label: "指令手册", sub: "GM COMMAND REFERENCE", icon: Command },
      { id: "database", label: "数据库", sub: "PERSISTENCE LAYER", icon: Database },
      { id: "market", label: "物品市场", sub: "ITEM & MARKET CATALOG", icon: Store },
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
