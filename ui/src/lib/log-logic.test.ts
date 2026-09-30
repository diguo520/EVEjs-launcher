import { describe, expect, it } from "vitest"

import type { LogLine } from "@/lib/mock"
import {
  filterLogs,
  levelCounts,
  lineKey,
  logTabOf,
  matchKeyword,
  matchLogTab,
  overlapTail,
  pruneLogs,
  renderLogLines,
  renderSegments,
  splitHits,
} from "@/lib/log-logic"
import { getActiveLocale, setActiveLocale, translate } from "@/lib/i18n"

function line(partial: Partial<LogLine> & Pick<LogLine, "src" | "msg">): LogLine {
  return {
    id: 0,
    t: "12:00:00",
    level: "INFO",
    ...partial,
  }
}

const LINES: LogLine[] = [
  line({ id: 1, src: "node", msg: "server listening on 26000" }),
  line({ id: 2, src: "gateway", msg: "gateway ready", level: "WARN" }),
  line({ id: 3, src: "market", msg: "market tick ok" }),
  line({ id: 4, src: "client", msg: "Character Login OK", level: "ERROR" }),
  line({ id: 5, src: "images", msg: "image cache warm", level: "DEBUG" }),
]

describe("matchLogTab", () => {
  it("sys 页签只收启动器自己的记录（MOD / 功能启停），不收各服务的原始输出", () => {
    expect(matchLogTab("sys", "sys")).toBe(true)
    expect(matchLogTab("node", "sys")).toBe(false)
    expect(matchLogTab("server", "sys")).toBe(false)
    expect(matchLogTab("gateway", "sys")).toBe(false)
    expect(matchLogTab("images", "sys")).toBe(false)
    expect(matchLogTab("market", "sys")).toBe(false)
    expect(matchLogTab("client", "sys")).toBe(false)
  })

  it("node 页签收主服务器的实时流与日志文件（node/server/gateway/images）", () => {
    expect(matchLogTab("node", "node")).toBe(true)
    expect(matchLogTab("server", "node")).toBe(true)
    expect(matchLogTab("gateway", "node")).toBe(true)
    expect(matchLogTab("images", "node")).toBe(true)
    expect(matchLogTab("market", "node")).toBe(false)
    expect(matchLogTab("client", "node")).toBe(false)
  })

  it("market / client 页签各自只收自己", () => {
    expect(matchLogTab("market", "market")).toBe(true)
    expect(matchLogTab("gateway", "market")).toBe(false)
    expect(matchLogTab("client", "client")).toBe(true)
    expect(matchLogTab("node", "client")).toBe(false)
  })
})

describe("matchKeyword", () => {
  it("空关键字全通过（含纯空白）", () => {
    expect(matchKeyword(LINES[0], "")).toBe(true)
    expect(matchKeyword(LINES[0], "   ")).toBe(true)
  })

  it("大小写不敏感，且正文与来源都参与匹配", () => {
    expect(matchKeyword(LINES[3], "character login")).toBe(true)
    expect(matchKeyword(LINES[3], "CLIENT")).toBe(true)
    expect(matchKeyword(LINES[3], "26000")).toBe(false)
  })
})

describe("filterLogs", () => {
  it("三道过滤按 页签 → 关键字 → 级别 收窄", () => {
    expect(filterLogs(LINES).length).toBe(5)
    expect(filterLogs(LINES, { tab: "node" }).map((l) => l.id)).toEqual([1, 2, 5])
    // 系统页只认 src="sys"：这批行里一条都没有，所以是空的
    expect(filterLogs(LINES, { tab: "sys" })).toEqual([])
    expect(
      filterLogs(LINES, { tab: "node", keyword: "ready" }).map((l) => l.id)
    ).toEqual([2])
    expect(
      filterLogs(LINES, { level: "ERROR" }).map((l) => l.id)
    ).toEqual([4])
    expect(filterLogs(LINES, { tab: "market", level: "ERROR" })).toEqual([])
  })
})

