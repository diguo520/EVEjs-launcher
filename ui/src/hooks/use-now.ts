import { useEffect, useState } from "react"

/**
 * 每隔一段时间报一次当前时间。
 * 给「在线多久了」这种一直往前走的读数用：靠渲染自己不会动，得有个节拍。
 */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return now
}
