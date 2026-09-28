import * as React from "react"

import {
  call,
  callOr,
  hasIpc,
  subscribe,
  type RawAppInfo,
  type RawUpdateCheck,
  type RawUpdateState,
} from "@/lib/ipc"
import { releaseNotesFrom } from "@/lib/release-notes"
import { LAUNCHER_META, type ReleaseNoteGroup } from "@/lib/mock"

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
  /** 最近一次 `update:check` 的真结果（没查过 / 浏览器里跑原型时为 null） */
  check: RawUpdateCheck | null
  /** 正在检查更新 */
  checking: boolean
  /** 这一版的更新说明，按 新增 / 优化 / 修复 分好组；清单里没写就是空数组 */
  notes: ReleaseNoteGroup[]
  /** 更新包体积的可读文本；拿不到时是「—」 */
  sizeText: string
  /** 清单里的发布时间（ISO 字符串）；拿不到时是空串 */
  releaseDate: string
  /** 更新通道名（清单里的 channel）；拿不到时退回构建声明的通道 */
  channel: string
  /** 真去查一次更新：更新说明与是否有新版都从这次结果来 */
  checkForUpdate: () => Promise<RawUpdateCheck | null>
  /** 开始自更新：真去下载并安装 */
  startUpdate: () => void
}

/** 字节数 → 可读体积：与现役版「安装包 18.4 MB」同一口径，拿不到写「—」 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—"
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  check: null,
  checking: false,
  notes: [],
  sizeText: "—",
  releaseDate: "",
  channel: LAUNCHER_META.channel,
  checkForUpdate: async () => null,
  startUpdate: () => {},
}

const LauncherVersionContext = React.createContext<LauncherVersionValue>(FALLBACK)

/**
 * 版本状态：启动器自己的版本与更新走真更新通道（update:state / update:check /
 * update:download + update:changed 事件），EveJS 版本取 app:info.evejsVersion。
 *
 * 原型的「假进度条」整个去掉：进度是后端下载的 percent，装与不装由后端决定。
 * 更新说明也不再是原型里的示例条目 —— 一律取自 `update:check` 回包的 changelog
 * （清单 `update-manifest.json` 里的 `{ zh, en }`），见 lib/release-notes.ts。
 */
export function useLauncherVersionState(): LauncherVersionValue {
  const live = hasIpc()
  const [update, setUpdate] = React.useState<RawUpdateState | null>(null)
  const [info, setInfo] = React.useState<RawAppInfo | null>(null)
  const [check, setCheck] = React.useState<RawUpdateCheck | null>(null)
  const [checking, setChecking] = React.useState(false)

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

  /**
   * 真查一次更新。入口只有「打开更新弹窗」这一处 —— 启动时不主动联网：
   * 更新通道的内置公钥没配之前查了也只会失败（fail closed），白白多一次请求。
   */
  const checkForUpdate = React.useCallback(async () => {
    if (!live) return null
    setChecking(true)
    try {
      const result = await callOr<RawUpdateCheck>("updateCheck", null)
      if (result) setCheck(result)
      return result
    } finally {
      setChecking(false)
    }
  }, [live])

  const version = info ? `v${info.version}` : update?.currentVersion ? `v${update.currentVersion}` : LAUNCHER_META.version
  const latestVersion = update?.latestVersion ? `v${update.latestVersion}` : version
  const outdated = latestVersion !== version
  const updating = update?.state === "downloading" || update?.state === "verifying" ||
    update?.state === "installing"
  const progress = Math.max(0, Math.min(100, Number(update?.percent ?? 0)))

  const notes = React.useMemo(
    () => (check?.changelog ? releaseNotesFrom(check.changelog) : []),
    [check]
  )
  const sizeText = formatSize(Number(check?.size ?? 0))
  const releaseDate = typeof check?.date === "string" ? check.date : ""
  const channel = check?.channel ?? update?.channel ?? LAUNCHER_META.channel

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
      check,
      checking,
      notes,
      sizeText,
      releaseDate,
      channel,
      checkForUpdate,
      startUpdate,
    }),
    [
      version,
      latestVersion,
      outdated,
      updating,
      progress,
      info,
      check,
      checking,
      notes,
      sizeText,
      releaseDate,
      channel,
      checkForUpdate,
      startUpdate,
    ]
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
