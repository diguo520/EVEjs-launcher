import { describe, expect, it } from "vitest"

import type { RawMarketTypeInfo, RawMarketTypeInfoAttr } from "@/lib/ipc"
import {
  attrOriginalValue,
  attributeSections,
  bonusPlan,
  bonusValue,
  clampDescription,
  DAMAGE_TITLE,
  damageAttrSlot,
  enumUnitLabel,
  formatAttrNumber,
  formatAttrValue,
  formatOriginalValue,
  RESIST_BONUS_TITLE,
  RESIST_ATTR_IDS,
  restorableAttrs,
  SECTION_SENSOR,
  tooltipPlan,
  type TypeInfoQuad,
  type TypeInfoSectionView,
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

/** 分区里折成一行四格的那一组（按行名找：伤害 / 伤害抗性加成） */
function quadOf(section: TypeInfoSectionView, label: string = DAMAGE_TITLE): TypeInfoQuad {
  for (const item of section.items) {
    if (item.kind === "quad" && item.quad.label === label) return item.quad
  }
  throw new Error("这一段里没有这一行四格：" + label)
}

/** 渲染顺序的可读写法：普通属性行给属性 id，四格行给 "quad" */
function shape(section: TypeInfoSectionView): (number | "quad")[] {
  return section.items.map((item) => (item.kind === "quad" ? "quad" : item.attr.id))
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

  it("unitID 111 是反向修正百分比：0.75 = 25% 抗性", () => {
    // 弹道偏阻阵列（定锚建筑）的动能伤害抗性加成 0.75 → 25%
    expect(formatAttrValue(attr({ id: 131, name: "动能伤害抗性加成", value: 0.75, unitId: 111, unit: "%" }))).toBe(
      "25 %"
    )
    expect(formatAttrValue(attr({ id: 130, name: "热能伤害抗性加成", value: 1, unitId: 111, unit: "%" }))).toBe(
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
 * 原厂值（「还原」的目标）：后端只在**确实被改过**时才回 `originalValue`，没回就说明
 * 现值就是原厂值 —— 这条口径决定弹窗会不会把没改过的行也标成「已修改」。
 */
describe("原厂值与还原", () => {
  it("没被改过时原厂值就是现值（后端不会回 originalValue）", () => {
    const untouched = attr({ id: 37, name: "最大速度", value: 365 })
    expect(attrOriginalValue(untouched)).toBe(365)
    expect(formatOriginalValue(untouched)).toBe("365")
  })

  it("被改过时取后端回的原厂值，显示与现值同一套单位规则", () => {
    // 护盾回充时间：unitId 101 以毫秒存，625000 → 10分25秒
    const recharged = attr({
      id: 479,
      name: "护盾回充时间",
      value: 500000,
      unitId: 101,
      unit: "s",
      originalValue: 625000,
      modified: true,
    })
    expect(attrOriginalValue(recharged)).toBe(625000)
    expect(formatAttrValue(recharged)).toBe("8分20秒")
    expect(formatOriginalValue(recharged)).toBe("10分25秒")
  })

  it("modified=true 但原值缺失（SDE 里查不到这条）：退回现值，不画出一个假的差异", () => {
    const orphan = attr({ id: 9999, name: "野生属性", value: 7, modified: true })
    expect(attrOriginalValue(orphan)).toBe(7)
  })

  it("引用型属性的原值不带上按现值解析出来的名字", () => {
    const skill = attr({
      id: 182,
      name: "主技能需求",
      value: 3329,
      unitId: 116,
      unit: "typeID",
      typeName: "米玛塔尔护卫舰",
      originalValue: 3300,
      modified: true,
    })
    expect(formatAttrValue(skill)).toBe("米玛塔尔护卫舰")
    // 名字是按现值 3329 解析的，原值 3300 可能是别的物品 —— 宁可印数字
    expect(formatOriginalValue(skill)).toBe("3,300")
  })

  it("可还原的判定只看后端标记，不自己拿现值跟原值比（草稿不算）", () => {
    // 用户刚在草稿里输了 999：数值上确实跟原值不同，但后端还没标 modified → 不进列表，
    // 否则每敲一个字行尾都会冒出一个还原图标
    const draftOnly = attr({ id: 37, name: "最大速度", value: 999, originalValue: 365 })
    expect(restorableAttrs([draftOnly])).toEqual([])

    // 已经保存过的改动（后端标了 modified）→ 用后端给的原值
    const saved = attr({
      id: 148,
      name: "装甲值加成",
      value: 2,
      originalValue: 1,
      modified: true,
    })
    expect(restorableAttrs([saved])).toEqual([{ id: 148, original: 1 }])

    // 属性缺省（还没拉到 info）时不炸
    expect(restorableAttrs(undefined)).toEqual([])
    expect(restorableAttrs([])).toEqual([])
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

  it("主伤害那四条折成一行四格（电 / 火 / 动 / 爆），插在原来那条的位置", () => {
    // 弹药 EMP S 185：电磁 9 / 爆炸 2 / 动能 1，全挂在「炮台」段里（热能那格是 0，侧车已滤掉）
    const ammo = [
      attr({ id: 51, name: "射击速度", value: 2100, unitId: 101, unit: "s", category: 29 }),
      attr({ id: 114, name: "电磁伤害", value: 9, unitId: 113, unit: "HP", category: 29 }),
      attr({ id: 116, name: "爆炸伤害", value: 2, unitId: 113, unit: "HP", category: 29 }),
      attr({ id: 117, name: "动能伤害", value: 1, unitId: 113, unit: "HP", category: 29 }),
      attr({ id: 37, name: "最大速度", value: 365, unitId: 11, unit: "m/s", category: 17 }),
    ]
    const turret = attributeSections(ammo, {}).find((section) => section.id === 29)!
    // 四条照旧留在 rows 里：右栏「改属性」弹窗按 rows 列输入框，一条都不能少
    expect(turret.rows.map((row) => row.id)).toEqual([51, 114, 116, 117])
    // 渲染顺序由 items 给：四格行插在原来第一条伤害属性的位置，同组其余几条不再单独列
    expect(shape(turret)).toEqual([51, "quad"])
    // 四格固定是电磁 / 热能 / 动能 / 爆炸，没填的那格留 null（界面照客户端画「—」）
    const quad = quadOf(turret)
    expect(quad.cells.map((cell) => cell?.id ?? null)).toEqual([114, null, 117, 116])
    expect(quad.only).toBe(false)
  })

  it("整段只有伤害的段（末日武器、部分弹药）：标题带换成「伤害」，行里不再重复一遍行名", () => {
    // 末日武器「赫姆达洱之焰噬爆炸末日武器」：整段就一条爆炸伤害 2,400,000，折行后什么都不剩，
    // 旧样式会叠成「炮台 / 伤害 / 四格」；实测在售物品里有 957 段是这种
    const doomsday = [
      attr({ id: 116, name: "爆炸伤害", value: 2400000, unitId: 113, unit: "HP", category: 29 }),
    ]
    const section = attributeSections(doomsday, {})[0]
    expect(section.title).toBe(DAMAGE_TITLE)
    const quad = quadOf(section)
    // 整段就这一行四格 —— 面板因此把行名收进标题带，不再画那行重复的行名
    expect(quad.only).toBe(true)
    expect(shape(section)).toEqual(["quad"])
    expect(quad.cells.map((cell) => cell?.id ?? null)).toEqual([null, null, null, 116])
    // 那一条属性还在 rows 里：改属性弹窗仍列得出它
    expect(section.rows.map((row) => row.id)).toEqual([116])
  })

  it("同段还有别的属性时不换标题（射速 / 抗性这些照旧挂「炮台」标题带）", () => {
    const mixed = [
      attr({ id: 114, name: "电磁伤害", value: 20, unitId: 113, unit: "HP", category: 29 }),
      attr({ id: 51, name: "射击速度", value: 4000, unitId: 101, unit: "s", category: 29 }),
    ]
    const section = attributeSections(mixed, {})[0]
    expect(section.title).toBe("炮台")
    expect(quadOf(section).only).toBe(false)
    expect(shape(section)).toEqual(["quad", 51])
  })

  it("主伤害一条都没有的段不折行（舰载机那套「（每架铁骑舰载机）」保持一行一条）", () => {
    // 铁骑舰载机 Shadow 2948：同一段里两套家族各有值，客户端那一行四格只认主伤害四条
    const fighter = [
      attr({ id: 2131, name: "电磁伤害（每架铁骑舰载机）", value: 200, unitId: 113, unit: "HP", category: 34 }),
      attr({ id: 2227, name: "电磁伤害（每架铁骑舰载机）", value: 50000, unitId: 113, unit: "HP", category: 34 }),
    ]
    const section = attributeSections(fighter, {})[0]
    expect(shape(section)).toEqual([2131, 2227])
  })

  it("「伤害抗性加成」四条也折成一行四格：单抗装备另外三格留空（客户端同款）", () => {
    // 热能抗性放大器 I 2537：只有热能那条有值 -32.5，另外三条是 0（侧车按 displayWhenZero 滤掉）
    const amplifier = [
      attr({ id: 422, name: "科技等级", value: 1, unitId: 140, unit: "%", category: 7 }),
      attr({ id: 987, name: "热能伤害抗性加成", value: -32.5, unitId: 124, unit: "%", category: 7 }),
      attr({ id: 182, name: "主技能需求", value: 3425, unitId: 116, unit: "typeID", category: 8 }),
    ]
    const misc = attributeSections(amplifier, {}).find((section) => section.id === 7)!
    const quad = quadOf(misc, RESIST_BONUS_TITLE)
    // 固定顺序电磁 / 热能 / 动能 / 爆炸（与四抗色块、伤害四格同一套）
    expect(quad.cells.map((cell) => cell?.id ?? null)).toEqual([null, 987, null, null])
    expect(quad.cells.map((cell) => (cell ? formatAttrValue(cell) : "—"))).toEqual([
      "—",
      "-32.5 %",
      "—",
      "—",
    ])
    // 行插在原来第一条抗性加成所在的位置（不是拍在段首），同段别的属性照旧列在后面
    expect(shape(misc)).toEqual([422, "quad"])
    expect(quad.only).toBe(false)
  })

  it("四条都在时四格都有值（多谱抗性强化器 / 抗性膜这类）", () => {
    // 多谱抗性强化器 I 578：四条都是 -25；单位 105 / 124 都是「%」
    const hardener = [
      attr({ id: 422, name: "科技等级", value: 1, unitId: 140, unit: "%", category: 7 }),
      attr({ id: 984, name: "电磁伤害抗性加成", value: -25, unitId: 124, unit: "%", category: 7 }),
      attr({ id: 985, name: "爆炸伤害抗性加成", value: -25, unitId: 124, unit: "%", category: 7 }),
      attr({ id: 986, name: "动能伤害抗性加成", value: -25, unitId: 105, unit: "%", category: 7 }),
      attr({ id: 987, name: "热能伤害抗性加成", value: -25, unitId: 124, unit: "%", category: 7 }),
    ]
    const misc = attributeSections(hardener, {}).find((section) => section.id === 7)!
    const quad = quadOf(misc, RESIST_BONUS_TITLE)
    expect(quad.cells.map((cell) => cell?.id ?? null)).toEqual([984, 987, 986, 985])
    expect(quad.cells.map((cell) => formatAttrValue(cell!))).toEqual([
      "-25 %",
      "-25 %",
      "-25 %",
      "-25 %",
    ])
    // 四条属性照旧一条不少地留在 rows 里（改属性弹窗要用）
    expect(misc.rows.map((row) => row.id)).toEqual([422, 984, 985, 986, 987])
  })

  it("老一套的 130-133（定锚的偏导阵列）并进同一行四格", () => {
    // 单位是 111「反向修正百分比」：动能 0.75 折算成 25% 抗性，另外三条 1 就是 0%
    const array = [
      attr({ id: 130, name: "热能伤害抗性加成", value: 1, unitId: 111, unit: "%", category: 7 }),
      attr({ id: 131, name: "动能伤害抗性加成", value: 0.75, unitId: 111, unit: "%", category: 7 }),
      attr({ id: 132, name: "爆炸伤害抗性加成", value: 1, unitId: 111, unit: "%", category: 7 }),
      attr({ id: 133, name: "电磁伤害抗性加成", value: 1, unitId: 111, unit: "%", category: 7 }),
    ]
    const section = attributeSections(array, {})[0]
    const quad = quadOf(section, RESIST_BONUS_TITLE)
    expect(quad.cells.map((cell) => cell?.id ?? null)).toEqual([133, 130, 131, 132])
    expect(quad.cells.map((cell) => formatAttrValue(cell!))).toEqual(["0 %", "0 %", "25 %", "0 %"])
    expect(shape(section)).toEqual(["quad"])
    // 四条属性照旧一条不少地留在 rows 里（改属性弹窗要用）
    expect(section.rows.map((row) => row.id)).toEqual([130, 131, 132, 133])
  })

  it("伤害量那几条属性行给伤害类型编号（0 电磁 / 1 热能 / 2 动能 / 3 爆炸）", () => {
    const slot = (id: number, name: string) =>
      damageAttrSlot(attr({ id, name, value: 1, unitId: 113, unit: "HP", category: 34 }))
    expect(slot(2131, "电磁伤害（每架铁骑舰载机）")).toBe(0)
    expect(slot(2132, "热能伤害（每架铁骑舰载机）")).toBe(1)
    expect(slot(2133, "动能伤害（每架铁骑舰载机）")).toBe(2)
    expect(slot(2134, "爆炸伤害（每架铁骑舰载机）")).toBe(3)
    // 主伤害那四条走的是折行那条路，不再用单行图标
    expect(damageAttrSlot(attr({ id: 117, name: "动能伤害", value: 64, unitId: 113, unit: "HP", category: 29 }))).toBeNull()
    // 同一段的射速 / 射程与四抗不是伤害量：界面接着用分区图标
    expect(damageAttrSlot(attr({ id: 51, name: "射击速度", value: 2100, unitId: 101, unit: "s", category: 29 }))).toBeNull()
    expect(damageAttrSlot(attr({ id: 271, name: "护盾电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }))).toBeNull()
    // 「伤害加成」（138-141）不在其列 —— 客户端把它归「其他属性」，套伤害图标反而误导
    expect(damageAttrSlot(attr({ id: 138, name: "电磁伤害加成", value: 5, unitId: 113, unit: "HP", category: 7 }))).toBeNull()
  })

  it("四条抗性都是 0% 的护盾 / 装甲照样画色块（铁骑舰载机的护盾抗性本来就是 0%）", () => {
    // 铁骑舰载机 Ametat I 40362：护盾 3,762、四抗共振系数全是 1；结构只有值、没有抗性
    const fighter = [
      attr({ id: 263, name: "护盾容量", value: 3762, unitId: 113, unit: "HP", category: 2 }),
      attr({ id: 271, name: "护盾电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }),
      attr({ id: 272, name: "护盾爆炸伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }),
      attr({ id: 273, name: "护盾动能伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }),
      attr({ id: 274, name: "护盾热能伤害抗性", value: 1, unitId: 108, unit: "%", category: 2 }),
      attr({ id: 9, name: "结构值", value: 100, unitId: 113, unit: "HP", category: 4 }),
    ]
    const shield = attributeSections(fighter, {}).find((section) => section.id === 2)!
    expect(shield.defence?.resists.map((row) => row.percent)).toEqual([0, 0, 0, 0])
    // 抗性全 0% → 有效 HP 就是护盾容量本身；面板把四条抗性行折进色块，不再在下面重复列
    expect(formatAttrNumber(shield.defence!.effective!)).toBe("3,762")
    expect(shield.rows.filter((row) => !RESIST_ATTR_IDS.has(row.id)).map((row) => row.id)).toEqual([263])
  })

  it("结构抗性全是 0% 也画色块条（无人机、舰载机的结构抗性本来就是 0%）", () => {
    const rows = [
      attr({ id: 9, name: "结构值", value: 600, unitId: 113, unit: "HP", category: 4 }),
      attr({ id: 974, name: "结构电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 975, name: "结构爆炸伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 976, name: "结构动能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 977, name: "结构热能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
    ]
    const structure = attributeSections(rows, {}).find((section) => section.id === 4)!
    // 四条 0% 照样是色块条：面板不再给四条同名的普通行，与护盾 / 装甲一致
    expect(structure.defence?.resists.map((row) => row.percent)).toEqual([0, 0, 0, 0])
    expect(formatAttrNumber(structure.defence!.effective!)).toBe("600")
    // 逻辑层照旧把四条抗性留在 rows 里，面板见到色块条才过滤掉（RESIST_ATTR_IDS）
    expect(structure.rows.filter((row) => !RESIST_ATTR_IDS.has(row.id)).map((row) => row.id)).toEqual([9])
  })

  it("结构两套抗性 id 都在时挑有真值的那套，不挑整整齐齐的 0%", () => {
    // 实测 9 件在售物品两套都填：974-977 全是共振 1（0%），109-113 是 0.67（33%）
    const rows = [
      attr({ id: 9, name: "结构值", value: 600, unitId: 113, unit: "HP", category: 4 }),
      attr({ id: 974, name: "结构电磁伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 975, name: "结构爆炸伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 976, name: "结构动能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 977, name: "结构热能伤害抗性", value: 1, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 113, name: "结构电磁伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 110, name: "结构爆炸伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 109, name: "结构动能伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
      attr({ id: 111, name: "结构热能伤害抗性", value: 0.67, unitId: 108, unit: "%", category: 4 }),
    ]
    const structure = attributeSections(rows, {}).find((section) => section.id === 4)!
    expect(structure.defence?.resists.map((row) => row.id)).toEqual([113, 110, 109, 111])
    expect(structure.defence?.resists.map((row) => Math.round(row.percent))).toEqual([33, 33, 33, 33])
    // 两套加起来 8 条同名行都不再列出来 —— 色块条已经把这件事说清了
    expect(structure.rows.filter((row) => !RESIST_ATTR_IDS.has(row.id)).map((row) => row.id)).toEqual([9])
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
