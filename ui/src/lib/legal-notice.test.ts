import { describe, expect, it } from "vitest"

import {
  LEGAL_NOTICE_SEEN_KEY,
  markLegalNoticeSeen,
  needsLegalNotice,
  type LegalNoticeStorage,
} from "@/lib/legal-notice"

/** 内存版 localStorage：单测不碰真浏览器存储 */
function fakeStorage(initial: Record<string, string> = {}): LegalNoticeStorage & {
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
const throwingStorage: LegalNoticeStorage = {
  getItem: () => {
    throw new Error("SecurityError")
  },
  setItem: () => {
    throw new Error("QuotaExceededError")
  },
}

describe("法律声明的首次弹出标记", () => {
  it("没存过（第一次启动）就弹，存过就不弹", () => {
    expect(needsLegalNotice(fakeStorage())).toBe(true)
    expect(needsLegalNotice(fakeStorage({ [LEGAL_NOTICE_SEEN_KEY]: "1" }))).toBe(false)
  })

  it("确认一次就落盘，之后启动只留底部入口", () => {
    const store = fakeStorage()
    expect(needsLegalNotice(store)).toBe(true)
    markLegalNoticeSeen(store)
    expect(store.dump()[LEGAL_NOTICE_SEEN_KEY]).toBe("1")
    expect(needsLegalNotice(store)).toBe(false)
  })

  it("拿不到 localStorage 时按第一次启动处理，写失败也不抛", () => {
    // 隐私模式下宁可多弹一次，也不要静默把声明吞掉
    expect(needsLegalNotice(throwingStorage)).toBe(true)
    expect(() => markLegalNoticeSeen(throwingStorage)).not.toThrow()
    // null（非浏览器环境）同理：弹，但不炸
    expect(needsLegalNotice(null)).toBe(true)
    expect(() => markLegalNoticeSeen(null)).not.toThrow()
  })
})
