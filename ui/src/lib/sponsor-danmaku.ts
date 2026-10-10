/**
 * 赞助人弹幕的排布与发车时刻。
 *
 * 不再用整条轨道留白：轨道一留白就会出现整屏空档。这里改成每个名字一条独立弹幕，
 * 按「目标同时可见数」均匀分配入场时刻；名字之间连续出场，但不会扎堆。
 */
export const SPONSOR_DANMAKU_TARGET_VISIBLE = 6
export const SPONSOR_DANMAKU_MIN_CYCLE_SECONDS = 42
export const SPONSOR_DANMAKU_BASE_TRAVEL_SECONDS = 22
export const SPONSOR_DANMAKU_TRAVEL_JITTER_SECONDS = 8
export const SPONSOR_DANMAKU_TOP_MIN = 8
export const SPONSOR_DANMAKU_TOP_MAX = 92

export interface SponsorDanmakuBullet {
  /** 当前弹幕在舞台里的纵向位置（百分比） */
  topPercent: number
  /** 横穿屏幕所需时间（秒） */
  travelSeconds: number
  /** 同一枚弹幕两次出场之间的完整周期（秒） */
  cycleSeconds: number
  /** Web Animations 用的负延迟（秒），把弹幕错峰发车 */
  delaySeconds: number
  /** 横穿时轻微上下漂移（px） */
  driftY: number
  /** 轻微旋转，避免所有标签平行排列 */
  rotateDeg: number
}

/** 稳定伪随机：同一个编号每次得到同一组值 */
function noise(index: number, salt: number): number {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

/**
 * 名单越长，单枚弹幕的循环越长。
 *
 * 保持同一时刻大约只有 TARGET_VISIBLE 枚在屏幕上：人数翻倍时拉长周期，而不是把
 * 屏幕挤满，也不是制造一段整屏空白。
 */
export function sponsorDanmakuCycleSeconds(count: number): number {
  const safeCount = Math.max(0, count)
  return Math.max(
    SPONSOR_DANMAKU_MIN_CYCLE_SECONDS,
    (safeCount *
      (SPONSOR_DANMAKU_BASE_TRAVEL_SECONDS +
        SPONSOR_DANMAKU_TRAVEL_JITTER_SECONDS / 2)) /
      SPONSOR_DANMAKU_TARGET_VISIBLE
  )
}

/** 为整份名单生成均匀错峰、纵向散开、带轻微漂移的弹幕参数 */
export function sponsorDanmakuSchedule(count: number): SponsorDanmakuBullet[] {
  const safeCount = Math.max(0, count)
  if (safeCount === 0) return []

  const cycleSeconds = sponsorDanmakuCycleSeconds(safeCount)
  const interval = cycleSeconds / safeCount
  const topSpan = SPONSOR_DANMAKU_TOP_MAX - SPONSOR_DANMAKU_TOP_MIN

  return Array.from({ length: safeCount }, (_, index) => {
    // 低差异纵向分布：看着不排队，又不会全部堆到上下边缘。
    const topSeed = (index * 0.6180339887498949 + noise(index, 301) * 0.11) % 1
    const topPercent = SPONSOR_DANMAKU_TOP_MIN + topSeed * topSpan

    // 均匀铺满整周期，再加一点抖动；连续但没有整齐节拍。
    const phase = (index + noise(index, 302) * 0.42) * interval
    const travelSeconds =
      SPONSOR_DANMAKU_BASE_TRAVEL_SECONDS +
      noise(index, 303) * SPONSOR_DANMAKU_TRAVEL_JITTER_SECONDS
    const driftY = (noise(index, 304) - 0.5) * 28
    const rotateDeg = (noise(index, 305) - 0.5) * 2.6

    return {
      topPercent,
      travelSeconds,
      cycleSeconds,
      delaySeconds: -phase,
      driftY,
      rotateDeg,
    }
  })
}
