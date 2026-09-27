import { describe, expect, it } from "vitest"

import {
  EMPTY_CLIENT_DRAFT,
  EMPTY_SERVER_DRAFT,
  clientDraftFrom,
  clientPatchOf,
  flagOf,
  serverDraftFrom,
  startMarketOf,
  switchOf,
} from "@/lib/config-map"
import type { RawConfigBundle } from "@/lib/ipc"

const BUNDLE: RawConfigBundle = {
  server: {
    ports: { game: 26000, images: 26001, gateway: 26002 },
    sourceFile: "E:\\Games\\EveJS-v0.12.8\\config\\server.json",
  },
  client: {
    clientPath: "E:\\Games\\EVE",
    clientExe: "Exefile.exe",
    caPem: "E:\\Games\\EVE\\bin\\ca.crt",
    proxyUrl: "127.0.0.1:26002",
    safeGraphics: "off",
    safeWindowed: "on",
    sourceFile: "E:\\Games\\EveJS-v0.12.8\\config\\EvEJSConfig.bat",
  },
}

describe("serverDraftFrom", () => {
  it("没有回包时全部留空，不拿原型演示值填", () => {
    expect(serverDraftFrom(null, "")).toEqual(EMPTY_SERVER_DRAFT)
  })

  it("端口取真值（不是原型里的 3001 / 8080），根目录用外壳传进来的那份", () => {
    const draft = serverDraftFrom(BUNDLE, "E:\\Games\\EveJS-v0.12.8")
    expect(draft.gamePort).toBe("26000")
    expect(draft.imagesPort).toBe("26001")
    expect(draft.gatewayPort).toBe("26002")
    expect(draft.sourcePath).toContain("server.json")
    expect(draft.root).toBe("E:\\Games\\EveJS-v0.12.8")
  })
})

describe("clientDraftFrom", () => {
  it("没有回包时留空", () => {
    expect(clientDraftFrom(null)).toEqual(EMPTY_CLIENT_DRAFT)
  })

  it("五个字段各自对上客户端的真配置", () => {
    const draft = clientDraftFrom(BUNDLE)
    expect(draft.path).toBe("E:\\Games\\EVE")
    expect(draft.exe).toBe("Exefile.exe")
    expect(draft.caPem).toBe("E:\\Games\\EVE\\bin\\ca.crt")
    expect(draft.proxy).toBe("127.0.0.1:26002")
    expect(draft.scriptPath).toContain("EvEJSConfig.bat")
  })
})

describe("clientPatchOf", () => {
  it("只带写通道认得的四个字段，并去掉首尾空白", () => {
    const patch = clientPatchOf({
      path: "  E:\\Games\\EVE  ",
      exe: " Exefile.exe ",
      caPem: " ca.crt ",
      proxy: " 127.0.0.1:26002 ",
      scriptPath: "不该被写进去",
    })
    expect(patch).toEqual({
      clientPath: "E:\\Games\\EVE",
      clientExe: "Exefile.exe",
      caPem: "ca.crt",
      proxyUrl: "127.0.0.1:26002",
    })
    expect(Object.keys(patch)).toHaveLength(4)
  })
})

describe("开关换算", () => {
  it("只有 on 算打开，其它（含缺省）都算关闭", () => {
    expect(switchOf("on")).toBe(true)
    expect(switchOf("ON")).toBe(true)
    expect(switchOf(" off")).toBe(false)
    expect(switchOf("")).toBe(false)
    expect(switchOf(undefined)).toBe(false)
    expect(switchOf(null)).toBe(false)
  })

  it("反向写回就是 on / off", () => {
    expect(flagOf(true)).toBe("on")
    expect(flagOf(false)).toBe("off")
  })
})

describe("startMarketOf", () => {
  it("设置里没写过就是开（与后端 read_setting_bool 的缺省一致）", () => {
    expect(startMarketOf(null)).toBe(true)
    expect(startMarketOf({})).toBe(true)
    expect(startMarketOf({ startMarket: true })).toBe(true)
  })

  it("只有显式 false 才算关", () => {
    expect(startMarketOf({ startMarket: false })).toBe(false)
  })
})