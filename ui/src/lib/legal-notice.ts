/**
 * 「法律声明」的外壳侧状态：第一次启动自动弹一次，关掉之后缩成状态栏底部的一个入口，
 * 之后随时能再打开。
 *
 * 存储放在界面语言那一层（localStorage），不进数据目录：清缓存 / 换机器丢了就再弹一次，
 * 顶多多看一遍，不影响任何功能。与 React 无关，纯函数 + 可注入存储，方便单测。
 */

/** localStorage 键（与 evejs-language 同一层：换外壳不丢） */
export const LEGAL_NOTICE_SEEN_KEY = "evejs-legal-notice-seen"

/** 只用到这两个方法的极简存储接口，测试里给个假的即可 */
export interface LegalNoticeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 要不要自动弹：没存过标记（第一次启动）就弹一次 */
export function needsLegalNotice(
  storage: LegalNoticeStorage | null | undefined = defaultStorage()
): boolean {
  if (!storage) return true
  try {
    return storage.getItem(LEGAL_NOTICE_SEEN_KEY) === null
  } catch {
    return true
  }
}

/** 记下「看过了」：写个固定值就行，只关心有没有写过 */
export function markLegalNoticeSeen(
  storage: LegalNoticeStorage | null | undefined = defaultStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(LEGAL_NOTICE_SEEN_KEY, "1")
  } catch {
    /* 隐私模式等写不进去：这次会话内底部入口照样出现，重启可能再弹一次，可接受 */
  }
}

/** 非浏览器环境（单测 / 预渲染）没有 window：当作第一次启动 */
function defaultStorage(): LegalNoticeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
