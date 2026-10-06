import { describe, expect, it } from "vitest"

import {
  AUTHORING_DOC_REVISION,
  AUTHORING_DOC_SEEN_KEY,
  markAuthoringDocSeen,
  needsAuthoringDocPulse,
  shouldPulseAuthoringDoc,
  type DocSeenStorage,
} from "@/lib/mod-doc-seen"

/** 内存版 localStorage：单测不碰真浏览器存储 */
function fakeStorage(initial: Record<string, string> = {}): DocSeenStorage & {
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
const throwingStorage: DocSeenStorage = {
  getItem: () => {
    throw new Error("SecurityError")
  },
  setItem: () => {
    throw new Error("QuotaExceededError")
  },
}

describe("模组规范的新内容脉冲", () => {
  it("没看过就亮，看过同一修订号就不亮", () => {
    expect(shouldPulseAuthoringDoc(null)).toBe(true)
    expect(shouldPulseAuthoringDoc(AUTHORING_DOC_REVISION)).toBe(false)
  })

  it("正文改版（修订号变了）重新亮一次", () => {
    expect(shouldPulseAuthoringDoc("2026-01-01")).toBe(true)
    expect(shouldPulseAuthoringDoc("2026-01-01", "2026-01-01")).toBe(false)
  })

  it("点开一次就落盘，重启不再亮", () => {
    const store = fakeStorage()
    expect(needsAuthoringDocPulse(store)).toBe(true)
    markAuthoringDocSeen(store)
    expect(store.dump()[AUTHORING_DOC_SEEN_KEY]).toBe(AUTHORING_DOC_REVISION)
    expect(needsAuthoringDocPulse(store)).toBe(false)
  })

  it("拿不到 localStorage 时按「没看过」处理，写失败也不抛", () => {
    expect(needsAuthoringDocPulse(throwingStorage)).toBe(true)
    expect(() => markAuthoringDocSeen(throwingStorage)).not.toThrow()
    // null（非浏览器环境）同理：亮，但不炸
    expect(needsAuthoringDocPulse(null)).toBe(true)
    expect(() => markAuthoringDocSeen(null)).not.toThrow()
  })
})
