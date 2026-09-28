import { describe, expect, it } from "vitest"

import { changelogForLanguage, groupNotes, releaseNotesFrom } from "@/lib/release-notes"

describe("changelogForLanguage", () => {
  it("双语对象按语言取，缺了退回另一种", () => {
    const changelog = { zh: [{ type: "new", text: "中文" }], en: [{ type: "new", text: "en" }] }
    expect(changelogForLanguage(changelog, "zh")).toEqual([{ type: "new", text: "中文" }])
    expect(changelogForLanguage(changelog, "en")).toEqual([{ type: "new", text: "en" }])
    expect(changelogForLanguage({ zh: [{ type: "new", text: "中文" }] }, "en")).toEqual([
      { type: "new", text: "中文" },
    ])
  })

  it("单语言数组原样返回（老清单写法）", () => {
    const list = [{ type: "fix", text: "x" }]
    expect(changelogForLanguage(list, "zh")).toEqual(list)
  })

  it("被包了一层的数组拆开（与现役版 changelogForLanguage 对齐）", () => {
    const wrapped = [{ zh: [{ type: "opt", text: "中文" }], en: [{ type: "opt", text: "en" }] }]
    expect(changelogForLanguage(wrapped, "zh")).toEqual([{ type: "opt", text: "中文" }])
  })

  it("认不出来就当没有，不编内容", () => {
    expect(changelogForLanguage(null)).toEqual([])
    expect(changelogForLanguage("nope")).toEqual([])
    expect(changelogForLanguage({})).toEqual([])
    expect(changelogForLanguage([{ type: "new", text: "a" }, { type: "new", text: "b" }])).toHaveLength(2)
  })
})

describe("groupNotes", () => {
  it("按 新增 / 优化 / 修复 分组，顺序固定，空组不出现", () => {
    const groups = groupNotes([
      { type: "fix", text: "修好了" },
      { type: "new", text: "新加的" },
      { type: "new", text: "又一个" },
      { type: "opt", text: "快了点" },
    ])
    expect(groups).toEqual([
      { group: "新增", items: ["新加的", "又一个"] },
      { group: "优化", items: ["快了点"] },
      { group: "修复", items: ["修好了"] },
    ])
  })

  it("契约外的 type 收进「其它」，不丢内容", () => {
    const groups = groupNotes([{ type: "chore", text: "杂项" }, { text: "没写 type" }])
    expect(groups).toEqual([{ group: "其它", items: ["杂项", "没写 type"] }])
  })

  it("空文本与非对象条目直接丢掉", () => {
    expect(groupNotes([{ type: "fix", text: "   " }, null, 3, { type: "fix" }])).toEqual([])
  })
})

describe("releaseNotesFrom", () => {
  it("双语清单直接出中文分组", () => {
    const notes = releaseNotesFrom({
      zh: [{ type: "new", text: "中文新增" }],
      en: [{ type: "new", text: "en new" }],
    })
    expect(notes).toEqual([{ group: "新增", items: ["中文新增"] }])
  })
})
