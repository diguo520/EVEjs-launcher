import { describe, expect, it } from "vitest"

import {
  AUTHORING_DOC_REVISION,
  AUTHORING_DOC_SEEN_KEY,
  markAuthoringDocSeen,
  needsAuthoringDocPulse,
  shouldPulseAuthoringDoc,
} from "@/lib/mod-doc-seen"
import { fakeStorage, throwingStorage } from "@/test/fake-storage"

// B4（2026-10-29）：假存储夹具收在 ui/src/test/fake-storage.ts（与 legal-notice.test 共用）

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
