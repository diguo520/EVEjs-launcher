import { describe, expect, it, afterEach } from "vitest"

import { listSeparator, setActiveLocale, t } from "@/lib/i18n"
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
    expect(localizeEnvItem(item("Node.js 运行时", "Node v24.4.1（满足 ≥22）")).detail).toBe(
      "Node v24.4.1（满足 ≥22）"
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

  /**
   * 2026-10-01 报障：法语界面上红条那句是「Contrôle … : manquant 主服务器依赖、本地数据库…」——
   * 整句走了 `t()`，可拼进去的**项名**没走：翻译桥只认完整的文本节点，拼接出来的看不见。
   */
  it("项名跟着语言走（项名会被拼进红条那句「缺少 {list}」）", () => {
    setActiveLocale("fr")
    expect(localizeEnvItem(item("主服务器依赖", "x")).name).toBe("Dépendances du serveur principal")
    expect(localizeEnvItem(item("本地数据库", "x")).name).toBe("Base de données locale")
    expect(localizeEnvItem(item("市场服务二进制", "x")).name).toBe("Binaire du service marché")
    expect(localizeEnvItem(item("客户端路径", "x")).name).toBe("Chemin du client")
    expect(localizeEnvItem(item("客户端证书 CA", "x")).name).toBe("CA du certificat client")

    setActiveLocale("en")
    expect(localizeEnvItem(item("主服务器依赖", "x")).name).toBe("Primary server dependencies")
  })

  it("静态读数也走目录（复制出来的报告里不留中文）", () => {
    setActiveLocale("en")
    expect(localizeEnvItem(item("主服务器依赖", "server/node_modules 已就绪")).detail).toBe(
      "server/node_modules is ready"
    )
    expect(localizeEnvItem(item("市场服务二进制", "release 二进制已构建")).detail).toBe(
      "release binary has been built"
    )
    expect(localizeEnvItem(item("客户端证书 CA", "CA 证书缺失")).detail).toBe("CA certificate missing")
    expect(localizeEnvItem(item("客户端路径", "未配置 EVEJS_CLIENT_PATH")).detail).toBe(
      "EVEJS_CLIENT_PATH not configured"
    )
  })

  it("修复指引与按钮文案跟着语言走，按钮里的项名也换掉", () => {
    setActiveLocale("en")
    const localized = localizeEnvItem({
      ...item("主服务器依赖", "缺少 server/node_modules（express 未安装）"),
      ok: false,
      level: "missing",
      fix: {
        hint: "缺少 server/node_modules（express 未安装）",
        action: "执行「主服务器依赖」初始化",
        okDetail: "server/node_modules 已就绪",
        done: "{name} 初始化已执行，重新自检确认结果。",
      },
    })
    expect(localized.fix?.hint).toBe("Missing server/node_modules (express not installed)")
    expect(localized.fix?.action).toBe('Executing "Primary server dependencies" initialization')
    expect(localized.fix?.okDetail).toBe("server/node_modules is ready")
  })

  it("项名里没有的按钮文案走目录，翻不到就原样", () => {
    setActiveLocale("fr")
    const prototype = localizeEnvItem({
      ...item("客户端证书 CA", "未检测到"),
      ok: false,
      level: "missing",
      fix: {
        hint: "换过机器之后证书就没了。",
        action: "重新签发证书",
        okDetail: "bin\\ca.crt",
        done: "证书已重新签发。",
      },
    })
    expect(prototype.fix?.action).toBe("Réémettre le certificat")
  })

  /**
   * 端到端那条：把启动横幅与自检面板拼句子的方式照抄一遍，断言**最终整句**里没有汉字。
   * 只测单项会漏掉「句子翻了、拼进去的项名没翻」这类缺口 —— 这次报障正是这么来的。
   */
  it("拼好的整句在法语下不含任何中文", () => {
    setActiveLocale("fr")
    const names = ["主服务器依赖", "本地数据库", "市场服务二进制", "客户端路径", "客户端证书 CA"].map(
      (name) => localizeEnvItem(item(name, "x")).name
    )
    const list = names.join(listSeparator())
    for (const key of [
      "环境自检门禁未放行：缺少 {list}，照环境自检里的指引补上再启动。",
      "缺少 {list}，补上后即可启动",
      "缺少 {list}，一键启动已被挡住；照下面每项的指引补上就会放行。",
    ]) {
      const sentence = t(key, { list })
      expect(sentence, key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(list).not.toContain("、")
  })
})