/**
 * 「找回旧模组」的纯逻辑。
 *
 * 背景见 `src-tauri/src/mods/claim.rs`：作者重装系统 / 换电脑后本机换了身份，
 * 归属保护会把他的旧模组当成别人的拒掉。恢复流程是「列出候选 → 逐个核验仓库归属 → 认领」，
 * 这里只放界面侧算得出来的那部分：排序与「这个仓库看起来是我的吗」。
 *
 * 归属的最终判定**只在后端**（要联网查 GitHub 的写权限）；前端这份只用来排序与提示，
 * 认领按钮点下去还是会老老实实走一遍核验。
 */
import type { RawClaimCandidates, RawClaimItem } from "@/lib/ipc"

/** `mods:claimCandidates` 的入参：分页 + 搜索（后端 `ClaimOptions`） */
export interface ClaimQuery {
  offset?: number
  limit?: number
  query?: string
  /** `mine`＝只看令牌账号名下（或已认领）的；`all`＝连别人的一起列 */
  scope?: ClaimScope
}

/** 候选列表的范围（后端 `ClaimScope`） */
export type ClaimScope = "mine" | "all"

/** 一页要多少条：与后端 `CLAIM_PAGE_DEFAULT` 对齐，上万条候选不能一次全要过来 */
export const CLAIM_PAGE_SIZE = 50

/**
 * 弹窗默认只看「像我的」：候选里绝大部分其实是「从市场装的别人的模组」，那些仓库在
 * 别人名下，点认领一定被拒（后端 `ClaimScope::Mine`）。被判不了归属时（登录名还没核验
 * 出来）后端不会筛，界面也不会误标。
 */
export const CLAIM_SCOPE_DEFAULT: ClaimScope = "mine"

/** 仓库主人是不是当前登录名：GitHub 的 owner 与登录名都不区分大小写 */
export function repoLooksMine(item: RawClaimItem, login: string): boolean {
  if (item.claimed) return false
  const owner = (item.repoOwner ?? "").trim().toLowerCase()
  const me = login.trim().toLowerCase()
  if (!owner || !me) return false
  return owner === me
}

/**
 * 列表顺序：像自己的最前，其次是仓库归属待确认的，已认领的垫底。
 * 认领一次只能认一个，先让人看到最有把握的那些。
 */
export function orderClaimItems(items: RawClaimItem[], login: string): RawClaimItem[] {
  const rank = (item: RawClaimItem) => (item.claimed ? 2 : repoLooksMine(item, login) ? 0 : 1)
  return [...items].sort((left, right) => {
    const diff = rank(left) - rank(right)
    if (diff !== 0) return diff
    return left.displayName.localeCompare(right.displayName)
  })
}

/** 有没有值得给用户看的候选（列表为空时页面上不出现「找回旧模组」这个入口） */
export function needsRecovery(claims: RawClaimCandidates | null): boolean {
  return claims?.ok === true && claims.items.length > 0
}
