import { describe, expect, it } from "vitest"

import {
  normalizeCurrency,
  parseSponsorsHtml,
  parseSponsorsJson,
  parseSponsorsTxt,
  toSponsorEntry,
} from "@/lib/sponsor-source"
import {
  SPONSORS,
  currencySymbol,
  formatAmount,
  formatMoney,
  sponsorEntriesFrom,
} from "@/lib/sponsors"

/** 假的 DOM 节点：解析器只用到 querySelectorAll / getAttribute / textContent */
function fakeRoot(
  items: Array<{ name: string; amount: string | null; currency?: string | null }>
) {
  return {
    querySelectorAll: () =>
      items.map((item) => ({
        getAttribute: (attr: string) => {
          if (attr === "data-amount") return item.amount
          if (attr === "data-currency") return item.currency ?? null
          return null
        },
        textContent: item.name,
      })),
  }
}

describe("赞助人名单 · 格式 A（TXT）", () => {
  it("一行一条，注释与空行忽略，名字里带逗号也不切错", () => {
    const { entries, skipped } = parseSponsorsTxt(
      [
        "# 补给线名单",
        "",
        "星海孤舟,666",
        "  星轨拾荒者 , 500.5 ",
        "「星门」守望者,公司,128",
      ].join("\n")
    )
    expect(skipped).toEqual([])
    expect(entries.map((e) => [e.name, e.amount])).toEqual([
      ["星海孤舟", 666],
      ["星轨拾荒者", 500.5],
      ["「星门」守望者,公司", 128],
    ])
  })

  it("末列写三位字母就当币种（大小写都认，存的时候统一大写）", () => {
    const { entries, skipped } = parseSponsorsTxt(
      ["星海孤舟,666", "Cmdr. Nova,50,USD", "Star Drifter,12.5,usd"].join("\n")
    )
    expect(skipped).toEqual([])
    expect(entries.map((e) => [e.name, e.amount, e.currency])).toEqual([
      ["星海孤舟", 666, "CNY"],
      ["Cmdr. Nova", 50, "USD"],
      ["Star Drifter", 12.5, "USD"],
    ])
  })

  it("带币种时名字里的逗号照样不切错", () => {
    const { entries, skipped } = parseSponsorsTxt("「星门」守望者,公司,128,EUR")
    expect(skipped).toEqual([])
    expect(entries.map((e) => [e.name, e.amount, e.currency])).toEqual([
      ["「星门」守望者,公司", 128, "EUR"],
    ])
  })

  it("只写了名字 + 三位字母、没有金额那一段的，判为无效（不猜成 0）", () => {
    const { entries, skipped } = parseSponsorsTxt("星海孤舟,USD")
    expect(entries).toHaveLength(0)
    expect(skipped).toEqual(["星海孤舟,USD"])
  })

  it("金额不是有限数就丢进 skipped，不编造 0", () => {
    const { entries, skipped } = parseSponsorsTxt(
      ["星海孤舟,666", "打错的行", "无金额,一"].join("\n")
    )
    expect(entries.map((e) => e.name)).toEqual(["星海孤舟"])
    expect(skipped).toEqual(["打错的行", "无金额,一"])
  })

  it("同名只保留第一条，不累加", () => {
    const { entries } = parseSponsorsTxt(["星海孤舟,666", "星海孤舟,128"].join("\n"))
    expect(entries).toHaveLength(1)
    expect(entries[0].amount).toBe(666)
  })

  it("负数金额判为无效", () => {
    const { entries, skipped } = parseSponsorsTxt("星海孤舟,-5")
    expect(entries).toHaveLength(0)
    expect(skipped).toEqual(["星海孤舟,-5"])
  })
})

describe("赞助人名单 · 格式 B（HTML）", () => {
  it("取带 data-amount 的元素，名字取 textContent", () => {
    const { entries, skipped } = parseSponsorsHtml(
      fakeRoot([
        { name: "星海孤舟", amount: "666" },
        { name: "星轨拾荒者", amount: "500.5" },
      ])
    )
    expect(skipped).toEqual([])
    expect(entries.map((e) => [e.name, e.amount])).toEqual([
      ["星海孤舟", 666],
      ["星轨拾荒者", 500.5],
    ])
  })

  it("币种取可选的 data-currency，缺省人民币", () => {
    const { entries } = parseSponsorsHtml(
      fakeRoot([
        { name: "Cmdr. Nova", amount: "50", currency: "usd" },
        { name: "星海孤舟", amount: "666" },
      ])
    )
    expect(entries.map((e) => [e.name, e.currency])).toEqual([
      ["Cmdr. Nova", "USD"],
      ["星海孤舟", "CNY"],
    ])
  })

  it("金额缺失或名字空白都判为无效并在 skipped 里留痕", () => {
    const { entries, skipped } = parseSponsorsHtml(
      fakeRoot([
        { name: "星海孤舟", amount: null },
        { name: "   ", amount: "10" },
      ])
    )
    expect(entries).toHaveLength(0)
    expect(skipped).toEqual(["星海孤舟", "<空元素>"])
  })
})

