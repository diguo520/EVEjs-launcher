import { describe, expect, it } from "vitest"

import {
  fleetComposition,
  theatreComposition,
  type FleetTypeLine,
  type TheatreBattleReport,
} from "@/lib/km-ships"

describe("会战来源：双方各有什么船", () => {
  const report: TheatreBattleReport = {
    theatreID: 7,
    systemID: 30000142,
    systemName: "吉他",
    sides: [
      {
        key: "frat",
        factions: ["frat", "nc"],
        committed: [
          { hullKey: "amarr_titan", typeID: 11567, count: 3, value: 300 },
          { hullKey: "caldari_dread", typeID: 19720, count: 12, value: 120 },
        ],
        lost: [{ hullKey: "amarr_titan", typeID: 11567, count: 1, value: 100 }],
      },
      {
        key: "snuffed",
        factions: ["snuffed"],
        committed: [{ hullKey: "minmatar_titan", count: 2 }],
        lost: [],
      },
    ],
  }

  it("按舰型列出每一侧的船，两侧各自成表", () => {
    const sides = theatreComposition(report)
    expect(sides.map((s) => s.key)).toEqual(["frat", "snuffed"])
    expect(sides[0].source).toBe("theatre")
    // 无畏 12 艘排前面，泰坦 3 艘在后
    expect(sides[0].lines.map((l) => l.name)).toEqual(["caldari_dread", "amarr_titan"])
    expect(sides[0].lines.map((l) => l.count)).toEqual([12, 3])
  })

  it("同一型的 committed 与 lost 合并到同一行，不拆成两行", () => {
    const frat = theatreComposition(report)[0]
    const titan = frat.lines.find((l) => l.name === "amarr_titan")!
    // 投 3 艘、其中 1 艘被打掉 → 仍然是一行
    expect(titan.lost).toBe(1)
    expect(frat.lines.filter((l) => l.name === "amarr_titan")).toHaveLength(1)
  })

  it("认得出中文舰名就用中文名", () => {
    const names = new Map([[11567, "神使级"], [19720, "莫洛级"]])
    const sides = theatreComposition(report, names)
    expect(sides[0].lines.map((l) => l.name)).toEqual(["莫洛级", "神使级"])
  })

  it("模组没给价值的行标成 valueUnknown，不用 0 冒充不值钱", () => {
    const sides = theatreComposition(report)
    const dread = sides[0].lines.find((l) => l.name === "caldari_dread")!
    const titan = sides[1].lines[0]
    expect(dread.valueUnknown).toBe(false)
    expect(titan.valueUnknown).toBe(true)
    expect(titan.value).toBe(0)
  })

  it("艘数是这一侧的总数", () => {
    const sides = theatreComposition(report)
    expect(sides[0].ships).toBe(15) // 12 + 3
    expect(sides[1].ships).toBe(2)
  })

  it("空报告 / 没有 sides 不炸，返回空数组", () => {
    expect(theatreComposition(null)).toEqual([])
    expect(theatreComposition(undefined)).toEqual([])
    expect(theatreComposition({ sides: [] })).toEqual([])
  })

  it("数量和名字缺省或非法时不产生垃圾行", () => {
    const messy: TheatreBattleReport = {
      sides: [
        {
          key: "a",
          committed: [
            { hullKey: "", count: 5 },
            { hullKey: "ok", count: 0 },
            { hullKey: "neg", count: -3 },
            { hullKey: "nan", count: NaN as unknown as number },
          ],
          lost: [],
        },
      ],
    }
    expect(theatreComposition(messy)[0].lines).toEqual([])
  })
})

describe("普通交战来源：舰队回查合并", () => {
  const sides = [
    { key: "left", fleets: [{ id: 1, power: 100 }, { id: 2, power: 50 }] },
    { key: "right", fleets: [{ id: 3, power: 80 }] },
  ]
  const types = new Map<number, FleetTypeLine[]>([
    [1, [{ name: "战列舰", count: 10 }, { name: "护卫舰", count: 4 }]],
    [2, [{ name: "战列舰", count: 5 }]],
    [3, [{ name: "巡洋舰", count: 7 }]],
  ])

  it("把各舰队的舰型合并成这一侧的清单", () => {
    const out = fleetComposition(sides, types)
    expect(out.map((s) => s.key)).toEqual(["left", "right"])
    expect(out[0].source).toBe("fleet")
    // 战列舰 10 + 5 = 15 排第一
    expect(out[0].lines.map((l) => l.name)).toEqual(["战列舰", "护卫舰"])
    expect(out[0].lines.map((l) => l.count)).toEqual([15, 4])
    expect(out[0].ships).toBe(19)
  })

  it("舰队查不到构成时只记 unknownFleets，不编造行", () => {
    const partial = new Map<number, FleetTypeLine[]>([[1, [{ name: "战列舰", count: 10 }]]])
    const out = fleetComposition(sides, partial)
    expect(out[0].unknownFleets).toBe(1) // fleet 2 查不到
    expect(out[0].lines.map((l) => l.name)).toEqual(["战列舰"])
    // 一个都查不到时 lines 为空、缺口数如实报出
    expect(fleetComposition(sides, new Map())[0].lines).toEqual([])
    expect(fleetComposition(sides, new Map())[0].unknownFleets).toBe(2)
  })

  it("舰队构成来源没有价值，一律标 valueUnknown", () => {
    expect(fleetComposition(sides, types)[0].lines.every((l) => l.valueUnknown)).toBe(true)
  })

  it("普通交战没有损失明细，lost 一律 0（不猜）", () => {
    expect(fleetComposition(sides, types)[0].lines.every((l) => l.lost === 0)).toBe(true)
  })

  it("空输入不炸", () => {
    expect(fleetComposition([], types)).toEqual([])
    expect(fleetComposition([{ key: "a", fleets: [] }], types)).toEqual([
      { key: "a", source: "fleet", ships: 0, unknownFleets: undefined, lines: [] },
    ])
  })
})
