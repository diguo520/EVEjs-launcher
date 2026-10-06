/**
 * 「模组制作规范」的外壳侧状态：正文有更新时在按钮旁边亮一圈脉冲，点开过一次就不再亮。
 *
 * 规范正文随包发布（中英两份 md 由 scaffold.rs 内嵌，启动时释放到 `_launcher/mods/`），
 * 改了正文就该让老用户看见 —— 但只该看见一次。做法是把「看过」记成一个修订号：
 * 修订号写死在代码里，正文有用户该知道的变化时改这里，所有人的脉冲重新亮一次。
 *
 * 存储放在界面语言那一层（localStorage），不进数据目录：清缓存 / 换机器丢了就当没看过，
 * 顶多多亮一次，不影响任何功能。与 React 无关，纯函数 + 可注入存储，方便单测。
 */

/** 规范正文的修订号：正文有用户该知道的变化时改这里（同一天改多次就用更细的号） */
export const AUTHORING_DOC_REVISION = "2026-10-06"

/** localStorage 键（与 evejs-language 同一层：换外壳不丢，清缓存也不心疼） */
export const AUTHORING_DOC_SEEN_KEY = "evejs-mod-authoring-seen"

/** 只用到这两个方法的极简存储接口，测试里给个假的即可 */
export interface DocSeenStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 该不该亮脉冲：存下来的修订号与当前不一致（没存过 / 存的是上一版 / 存了个不认识的号）
 * 就亮。只比字符串：不解析、不抛。
 */
export function shouldPulseAuthoringDoc(
  stored: string | null,
  revision: string = AUTHORING_DOC_REVISION
): boolean {
  return stored !== revision
}

/** 打开模组页时问一次：还要不要再亮（读不到 localStorage 就当没看过） */
export function needsAuthoringDocPulse(
  storage: DocSeenStorage | null | undefined = defaultStorage()
): boolean {
  return shouldPulseAuthoringDoc(readSeen(storage))
}

/** 记下「看过了」：写的是当前修订号，下次启动就不亮了 */
export function markAuthoringDocSeen(
  storage: DocSeenStorage | null | undefined = defaultStorage(),
  revision: string = AUTHORING_DOC_REVISION
): void {
  if (!storage) return
  try {
    storage.setItem(AUTHORING_DOC_SEEN_KEY, revision)
  } catch {
    /* 隐私模式等写不进去：这次会话内不再亮，重启可能再亮一次，可接受 */
  }
}

/** 读本机记录：拿不到 localStorage（隐私模式）就当没看过 */
function readSeen(storage: DocSeenStorage | null | undefined): string | null {
  if (!storage) return null
  try {
    return storage.getItem(AUTHORING_DOC_SEEN_KEY)
  } catch {
    return null
  }
}

/** 非浏览器环境（单测 / 预渲染）没有 window：直接当没看过 */
function defaultStorage(): DocSeenStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
