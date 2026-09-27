import { describe, expect, it } from "vitest"

import type { LogLine } from "@/lib/mock"
import {
  filterLogs,
  levelCounts,
  lineKey,
  matchKeyword,
  matchLogTab,
  overlapTail,
  splitHits,
} from "@/lib/log-logic"

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
  it("sys 页签不过滤任何来源", () => {
    for (const item of LINES) expect(matchLogTab(item.src, "sys")).toBe(true)
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
