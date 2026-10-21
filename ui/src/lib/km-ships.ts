/**
 * KM「双方各有什么船」的数据层。
 *
 * 需求：在每一侧的列表下，列出**该方参战的舰船**，不论联盟会战、军团战还是普通交战。
 *
 * 模组有两套来源，形状不同，这里统一成同一种行：
 *   · **会战（theatre）** —— `/api/theatre` 的 `history[].battleReport.sides[]` 带
 *     `committed` / `lost`，**已经是按舰型（hullKey）的明细**，直接可用（首选）；
 *   · **普通交战（encounter）** —— `/api/military` 的 `sides[].committed` 只有
 *     `fleetID → 战力`，**没有舰型**，要拿每个 fleetID 去 `/api/fleet?id=` 取 `types[]` 再合并。
 *
 * ⚠️ 两条来源的**可信度不同**，不能混为一谈：
 *   · 会战的 committed 是"这一场打的时候就投了这些船"，是历史事实；
 *   · 普通交战走的是"舰队**现在**的构成"，战斗结束后舰队可能已经补员、被击沉或改编，
 *     所以它只是**近似**。界面必须如实标注，不能当成精确的参战记录。
 */

/** `/api/theatre` → history[] → battleReport.sides[] 的一行舰型明细 */
export interface TheatreHullLine {
  hullKey: string
  count: number
  /** 模组认得出舰型时给的 typeID（可据此查中文名） */
  typeID?: number
  /** 这 N 艘的估值（ISK）；模组算不出来时缺省 */
  value?: number
}

export interface TheatreSide {
  key: string
  role?: string
  /** 这一侧的成员势力 key */
  factions?: string[]
  /** 这一场投进去的船（按舰型） */
  committed: TheatreHullLine[]
  /** 这一场打掉的船（按舰型） */
  lost: TheatreHullLine[]
}

export interface TheatreBattleReport {
  theatreID?: number
  systemID?: number | null
  systemName?: string | null
  outcome?: string | null
  endedAt?: number | null
  winnerSide?: string | null
  sides: TheatreSide[]
}

/** `/api/fleet?id=` 的 `types[]`：舰队当前的舰型构成 */
export interface FleetTypeLine {
  name: string
  count: number
}

/** 统一后的展示行：一侧的一种船 */
export interface SideShipLine {
  /** 排序与合并用的稳定键；typeID 优先，退化成船名 */
  id: string
  /** 展示名（中文舰名；取不到就是 hullKey 或模组给的 role 名） */
  name: string
  /** 这一侧这一型有多少艘 */
  count: number
  /** 这一型这一场的损失数（会战来源才有；普通交战缺省 0） */
  lost: number
  /** 这一型的估值（ISK）。缺省 0 表示模组没给，不代表不值钱 */
  value: number
  /** 这一型的价值是不是**没有记录**（不能用 0 冒充"不值钱"） */
  valueUnknown: boolean
}

/** 一侧的完整构成 */
export interface SideComposition {
  key: string
  /** 来源：会战报告是精确的，舰队回查是近似的 */
  source: "theatre" | "fleet"
  /** 这一侧投进来的总艘数 */
  ships: number
  /** 查不到舰型构成的舰队数（普通交战来源才有）。界面要如实提示，不能当 0 */
  unknownFleets?: number
  lines: SideShipLine[]
}

function nameOfLine(line: TheatreHullLine, shipNames: Map<number, string> | undefined): string {
  if (line.typeID != null && shipNames) {
    const found = shipNames.get(line.typeID)
    if (found) return found
  }
  return line.hullKey
}

/**
 * 会战报告 → 双方的构成（**首选来源**，按舰型且为历史事实）。
 *
 * 合并口径：同一型在 committed 里出现多次（多个成员势力各投了一些）时按舰名/typeID 相加。
 * 排序：艘数降序，艘数相同按名字，保证两张表顺序稳定、不随对象键顺序跳。
 */
