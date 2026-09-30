import * as React from "react"

import { useLocale } from "@/components/shell/locale-provider"
import {
  call,
  callOr,
  hasIpc,
  subscribe,
  type RawAppInfo,
  type RawUpdateCheck,
  type RawUpdateState,
} from "@/lib/ipc"
import { changelogLanguage, releaseNotesFrom } from "@/lib/release-notes"
import { LAUNCHER_META, type ReleaseNoteGroup } from "@/lib/mock"
import { isSelfTestSession, startUpdateWatch } from "@/lib/update-watch"
import { updatePhaseView, type UpdatePhase } from "@/lib/update-phase"

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
  /** 开始自更新：先把更新包下载下来（下载完还要再点一次「重启并安装」） */
  startUpdate: () => void
  /** 下载完成后真的去替换：拉起 Go 更新器并重启（老版 0.1.28 的「重启并安装」） */
  installUpdate: () => void
  /** 后端 update:state 认出来的阶段：idle / downloading / ready / applying / … */
  phase: UpdatePhase
  /** 后端给更新状态配的说明：下载提示与失败原因都在这里 */
  updateMessage: string
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
  installUpdate: () => {},
  phase: "idle",
  updateMessage: "",
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
  const { locale } = useLocale()
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
   * 真查一次更新。两个入口：开机后的自动排班（见下面的 startUpdateWatch），
   * 以及打开更新弹窗时补查一次 —— 弹窗里要的是此刻的事实。
   *
   * 自动检查省不得：左下角的更新入口在「没有新版」时什么都不渲染，
   * 不主动查它就没有亮起来的机会（设置 → 关于里的「检查更新」是老版就有的兜底入口）。
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

  /**
   * 开机 5 秒后查一次、之后每 30 分钟复查、窗口重新聚焦时补查
   * （节奏与老版 0.1.28 一致，见 lib/update-watch.ts）。
   * 只负责查：查到新版本会经 update:changed 落到 update 上，底部入口自己就亮了。
   */
  React.useEffect(() => {
    // 自检 / 冒烟进程不排后台检查：那是无人值守的诊断跑，不该真去打 GitHub，
    // 也不该把瞬时状态留给冻结基线（见 lib/update-watch.ts 的 isSelfTestSession）
    if (!live || isSelfTestSession()) return
    return startUpdateWatch({
      check: () => void checkForUpdate(),
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle),
      addFocusListener: (fn) => window.addEventListener("focus", fn),
      removeFocusListener: (fn) => window.removeEventListener("focus", fn),
    })
  }, [live, checkForUpdate])

  const version = info ? `v${info.version}` : update?.currentVersion ? `v${update.currentVersion}` : LAUNCHER_META.version
  const latestVersion = update?.latestVersion ? `v${update.latestVersion}` : version
  const outdated = latestVersion !== version

  /**
   * 阶段与进度都从后端那一个状态收出来（见 lib/update-phase.ts）。
   * 「下载完成」也算忙：这时界面要给的是「重启并安装」，而不是再点一次「立即更新」——
   * 2026-09-30 报障：以前只有下载那一步，包下完了却从来没调过 update:apply。
   */
  const phaseView = React.useMemo(
    () => updatePhaseView(update?.state, update?.percent, update?.message),
    [update?.state, update?.percent, update?.message]
  )
  const updating = phaseView.busy
  const progress = phaseView.progress

  // 更新说明按界面语言取：中文看 changelog.zh，其余语言看 changelog.en
  const notes = React.useMemo(
    () =>
      check?.changelog ? releaseNotesFrom(check.changelog, changelogLanguage(locale)) : [],
    [check, locale]
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

  /**
   * 下载完成后才走的那一步：把包交给 Go 更新器替换 exe 并重启，本进程随即退出。
   * 前置（还有服务在跑、更新器不存在…）由后端自己拦，原因经 update:changed 落回 updateMessage。
   */
  const installUpdate = React.useCallback(() => {
    if (!live) return
    void call("updateApply").catch(() => {
      /* 同上：失败原因走后端状态，界面照 updateMessage 显示 */
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
      installUpdate,
      phase: phaseView.phase,
      updateMessage: phaseView.message,
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
      installUpdate,
      phaseView,
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
