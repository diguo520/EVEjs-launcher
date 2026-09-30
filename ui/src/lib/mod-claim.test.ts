import { describe, expect, it } from "vitest"

import type { RawClaimCandidates, RawClaimItem } from "@/lib/ipc"
import { needsRecovery, orderClaimItems, repoLooksMine, shouldOfferClaim } from "@/lib/mod-claim"

function item(patch: Partial<RawClaimItem>): RawClaimItem {
  return {
    id: "evejs-x",
    folder: "evejs-x",
    displayName: "X",
    version: "1.0.0",
    declaredAuthorId: "au-old",
    declaredKeyId: "oldkey",
    declaredAuthorName: "旧名",
    repo: "",
    claimed: false,
    ...patch,
  }
}

describe("mod-claim", () => {
  it("仓库主人与登录名一致才算「像是我的」，大小写不敏感", () => {
    expect(repoLooksMine(item({ repoOwner: "diguo520" }), "diguo520")).toBe(true)
    expect(repoLooksMine(item({ repoOwner: "Diguo520" }), "diguo520")).toBe(true)
    expect(repoLooksMine(item({ repoOwner: "juzimandarin" }), "diguo520")).toBe(false)
    // 没有仓库主人 / 没有登录名：判不出来，别乱标
    expect(repoLooksMine(item({}), "diguo520")).toBe(false)
    expect(repoLooksMine(item({ repoOwner: "diguo520" }), "")).toBe(false)
    expect(repoLooksMine(item({ repoOwner: "diguo520" }), "   ")).toBe(false)
    // 已认领的不再提示「像是你的」
    expect(repoLooksMine(item({ repoOwner: "diguo520", claimed: true }), "diguo520")).toBe(false)
  })

  it("排序：像自己的最前，待确认居中，已认领垫底", () => {
    const list = [
      item({ id: "b", displayName: "B", claimed: true }),
      item({ id: "c", displayName: "C", repoOwner: "someone" }),
      item({ id: "a", displayName: "A", repoOwner: "diguo520" }),
      item({ id: "d", displayName: "D", repoOwner: "diguo520" }),
    ]
    expect(orderClaimItems(list, "diguo520").map((entry) => entry.id)).toEqual([
      "a",
      "d",
      "c",
      "b",
    ])
    // 原数组不动（纯函数）
    expect(list.map((entry) => entry.id)).toEqual(["b", "c", "a", "d"])
  })

  it("候选为空时 needsRecovery 是假（本机确实没什么可认领的）", () => {
    expect(needsRecovery(null)).toBe(false)
    expect(needsRecovery({ ok: false, items: [], skipped: [] })).toBe(false)
    expect(needsRecovery({ ok: true, items: [], skipped: [] })).toBe(false)
    const withItem: RawClaimCandidates = { ok: true, items: [item({})], skipped: [] }
    expect(needsRecovery(withItem)).toBe(true)
  })

  /**
   * 2026-09-30 报障：用户在 0.2.4 上找不到「找回旧模组」这个按钮，维护者本机却有。
   * 差别就在这条判据上：候选来自本机 mods/ 的扫描，重装后目录一空就没有候选了。
   */
  it("配了令牌的人一直能看到入口：没有候选也看得见（认领本来就要令牌）", () => {
    expect(shouldOfferClaim(null, true)).toBe(true)
    expect(shouldOfferClaim({ ok: false, items: [], skipped: [] }, true)).toBe(true)
    expect(shouldOfferClaim({ ok: true, items: [], skipped: [] }, true)).toBe(true)
  })

  it("没配令牌的人只有真扫到候选才给入口（纯玩家不多一个按钮）", () => {
    expect(shouldOfferClaim(null, false)).toBe(false)
    expect(shouldOfferClaim({ ok: true, items: [], skipped: [] }, false)).toBe(false)
    expect(
      shouldOfferClaim({ ok: true, items: [item({})], skipped: [] }, false)
    ).toBe(true)
  })
})