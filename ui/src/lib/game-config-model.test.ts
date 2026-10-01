import { describe, expect, it } from "vitest"

import {
  controlOf,
  definitionsOfDomain,
  draftDiff,
  draftOf,
  filterDefinitions,
  groupDefinitions,
  labelOf,
  multiplierKindOf,
  parseDraftValue,
  sectionLabelOf,
  sliderSpecOf,
  validateDraftValue,
  valueSummary,
  type GameConfigDefinition,
} from "@/lib/game-config-model"

/** 造一条定义，只覆盖关心的字段 */
function def(partial: Partial<GameConfigDefinition> & { key: string }): GameConfigDefinition {
  return {
    domain: "gameplay",
    section: "skills",
    valueType: "number",
    defaultValue: 1,
    description: [],
    validValues: null,
    integer: false,
    minValue: null,
    maxValue: null,
    exclusiveMinValue: false,
    allowBlank: false,
    allowedValues: null,
    envVar: null,
    ...partial,
  }
}

describe("倍率识别", () => {
  it("认得 167 条里那 8 个倍率键", () => {
    const keys = [
      "missionRewardMultiplier",
      "planetSchematicOutputMultiplier",
      "industryJobSpeedMultiplier",
      "skillTrainingSpeed",
      "upwellTimerScale",
      "wormholeLifetimeScale",
      "wormholeWanderingCountScale",
      "miningBeltQuantityScale",
    ]
    for (const key of keys) expect(multiplierKindOf(key), key).toBe(true)
  })

  it("不把端口、毫秒、体积当成倍率", () => {
    for (const key of ["serverPort", "socketIdleTimeoutMs", "miningBeltMaximumAsteroidVolumeM3"]) {
      expect(multiplierKindOf(key), key).toBe(false)
    }
  })
})

describe("控件选型", () => {
  it("开关 / 枚举 / 文本 / 数字各归各位", () => {
    expect(controlOf(def({ key: "a", valueType: "boolean" }))).toBe("switch")
    expect(controlOf(def({ key: "b", valueType: "string" }))).toBe("text")
    expect(controlOf(def({ key: "c", valueType: "json" }))).toBe("json")
    expect(controlOf(def({ key: "serverPort", minValue: 1, maxValue: 65535 }))).toBe("number")
    expect(controlOf(def({ key: "logLevel", allowedValues: [0, 1, 2] }))).toBe("select")
  })

  it("倍率走滑块，量程按类型给", () => {
    expect(sliderSpecOf(def({ key: "missionRewardMultiplier", minValue: 0 }))).toEqual({
      min: 0,
      max: 10,
      step: 0.05,
    })
    expect(sliderSpecOf(def({ key: "skillTrainingSpeed", minValue: 0 }))).toEqual({
      min: 0,
      max: 20,
      step: 0.1,
    })
    expect(sliderSpecOf(def({ key: "miningBeltQuantityScale", minValue: 0 }))).toEqual({
      min: 0,
      max: 1,
      step: 0.01,
    })
  })

  it("0~1 的概率与 -1~1 的安等阈值也走滑块", () => {
    expect(controlOf(def({ key: "asteroidBeltNpcRatHighSecChance", minValue: 0, maxValue: 1 }))).toBe(
      "slider"
    )
    expect(
      controlOf(def({ key: "asteroidBeltNpcRatOfficerMaxSecurity", minValue: -1, maxValue: 1 }))
    ).toBe("slider")
  })

  it("枚举即使带范围也不给滑块（滑块对不上离散值）", () => {
    expect(sliderSpecOf(def({ key: "logLevel", minValue: 0, maxValue: 2, allowedValues: [0, 1, 2] }))).toBeNull()
  })
})

describe("草稿转换与校验", () => {
  it("布尔 / 数字 / JSON 各自解析", () => {
    expect(parseDraftValue(def({ key: "a", valueType: "boolean" }), "true")).toEqual({
      ok: true,
      value: true,
    })
    expect(parseDraftValue(def({ key: "b", valueType: "number" }), "2.5")).toEqual({
      ok: true,
      value: 2.5,
    })
    expect(parseDraftValue(def({ key: "c", valueType: "json" }), "[1,2]")).toEqual({
      ok: true,
      value: [1, 2],
    })
    expect(parseDraftValue(def({ key: "d", valueType: "number" }), "abc").ok).toBe(false)
    expect(parseDraftValue(def({ key: "e", valueType: "json" }), "{oops").ok).toBe(false)
  })

  it("范围 / 整型 / 空值 / 枚举都在提交前拦下", () => {
    expect(
      validateDraftValue(def({ key: "serverPort", minValue: 1, maxValue: 65535, integer: true }), "70000")
    ).toContain("65535")
    expect(
      validateDraftValue(def({ key: "serverPort", minValue: 1, maxValue: 65535, integer: true }), "26.5")
    ).toContain("整数")
    expect(validateDraftValue(def({ key: "playerConnectToken", valueType: "string" }), "")).toContain(
      "不能为空"
    )
    expect(
      validateDraftValue(def({ key: "logLevel", valueType: "number", allowedValues: [0, 1, 2] }), "9")
    ).toBeNull()
    expect(
      validateDraftValue(def({ key: "xmppDomain", valueType: "string" }), "")
    ).not.toBeNull()
  })

  it("允许留空的字符串字段不拦空值", () => {
    const allowBlank = def({ key: "miningNpcFleetProfileOrPool", valueType: "string", allowBlank: true })
    expect(validateDraftValue(allowBlank, "")).toBeNull()
  })
})

