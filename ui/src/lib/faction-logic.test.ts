import { describe, expect, it } from "vitest"

import {
  chunk,
  eventTone,
  FALLBACK_COLOR,
  factionTotals,
  filterFactions,
  fitTransform,
  formatSimClock,
  formatSpeed,
  formatUptime,
  mergeEvents,
  parseProbe,
  projectPoint,
  relationMap,
  relationsFor,
  sortFactions,
  starmapView,
  tierCounts,
  battleEventsFor,
  battleOutcomeTone,
  battleReports,
  battleRows,
  decodeRealmColumn,
  killRows,
  realmOwner,
  realmPolities,
  sovereigntyView,
  territoryPairsUp,
  umbrellaBuckets,
  umbrellaRange,
  umbrellaRows,
  umbrellaStateOf,
  umbrellaTone,
  type FactionBrief,
  type FactionEvent,
  type BattleView,
  type StarmapRaw,
  type UmbrellaView,
} from "@/lib/faction-logic"

function brief(overrides: Partial<FactionBrief> & { key: string; name: string }): FactionBrief {
  return {
    color: "#3b82f6",
    tier: "major",
    paused: false,
    morale: 1,
    power: 0,
    armedShips: 0,
    armedFleets: 0,
    fleets: { total: 0, ships: 0, inFlight: 0, docked: 0, byRole: [] },
    economy: {
      treasury: 0,
      stockUnits: 0,
      miningFleets: 0,
      jobs: 0,
      stuckCount: 0,
      gapCount: 0,
      targets: 0,
      tight: false,
      capital: { enabled: false, owned: {} },
    },
    military: { patrols: 0, scouts: 0, strikes: 0, capital: false, sightings: 0, alarms: 0, stuck: 0 },
    territory: { owned: 0, front: 0, contested: 0, middle: 0, rear: 0, presence: 0 },
    structures: { total: 0, online: 0, building: 0, reinforced: 0, destroyed: 0, influence: 0 },
    home: { systemID: 30000142, systemName: "Jita" },
    logistics: { open: 0, delivered: 0, lost: 0 },
    relations: [],
    relationCounts: { hostile: 0, friendly: 0, neutral: 0 },
    ...overrides,
  }
}

function rawStarmap(): StarmapRaw {
  return {
    count: 3,
    bounds: [0, 0, 10, 10],
    ids: [11, 22, 33],
    x: [0, 10, 5],
    y: [0, 0, 10],
    sec: [0.9, -0.2, 0.5],
    r: [0, 1, 1],
    en: ["Alpha", "Beta", "Gamma"],
    zh: ["阿尔法", "贝塔", "伽马"],
    st: [1, 0, 4],
    links: [0, 1, 1, 2],
    regions: [[10000001, "Derelik", "德里克", 1, 2]],
  }
}

