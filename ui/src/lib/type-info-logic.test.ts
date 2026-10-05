import { describe, expect, it } from "vitest"

import type { RawMarketTypeInfo, RawMarketTypeInfoAttr } from "@/lib/ipc"
import {
  attributeSections,
  bonusPlan,
  bonusValue,
  clampDescription,
  enumUnitLabel,
  formatAttrNumber,
  formatAttrValue,
  SECTION_SENSOR,
  tooltipPlan,
} from "@/lib/type-info-logic"

/**
 * fixture 用的是真机 SDE 的原始形状（2026-10-05 从裂谷级 587 与 125mm 自动加农炮上取的），
 * 不是编的：单位符号已经是中文 SDE 的原话，值也是侧车回包里的原始值。
 */
function attr(
  over: Partial<RawMarketTypeInfoAttr> & { id: number; name: string; value: number }
): RawMarketTypeInfoAttr {
  return {
    unitId: null,
    unit: null,
    highIsGood: true,
    category: 0,
    typeName: null,
    ...over,
  }
}

describe("属性值格式化", () => {
  it("整数带千分位，小数最多两位", () => {
    expect(formatAttrNumber(625000)).toBe("625,000")
    expect(formatAttrNumber(4)).toBe("4")
    expect(formatAttrNumber(3.2)).toBe("3.2")
    expect(formatAttrNumber(0.6666667)).toBe("0.67")
    expect(formatAttrNumber(Number.NaN)).toBe("—")
  })

  it("unitID 101 的「秒」以毫秒存：除以 1000，满一分钟按游戏写「分秒」", () => {
    // 裂谷级护盾回充时间 625000 ms ＝ 10分25秒（游戏属性面板同款写法）、
    // 125mm 自动加农炮射速 2100 ms ＝ 2.1 s（不到一分钟照旧拼单位符号）
    expect(formatAttrValue(attr({ id: 479, name: "护盾回充时间", value: 625000, unitId: 101, unit: "s" }))).toBe(
      "10分25秒"
    )
    expect(formatAttrValue(attr({ id: 51, name: "射击速度", value: 2100, unitId: 101, unit: "s" }))).toBe(
      "2.1 s"
    )
  })

  it("unitID 108 是抗性共振系数：1 = 0% 抗性", () => {
    // 裂谷级护盾爆炸抗性 0.5 → 50%
    expect(formatAttrValue(attr({ id: 272, name: "护盾爆炸伤害抗性", value: 0.5, unitId: 108, unit: "%" }))).toBe(
      "50 %"
    )
    expect(formatAttrValue(attr({ id: 271, name: "护盾电磁伤害抗性", value: 1, unitId: 108, unit: "%" }))).toBe(
      "0 %"
    )
  })

  it("值指向物品：有名字用名字，没解析出来就只给数字", () => {
    expect(
      formatAttrValue(
        attr({ id: 182, name: "主技能需求", value: 3329, unitId: 116, unit: "类别ID", typeName: "米玛塔尔护卫舰" })
      )
    ).toBe("米玛塔尔护卫舰")
    expect(formatAttrValue(attr({ id: 182, name: "主技能需求", value: 3329, unitId: 116, unit: "类别ID" }))).toBe(
      "3,329"
    )
    // 115 是组别引用：同样不把「组别ID」当单位拼在数字后面
    expect(formatAttrValue(attr({ id: 1, name: "组别", value: 25, unitId: 115, unit: "组别ID" }))).toBe("25")
  })

  it("其余属性原样拼 SDE 的单位符号", () => {
    expect(formatAttrValue(attr({ id: 11, name: "能量栅格输出", value: 41, unitId: 107, unit: "MW" }))).toBe("41 MW")
    expect(formatAttrValue(attr({ id: 37, name: "最大速度", value: 365, unitId: 11, unit: "m/s" }))).toBe("365 m/s")
    // 无量纲：不留一个尾随空格
    expect(formatAttrValue(attr({ id: 14, name: "高能量槽", value: 3 }))).toBe("3")
  })

  it("枚举型单位按 SDE 写的标签取值，不自己建对照表", () => {
    const rig = attr({ id: 1547, name: "改装件尺寸", value: 2, unitId: 117, unit: "1=小型  2=中型  3=大型" })
    expect(formatAttrValue(rig)).toBe("中型")
    const bool = attr({ id: 1000, name: "开关", value: 0, unitId: 137, unit: "1=True 0=False" })
    expect(formatAttrValue(bool)).toBe("False")
    expect(enumUnitLabel("1=小型  2=中型  3=大型", 3)).toBe("大型")
    expect(enumUnitLabel("m/s", 3)).toBeNull()
    expect(enumUnitLabel("1=唯一", 1)).toBeNull()
  })
})

