import { describe, expect, it, afterEach } from "vitest"

import { setActiveLocale } from "@/lib/i18n"
import { localizeEnvItem } from "@/lib/env-i18n"
import type { CheckItem } from "@/lib/mock"

/** 造一条自检项：只关心 name / detail 的本地化 */
function item(name: string, detail: string): CheckItem {
  return { id: "x", name, detail, ok: true, level: "ok", blocking: true }
}

afterEach(() => setActiveLocale("zh"))

/**
 * 2026-09-30 报障：环境自检里 VS 构建工具与客户端路径两行显示成 `已安装：{path}` /
 * `客户端: {path}` —— 占位符名字按捕获组下标取，除第一条外全对不上，值没填进去。
 */
describe("localizeEnvItem", () => {
  it("带变量的读数按模板回填，不是把 {path} 原样显示", () => {
    setActiveLocale("zh")
    expect(localizeEnvItem(item("VS C++ 构建工具", "已安装：C:\\Build Tools")).detail).toBe(
      "已安装：C:\\Build Tools"
    )
    expect(localizeEnvItem(item("客户端路径", "客户端: D:\\EVE")).detail).toBe("客户端: D:\\EVE")
    expect(localizeEnvItem(item("客户端路径", "路径不存在: D:\\EVE")).detail).toBe(
      "路径不存在: D:\\EVE"
    )
    expect(localizeEnvItem(item("Rust / Cargo 工具链", "工具链不完整（仅检测到 cargo）")).detail).toBe(
      "工具链不完整（仅检测到 cargo）"
    )
    expect(localizeEnvItem(item("Node.js 运行时", "Node v24.4.1（满足 ≥24）")).detail).toBe(
      "Node v24.4.1（满足 ≥24）"
    )
  })

  it("换语言时变量跟着走，路径不会被吞掉", () => {
    setActiveLocale("en")
    expect(localizeEnvItem(item("VS C++ 构建工具", "已安装：C:\\Build Tools")).detail).toBe(
      "Installed: C:\\Build Tools"
    )
    expect(localizeEnvItem(item("客户端路径", "客户端: D:\\EVE")).detail).toBe("Client: D:\\EVE")
  })

  it("标签后缀精简与静态读数不受影响", () => {
    setActiveLocale("zh")
    expect(localizeEnvItem(item("VS C++ 构建工具", "安装了 C++ 负载")).name).toBe("VS C++")
    expect(localizeEnvItem(item("服务器依赖", "server/node_modules 已就绪")).detail).toBe(
      "server/node_modules 已就绪"
    )
  })
})