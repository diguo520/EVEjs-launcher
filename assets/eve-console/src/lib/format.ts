/** 千分位整数。 */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

/** 一位小数 + 千分位。 */
export function formatFixed(value: number, digits = 1): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** ISK 按中文习惯折算：亿 / 万，避免一长串数字糊在表格里。 */
export function formatIsk(value: number): string {
  if (value >= 1e8) return `${formatFixed(value / 1e8, 2)} 亿`
  if (value >= 1e4) return `${formatFixed(value / 1e4, 1)} 万`
  return formatInt(value)
}

/** 技能点用 K/M 缩写，表格列宽才压得住。 */
export function formatSp(value: number): string {
  if (value >= 1e6) return `${formatFixed(value / 1e6, 2)}M`
  if (value >= 1e3) return `${formatFixed(value / 1e3, 1)}K`
  return formatInt(value)
}

/** 运行时长 → 12天 04:31:08。 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const clock = [h, m, s].map((n) => String(n).padStart(2, "0")).join(":")
  return d > 0 ? `${d}天 ${clock}` : clock
}

/** 时钟 HH:MM:SS。 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":")
}

/** 日期 + 时刻。 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`
  return `${date} ${formatClock(ts)}`
}

/** 相对时间：刚刚 / 3 分钟前 / 2 天前。 */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000))
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

/** 安等保留一位小数，带正负号。 */
export function formatSecurity(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : ""
  return `${sign}${formatFixed(Math.abs(value), 1)}`
}
