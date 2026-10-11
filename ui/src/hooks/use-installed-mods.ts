import { useEffect, useState } from "react"

import { callOr, hasIpc, type RawModList } from "@/lib/ipc"

/**
 * 本机装了哪些模组（模组清单里的 `id`）。
 *
 * 用途：导航分组按「有没有装某个模组」决定显不显示（例如群星那一组要 `evejs-faction-sim`）。
 *
 * 返回值有三种含义，调用方必须分清楚：
 *   `null`    —— 拿不到清单（浏览器里预览、桥不可用）→ 调用方按「全都显示」处理；
 *   `Set`     —— 已知清单（可能是空集：一个模组都没装）；
 *   还没回来  —— 与 `null` 区分开：有桥时先给空集（宁可先不显示，也别先闪一下再收回）。
 *
 * `refreshKey` 变化时重查一次：模组是用户现场装/卸的，而这条路没有「模组变了」的事件，
 * 所以切页时顺手重扫一遍（本地目录扫描，几毫秒）。
 */
export function useInstalledMods(refreshKey?: unknown): Set<string> | null {
  const [ids, setIds] = useState<Set<string> | null>(() => (hasIpc() ? new Set<string>() : null))

  useEffect(() => {
    if (!hasIpc()) {
      setIds(null)
      return
    }
    let alive = true
    void callOr<RawModList>("modsList", null).then((reply) => {
      if (!alive || !reply || !Array.isArray(reply.mods)) return
      setIds(new Set(reply.mods.map((mod) => mod.id).filter((id): id is string => Boolean(id))))
    })
    return () => {
      alive = false
    }
  }, [refreshKey])

  return ids
}