/**
 * 属性分区（游戏「属性」页签）：fixture 是裂谷级 587 的真机数值 —— 服务端静态表
 * typeDogma 里怎么存就怎么给（护盾 450、装甲 450、结构 350、四抗共振系数全是原值）。
 */
describe("属性分区（游戏属性页签）", () => {
  const rifter = [
    attr({ id: 263, name: "护盾容量", value: 450, unitId: 113, unit: "HP", category: 2 }),
    attr({ id: 479, name: "护盾回充时间", value: 625000, unitId: 101, unit: "s", category: 2 }),
    attr({ id: 271, name: "护盾电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }),
    attr({ id: 274, name: "护盾热能伤害抗性", value: 0.8, unitId: 108, unit: "%", category: 2 }),
    attr({ id: 273, name: "护盾动能伤害抗性", value: 0.6, unitId: 108, unit: "%", category: 2 }),
    attr({ id: 272, name: "护盾爆炸伤害抗性", value: 0.5, unitId: 108, unit: "%", category: 2 }),
    attr({ id: 265, name: "装甲值", value: 450, unitId: 113, unit: "HP", category: 3 }),
    attr({ id: 267, name: "装甲电磁伤害抗性", value: 0.4, unitId: 108, unit: "%", category: 3 }),
    attr({ id: 270, name: "装甲热能伤害抗性", value: 0.65, unitId: 108, unit: "%", category: 3 }),
    attr({ id: 269, name: "装甲动能伤害抗性", value: 0.75, unitId: 108, unit: "%", category: 3 }),
    attr({ id: 268, name: "装甲爆炸伤害抗性", value: 0.9, unitId: 108, unit: "%", category: 3 }),
    attr({ id: 9, name: "结构值", value: 350, unitId: 113, unit: "HP", category: 4 }),
    attr({ id: 974, name: "结构电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 975, name: "结构爆炸伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 976, name: "结构动能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 977, name: "结构热能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 113, name: "结构电磁伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 110, name: "结构热能伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 109, name: "结构动能伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 111, name: "结构爆炸伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
    attr({ id: 38, name: "容量", value: 140, unitId: 9, unit: "m3", category: 4 }),
    attr({ id: 482, name: "电容容量", value: 250, unitId: 114, unit: "GJ", category: 5 }),
    attr({ id: 4, name: "质量", value: 1067000, unitId: 2, unit: "kg", category: 4 }),
    attr({ id: 37, name: "最大速度", value: 365, unitId: 11, unit: "m/s", category: 17 }),
    attr({ id: 76, name: "锁定范围上限", value: 22500, unitId: 1, unit: "m", category: 6 }),
    attr({ id: 209, name: "光雷达感应强度", value: 8, unitId: 120, unit: "点", category: 6 }),
  ]

  it("分区顺序照客户端：护盾 → 装甲 → 结构 → 电容器 → 导航 → 目标锁定 → 感应强度 → 仓库", () => {
    const sections = attributeSections(rifter, {})
    expect(sections.map((section) => section.id)).toEqual([2, 3, 4, 5, 17, 6, SECTION_SENSOR, 40])
    expect(sections.map((section) => section.title)).toEqual([
      "护盾",
      "装甲",
      "结构",
      "电容器",
      "导航",
      "目标锁定系统",
      "感应强度",
      "仓库",
    ])
  })

  it("感应强度从「目标锁定系统」里拆出来，容量归「仓库」、质量归「导航」", () => {
    const sections = attributeSections(rifter, {})
    const at = (id: number) => sections.find((section) => section.id === id)!
    expect(at(SECTION_SENSOR).rows.map((row) => row.id)).toEqual([209])
    expect(at(6).rows.map((row) => row.id)).toEqual([76])
    expect(at(40).rows.map((row) => row.id)).toEqual([38])
    expect(at(17).rows.map((row) => row.id)).toEqual([4, 37])
  })

  it("有效 HP 按客户端口径：值 ÷ (1 − 四抗平均)", () => {
    const sections = attributeSections(rifter, {})
    const shield = sections.find((section) => section.id === 2)!
    expect(shield.defence?.resists.map((row) => Math.round(row.percent))).toEqual([0, 20, 40, 50])
    expect(formatAttrNumber(shield.defence!.effective!)).toBe("620.69")
    // 装甲 450、抗性 60/35/25/10% → 666.67
    const armor = sections.find((section) => section.id === 3)!
    expect(formatAttrNumber(armor.defence!.effective!)).toBe("666.67")
  })

  it("结构抗性两套 id 只用填了真值的那一套（裂谷级船体那套全是 1）", () => {
    const structure = attributeSections(rifter, {}).find((section) => section.id === 4)!
    expect(structure.defence?.resists.map((row) => Math.round(row.percent))).toEqual([33, 33, 33, 33])
    expect(formatAttrNumber(structure.defence!.effective!)).toBe("522.39")
  })

  it("少一条抗性就不给「有效 HP」，免得算出一个错的数", () => {
    const rows = [
      attr({ id: 263, name: "护盾容量", value: 450, category: 2 }),
      attr({ id: 271, name: "护盾电磁伤害抗性", value: 1, unitId: 108, category: 2 }),
    ]
    const shield = attributeSections(rows, {})[0]
    expect(shield.defence).toBeUndefined()
    expect(shield.rows).toHaveLength(2)
  })

  it("装配（1）排在最前，标题是客户端那套中文名，不看 SDE 的英文分类名", () => {
    const rows = [
      attr({ id: 11, name: "能量栅格输出", value: 41, category: 1 }),
      attr({ id: 263, name: "护盾容量", value: 450, category: 2 }),
    ]
    const sections = attributeSections(rows, { "1": "Fitting" })
    expect(sections.map((section) => section.id)).toEqual([1, 2])
    expect(sections[0].title).toBe("装配")
  })

  it("表里没登记的 SDE 分类仍然退成英文名；连名都没有就留空", () => {
    // 31＝Graphics：实测市场目录里没有任何物品用到它，故意不配标题，留着兜底那条路
    const rows = [attr({ id: 1, name: "图形", value: 1, category: 31 })]
    expect(attributeSections(rows, { "31": "Graphics" })[0].title).toBe("Graphics")
    expect(attributeSections(rows, {})[0].title).toBe("")
  })

  /**
   * 装备 / 无人机那几段以前只配了舰船身上的分类，SDE 的英文分类名就直接画在标题带上
   * （实测 9139 个有属性的在售物品里 4474 个至少中一条，既有装备也有无人机）。
   */
  it("装备 / 无人机那几段走中文标题，不再露 SDE 英文分类名", () => {
    // 125mm 自动加农炮：射击速度（分类 29 Turrets）、超载损耗（分类 52 Heat）
    const rows = [
      attr({ id: 51, name: "射击速度", value: 2100, unitId: 101, category: 29 }),
      attr({ id: 1211, name: "超载损耗", value: 3.4, category: 52 }),
    ]
    const sections = attributeSections(rows, { "29": "Turrets", "52": "Heat" })
    expect(sections.map((section) => section.id)).toEqual([29, 52])
    expect(sections.map((section) => section.title)).toEqual(["炮台", "过热"])
    // 段序：炮台 / 过热排在「其他属性」前面 —— 装备面板上最要紧的几条不该垫底
    const withMisc = attributeSections(
      [...rows, attr({ id: 422, name: "科技等级", value: 1, category: 7 })],
      {}
    )
    expect(withMisc.map((section) => section.id)).toEqual([29, 52, 7])
  })

  it("SDE 里没名字的分类 0 / 9 并进「其他属性」，不冒空标题与 NULL 标题带", () => {
    // 黄金富豪级 17720 的 angelCartelProjectileReloadingSpeed 是分类 0（标题会空），
    // 损伤控制 II 的「该武器组所允许的最大装备数量」是分类 9（SDE 名叫 NULL）
    const rows = [
      attr({ id: 6203, name: "angelCartelProjectileReloadingSpeed", value: 1, category: 0 }),
      attr({ id: 1544, name: "该武器组所允许的最大装备数量", value: 1, category: 9 }),
      attr({ id: 422, name: "科技等级", value: 1, category: 7 }),
    ]
    const sections = attributeSections(rows, { "7": "Miscellaneous" })
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe(7)
    expect(sections[0].title).toBe("其他属性")
    expect(sections[0].rows.map((row) => row.id)).toEqual([6203, 1544, 422])
  })

  it("四抗齐了就出条：缺护盾容量 / 装甲值也不挡（损伤控制那种装备）", () => {
    // 损伤控制 II 的护盾四抗是 0.875（12.5%），但它没有「护盾容量」这条值属性；
    // 以前这里直接跳过，于是同一件装备的护盾段是四行文字、结构段却是色块条
    const rows = [
      attr({ id: 271, name: "护盾电磁伤害抗性", value: 0.875, unitId: 108, category: 2 }),
      attr({ id: 272, name: "护盾爆炸伤害抗性", value: 0.875, unitId: 108, category: 2 }),
      attr({ id: 273, name: "护盾动能伤害抗性", value: 0.875, unitId: 108, category: 2 }),
      attr({ id: 274, name: "护盾热能伤害抗性", value: 0.875, unitId: 108, category: 2 }),
    ]
    const shield = attributeSections(rows, {}).find((section) => section.id === 2)!
    expect(shield.defence?.resists.map((row) => row.percent)).toEqual([12.5, 12.5, 12.5, 12.5])
    // 没有值属性 → 不给「有效 HP」读数（界面上那截留空），但条照画
    expect(shield.defence?.hp).toBeNull()
    expect(shield.defence?.effective).toBeNull()
  })

  it("导航头部的「朝向时间」＝ ln(4) × 惯性调整 × 质量 ÷ 10⁶（缺一条就不给）", () => {
    // 游戏里那组数：质量 997,000 kg、惯性调整 3.6 → 4.98 秒
    const rows = [
      attr({ id: 4, name: "质量", value: 997000, unitId: 2, unit: "kg", category: 4 }),
      attr({ id: 70, name: "惯性调整", value: 3.6, unitId: 104, unit: "x", category: 17 }),
    ]
    const nav = attributeSections(rows, {}).find((section) => section.id === 17)!
    expect(formatAttrNumber(nav.alignSeconds!)).toBe("4.98")
    // 只有质量、没有惯性调整：整条不画，而不是画一个 0
    const half = attributeSections([rows[0]], {}).find((section) => section.id === 17)!
    expect(half.alignSeconds).toBeUndefined()
  })

  it("没有属性时回空数组（界面据此画空态）", () => {
    expect(attributeSections(undefined, undefined)).toEqual([])
  })
})

/** 加成：fixture 是飞燕级 22464 的真机回包（拦截舰操作 / 加达里驱逐舰操作 / 特有加成） */
describe("舰船加成", () => {
  it("百分比不留空格、其余单位留一个空格，没有数值的只给文字", () => {
    expect(bonusValue({ value: 15, unitId: 105, unit: "%", text: "护盾值加成" })).toBe("15%")
    expect(bonusValue({ value: 7.5, unitId: 105, unit: "%", text: "射速加成" })).toBe("7.5%")
    expect(bonusValue({ value: 3.6, unitId: 104, unit: "x", text: "惯性调整" })).toBe("3.6 x")
    expect(bonusValue({ value: null, unitId: null, unit: null, text: "可以安装拦截泡发射器" })).toBeNull()
  })

  it("技能加成按段折出来，特有加成不标技能名", () => {
    const plan = bonusPlan({
      ok: true,
      bonuses: [
        {
          skillId: 12098,
          skill: "拦截舰操作",
          entries: [
            { value: 15, unitId: 105, unit: "%", text: "护盾值加成" },
            { value: 10, unitId: 105, unit: "%", text: "微型跃迁推进器的信号半径惩罚加成" },
          ],
        },
        {
          skillId: 0,
          skill: "",
          entries: [
            { value: null, unitId: null, unit: null, text: "可以安装拦截泡发射器" },
            { value: 25, unitId: 105, unit: "%", text: "跃迁速度和跃迁加速加成" },
          ],
        },
      ],
    })
    expect(plan).toHaveLength(2)
    expect(plan[0].role).toBe(false)
    expect(plan[0].skill).toBe("拦截舰操作")
    expect(plan[0].entries.map((entry) => entry.value)).toEqual(["15%", "10%"])
    expect(plan[1].role).toBe(true)
    expect(plan[1].entries.map((entry) => entry.value)).toEqual([null, "25%"])
  })

  it("空条目整段丢掉，没有加成的物品回空数组（界面上整块不画）", () => {
    expect(bonusPlan({ ok: true, bonuses: [{ skillId: 3329, skill: "米玛塔尔护卫舰", entries: [] }] })).toEqual([])
    expect(bonusPlan({ ok: true })).toEqual([])
    expect(bonusPlan(null)).toEqual([])
  })
})

describe("悬停卡的显示计划", () => {
  function info(over: Partial<RawMarketTypeInfo>): RawMarketTypeInfo {
    return { ok: true, ...over }
  }

  it("简介折成一行并在超长时截断", () => {
    expect(clampDescription("第一行\n第二行").text).toBe("第一行 第二行")
    const long = clampDescription("字".repeat(30), 10)
    expect(long.truncated).toBe(true)
    expect(long.text).toBe("字".repeat(10) + "…")
    expect(clampDescription(undefined).text).toBe("")
  })

  it("属性最多列 6 条，但总数照实报", () => {
    const attributes = Array.from({ length: 48 }, (_, index) =>
      attr({ id: index + 1, name: "属性 " + (index + 1), value: index + 1 })
    )
    const plan = tooltipPlan(info({ description: "裂谷级", attributes }))
    expect(plan.attributes).toHaveLength(6)
    expect(plan.total).toBe(48)
    expect(plan.description).toBe("裂谷级")
  })

  it("加成一起折进计划（没有就是空数组）", () => {
    const plan = tooltipPlan(
      info({
        bonuses: [
          {
            skillId: 3329,
            skill: "米玛塔尔护卫舰",
            entries: [{ value: 10, unitId: 105, unit: "%", text: "小型射弹炮台射速加成" }],
          },
        ],
      })
    )
    expect(plan.bonuses).toHaveLength(1)
    expect(plan.bonuses[0].entries[0].value).toBe("10%")
    expect(tooltipPlan(info({})).bonuses).toEqual([])
  })

  it("没有回包时给出一个空计划，不会炸", () => {
    const plan = tooltipPlan(null)
    expect(plan).toEqual({
      description: "",
      descriptionTruncated: false,
      attributes: [],
      total: 0,
      bonuses: [],
    })
  })
})
