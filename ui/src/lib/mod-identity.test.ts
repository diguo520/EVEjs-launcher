import { describe, expect, it } from "vitest"

import {
  AUTHOR_NAME_PLACEHOLDER,
  displayAuthor,
  EVEJS_ID_PREFIX,
  hasOwnSignature,
  modIdFromName,
  signatureDraft,
  stripEvejsPrefix,
  UNSIGNED_AUTHOR,
  validateNewMod,
  withEvejsPrefix,
} from "@/lib/mod-logic"

/**
 * 「标识由模组名派生」这条规则是创建模组的入口约束（作者不单独输入 id），
 * 这里锁住两件事：中文名要转成拼音字母、派生结果必须落在 id 字符集里。
 */
describe("modIdFromName", () => {
  it("拉丁名字照旧走短横拼接", () => {
    expect(modIdFromName("Sansha Incursion")).toBe("sansha-incursion")
    expect(modIdFromName("my first mod")).toBe("my-first-mod")
  })

  it("中文名字转成拼音字母，不再落空", () => {
    expect(modIdFromName("三沙冲突")).toBe("san-sha-chong-tu")
    expect(modIdFromName("我的第一个模组")).toBe("wo-de-di-yi-ge-mo-zu")
  })

  it("推不出可用字符时返回空串，交给校验拦下", () => {
    expect(modIdFromName("★★★")).toBe("")
    expect(modIdFromName("   ")).toBe("")
    expect(modIdFromName("")).toBe("")
  })

  it("派生结果只含小写字母、数字与短横，拼上前缀即可落盘", () => {
    for (const name of ["三沙冲突", "Test Mod 2", "EVEJS 测试"]) {
      const id = modIdFromName(name)
      expect(id).toMatch(/^[a-z0-9-]+$/)
      expect(withEvejsPrefix(id)).toBe(`${EVEJS_ID_PREFIX.toLowerCase()}${id}`)
      expect(stripEvejsPrefix(withEvejsPrefix(id))).toBe(id)
    }
  })
})

describe("validateNewMod 与派生标识", () => {
  it("名字推不出标识时给出换名字的提示", () => {
    const error = validateNewMod({ name: "★★★", id: modIdFromName("★★★") }, [])
    expect(error?.message).toContain("推不出可用的标识")
  })

  it("派生标识撞上已有模组目录时拦下并点名目录", () => {
    const existing = [withEvejsPrefix(modIdFromName("三沙冲突"))]
    const error = validateNewMod(
      { name: "三沙冲突", id: modIdFromName("三沙冲突") },
      existing
    )
    expect(error?.message).toContain("已经被占用")
    expect(error?.detail).toContain("evejs-san-sha-chong-tu")
  })

  it("派生标识可用时放行", () => {
    expect(
      validateNewMod({ name: "三沙冲突", id: modIdFromName("三沙冲突") }, ["evejs-other"])
    ).toBeNull()
  })
})

/**
 * 署名里的占位提示不是真署名：后端给「没填过」的身份落盘的就是这串字
 * （src-tauri/src/author.rs 的 DEFAULT_NAME），读回来必须还原成空 ——
 * 否则输入框里显示的是一个替你填好的预设，作者栏还会把「指挥官」当成用户自己的名。
 */
describe("署名占位提示的处理", () => {
  it("占位提示还原成空，输入框只余下灰色提示", () => {
    expect(signatureDraft(AUTHOR_NAME_PLACEHOLDER)).toBe("")
    expect(signatureDraft(`  ${AUTHOR_NAME_PLACEHOLDER}  `)).toBe("")
    expect(signatureDraft("影歌")).toBe("影歌")
    expect(signatureDraft("   ")).toBe("")
  })

  it("占位提示不算填过署名，作者栏退回「未署名」", () => {
    expect(hasOwnSignature(AUTHOR_NAME_PLACEHOLDER)).toBe(false)
    expect(hasOwnSignature("")).toBe(false)
    expect(hasOwnSignature("影歌")).toBe(true)
    expect(displayAuthor(AUTHOR_NAME_PLACEHOLDER)).toBe(UNSIGNED_AUTHOR)
    expect(displayAuthor("影歌")).toBe("影歌")
  })
})