describe("levelCounts", () => {
  it("all 是总行数，其余按级别计数（含 0）", () => {
    expect(levelCounts(LINES)).toEqual({
      all: 5,
      INFO: 2,
      WARN: 1,
      ERROR: 1,
      DEBUG: 1,
    })
    expect(levelCounts([]).all).toBe(0)
  })
})

describe("splitHits", () => {
  it("把命中片段切出来，保留原文大小写", () => {
    expect(splitHits("Server Ready OK", "ready")).toEqual([
      { text: "Server ", hit: false },
      { text: "Ready", hit: true },
      { text: " OK", hit: false },
    ])
  })

  it("多次命中都要标出来", () => {
    expect(splitHits("aXbXc", "x")).toEqual([
      { text: "a", hit: false },
      { text: "X", hit: true },
      { text: "b", hit: false },
      { text: "X", hit: true },
      { text: "c", hit: false },
    ])
  })

  it("空关键字与无命中都返回整段未命中", () => {
    expect(splitHits("hello", "")).toEqual([{ text: "hello", hit: false }])
    expect(splitHits("hello", "zzz")).toEqual([{ text: "hello", hit: false }])
  })
})
describe("lineKey / overlapTail", () => {
  it("指纹含 时间 / 级别 / 来源 / 正文，任一项不同就算不同行", () => {
    const a = line({ src: "server", msg: "x" })
    expect(lineKey(a)).toBe(lineKey({ ...a, id: 99 }))
    expect(lineKey(a)).not.toBe(lineKey({ ...a, msg: "y" }))
    expect(lineKey(a)).not.toBe(lineKey({ ...a, t: "12:00:01" }))
    expect(lineKey(a)).not.toBe(lineKey({ ...a, src: "node" }))
  })

  it("窗口整体下滑时只认重叠的那几行", () => {
    const prev = ["a", "b", "c", "d"]
    expect(overlapTail(prev, ["c", "d", "e"])).toBe(2)
    expect(overlapTail(prev, ["a", "b", "c", "d"])).toBe(4)
    expect(overlapTail(prev, ["b", "c", "d", "e", "f"])).toBe(3)
  })

  it("完全对不上（轮转 / 整段换掉）返回 0，交给调用方整批收下", () => {
    expect(overlapTail(["a", "b"], ["x", "y"])).toBe(0)
    expect(overlapTail([], ["x"])).toBe(0)
    expect(overlapTail(["a"], [])).toBe(0)
  })

  it("尾巴比这一批还长时也要能对上", () => {
    expect(overlapTail(["a", "b", "c", "d"], ["c", "d"])).toBe(2)
  })
})

describe("renderLogLines", () => {
  /** 一条「可重翻」的行：parts 是真相，msg 只是生成那一刻的快照 */
  const banner: LogLine = {
    id: 1,
    t: "12:00:00",
    level: "INFO",
    src: "sys",
    msg: "[启动器] 仓库: C:\\tq",
    parts: [{ key: "[启动器] 仓库: {path}", vars: { path: "C:\\tq" } }],
  }
  /** 服务端原始输出：死文本，没有也不该有译文 */
  const dead: LogLine = { id: 2, t: "12:00:00", level: "INFO", src: "node", msg: "服务端自己打的一行" }

  it("中文（源语言）重算前后一模一样", () => {
    expect(renderLogLines([banner, dead])[0]).toBe(banner)
    expect(renderLogLines([dead])[0]).toBe(dead)
  })

  it("切到外文后按当前语言重算；死文本连对象都不换", () => {
    const previous = getActiveLocale()
    setActiveLocale("en")
    try {
      const [first, second, third] = renderLogLines([
        banner,
        dead,
        { ...banner, id: 3, parts: ["启动序列完成"], msg: "启动序列完成" },
      ])
      expect(first.msg).toBe(translate("en", "[启动器] 仓库: {path}", { path: "C:\\tq" }))
      expect(first.msg).not.toBe(banner.msg)
      expect(second).toBe(dead)
      // 纯静态的一段（没有插值）也要跟着翻
      expect(third.msg).toBe(translate("en", "启动序列完成"))
    } finally {
      setActiveLocale(previous)
    }
  })

  it("数组变量按当前语言的列表分隔符拼：中文顿号、英文逗号", () => {
    const parts = [{ key: "冲突: {list}", vars: { list: ["m1", "m2"] } }]
    expect(renderSegments(parts)).toBe("冲突: m1、m2")
    const previous = getActiveLocale()
    setActiveLocale("en")
    try {
      expect(renderSegments(parts)).toBe(translate("en", "冲突: {list}", { list: "m1, m2" }))
    } finally {
      setActiveLocale(previous)
    }
  })
})