describe("赞助人名单 · 格式 C（JSON）", () => {
  it("接受裸数组与 { sponsors: [...] } 两种外形", () => {
    const bare = parseSponsorsJson(
      '[{"id":"s1","name":"星海孤舟","amount":666,"currency":"CNY"}]'
    )
    const wrapped = parseSponsorsJson(
      '{"sponsors":[{"name":"Cmdr. Nova","amount":50,"currency":"usd"}]}'
    )
    expect(bare.entries.map((e) => [e.id, e.name, e.amount, e.currency])).toEqual([
      ["s1", "星海孤舟", 666, "CNY"],
    ])
    expect(wrapped.entries.map((e) => [e.name, e.currency])).toEqual([["Cmdr. Nova", "USD"]])
    expect(bare.skipped).toEqual([])
  })

  it("不写 currency 就是人民币", () => {
    const { entries } = parseSponsorsJson('{"sponsors":[{"name":"星海孤舟","amount":666}]}')
    expect(entries[0].currency).toBe("CNY")
  })

  it("解析失败或没有 sponsors 都返回空名单 + 原因，不抛异常", () => {
    expect(parseSponsorsJson("{ 不是 JSON").skipped[0]).toContain("JSON 解析失败")
    expect(parseSponsorsJson('{"a":1}').skipped).toEqual(["JSON 里没有 sponsors 数组"])
  })
})

describe("赞助人名单 · 远端快照（sponsors:snapshot 回包）", () => {
  it("ok 为真时逐条过一遍，id 缺了按序补、币种缺省人民币", () => {
    const entries = sponsorEntriesFrom({
      ok: true,
      sponsors: [
        { id: "s1", name: "星海孤舟", amount: 666, currency: "CNY" },
        { name: "Cmdr. Nova", amount: 50, currency: "usd" },
      ],
    })
    expect(entries.map((e) => [e.id, e.name, e.amount, e.currency])).toEqual([
      ["s1", "星海孤舟", 666, "CNY"],
      ["sponsor-2", "Cmdr. Nova", 50, "USD"],
    ])
  })

  it("ok 为假、形状不对、或单条有问题：空名单或丢掉那一条，都不抛", () => {
    expect(sponsorEntriesFrom(null)).toEqual([])
    expect(sponsorEntriesFrom({ ok: false, sponsors: [{ name: "甲", amount: 1 }] })).toEqual([])
    expect(sponsorEntriesFrom({ ok: true })).toEqual([])
    expect(
      sponsorEntriesFrom({
        ok: true,
        sponsors: [
          { name: "   ", amount: 10 },
          { name: "甲", amount: "abc" },
          { name: "乙", amount: -1 },
          { name: "丙", amount: 3 },
        ],
      }).map((e) => e.name)
    ).toEqual(["丙"])
  })
})

describe("赞助人名单 · 共用校验与现有名单", () => {
  it("toSponsorEntry 统一口径：名字 trim、金额非负有限数、币种缺省人民币", () => {
    expect(toSponsorEntry("s1", " 星海孤舟 ", "666")).toEqual({
      id: "s1",
      name: "星海孤舟",
      amount: 666,
      currency: "CNY",
    })
    expect(toSponsorEntry("s1", "Cmdr. Nova", "50", "usd")).toEqual({
      id: "s1",
      name: "Cmdr. Nova",
      amount: 50,
      currency: "USD",
    })
    expect(toSponsorEntry("s1", "", 1)).toBeNull()
    expect(toSponsorEntry("s1", "甲", "abc")).toBeNull()
    expect(toSponsorEntry("s1", "甲", Number.POSITIVE_INFINITY)).toBeNull()
  })

  it("随包回落刻意留空：不把演示 / 测试名单带进界面", () => {
    expect(SPONSORS).toEqual([])
  })
})

describe("赞助人名单 · 币种符号与金额显示", () => {
  it("认得的币种给符号，认不出的码原样显示（不猜成人民币）", () => {
    expect(currencySymbol("CNY")).toBe("¥")
    expect(currencySymbol("usd")).toBe("$")
    expect(currencySymbol("EUR")).toBe("€")
    expect(currencySymbol("GBP")).toBe("£")
    expect(currencySymbol("KRW")).toBe("₩")
    expect(currencySymbol("RUB")).toBe("₽")
    expect(currencySymbol("RMB")).toBeNull()
    expect(formatMoney({ amount: 666, currency: "CNY" })).toBe("¥666")
    expect(formatMoney({ amount: 50, currency: "USD" })).toBe("$50")
    expect(formatMoney({ amount: 9.9, currency: "cny" })).toBe("¥9.9")
    expect(formatMoney({ amount: 20, currency: "XYZ" })).toBe("XYZ 20")
    expect(formatMoney({ amount: 20, currency: "" })).toBe("¥20")
  })

  it("币种归一化：三位字母转大写照收，其余当人民币", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD")
    expect(normalizeCurrency("RMB")).toBe("RMB")
    expect(normalizeCurrency("人民币")).toBe("CNY")
    expect(normalizeCurrency(null)).toBe("CNY")
    expect(normalizeCurrency(120)).toBe("CNY")
  })

  it("金额显示去掉多余的零", () => {
    expect(formatAmount(9.9)).toBe("9.9")
    expect(formatAmount(666)).toBe("666")
    expect(formatAmount(32.66)).toBe("32.66")
  })
})
