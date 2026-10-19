import { describe, expect, it } from "vitest"

import { parseFavoriteIds, toggleFavoriteId } from "@/lib/mod-favorites"

describe("模组收藏", () => {
  it("只接受非空字符串 id，并去重", () => {
    expect(parseFavoriteIds(null)).toEqual([])
    expect(parseFavoriteIds("not json")).toEqual([])
    expect(parseFavoriteIds('{"id":"x"}')).toEqual([])
    expect(parseFavoriteIds('["a","a","", 3, null, " b "]')).toEqual(["a", "b"])
  })

  it("收藏与取消收藏是二元切换", () => {
    expect(toggleFavoriteId([], "a")).toEqual(["a"])
    expect(toggleFavoriteId(["a"], "a")).toEqual([])
    expect(toggleFavoriteId(["a", "b"], "c")).toEqual(["a", "b", "c"])
    expect(toggleFavoriteId(["a"], "")).toEqual(["a"])
  })
})