export function theatreComposition(
  report: TheatreBattleReport | null | undefined,
  shipNames?: Map<number, string>,
): SideComposition[] {
  if (!report || !Array.isArray(report.sides)) return []
  return report.sides.map((side) => {
    const merged = new Map<string, SideShipLine>()
    const touch = (line: TheatreHullLine): SideShipLine | null => {
      if (!line.hullKey) return null
      const id = line.typeID != null ? `t${line.typeID}` : `k${line.hullKey}`
      const found = merged.get(id)
      if (found) return found
      const created: SideShipLine = {
        id,
        name: nameOfLine(line, shipNames),
        count: 0,
        lost: 0,
        value: 0,
        valueUnknown: false,
      }
      merged.set(id, created)
      return created
    }
    // 参战数量**只**来自 committed —— lost 是它的子集，不能重复加进数量，
    // 否则「这一侧有多少船」会把被打掉的那批算两遍（测试抓过这个 bug）。
    for (const line of side.committed ?? []) {
      const count = Math.max(0, Math.floor(Number(line.count) || 0))
      // 先验数量再建行：0 / 负数 / NaN 的条目不该在表里留一个空壳行
      if (count <= 0) continue
      const row = touch(line)
      if (!row) continue
      row.count += count
      const value = Number(line.value)
      if (Number.isFinite(value) && value > 0) row.value += Math.round(value)
      else row.valueUnknown = true
    }
    for (const line of side.lost ?? []) {
      const count = Math.max(0, Math.floor(Number(line.count) || 0))
      if (count <= 0) continue
      const row = touch(line)
      if (!row) continue
      row.lost += count
      // 只出现在 lost 里、committed 没记的型：用损失数兜底，避免出现 "0 艘却有损失" 的怪行
      if (row.count === 0) row.count = count
      const value = Number(line.value)
      if (Number.isFinite(value) && value > 0) row.value += Math.round(value)
      else row.valueUnknown = true
    }
    const lines = [...merged.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    )
    return {
      key: String(side.key ?? ""),
      source: "theatre" as const,
      ships: lines.reduce((sum, line) => sum + line.count, 0),
      lines,
    }
  })
}

/**
 * 普通交战 → 双方的构成（**近似来源**）。
 *
 * `/api/military` 只给了 `sides[].committed` 的 `fleetID → 战力`，舰型要去
 * `/api/fleet?id=<fleetID>` 的 `types[]` 里回查。这里接收"已经查好的"结果：
 * 调用方负责发请求（见 km-page 里的取数），本函数只做合并，保持可单测。
 *
 * `fleetTypes` 是 fleetID → 该舰队的舰型行。查不到（舰队已解散 / 请求失败）时不编造，
 * 只把这一支舰队记成"未知"，让界面能如实显示缺口。
 */
export function fleetComposition(
  sides: { key: string; fleets: { id: number; power: number }[] }[],
  fleetTypes: Map<number, FleetTypeLine[]>,
): SideComposition[] {
  return sides.map((side) => {
    const merged = new Map<string, SideShipLine>()
    let unknownFleets = 0
    for (const fleet of side.fleets) {
      const types = fleetTypes.get(fleet.id)
      if (!types || types.length === 0) {
        unknownFleets += 1
        continue
      }
      for (const type of types) {
        const name = String(type.name ?? "").trim()
        const count = Math.max(0, Math.floor(Number(type.count) || 0))
        if (!name || count <= 0) continue
        const found = merged.get(name) ?? {
          id: "n" + name,
          name,
          count: 0,
          lost: 0,
          value: 0,
          valueUnknown: true,
        }
        found.count += count
        merged.set(name, found)
      }
    }
    const lines = [...merged.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    )
    return {
      key: String(side.key ?? ""),
      source: "fleet" as const,
      ships: lines.reduce((sum, line) => sum + line.count, 0),
      // 只报数、不编造行：查不到构成的舰队单列一个缺口读数
      unknownFleets: unknownFleets > 0 ? unknownFleets : undefined,
      lines,
    }
  })
}
