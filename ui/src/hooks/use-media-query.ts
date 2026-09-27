import { useEffect, useState } from "react"

/**
 * 断点判断。侧栏在窄窗要换一副骨架（图标条 vs 完整侧栏），
 * 只靠 CSS 隐藏会留下两套 DOM 和两个弹窗，所以这里用 matchMedia 直接选结构。
 * 初值同步取一次，首屏不会先渲染宽的那套再跳。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}
