/**
 * 单测用的假存储（B4，2026-10-29）。
 *
 * `legal-notice.test.ts` 与 `mod-doc-seen.test.ts` 原本各写了一份**逐字相同**的夹具
 * （jscpd #1：10 行 `fakeStorage` + 8 行 `throwingStorage`）。
 *
 * 类型上刻意用结构化类型（`getItem` / `setItem`）而不是 `LegalNoticeStorage` / `DocSeenStorage`：
 * 那两个接口分属两个模块的**公开契约**，只是碰巧形状相同 —— 合并它们是把两个契约绑在一起。
 */
export interface FakeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 内存版 localStorage：单测不碰真浏览器存储 */
export function fakeStorage(initial: Record<string, string> = {}): FakeStorage & {
  dump: () => Record<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  }
}

/** 隐私模式那种一碰就抛的存储 */
export const throwingStorage: FakeStorage = {
  getItem: () => {
    throw new Error("SecurityError")
  },
  setItem: () => {
    throw new Error("QuotaExceededError")
  },
}
