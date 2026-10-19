import { useCallback, useEffect, useMemo, useState } from "react"

import {
  MOD_FAVORITES_STORAGE_KEY,
  parseFavoriteIds,
  toggleFavoriteId,
} from "@/lib/mod-favorites"

function readFavoriteIds(): string[] {
  try {
    return parseFavoriteIds(window.localStorage.getItem(MOD_FAVORITES_STORAGE_KEY))
  } catch {
    // 隐私模式 / 存储被禁用时就只在本次会话里记，不把页面打挂
    return []
  }
}

/**
 * 本机收藏。与服务端的「获星」完全分开：
 *   - 获星：一人一颗、写服务端、计入公开星标数；
 *   - 收藏：只是本机书签，用来筛「我收藏的」，不出现在任何公开统计里。
 */
export function useModFavorites() {
  const [ids, setIds] = useState<string[]>(readFavoriteIds)
  const idSet = useMemo(() => new Set(ids), [ids])
  const favoriteOf = useCallback((id: string) => idSet.has(id), [idSet])
  const toggleFavorite = useCallback((id: string) => {
    setIds((prev) => toggleFavoriteId(prev, id))
  }, [])

  // 状态更新后再落盘，避免在 setState 的 updater 里做副作用
  useEffect(() => {
    try {
      window.localStorage.setItem(MOD_FAVORITES_STORAGE_KEY, JSON.stringify(ids))
    } catch {
      // 写不进去也不影响当前会话的收藏状态
    }
  }, [ids])

  return { favoriteOf, toggleFavorite }
}
