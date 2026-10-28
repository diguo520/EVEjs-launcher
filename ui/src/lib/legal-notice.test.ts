import { describe, expect, it } from "vitest"

import {
  LEGAL_NOTICE_SEEN_KEY,
  markLegalNoticeSeen,
  needsLegalNotice,
} from "@/lib/legal-notice"
import { fakeStorage, throwingStorage } from "@/test/fake-storage"

// B4（2026-10-29）：假存储夹具收在 ui/src/test/fake-storage.ts（与 mod-doc-seen.test 共用）

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
