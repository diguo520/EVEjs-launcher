/**
 * 补给线（赞助人）名单：**优先读远端，拿不到就退回随包那份**。
 *
 * 远端那份由 `infra/` 那个 Cloudflare 服务定时签出来（`GET /v1/sponsors.json`），
 * 走 Rust 侧的 `sponsors:snapshot`（多镜像 + 本地缓存 + 验签），所以改名单不用发版。
 *
 * 这里只做两件事：
 *   1) 把回包过一遍 `sponsorEntriesFrom`（与写名单的人共用一套校验口径）；
 *   2) 一条都没剩下（没网 / 服务还没上 / 验签没过 / 回包形状不对）时退回随包的
 *      `SPONSORS` —— 这块面板不能开天窗。
 *
 * 浏览器里（没有桥）`callOr` 直接给兜底值，原型预览照常显示随包名单。
 */
import * as React from "react"

import { callOr, type RawSponsorsSnapshot } from "@/lib/ipc"
import { SPONSORS, sponsorEntriesFrom, type SponsorEntry } from "@/lib/sponsors"

/**
 * 名单只拉一次：这块面板挂在设置页，不值得为它做轮询。
 * `force = false` 交给后端按 TTL 判断要不要真出网 —— 缓存新鲜时是纯本地读。
 *
 * 返回值直接用数组：调用方只关心「画哪几条」。回落这件事不需要透出去，
 * 面板上两条路长得一模一样，也没必要多一个「当前用的是回落名单」的提示。
 */
export function useSponsors(): SponsorEntry[] {
  const [entries, setEntries] = React.useState<SponsorEntry[]>(SPONSORS)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      const raw = await callOr<RawSponsorsSnapshot>("sponsorsSnapshot", null, false)
      if (!alive) return
      const live = sponsorEntriesFrom(raw)
      // 空名单不动 state：宁可用随包那份，也不让面板变成空的
      if (live.length) setEntries(live)
    })()
    return () => {
      alive = false
    }
  }, [])

  return entries
}
