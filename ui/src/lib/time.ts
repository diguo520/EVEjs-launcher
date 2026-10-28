/**
 * 时钟格式化（B3，2026-10-29）。
 *
 * `const p = (n) => String(n).padStart(2, "0")` 这一行原本在 **11 个文件**里各写一遍
 * （名字还不一样：`p` / `pad` / `value`）。收成 `pad2` + `formatClock` 两个入口。
 *
 * 注意口径：`faction-*.tsx` 里另有 `toLocaleTimeString("zh-CN", { hour12: false })`，
 * 它与手拼的时区/本地化行为**不完全等价**（locale 影响分隔符），所以**不并进这里**。
 */

/** 两位补零：`9` → `09` */
export function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** `HH:MM:SS`（本地时间）：日志面板与时钟到处在用 */
export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