describe("faction-logic", () => {
  describe("探针", () => {
    it("把三种状态分开：读不到令牌 / 连不上面板 / 正常", () => {
      const missing = parseProbe({ ok: false, available: false, url: "http://127.0.0.1:26410", reason: "没有找到推演库" })
      expect(missing.ok).toBe(false)
      expect(missing.available).toBe(false)
      expect(missing.reason).toContain("推演库")
      expect(missing.status).toBeNull()

      const down = parseProbe({ ok: true, available: false, port: 26410, reason: "连接被拒绝" })
      expect(down.ok).toBe(true)
      expect(down.available).toBe(false)

      const up = parseProbe({
        ok: true,
        available: true,
        port: 26410,
        status: { now: 1, speed: 1, paused: false, alertCounts: { bad: 3, warn: 66, info: 0 } },
      })
      expect(up.available).toBe(true)
      expect(up.status?.alertCounts.warn).toBe(66)
    })

    it("字段乱给也不抛，缺的当 0 / 空串", () => {
      expect(parseProbe(null)).toEqual({
        ok: false,
        available: false,
        url: "",
        port: 0,
        reason: "",
        database: "",
        status: null,
      })
      const junk = parseProbe({ ok: "yes", available: 1, port: "26410", status: [] })
      expect(junk.ok).toBe(false)
      expect(junk.available).toBe(false)
      expect(junk.port).toBe(0)
      expect(junk.status).toBeNull()
    })
  })

  describe("势力一览", () => {
    const list = [
      brief({ key: "a", name: "赤潮", power: 10, armedShips: 5, economy: { ...brief({ key: "x", name: "x" }).economy, treasury: 100 } }),
      brief({ key: "b", name: "苍穹", power: 30, armedShips: 1 }),
      brief({ key: "c", name: "翠岚", tier: "clan", power: 20, armedShips: 9 }),
    ]

    it("按战力 / 舰船 / 资金 / 领地排序，名字兜底", () => {
      expect(sortFactions(list, "power").map((item) => item.key)).toEqual(["b", "c", "a"])
      expect(sortFactions(list, "ships").map((item) => item.key)).toEqual(["c", "a", "b"])
      expect(sortFactions(list, "money").map((item) => item.key)).toEqual(["a", "b", "c"])
      // 中文按拼音排：苍(cang) < 赤(chi) < 翠(cui)
      expect(sortFactions(list, "name").map((item) => item.name)).toEqual(["苍穹", "赤潮", "翠岚"])
    })

    it("按层级与搜索过滤（名称 / 标识 / 家园都算）", () => {
      expect(filterFactions(list, { tier: "clan" }).map((item) => item.key)).toEqual(["c"])
      expect(filterFactions(list, { query: "苍" }).map((item) => item.key)).toEqual(["b"])
      // 三条家园都是 Jita，全命中；顺序仍是默认的战力序
      expect(filterFactions(list, { query: "jit" }).map((item) => item.key)).toEqual(["b", "c", "a"])
      expect(filterFactions(list, { tier: "all" })).toHaveLength(3)
      expect(filterFactions(list, { query: "不存在的名字" })).toHaveLength(0)
    })

    it("汇总把九个数加总", () => {
      const totals = factionTotals(list)
      expect(totals.power).toBe(60)
      expect(totals.armedShips).toBe(15)
      expect(totals.treasury).toBe(100)
    })

    it("层级计数按固定顺序排，未知层级排在后面", () => {
      // all 是总数（模组也塞在同一张表里），不是层级 —— 必须排掉，否则会多出一个「all N」的按钮
      expect(tierCounts({ all: 121, pirate: 2, major: 5, zzz: 1 })).toEqual([
        { tier: "major", count: 5 },
        { tier: "pirate", count: 2 },
        { tier: "zzz", count: 1 },
      ])
      expect(tierCounts(undefined)).toEqual([])
      expect(tierCounts({ all: 121, major: 0 })).toEqual([])
    })
  })

  describe("外交", () => {
    const lookup = new Map([
      ["red_tide", { name: "赤潮", color: "#e0453a" }],
      ["jade_mist", { name: "翠岚", color: "#22a06b" }],
    ])

    it("关系表双向可查，未知值算中立", () => {
      const map = relationMap([
        { a: "red_tide", b: "azure_sky", relation: "hostile" },
        { a: "jade_mist", b: "azure_sky", relation: "wat" },
      ])
      expect(map.get("azure_sky|red_tide")).toBe("hostile")
      expect(map.get("red_tide|azure_sky")).toBe("hostile")
      expect(map.get("azure_sky|jade_mist")).toBe("neutral")
    })

    it("只列与这个势力有关的关系，按对方名字排序", () => {
      const rows = relationsFor("azure_sky", [
        { a: "red_tide", b: "azure_sky", relation: "hostile" },
        { a: "jade_mist", b: "azure_sky", relation: "friendly" },
        { a: "red_tide", b: "jade_mist", relation: "hostile" },
      ], lookup)
      // 拼音序：赤(chi) < 翠(cui)
      expect(rows.map((row) => row.name)).toEqual(["赤潮", "翠岚"])
      expect(rows[0].relation).toBe("hostile")
      expect(rows[0].color).toBe("#e0453a")
      expect(rows[1].relation).toBe("friendly")
    })

    it("两个方向各写一行时按对方去重（面板实际就是这么写的）", () => {
      const rows = relationsFor("azure_sky", [
        { a: "azure_sky", b: "red_tide", relation: "hostile" },
        { a: "red_tide", b: "azure_sky", relation: "hostile" },
        { a: "jade_mist", b: "azure_sky", relation: "friendly" },
        { a: "azure_sky", b: "jade_mist", relation: "friendly" },
      ], lookup)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.key)).toEqual(["red_tide", "jade_mist"])
    })
  })

  describe("星图", () => {
    it("列式数组转成点 / 连线 / 索引，并按语言取名字", () => {
      const zh = starmapView(rawStarmap(), true)
      expect(zh.points).toHaveLength(3)
      expect(zh.points[0].name).toBe("阿尔法")
      expect(zh.points[2].stations).toBe(4)
      expect(zh.links).toEqual([
        [0, 1],
        [1, 2],
      ])
      expect(zh.index.get(33)).toBe(2)
      expect(zh.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 })

      const en = starmapView(rawStarmap(), false)
      expect(en.points[1].name).toBe("Beta")
    })

    it("空数据 / 缺列都不炸", () => {
      expect(starmapView(null, true).points).toEqual([])
      expect(starmapView({ ...rawStarmap(), links: [] }, true).links).toEqual([])
      expect(starmapView({ ...rawStarmap(), count: 0, ids: [] }, true).points).toEqual([])
    })

    it("缩放居中，且 y 轴上下翻转", () => {
      const view = starmapView(rawStarmap(), true)
      const transform = fitTransform(view.bounds, 200, 100, 0)
      // 10×10 铺进 200×100：取小的那个比例 = 10
      expect(transform.scale).toBe(10)
      const origin = projectPoint(transform, 0, 0)
      expect(origin.px).toBeCloseTo(50, 6)
      expect(origin.py).toBeCloseTo(100, 6)
      const top = projectPoint(transform, 0, 10)
      expect(top.py).toBeCloseTo(0, 6)
    })
  })

  describe("事件", () => {
    const event = (id: number, group = "economy"): FactionEvent => ({
      id,
      at: 0,
      factionKey: "red_tide",
      type: "jobDone",
      label: "完工",
      group,
      text: "精炼完成",
    })

    it("按 id 去重并倒序，超出上限截断", () => {
      const merged = mergeEvents([event(5), event(3)], [event(4), event(5)])
      expect(merged.map((item) => item.id)).toEqual([5, 4, 3])
      expect(mergeEvents([], [event(1), event(2), event(3)], 2).map((item) => item.id)).toEqual([3, 2])
    })

    it("分组映射到色调，未知分组落到 other", () => {
      expect(eventTone("combat")).toBe("combat")
      expect(eventTone("whatever")).toBe("other")
    })
  })

  describe("旗舰保护伞", () => {
    it("状态口径照抄模组：off / none / engaged / cooling / ready", () => {
      expect(umbrellaStateOf(null)).toBe("off")
      expect(umbrellaStateOf({ state: "off", ships: 0 })).toBe("off")
      expect(umbrellaStateOf({ state: "none", ships: 0 })).toBe("none")
      expect(umbrellaStateOf({ state: "ready", ships: 2, phase: "standby" })).toBe("ready")
      expect(umbrellaStateOf({ state: "ready", ships: 2, phase: "cooldown" })).toBe("cooling")
      expect(umbrellaStateOf({ state: "engaged", ships: 2, phase: "engaged", engagedIn: "MHC-R3" })).toBe("engaged")
      expect(umbrellaStateOf({ state: "ready", ships: 2, phase: "engaged", engagedIn: "MHC-R3" })).toBe("engaged")
    })

    const military: Record<string, UmbrellaView> = {
      // 待命就绪：不需要人看
      calm: {
        key: "calm",
        enabled: true,
        template: "calm_capitals",
        hulls: [{ typeID: 19726, qty: 2, have: 2 }],
        demand: null,
        group: { ships: 2, phase: "standby", baseName: "Y-4CFK", ready: { ok: true }, fatigueMinutes: 0, activationMinutes: 0, jumps: 2 },
        coverage: { count: 16 },
        rules: { rangeMode: "ly", jumpRangeLY: 3.5, zones: ["rear", "middle"], respectHighSec: false },
      },
      // 出不了动：模组那行判据会把它误报成「待命就绪」，我们必须照实说
      cooling: {
        key: "cooling",
        enabled: true,
        group: { ships: 2, phase: "standby", baseName: "BMNV-P", ready: { ok: false, why: "跳跃引擎冷却" }, fatigueMinutes: 12, activationMinutes: 8, jumps: 1 },
        coverage: { count: 9 },
      },
      // 正在参战
      fighting: {
        key: "fighting",
        enabled: true,
        group: { ships: 2, phase: "engaged", engagedIn: "MHC-R3", baseName: "FDZ4-A", ready: { ok: true } },
        coverage: { count: 4 },
      },
      // 上次没去
      refused: {
        key: "refused",
        enabled: true,
        group: { ships: 2, phase: "standby", baseName: "Jita", ready: { ok: true }, lastRefusal: { why: "没有能点诱导力场的船" } },
      },
      // 还没组起来
      empty: { key: "empty", enabled: true, hulls: [{ typeID: 19726, qty: 2, have: 0 }], group: null },
      // 关掉了
      off: { key: "off", enabled: false, group: null },
    }

    it("摊平成表格行：算出状态、不能出动的原因、船体到位数", () => {
      const rows = umbrellaRows(military)
      const byKey = new Map(rows.map((row) => [row.key, row]))
      expect(byKey.get("calm")?.state).toBe("ready")
      expect(byKey.get("calm")?.attention).toBe(false)
      expect(byKey.get("cooling")?.state).toBe("cooling")
      expect(byKey.get("cooling")?.blockedReason).toBe("跳跃引擎冷却")
      expect(byKey.get("cooling")?.activationMinutes).toBe(8)
      expect(byKey.get("fighting")?.state).toBe("engaged")
      expect(byKey.get("fighting")?.engagedIn).toBe("MHC-R3")
      expect(byKey.get("refused")?.lastRefusal).toBe("没有能点诱导力场的船")
      expect(byKey.get("empty")?.state).toBe("none")
      expect(byKey.get("empty")?.hullsHave).toBe(0)
      expect(byKey.get("empty")?.hullsNeeded).toBe(2)
      expect(byKey.get("off")?.state).toBe("off")
    })

    it("需要看的排前面：参战 > 冷却 > 未组建 > 待命就绪", () => {
      const rows = umbrellaRows(military)
      expect(rows.slice(0, 4).map((row) => row.key)).toEqual(["fighting", "cooling", "refused", "empty"])
      // 不需要看的按「未组建 > 待命就绪 > 未启用」排（关掉的排最后）
      expect(rows.slice(4).map((row) => row.key)).toEqual(["calm", "off"])
    })

    it("分桶：只有需要看的进 attention，其余折成一行", () => {
      const { attention, rest } = umbrellaBuckets(umbrellaRows(military))
      expect(attention.map((row) => row.key).sort()).toEqual(["cooling", "fighting", "refused"])
      expect(rest.map((row) => row.key).sort()).toEqual(["calm", "empty", "off"])
    })

    it("色调与范围文案", () => {
      expect(umbrellaTone("ready")).toBe("success")
      expect(umbrellaTone("cooling")).toBe("warning")
      expect(umbrellaTone("engaged")).toBe("destructive")
      expect(umbrellaTone("off")).toBe("muted")
      const t = (source: string, params?: Record<string, unknown>) =>
        params ? source.replace(/\{(\w+)\}/g, (_, key) => String(params[key])) : source
      expect(umbrellaRange(military.calm, t)).toBe("3.5 光年 · 后方/中间")
      expect(umbrellaRange(military.off, t)).toBe("—")
    })
  })

  describe("KM（交战记录）", () => {
    const battles: BattleView[] = [
      {
        battleID: 39,
        systemID: 30003268,
        systemName: "MHC-R3",
        status: "done",
        highsec: false,
        startedAt: 1_791_640_015_714,
        endedAt: 1_791_640_035_714,
        siteLabel: "通往 6E-578 的星门",
        site: { kind: "gate", toSystemID: 30003270 },
        rounds: 2,
        sides: [
          { key: "taoyuan", committed: { "2532": 61.5 }, lost: 2, retreated: false, lastPower: 0 },
          { key: "yunxiu", committed: { "2089": 4033 }, lost: 0, retreated: false, lastPower: 4033 },
        ],
        result: {
          outcome: "destroyed",
          winner: "yunxiu",
          rounds: 2,
          lost: { taoyuan: 2, yunxiu: 0 },
          retreated: [],
          fleets: { taoyuan: [2532], yunxiu: [2089] },
          power: { taoyuan: { start: 61.5, end: 0 }, yunxiu: { start: 4033, end: 4033 } },
          durationSeconds: 20,
        },
      },
      {
        battleID: 40,
        systemID: 30003327,
        systemName: "BMNV-P",
        status: "active",
        startedAt: 1_791_640_100_000,
        endedAt: null,
        sides: [{ key: "red_tide", committed: { "2001": 500 }, lost: 1, lastPower: 420 }],
      },
    ]

    it("摊平成 KM 行：战力起止、损失、时长、参战舰队都按结算来", () => {
      const rows = battleRows(battles)
      // 进行中排最前
      expect(rows.map((row) => row.battleID)).toEqual([40, 39])
      const first = rows[1]
      expect(first.systemName).toBe("MHC-R3")
      expect(first.siteLabel).toBe("通往 6E-578 的星门")
      expect(first.durationSeconds).toBe(20)
      expect(first.rounds).toBe(2)
      expect(first.totalLost).toBe(2)
      expect(first.winner).toBe("yunxiu")
      // 战力高的那侧排前面（云岫 4033 > 桃源 61.5）
      expect(first.sides.map((side) => side.key)).toEqual(["yunxiu", "taoyuan"])
      expect(first.sides[1].start).toBe(61.5)
      expect(first.sides[1].end).toBe(0)
      expect(first.sides[1].lost).toBe(2)
      expect(first.sides[1].fleets).toEqual([{ id: 2532, power: 61.5 }])
    })

    it("没结算的（进行中）退回 sides 的实时读数，并把 open 标出来", () => {
      const row = battleRows(battles)[0]
      expect(row.open).toBe(true)
      expect(row.outcome).toBe("active")
      expect(row.sides[0].start).toBe(500)
      expect(row.sides[0].end).toBe(420)
    })

    it("结算里有、sides 里没有的势力也补进来", () => {
      const rows = battleRows([
        {
          battleID: 41,
          systemID: 1,
          systemName: "X",
          status: "done",
          startedAt: 1,
          sides: [{ key: "a", committed: {}, lost: 0, lastPower: 0 }],
          result: { outcome: "draw", power: { a: { start: 10, end: 10 }, b: { start: 25, end: 25 } }, lost: { b: 3 } },
        },
      ])
      expect(rows[0].sides.map((side) => side.key)).toEqual(["b", "a"])
      expect(rows[0].totalLost).toBe(3)
    })

    it("结果色调：全灭红、转场黄、平局与没打起来中性", () => {
      expect(battleOutcomeTone("destroyed")).toBe("destructive")
      expect(battleOutcomeTone("handover")).toBe("warning")
      expect(battleOutcomeTone("draw")).toBe("muted")
      expect(battleOutcomeTone("no-fight")).toBe("muted")
    })

    it("关联战斗事件只认「同星系 + 时间窗内的战斗组」，并且是近似的（不是 battleID）", () => {
      const events: FactionEvent[] = [
        { id: 100, at: 1_791_640_015_000, factionKey: "taoyuan", type: "defenceAlarm", label: "求援", group: "combat", text: "求援", payload: { systemID: 30003268 } },
        { id: 101, at: 1_791_640_016_000, factionKey: "yunxiu", type: "engagement", label: "交战", group: "combat", text: "交战", payload: { systemID: 30003268 } },
        // 别的星系：不算
        { id: 102, at: 1_791_640_016_000, factionKey: "x", type: "engagement", label: "交战", group: "combat", text: "别处", payload: { systemID: 30009999 } },
        // 时间窗外的：不算
        { id: 103, at: 1_791_600_000_000, factionKey: "x", type: "engagement", label: "交战", group: "combat", text: "很久以前", payload: { systemID: 30003268 } },
        // 非战斗组：不算
        { id: 104, at: 1_791_640_016_000, factionKey: "x", type: "jobDone", label: "完工", group: "economy", text: "精炼", payload: { systemID: 30003268 } },
      ]
      const row = battleRows(battles)[1]
      const linked = battleEventsFor(events, row, 1_791_640_200_000)
      expect(linked.map((event) => event.id)).toEqual([101, 100])
    })
  })

  describe("逐舰 KM", () => {
    const combat: FactionEvent[] = [
      {
        id: 900,
        at: 1_000,
        factionKey: "hantan",
        type: "loss",
        label: "战损",
        group: "combat",
        text: "",
        payload: {
          unitID: 8182,
          fleetID: 2079,
          systemID: 30045353,
          battleID: 44,
          fleetLost: false,
          killer: { kind: "engagement", key: "taoyuan", fleetID: 2065 },
        },
      },
      {
        id: 901,
        at: 1_100,
        factionKey: "hantan",
        type: "loss",
        label: "战损",
        group: "combat",
        text: "",
        payload: {
          unitID: 8183,
          fleetID: 2079,
          systemID: 30045353,
          battleID: 44,
          fleetLost: true,
          killer: { kind: "engagement", key: "taoyuan", fleetID: 2065 },
        },
      },
      {
        id: 902,
        at: 1_200,
        factionKey: "taoyuan",
        type: "loss",
        label: "战损",
        group: "combat",
        text: "",
        payload: {
          unitID: 9001,
          fleetID: 2065,
          systemID: 30045353,
          battleID: 44,
          killer: { kind: "engagement", key: "hantan", fleetID: 2079 },
        },
      },
      {
        id: 903,
        at: 1_150,
        factionKey: "taoyuan",
        type: "killReward",
        label: "击毁奖励",
        group: "combat",
        text: "",
        payload: { unitID: 8182, hullTypeID: 24700, value: 54_249_688, amount: 8_137_453 },
      },
      {
        id: 904,
        at: 1_250,
        factionKey: "hantan",
        type: "killReward",
        label: "击毁奖励",
        group: "combat",
        text: "",
        payload: { unitID: 9001, hullTypeID: 590, value: 1_000_000, amount: 150_000 },
      },
      {
        id: 905,
        at: 1_300,
        factionKey: "hantan",
        type: "loss",
        label: "战损",
        group: "combat",
        text: "",
        payload: { unitID: 8184, fleetID: 2079, systemID: 30045353, killer: { kind: "gank", key: "taoyuan" } },
      },
    ]

    it("loss 与同 unitID 的 killReward 对成一条 KM", () => {
      const rows = killRows(combat)
      expect(rows.map((row) => row.id)).toEqual([905, 902, 901, 900])
      const rich = rows.find((row) => row.id === 900)
      expect(rich?.shipTypeID).toBe(24700)
      expect(rich?.value).toBe(54_249_688)
      expect(rich?.reward).toBe(8_137_453)
      expect(rich?.killerKey).toBe("taoyuan")
      expect(rich?.killerFleetID).toBe(2065)
      expect(rich?.battleID).toBe(44)
      const poor = rows.find((row) => row.id === 901)
      expect(poor?.shipTypeID).toBeNull()
      expect(poor?.value).toBe(0)
      expect(poor?.fleetLost).toBe(true)
      expect(rows.find((row) => row.id === 905)?.battleID).toBeNull()
    })

    it("按 battleID 聚合成双方报表：损失、ISK、效率、参战舰队", () => {
      const reports = battleReports(combat)
      expect(reports).toHaveLength(1)
      const report = reports[0]
      expect(report.battleID).toBe(44)
      expect(report.totalLost).toBe(3)
      expect(report.totalValue).toBe(55_249_688)
      const byKey = new Map(report.sides.map((side) => [side.key, side]))
      const hantan = byKey.get("hantan")
      expect(hantan?.lost).toBe(2)
      expect(hantan?.lostValue).toBe(54_249_688)
      expect(hantan?.kills).toBe(1)
      expect(hantan?.killValue).toBe(1_000_000)
      expect(hantan?.fleets).toEqual([2079])
      const taoyuan = byKey.get("taoyuan")
      expect(taoyuan?.kills).toBe(2)
      expect(taoyuan?.killValue).toBe(54_249_688)
      expect(taoyuan?.lost).toBe(1)
      expect(taoyuan?.efficiency).toBeCloseTo(54_249_688 / 55_249_688, 6)
      expect((hantan?.efficiency ?? 0) + (taoyuan?.efficiency ?? 0)).toBeCloseTo(1, 6)
    })

    it("按舰型汇总：损失数与 ISK", () => {
      const report = battleReports(combat)[0]
      const types = new Map(report.shipLosses.map((row) => [row.typeID, row]))
      expect(types.get(24700)?.dead).toBe(1)
      expect(types.get(24700)?.value).toBe(54_249_688)
      expect(types.get(590)?.dead).toBe(1)
    })
  })

  describe("领土列（realm）", () => {
    it("按字母表解出整数：宽度 2 拼两个字符，宽度 1 只取一个", () => {
      expect([...decodeRealmColumn("AAAB", 2, 2)]).toEqual([0, 1])
      // 'BA' = 1×64 + 0 = 64
      expect([...decodeRealmColumn("BA", 1, 2)]).toEqual([64])
      // '-' 是字母表第 62 位（62 位字母表里最后第二个是 '-'）
      expect([...decodeRealmColumn("A-", 2, 1)]).toEqual([0, 62])
    })

    it("归属列 → 政体序号：原始值 1 起要减 1，无主是 -1", () => {
      const owner = realmOwner({ count: 3, owner: "ABACAA" }, 3)
      expect(owner && [...owner]).toEqual([0, 1, -1])
    })

    it("星系数对不上就不上色（宁可不上色，也别错位染色）", () => {
      expect(realmOwner({ count: 2, owner: "ABAC" }, 3)).toBeNull()
      expect(realmOwner({ count: 3 }, 3)).toBeNull()
      expect(realmOwner(null, 3)).toBeNull()
    })

    it("政体清单：数组顺序就是编号顺序，颜色非法值退成兜底色", () => {
      const list = realmPolities({
        polities: [
          ["a", "甲", "major", "#3b82f6", 1, 7],
          ["b", "乙", "clan", "nope", 0, 2],
        ],
      })
      expect(list.map((row) => row.key)).toEqual(["a", "b"])
      expect(list[0].color).toBe("#3b82f6")
      expect(list[1].color).toBe(FALLBACK_COLOR)
      expect(list[1].systems).toBe(2)
      expect(realmPolities(null)).toEqual([])
      expect(realmPolities({ polities: "no" })).toEqual([])
    })

    it("配对校验：归属列统计数必须逐条等于清单声明的 systems", () => {
      const polities = realmPolities({
        polities: [
          ["a", "甲", "major", "#3b82f6", 1, 2],
          ["b", "乙", "clan", "#22a06b", 2, 1],
        ],
      })
      // 编号 0 出现 2 次、编号 1 出现 1 次 → 与声明一致
      expect(territoryPairsUp(new Int16Array([0, 0, 1, -1]), polities)).toBe(true)
      // 顺序没变但数量变了（A 少一个）→ 不是一对
      expect(territoryPairsUp(new Int16Array([0, 1, -1, -1]), polities)).toBe(false)
      // 归属列里出现清单之外的编号 → 不是一对
      expect(territoryPairsUp(new Int16Array([0, 0, 2, -1]), polities)).toBe(false)
      // 缺数据一律不成对
      expect(territoryPairsUp(null, polities)).toBe(false)
      expect(territoryPairsUp(new Int16Array([0]), [])).toBe(false)
    })
  })

  describe("玩家主权（游戏侧）", () => {
    const payload = {
      ok: true,
      systems: [
        { systemID: 30004712, allianceID: 99000027, corporationID: 98000126, claimStructureID: 9988400002609, claimTime: "134360908906700000" },
        { systemID: 0, allianceID: 1, corporationID: 2 },
      ],
      alliances: { "99000027": { name: "阿拉蕾雇佣兵集团", shortName: "ALLY" } },
      corporations: { "98000126": "阿拉蕾雇佣兵公司" },
      structureCounts: { "30004712": 4 },
    }

    it("解析主权声明，并给出联盟 / 军团名字与建筑数", () => {
      const view = sovereigntyView(payload)
      expect(view.claims.size).toBe(1)
      const claim = view.claims.get(30004712)
      expect(claim?.allianceID).toBe(99000027)
      expect(claim?.corporationID).toBe(98000126)
      expect(view.alliances.get(99000027)?.name).toBe("阿拉蕾雇佣兵集团")
      expect(view.corporations.get(98000126)).toBe("阿拉蕾雇佣兵公司")
      expect(view.structureCounts.get(30004712)).toBe(4)
    })

    it("读不到（ok:false / 空 / 乱给）时给空视图，不抛", () => {
      expect(sovereigntyView({ ok: false, reason: "游戏库不存在" }).claims.size).toBe(0)
      expect(sovereigntyView(null).claims.size).toBe(0)
      expect(sovereigntyView({ ok: true, systems: "nope" }).claims.size).toBe(0)
      expect(sovereigntyView({ ok: true, systems: [{ systemID: "x" }] }).claims.size).toBe(0)
    })
  })

  describe("杂项", () => {
    it("倍速 / 运行时长 / 推演时钟", () => {
      expect(formatSpeed(1)).toBe("1×")
      expect(formatSpeed(0)).toBe("—")
      expect(formatUptime(0)).toBe("—")
      expect(formatUptime(1000 * 59)).toBe("59s")
      expect(formatUptime(1000 * 90)).toBe("1m 30s")
      expect(formatUptime(1000 * 3600 * 3 + 1000 * 60 * 5)).toBe("3h 05m")
      expect(formatUptime(1000 * 86400 * 2 + 1000 * 3600 * 7)).toBe("2d 07h")
      expect(formatSimClock(0)).toBe("—")
      expect(formatSimClock(new Date(2026, 9, 11, 21, 44).getTime())).toBe("10-11 21:44")
    })

    it("分组切片", () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
      expect(chunk([1], 0)).toEqual([[1]])
    })
  })
})
