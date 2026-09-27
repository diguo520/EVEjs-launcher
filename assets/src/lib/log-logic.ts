import type { LogLevel, LogLine } from "@/lib/mock"

/** 日志面板的四个来源页签 */
export type LogTab = "sys" | "node" | "market" | "client"

export const LOG_TABS: LogTab[] = ["sys", "node", "market", "client"]

export const LOG_TAB_LABEL: Record<LogTab, string> = {
  sys: "系统",
  node: "主服务器",
  market: "市场服务",
  client: "客户端",
}

const TAB_SOURCES: Record<LogTab, string[] | null> = {
  sys: null, // 系统页签 = 不过滤，看全量
  node: ["node", "gateway", "images"],
  market: ["market"],
  client: ["client"],
}

export function matchLogTab(src: string, tab: LogTab): boolean {
  const allow = TAB_SOURCES[tab]
  return allow === null || allow.includes(src)
}

/** 级别档位：all 之外与日志级别一一对应 */
export type LevelFilter = "all" | LogLevel

export const LEVEL_FILTER_ORDER: LevelFilter[] = [
  "all",
  "INFO",
  "WARN",
  "ERROR",
  "DEBUG",
]

/** 关键字只比正文与来源——时间与级别各有自己的入口，不必再搜一遍 */
export function matchKeyword(line: LogLine, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true
  return (
    line.msg.toLowerCase().includes(needle) ||
    line.src.toLowerCase().includes(needle)
  )
}

export interface LogFilter {
  tab?: LogTab
  keyword?: string
  level?: LevelFilter
}

/** 页签 → 关键字 → 级别，三道过滤按顺序收窄 */
export function filterLogs(lines: LogLine[], filter: LogFilter = {}): LogLine[] {
  const { tab, keyword = "", level = "all" } = filter
  return lines.filter(
    (line) =>
      (tab ? matchLogTab(line.src, tab) : true) &&
      matchKeyword(line, keyword) &&
      (level === "all" || line.level === level)
  )
}

/** 各档位各有多少行，用来在过滤条上标数 */
export function levelCounts(lines: LogLine[]): Record<LevelFilter, number> {
  const counts: Record<LevelFilter, number> = {
    all: lines.length,
    INFO: 0,
    WARN: 0,
    ERROR: 0,
    DEBUG: 0,
  }
  lines.forEach((line) => {
    counts[line.level] += 1
  })
  return counts
}

export interface TextPart {
  text: string
  hit: boolean
}

/** 按关键字把一行正文切成片段，交给视图给命中处上色（大小写不敏感，保留原样） */
export function splitHits(text: string, keyword: string): TextPart[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return [{ text, hit: false }]

  const haystack = text.toLowerCase()
  const parts: TextPart[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}
