/** 本机收藏的存储键：收藏是书签，不参与服务端星标计数 */
export const MOD_FAVORITES_STORAGE_KEY = "evejs.mod-favorites.v1"

/**
 * 解析 localStorage 里的收藏 id。
 * 数据可能被旧版本、手改或异常写入污染，这里只接受非空字符串并去重。
 */
export function parseFavoriteIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const ids = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "")
    return Array.from(new Set(ids))
  } catch {
    return []
  }
}

/** 收藏 / 取消收藏是二元切换；空 id 原样返回，避免写进一条无意义记录 */
export function toggleFavoriteId(ids: readonly string[], id: string): string[] {
  if (!id) return [...ids]
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}
