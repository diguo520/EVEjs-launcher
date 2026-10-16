import { describe, expect, it } from "vitest"

import { formatMB } from "@/lib/mock"
import { toMB } from "@/lib/mod-source"

describe("formatMB（安装包体积读数）", () => {
  it("按量级换单位", () => {
    expect(formatMB(0.1)).toBe("0.1 MB")
    expect(formatMB(18.4)).toBe("18.4 MB")
    expect(formatMB(128.4)).toBe("128.4 MB")
    expect(formatMB(1024)).toBe("1.00 GB")
    expect(formatMB(1536)).toBe("1.50 GB")
  })

  it("不足 0.1 MB 的包按 KB 读，不写成 0.0 MB", () => {
    expect(formatMB(0.0054)).toBe("5.5 KB")
    expect(formatMB(0.0456)).toBe("46.7 KB")
    // 贴着 0.1 MB 那一档时进位到整数 KB
    expect(formatMB(0.099)).toBe("101 KB")
  })

  it("体积拿不到画破折号，不编一个 0.0 出来", () => {
    expect(formatMB(0)).toBe("—")
    expect(formatMB(-1)).toBe("—")
    expect(formatMB(Number.NaN)).toBe("—")
  })

  it("与 toMB 串起来读：5663 B 的包读成 5.5 KB（2026-10-16 报障现场）", () => {
    expect(formatMB(toMB(5663))).toBe("5.5 KB")
  })
})