/**
 * 2026-09-30 报障：系统 / 市场 / 客户端三个页签的记录会「消失」—— 面板原本只有一个
 * 400 行的环形窗口，主服务器刷屏就会把它们挤出去。这一组钉住「按页签各留各的」。
 */
describe("logTabOf / pruneLogs", () => {
  it("来源归页签：主服务器名下的四种来源都算一页，认不出的不算", () => {
    expect(logTabOf("sys")).toBe("sys")
    expect(logTabOf("node")).toBe("node")
    expect(logTabOf("server")).toBe("node")
    expect(logTabOf("gateway")).toBe("node")
    expect(logTabOf("images")).toBe("node")
    expect(logTabOf("market")).toBe("market")
    expect(logTabOf("client")).toBe("client")
    expect(logTabOf("whatever")).toBeNull()
  })

  it("主服务器刷屏时，系统横幅与市场 / 客户端的记录一条都不掉", () => {
    const logs = [
      line({ src: "sys", msg: "[启动器] EvEJS Launcher v0.2.5" }),
      line({ src: "market", msg: "市场服务已就绪" }),
      line({ src: "client", msg: "客户端已就绪" }),
      ...Array.from({ length: 50 }, (_, index) => line({ src: "node", msg: `刷屏 ${index}` })),
    ]
    const kept = pruneLogs(logs, 10)
    expect(kept.filter((item) => item.src === "sys").map((item) => item.msg)).toEqual([
      "[启动器] EvEJS Launcher v0.2.5",
    ])
    expect(kept.filter((item) => item.src === "market")).toHaveLength(1)
    expect(kept.filter((item) => item.src === "client")).toHaveLength(1)
    // 超额的那一页签自己从最旧的开始丢，留下的正好是最后 10 条
    expect(kept.filter((item) => item.src === "node").map((item) => item.msg)).toEqual(
      Array.from({ length: 10 }, (_, index) => `刷屏 ${40 + index}`)
    )
    // 时间先后不能被重排：留下来的行仍是原来的相对次序
    expect(kept.map((item) => item.msg)).toEqual([
      "[启动器] EvEJS Launcher v0.2.5",
      "市场服务已就绪",
      "客户端已就绪",
      ...Array.from({ length: 10 }, (_, index) => `刷屏 ${40 + index}`),
    ])
  })

  it("没超额就原样返回（不复制、不动顺序）", () => {
    const logs = [line({ src: "sys", msg: "a" }), line({ src: "node", msg: "b" })]
    expect(pruneLogs(logs, 10)).toBe(logs)
  })

  it("认不出来源的行不参与截断：宁可留着，也别把没分类的记录悄悄丢掉", () => {
    const logs = Array.from({ length: 20 }, (_, index) => line({ src: "mystery", msg: `x${index}` }))
    expect(pruneLogs(logs, 5)).toHaveLength(20)
  })

  it("默认每页签 400 行：主服务器灌 1000 行也不会碰别的页签", () => {
    const logs = [
      line({ src: "sys", msg: "banner" }),
      ...Array.from({ length: 1000 }, (_, index) => line({ src: "node", msg: `n${index}` })),
    ]
    const kept = pruneLogs(logs)
    expect(kept.filter((item) => item.src === "sys")).toHaveLength(1)
    expect(kept.filter((item) => item.src === "node")).toHaveLength(400)
    expect(kept.filter((item) => item.src === "node")[0].msg).toBe("n600")
  })
})
