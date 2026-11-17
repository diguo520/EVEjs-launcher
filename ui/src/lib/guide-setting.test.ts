import { describe, expect, it } from "vitest"

import { GUIDE_ENABLED_KEY, readGuideEnabled, writeGuideEnabled } from "@/lib/guide-setting"
import { fakeStorage, throwingStorage } from "@/test/fake-storage"

describe("启动器引导开关（localStorage）", () => {
  it("没存过默认开启，写 0 后关闭，写 1 后开启", () => {
    const store = fakeStorage()
    expect(readGuideEnabled(store)).toBe(true)

    writeGuideEnabled(false, store)
    expect(store.dump()[GUIDE_ENABLED_KEY]).toBe("0")
    expect(readGuideEnabled(store)).toBe(false)

    writeGuideEnabled(true, store)
    expect(readGuideEnabled(store)).toBe(true)
  })

  it("拿不到 localStorage 时按默认开启处理，写失败不抛", () => {
    expect(readGuideEnabled(throwingStorage)).toBe(true)
    expect(() => writeGuideEnabled(false, throwingStorage)).not.toThrow()
    // null（非浏览器环境）同理
    expect(readGuideEnabled(null)).toBe(true)
    expect(() => writeGuideEnabled(false, null)).not.toThrow()
  })
})
