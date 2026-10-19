import { describe, expect, it } from "vitest"

import { compatibleDeclaration, formatMB } from "@/lib/mock"
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

describe("compatibleDeclaration（新模组的兼容声明预设）", () => {
  it("日期版本号只保留日期段", () => {
    // 服务端 0.5.0 起是「日期.构建号」，同一天的构建都算兼容
    expect(compatibleDeclaration("261018.1")).toBe("261018.x")
    expect(compatibleDeclaration("261018.12")).toBe("261018.x")
  })

  it("老版本号去掉补丁位，两段的直接补 .x", () => {
    expect(compatibleDeclaration("0.12.8")).toBe("0.12.x")
    expect(compatibleDeclaration("0.12")).toBe("0.12.x")
  })

  it("预发布 / 构建后缀不做通配", () => {
    expect(compatibleDeclaration("0.12.8-rc.1")).toBe("0.12.8-rc.1")
    expect(compatibleDeclaration("")).toBe("")
  })
})
