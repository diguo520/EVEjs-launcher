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