import { describe, expect, it } from "vitest"

import {
  FACTION_MOD_ID,
  NAV_GROUPS,
  VIEW_META,
  visibleNavGroups,
  type NavGroup,
} from "@/components/shell/nav-config"

const groups: NavGroup[] = [
  { title: "控制", items: [{ id: "dashboard", label: "主控台", sub: "X", icon: NAV_GROUPS[0].items[0].icon }] },
  {
    title: "群星",
    requiresMod: FACTION_MOD_ID,
    items: [{ id: "faction", label: "势力", sub: "Y", icon: NAV_GROUPS[0].items[0].icon }],
  },
]

describe("导航分组按模组显隐", () => {
  it("装了模组就显示依赖它的那一组", () => {
    const visible = visibleNavGroups(groups, new Set([FACTION_MOD_ID]))
    expect(visible.map((group) => group.title)).toEqual(["控制", "群星"])
  })

  it("没装就整组隐藏（连标题一起），不依赖模组的分组照常显示", () => {
    const visible = visibleNavGroups(groups, new Set<string>())
    expect(visible.map((group) => group.title)).toEqual(["控制"])
    // 装了别的模组不算数
    expect(visibleNavGroups(groups, new Set(["evejs-perf-fix"])).map((g) => g.title)).toEqual(["控制"])
  })

  it("拿不到清单（浏览器预览）时全都显示，别让预览平白少一组", () => {
    expect(visibleNavGroups(groups, null).map((group) => group.title)).toEqual(["控制", "群星"])
  })
})

describe("群星分组的配置", () => {
  it("群星那一组挂的是 evejs-faction-sim，三个页面都在里面", () => {
    const group = NAV_GROUPS.find((item) => item.title === "群星")
    expect(group?.requiresMod).toBe("evejs-faction-sim")
    expect(group?.items.map((item) => item.id)).toEqual(["faction", "starmap", "km"])
  })

  it("每个导航项都有标题元数据（页头要按 view 取标题）", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(VIEW_META[item.id]?.title).toBe(item.label)
      }
    }
  })
})
