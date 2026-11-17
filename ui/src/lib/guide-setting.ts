/**
 * 「启动器引导」开关：走 localStorage（与界面语言那一层同），不进后端设置。
 * 现役后端没有这个设置项，用本地存储让它真正可用，而不是灰掉的假开关。
 * 与 React 无关，纯函数 + 可注入存储，方便单测。
 */

/** localStorage 键（与 evejs-language 同一层：换外壳不丢，清缓存也不心疼） */
export const GUIDE_ENABLED_KEY = "evejs_guide_enabled"

/** 只用到这两个方法的极简存储接口，测试里给个假的即可 */
export interface GuideStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 读引导开关：没存过 / 读不到 = 默认开启（保持引导照常出现） */
export function readGuideEnabled(
  storage: GuideStorage | null | undefined = defaultStorage()
): boolean {
  if (!storage) return true
  try {
    return storage.getItem(GUIDE_ENABLED_KEY) !== "0"
  } catch {
    return true
  }
}

/** 写引导开关：on 存 "1"，off 存 "0" */
export function writeGuideEnabled(
  on: boolean,
  storage: GuideStorage | null | undefined = defaultStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(GUIDE_ENABLED_KEY, on ? "1" : "0")
  } catch {
    /* 隐私模式等写不进去：本次会话内按当前值，重启回默认，可接受 */
  }
}

/** 非浏览器环境（单测 / 预渲染）没有 window：直接当默认开启 */
function defaultStorage(): GuideStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
