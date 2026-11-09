import { describe, expect, it } from "vitest"

import {
  DOWNLOADS,
  SERVER_VERSIONS,
  compareVersions,
  compatibleDeclaration,
  formatMB,
  latestServerVersion,
  resolveServerVersions,
} from "@/lib/mock"
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

describe("服务端版本清单（拼进 R2 地址的就是这些对象名）", () => {
  it("版本号按数值段比大小，不按字典序", () => {
    expect(compareVersions("261028.1", "261018.1")).toBeGreaterThan(0)
    expect(compareVersions("261028.1", "261028.1")).toBe(0)
    // 字典序会把这个比反：字符串上 "26120" < "2619"，数值上 26120 > 2619
    expect(compareVersions("26120", "2619")).toBeGreaterThan(0)
    expect(compareVersions("0.12.8", "0.12.10")).toBeLessThan(0)
    // 认不出的段当 0，不抛错
    expect(compareVersions("261028.1-rc1", "261028.1")).toBe(0)
  })

  it("最新那一版 = 版本号最大的那个", () => {
    const latest = latestServerVersion()
    expect(latest?.version).toBe("261028.1")
    for (const entry of SERVER_VERSIONS) {
      expect(compareVersions(latest!.version, entry.version)).toBeGreaterThanOrEqual(0)
    }
  })

  it("对象名都非空、不以斜杠开头、也不带 ..", () => {
    for (const entry of [DOWNLOADS.clientTorrent, ...SERVER_VERSIONS]) {
      expect(entry.file.length).toBeGreaterThan(0)
      expect(entry.file.startsWith("/")).toBe(false)
      expect(entry.file.includes("..")).toBe(false)
    }
  })

  it("远端清单有可用行就用远端，并按版本号从大到小排", () => {
    const resolved = resolveServerVersions([
      { file: "EveJS-261018.1.zip", version: "261018.1", size: "45.0 MB" },
      { file: "EveJS-261110.1.zip", version: "261110.1", size: "47.1 MB" },
    ])
    expect(resolved.map((row) => row.version)).toEqual(["261110.1", "261018.1"])
    expect(latestServerVersion(resolved)?.file).toBe("EveJS-261110.1.zip")
  })

  it("远端为空 / 不可用（网络失败、清单没传）时退回内置清单", () => {
    for (const remote of [null, undefined, [], [{ file: "", version: "" }]]) {
      expect(resolveServerVersions(remote as never)).toBe(SERVER_VERSIONS)
    }
  })
})
