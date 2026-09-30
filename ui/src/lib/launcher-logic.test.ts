import { describe, expect, it } from "vitest"

import {
  bloodlineFromId,
  formatIsk,
  genderFromCode,
  logotypeKey,
  logotypeTick,
  raceFromId,
  totalIsk,
  type Account,
  type Character,
} from "@/lib/launcher-logic"

/**
 * 服务端角色表 → 界面读数的换算。这些 id 是 CCP 静态数据主键，一旦写错，
 * 界面上就是「种族资料未记录」或者一个假种族，所以按固定向量钉住。
 */
describe("角色档案换算", () => {
  it("raceID 只认四个玩家种族（1 加达里 / 2 米玛塔尔 / 4 艾玛 / 8 盖伦特）", () => {
    expect(raceFromId(1)).toBe("caldari")
    expect(raceFromId(2)).toBe("minmatar")
    expect(raceFromId(4)).toBe("amarr")
    expect(raceFromId(8)).toBe("gallente")
    // 16 是 Jove，不是可选种族；其余一律当没记录
    expect(raceFromId(16)).toBeUndefined()
    expect(raceFromId(0)).toBeUndefined()
    expect(raceFromId(null)).toBeUndefined()
    expect(raceFromId(undefined)).toBeUndefined()
  })

  it("血统按 static characterCreationBloodlines 的 12 条换算", () => {
    expect(bloodlineFromId(1)).toBe("德泰斯")
    expect(bloodlineFromId(2)).toBe("西威雷")
    expect(bloodlineFromId(4)).toBe("布鲁特")
    expect(bloodlineFromId(8)).toBe("因塔基")
    expect(bloodlineFromId(14)).toBe("维赫罗基尔")
    expect(bloodlineFromId(9)).toBeUndefined()
    expect(bloodlineFromId(null)).toBeUndefined()
  })

  it("性别：两套编码里 1 都是男性，0 与 2 各自是女性", () => {
    expect(genderFromCode(1)).toBe("male")
    expect(genderFromCode(0)).toBe("female")
    expect(genderFromCode(2)).toBe("female")
    expect(genderFromCode(3)).toBeUndefined()
    expect(genderFromCode(null)).toBeUndefined()
  })

  it("徽标键带上 kind，军团与联盟的 id 不会撞在一起", () => {
    expect(logotypeKey("corporations", 98000001)).toBe("corporations:98000001")
    expect(logotypeKey("alliances", 98000001)).toBe("alliances:98000001")
  })

  it("徽标短标识：截 4 个字符、大写，空值回 ?", () => {
    expect(logotypeTick("ELFQ")).toBe("ELFQ")
    expect(logotypeTick("elysi")).toBe("ELYS")
    expect(logotypeTick("   ")).toBe("?")
    expect(logotypeTick(null)).toBe("?")
    expect(logotypeTick(undefined)).toBe("?")
  })

  it("ISK 合计按千分位原样展示，不缩写", () => {
    expect(formatIsk(0)).toBe("0")
    expect(formatIsk(100000)).toBe("100,000")
    expect(formatIsk(3000000000)).toBe("3,000,000,000")
    // 脏数据不该把 footer 变成 NaN
    expect(formatIsk(Number.NaN)).toBe("0")
  })
})

function character(over: Partial<Character>): Character {
  return {
    id: "1",
    name: "Test Pilot",
    ship: "Ibis",
    sp: 0,
    location: "Jita",
    online: false,
    bornAt: "—",
    ...over,
  }
}

describe("账号 ISK 合计", () => {
  const account = {
    id: "1",
    name: "test",
    role: "PLAYER",
    status: "READY",
    createdAt: "—",
    lastLogin: "—",
    characters: [
      character({ id: "1", isk: 1_000_000_000 }),
      character({ id: "2", isk: 500 }),
      // 没读到钱包的（老数据 / 后端没返回）按 0 算，不该变 NaN
      character({ id: "3" }),
    ],
  } as Account

  it("三个角色加起来", () => {
    expect(totalIsk(account)).toBe(1_000_000_500)
  })

  it("空账号是 0", () => {
    expect(totalIsk({ ...account, characters: [] })).toBe(0)
  })
})
