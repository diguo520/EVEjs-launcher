import * as React from "react"
import { toast } from "sonner"

import { LAUNCHER_META } from "@/lib/mock"

/** 更新包下载进度多久跳一次 */
const TICK_MS = 120

export interface LauncherVersionValue {
  /** 当前安装的启动器版本 */
  version: string
  /** 更新通道上的最新版本 */
  latestVersion: string
  /** 是否有可更新版本 */
  outdated: boolean
  /** 正在下载更新包 */
  updating: boolean
  /** 下载进度 0–100 */
  progress: number
  /** 开始自更新：进度走完后把本地版本推到最新 */
  startUpdate: () => void
}

/** 兜底值与数据源保持一致：Provider 外渲染时也要如实反映有新版 */
const FALLBACK: LauncherVersionValue = {
  version: LAUNCHER_META.version,
  latestVersion: LAUNCHER_META.latestVersion,
  outdated: LAUNCHER_META.version !== LAUNCHER_META.latestVersion,
  updating: false,
  progress: 0,
  startUpdate: () => {},
}

const LauncherVersionContext = React.createContext<LauncherVersionValue>(FALLBACK)

/**
 * 版本状态本身。外壳自己也要读它（环境自检里那份二进制跟着构建走），
 * 而外壳在 Provider 外面，拿不到 context，所以状态在这里建、由外壳传进来。
 *
 * 下载进度也放这儿：更新弹窗关掉之后，侧栏还得接着显示进度，
 * 两处各存一份必然对不上。
 */
export function useLauncherVersionState(): LauncherVersionValue {
  const [version, setVersion] = React.useState(LAUNCHER_META.version)
  const [updating, setUpdating] = React.useState(false)
  const [progress, setProgress] = React.useState(0)

  React.useEffect(() => {
    if (!updating) return
    const timer = window.setInterval(() => {
      setProgress((prev) => Math.min(100, prev + 5 + Math.random() * 6))
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [updating])

  React.useEffect(() => {
    if (!updating || progress < 100) return
    setUpdating(false)
    setVersion(LAUNCHER_META.latestVersion)
    toast.success(`启动器已更新到 ${LAUNCHER_META.latestVersion}`, {
      description: "更新内容已生效，配置与世界存档不受影响。",
    })
  }, [updating, progress])

  return React.useMemo<LauncherVersionValue>(
    () => ({
      version,
      latestVersion: LAUNCHER_META.latestVersion,
      outdated: version !== LAUNCHER_META.latestVersion,
      updating,
      progress,
      startUpdate: () => {
        setProgress(0)
        setUpdating(true)
      },
    }),
    [version, updating, progress]
  )
}

/**
 * 启动器版本状态：顶栏、状态栏、设置页、侧栏自更新入口共用一份，
 * 避免更新完成后各处版本号对不上。
 */
export function LauncherVersionProvider({
  value,
  children,
}: {
  value: LauncherVersionValue
  children: React.ReactNode
}) {
  return (
    <LauncherVersionContext.Provider value={value}>
      {children}
    </LauncherVersionContext.Provider>
  )
}

export function useLauncherVersion() {
  return React.useContext(LauncherVersionContext)
}
