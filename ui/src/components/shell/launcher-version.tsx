import * as React from "react"

import { call, callOr, hasIpc, subscribe, type RawAppInfo, type RawUpdateState } from "@/lib/ipc"
import { LAUNCHER_META } from "@/lib/mock"

export interface LauncherVersionValue {
  /** 当前安装的启动器版本（带 v 前缀，用于显示） */
  version: string
  /** 更新通道上的最新版本；没有更新源时等于当前版本 */
  latestVersion: string
  /** 是否有可更新版本 */
  outdated: boolean
  /** 正在下载更新包 */
  updating: boolean
  /** 下载进度 0–100 */
  progress: number
  /** EveJS 服务端版本（app:info.evejsVersion），状态栏显示用 */
  evejsVersion: string
  /** 服务端根目录（app:info.repoRoot）：配置中心与模组页的默认值 */
  repoRoot: string
  /** 开始自更新：真去下载并安装 */
  startUpdate: () => void
}

/** 兜底值与数据源保持一致：Provider 外渲染时也要能显示当前构建 */
const FALLBACK: LauncherVersionValue = {
  version: LAUNCHER_META.version,
  latestVersion: LAUNCHER_META.latestVersion,
  outdated: false,
  updating: false,
  progress: 0,
  evejsVersion: LAUNCHER_META.version,
  repoRoot: "",
  startUpdate: () => {},
}

const LauncherVersionContext = React.createContext<LauncherVersionValue>(FALLBACK)

/**
 * 版本状态：启动器自己的版本与更新走真更新通道（update:state / update:check /
 * update:download + update:changed 事件），EveJS 版本取 app:info.evejsVersion。
 *
 * 原型的「假进度条」整个去掉：进度是后端下载的 percent，装与不装由后端决定。
 */
export function useLauncherVersionState(): LauncherVersionValue {
  const live = hasIpc()
  const [update, setUpdate] = React.useState<RawUpdateState | null>(null)
  const [info, setInfo] = React.useState<RawAppInfo | null>(null)

  React.useEffect(() => {
    if (!live) return
    let alive = true
    void callOr<RawUpdateState>("updateState", null).then((value) => {
      if (alive && value) setUpdate(value)
    })
    void callOr<RawAppInfo>("appInfo", null).then((value) => {
      if (alive && value) setInfo(value)
    })
    const off = subscribe("onUpdateChanged", (payload) => {
      const next = (payload ?? null) as RawUpdateState | null
      if (next) setUpdate(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [live])

  const version = info ? `v${info.version}` : update?.currentVersion ? `v${update.currentVersion}` : LAUNCHER_META.version
  const latestVersion = update?.latestVersion ? `v${update.latestVersion}` : version
  const outdated = latestVersion !== version
  const updating = update?.state === "downloading" || update?.state === "verifying" ||
    update?.state === "installing"
  const progress = Math.max(0, Math.min(100, Number(update?.percent ?? 0)))

  const startUpdate = React.useCallback(() => {
    if (!live) return
    void call("updateDownload").catch(() => {
      /* 后端不可用/更新源没配：状态栏会显示 update:state 的 message，这里不弹二次错误 */
    })
  }, [live])

  return React.useMemo<LauncherVersionValue>(
    () => ({
      version,
      latestVersion,
      outdated,
      updating,
      progress,
      evejsVersion: info ? `v${info.evejsVersion}` : LAUNCHER_META.version,
      repoRoot: info?.repoRoot ?? "",
      startUpdate,
    }),
    [version, latestVersion, outdated, updating, progress, info, startUpdate]
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