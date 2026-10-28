import { describe, expect, it } from "vitest"

import { formatBytes, toMB } from "@/lib/format"

/**
 * B2 的回归网：**逐条钉住五个调用方原来的口径**（改实现不改口径）。
 * 其中 `formatMB` 那 8 条来自 `mock.test.ts`（2026-10-16 报障的验收网），这里一并保留。
 */
describe("formatBytes", () => {
  it("mod-logic 口径：0 照实写、字节四舍五入、KB ≥100 取整、MB 一位小数", () => {
    const progress = (n: number) => formatBytes(n, { roundBytes: true })
    expect(progress(0)).toBe("0 B")
    expect(progress(512)).toBe("512 B")
    expect(progress(1536)).toBe("1.5 KB")
    expect(progress(200 * 1024)).toBe("200 KB")
    expect(progress(1024 * 1024)).toBe("1.0 MB")
    expect(progress(3.5 * 1024 * 1024)).toBe("3.5 MB")
    expect(progress(-1)).toBe("—")
    expect(progress(Number.NaN)).toBe("—")
  })

  it("mock 口径：0 视为未知、0.1 MB 以下按 KB、GB 两位小数", () => {
    const pkg = (mb: number) =>
      formatBytes(mb, {
        input: "MB",
        maxUnit: "GB",
        gbDigits: 2,
        dashZero: true,
        kbBelowMB: 0.1,
        allowBytes: false,
      })
    expect(pkg(0)).toBe("—")
    expect(pkg(-5)).toBe("—")
    expect(pkg(Number.NaN)).toBe("—")
    expect(pkg(0.05)).toBe("51.2 KB")
    expect(pkg(0.1)).toBe("0.1 MB")
    expect(pkg(0.099)).toBe("101 KB")
    expect(pkg(2)).toBe("2.0 MB")
    expect(pkg(1024)).toBe("1.00 GB")
    // 复核修正（2026-10-29）：不足 1 KiB 的包原本也按 KB 读，不能掉到字节档
    expect(pkg(0.0009)).toBe("0.9 KB")
    expect(pkg(0.0005)).toBe("0.5 KB")
  })

  it("存档日志口径：字节原样、不兜底（NaN 会照实写成 NaN B）", () => {
    const archive = (n: number) => formatBytes(n, { invalid: null, nanAsMaxUnit: true })
    expect(archive(500)).toBe("500 B")
    expect(archive(2048)).toBe("2.0 KB")
    expect(archive(200 * 1024)).toBe("200 KB")
    expect(archive(2 * 1024 * 1024)).toBe("2.0 MB")
    // 复核修正：非数值原本走 **MB 档**（写 `NaN MB`），不是字节档
    expect(archive(Number.NaN)).toBe("NaN MB")
    expect(archive(Number(undefined))).toBe("NaN MB")
    // 负数仍走字节档（旧行为：`-5 < 1024` 成立）
    expect(archive(-5)).toBe("-5 B")
  })

  it("静态数据页口径：有 GB 档、KB 永远取整、GB 一位小数", () => {
    const data = (n: number) =>
      formatBytes(n, { maxUnit: "GB", gbDigits: 1, mbDigits: 1, kbDigits: 0, kbRoundAbove100: false, invalid: null })
    expect(data(500)).toBe("500 B")
    expect(data(1536)).toBe("2 KB")
    expect(data(1.5 * 1024 * 1024)).toBe("1.5 MB")
    expect(data(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB")
    // 静态数据页的非数值确实走字节档（写 `NaN B`）——与存档日志不同，别一起改
    expect(data(Number.NaN)).toBe("NaN B")
  })

  it("toMB：0 / 空值回 0，其余保留一位小数", () => {
    expect(toMB(0)).toBe(0)
    expect(toMB(undefined)).toBe(0)
    expect(toMB(5 * 1024 * 1024)).toBe(5)
    expect(toMB(1.25 * 1024 * 1024)).toBe(1.3)
  })
})