describe("改动比对", () => {
  const defs = [
    def({ key: "missionRewardMultiplier", minValue: 0 }),
    def({ key: "skillTrainingSpeed", minValue: 0 }),
    def({ key: "serverPort", minValue: 1, maxValue: 65535, integer: true }),
  ]
  const values = { missionRewardMultiplier: 1, skillTrainingSpeed: 1, serverPort: 26000 }

  it("只提交真正改过的项", () => {
    const draft = { ...draftOf(values), missionRewardMultiplier: "2.5" }
    const { patch, errors } = draftDiff(defs, draft, values)
    expect(patch).toEqual({ missionRewardMultiplier: 2.5 })
    expect(errors).toEqual({})
  })

  it("数字等价写法（1 与 1.0）不算改动", () => {
    const draft = { ...draftOf(values), skillTrainingSpeed: "1.000" }
    expect(draftDiff(defs, draft, values).patch).toEqual({})
  })

  it("不合法的项进 errors，且不会被塞进补丁", () => {
    const draft = { ...draftOf(values), serverPort: "70000" }
    const { patch, errors } = draftDiff(defs, draft, values)
    expect(patch).toEqual({})
    expect(Object.keys(errors)).toEqual(["serverPort"])
  })
})

describe("过滤与分组", () => {
  const defs = [
    def({ key: "missionRewardMultiplier", section: "missions", minValue: 0 }),
    def({ key: "skillTrainingSpeed", section: "skills", minValue: 0 }),
    def({ key: "serverPort", domain: "server", section: "network", minValue: 1, maxValue: 65535 }),
  ]

  it("只看倍率 = 只看有滑块量程的项", () => {
    const hit = filterDefinitions(
      defs,
      { query: "", multipliersOnly: true, changedOnly: false },
      {},
      {}
    )
    expect(hit.map((d) => d.key)).toEqual(["missionRewardMultiplier", "skillTrainingSpeed"])
  })

  it("搜索同时命中 key 与中文名", () => {
    const byKey = filterDefinitions(defs, { query: "serverport", multipliersOnly: false, changedOnly: false }, {}, {})
    expect(byKey.map((d) => d.key)).toEqual(["serverPort"])
    const byLabel = filterDefinitions(defs, { query: "任务奖励", multipliersOnly: false, changedOnly: false }, {}, {})
    expect(byLabel.map((d) => d.key)).toEqual(["missionRewardMultiplier"])
  })

  it("只看改动过的项", () => {
    const draft = { missionRewardMultiplier: "2", skillTrainingSpeed: "1", serverPort: "26000" }
    const values = { missionRewardMultiplier: 1, skillTrainingSpeed: 1, serverPort: 26000 }
    const hit = filterDefinitions(
      defs,
      { query: "", multipliersOnly: false, changedOnly: true },
      draft,
      values
    )
    expect(hit.map((d) => d.key)).toEqual(["missionRewardMultiplier"])
  })

  it("分组保持 schema 顺序，域过滤按域取值", () => {
    const groups = groupDefinitions(defs)
    expect(groups.map((g) => g.section)).toEqual(["missions", "skills", "network"])
    expect(groups[0].label).toBe("任务")
    expect(definitionsOfDomain(defs, "server").map((d) => d.key)).toEqual(["serverPort"])
  })
})

describe("文案回退", () => {
  it("服务端新增的条目没有中文标注时回退到 key，不显示空白", () => {
    expect(labelOf(def({ key: "brandNewServerSetting" }))).toBe("brandNewServerSetting")
    expect(sectionLabelOf("brandNewSection")).toBe("brandNewSection")
    expect(sectionLabelOf("skills")).toBe("技能")
  })

  it("长结构折叠成一行摘要", () => {
    expect(valueSummary(true)).toBe("true")
    expect(valueSummary([1, 2, 3])).toBe("[1,2,3]")
    expect(valueSummary("x".repeat(80))).toBe("x".repeat(80))
  })
})