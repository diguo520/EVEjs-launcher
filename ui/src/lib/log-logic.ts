import type { LogLevel, LogLine, LogSegment, LogTemplate, LogVar } from "@/lib/mock"
import { listSeparator, t } from "@/lib/i18n"

/** 日志面板的四个来源页签 */
export type LogTab = "sys" | "node" | "market" | "client"

export const LOG_TABS: LogTab[] = ["sys", "node", "market", "client"]

export const LOG_TAB_LABEL: Record<LogTab, string> = {
  sys: "系统",
  node: "主服务器",
  market: "市场服务",
  client: "客户端",
}

/**
 * 每个页签只收自己那一类来源。
 *
 * 系统页签收的是**启动器自己的记录**（启动横幅、模组清单、功能启停提示），
 * 主服务器 / 市场服务 / 客户端的原始输出各归各页 —— 2026-09-29 报障：
 * 系统页以前「不过滤」，把三个服务的原始输出（服务端自己打的中文）也混了进来。
 */
const TAB_SOURCES: Record<LogTab, string[]> = {
  sys: ["sys"],
  // node = 实时流；server = server.log 日志文件（同一台主服务器，两个来源都归这页）
  node: ["node", "server", "gateway", "images"],
  market: ["market"],
  client: ["client"],
}

export function matchLogTab(src: string, tab: LogTab): boolean {
  return TAB_SOURCES[tab].includes(src)
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

/**
 * 日志行的稳定指纹：时间 + 级别 + 来源 + 正文。
 * 服务端日志尾巴每 4s 重读一次，靠它认出「哪些行已经收过了」。
 */
export function lineKey(line: LogLine): string {
  return `${line.t}\u0000${line.level}\u0000${line.src}\u0000${line.msg}`
}

/**
 * 上一批与这一批的重叠长度：上一批的**尾巴**与这一批的**开头**对得上几行。
 *
 * 读日志尾巴就靠这个做增量：server.log 每 4s 重读一次，窗口整体往下滑，
 * 只有滑进来的那几行是新的；一次都没对上的（文件被轮转、内容整段换掉）返回 0，
 * 调用方就会把这一批整段收下。
 */
export function overlapTail(previous: string[], incoming: string[]): number {
  const max = Math.min(previous.length, incoming.length)
  for (let size = max; size > 0; size -= 1) {
    let same = true
    for (let index = 0; index < size; index += 1) {
      if (previous[previous.length - size + index] !== incoming[index]) {
        same = false
        break
      }
    }
    if (same) return size
  }
  return 0
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

/* ------------------------------ 正文重翻 ------------------------------ */

/** 模板变量 → 文字：数据原样、数组按当前语言的列表分隔符拼、模板再翻一层 */
function renderVar(value: LogVar): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.join(listSeparator())
  return renderTemplate(value)
}

function renderTemplate(template: LogTemplate): string {
  const vars = template.vars
  if (!vars) return t(template.key)
  const filled: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(vars)) filled[name] = renderVar(value)
  return t(template.key, filled)
}

/** 把一段正文按当前语言拼出来 */
export function renderSegments(parts: LogSegment[]): string {
  return parts
    .map((part) => (typeof part === "string" ? t(part) : renderTemplate(part)))
    .join("")
}

/**
 * 一条日志行按当前语言重算正文。
 *
 * 生成时的正文是**当时的语言**，切了语言只有重算才跟得上（2026-09-29 报障：
 * 启动横幅那一块永远是中文）。没有 `parts` 的行是死文本 —— 服务端自己打的输出、
 * 日志文件里读回来的行 —— 原样返回：那些内容本来就没有、也不该有译文。
 */
export function renderLogLine(line: LogLine): LogLine {
  if (!line.parts) return line
  const msg = renderSegments(line.parts)
  return msg === line.msg ? line : { ...line, msg }
}

/** 整批重算：面板在渲染期调用，关键字搜索 / 显示 / 复制都用重算后的正文 */
export function renderLogLines(lines: LogLine[]): LogLine[] {
  return lines.map(renderLogLine)
}
