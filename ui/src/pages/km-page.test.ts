import { describe, expect, it } from "vitest"

import { orderSidesForDisplay, sideTotalsCheck } from "@/pages/km-page"
import {
  battleReports,
  type BattleReport,
  type BattleSideReport,
  type FactionEvent,
} from "@/lib/faction-logic"

/**
 * KM 双阵营视图的**求和自检**与排序口径。
 *
 * 界面上两张阵营卡各自渲染自己的舰型损失，任何一侧漏掉一条，两卡看上去都还是"正常"的
 * （数字小了一点而已，没人能肉眼发现）。所以这里把「两侧合计 == 全场」钉成断言：
 * 卡片能画的数就是这些，画不全就必须当场红。
 */

/** 两方对打、各掉几条的最小事件流（含一条悬赏没结算的损失） */
function combatEvents(): FactionEvent[] {
  const loss = (
    id: number,
    factionKey: string,
    unitID: number,
    killer: string
  ): FactionEvent => ({
    id,
    at: id,
    factionKey,
    type: "loss",
    label: "战损",
    group: "combat",
    text: "",
    payload: { unitID, battleID: 44, systemID: 7, killer: { kind: "engagement", key: killer } },
  })
  const reward = (id: number, unitID: number, hullTypeID: number, value: number): FactionEvent => ({
    id,
    at: id,
    factionKey: "",
    type: "killReward",
    label: "悬赏",
    group: "combat",
    text: "",
    payload: { unitID, hullTypeID, value, amount: value },
  })
  return [
    loss(1, "hantan", 100, "taoyuan"),
    reward(2, 100, 24700, 54_249_688),
    loss(3, "hantan", 101, "taoyuan"),
    // 101 没有 killReward：悬赏没结算，舰型与价值都取不到，但损失确实发生了
    loss(4, "taoyuan", 200, "hantan"),
    reward(5, 200, 590, 1_000_000),
  ]
}

function side(key: string, lost: number, lostValue: number): BattleSideReport {
  return { key, lost, lostValue, kills: 0, killValue: 0, efficiency: 0, fleets: [] }
}

describe("KM 双阵营视图", () => {
  it("两侧舰型数量之和等于全场数量（含悬赏没结算的那一条）", () => {
    const report = battleReports(combatEvents())[0]
    const check = sideTotalsCheck(report)
    expect(check.shipsMatch).toBe(true)
    expect(check.valueMatch).toBe(true)
    expect(check.ships).toBe(report.totalLost)
    expect(check.value).toBe(report.totalValue)
    // 未知舰型那条也在账上：丢了它这一条就对不上了
    expect(check.ships).toBe(3)
    expect(report.sideShipLosses.flatMap((row) => row.losses).some((row) => row.typeID === null)).toBe(
      true
    )
  })

  it("只出手没挨打的一方也进合计（它是 0，但不许消失）", () => {
    const events: FactionEvent[] = [
      {
        id: 1,
        at: 1,
        factionKey: "a",
        type: "loss",
        label: "战损",
        group: "combat",
        text: "",
        payload: { unitID: 1, battleID: 12, systemID: 5, killer: { kind: "engagement", key: "b" } },
      },
    ]
    const report = battleReports(events)[0]
    const check = sideTotalsCheck(report)
    expect(check.shipsMatch).toBe(true)
    expect(check.ships).toBe(1)
    expect(report.sideShipLosses.map((row) => row.key).sort()).toEqual(["a", "b"])
  })

  it("整场无人掉船：合计是 0，对得上，也不会算出 NaN", () => {
    const report: BattleReport = {
      battleID: 1,
      firstAt: 0,
      lastAt: 0,
      systemID: 0,
      sides: [],
      shipLosses: [],
      sideShipLosses: [],
      kills: [],
      totalLost: 0,
      totalValue: 0,
    }
    const check = sideTotalsCheck(report)
    expect(check.ships).toBe(0)
    expect(check.value).toBe(0)
    expect(check.shipsMatch).toBe(true)
    expect(check.valueMatch).toBe(true)
    expect(Number.isNaN(check.ships)).toBe(false)
  })

  it("阵营卡排序：损失多的在左，平手比 ISK，再平手比 key（顺序确定）", () => {
    const ordered = orderSidesForDisplay([
      side("zulu", 2, 10),
      side("alpha", 5, 1),
      side("mike", 2, 999),
      side("bravo", 2, 999),
    ])
    expect(ordered.map((row) => row.key)).toEqual(["alpha", "bravo", "mike", "zulu"])
  })

  it("排序不改原数组，也不丢人", () => {
    const input = [side("b", 1, 1), side("a", 3, 1)]
    const snapshot = input.map((row) => row.key)
    const ordered = orderSidesForDisplay(input)
    expect(input.map((row) => row.key)).toEqual(snapshot)
    expect(ordered.map((row) => row.key)).toEqual(["a", "b"])
    expect(ordered).toHaveLength(2)
  })
})
