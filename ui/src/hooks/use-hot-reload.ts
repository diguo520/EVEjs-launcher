/**
 * 静态数据热重载的数据源。
 *
 * 口径与其它页一致：没有桥（浏览器里跑原型）就完全不碰 IPC；只读用 call 兜底，
 * 写动作走真通道，成功后就 reload 一遍拿权威结果（不在本地猜内存里换了几张表）。
 */
import { useCallback, useEffect, useState } from "react"

import { t } from "@/lib/i18n"
import { call, hasIpc } from "@/lib/ipc"

/** hotreload:state 里的一张静态表 */
export interface HotReloadTable {
  name: string
  path: string
  sizeBytes: number
  mtimeMs: number
  /** 被服务端模块级索引冻结：内存换了，不重启主服务器不生效 */
  needsRestart: boolean
  /** 还决定「已经在跑的星系」里有什么，得等场景重建 */
  sceneBound: boolean
  /** 冻结它的服务端模块（解释「为什么」） */
  frozenBy: string
  /** 磁盘上的文件比「上一次服务端吃进去的那份」新 */
  dirty: boolean
}

/** 一张「需重启」的表 + 是谁把它冻住的 */
export interface HotReloadFrozenTable {
  name: string
  owners: string
  scene: boolean
}

export interface HotReloadReloaded {
  table: string
  bytes?: number
  ms?: number
}

export interface HotReloadSkipped {
  table: string
  reason: string
}

export interface HotReloadFailed {
  table: string
  reason: string
  error?: string
}

/** hotreload:apply / hotreload:restore 的结果（就是 host 写出来的那份 result.json） */
export interface HotReloadResult {
  ok: boolean
  supported?: boolean
  armed?: boolean
  requestId?: string
  reason?: string
  scope?: string[] | "ALL_STATIC_TABLES"
  requestedCount?: number
  reloaded?: HotReloadReloaded[]
  skipped?: HotReloadSkipped[]
  failed?: HotReloadFailed[]
  derivedRefreshed?: string[]
  elapsedMs?: number
  snapshotId?: string | null
  restoredFrom?: string
  restoredTables?: string[]
}

export interface HotReloadSnapshot {
  id: string
  at: number
  bootId: string
  tables: string[]
}

export interface HotReloadState {
  supported: boolean
  /** 这一轮主服务器是不是启动器带 host 起来的 */
  armed: boolean
  bootId: string | null
  serverPid: number | null
  sessionPid: number | null
  dir: string
  dataDir: string
  /** 被拒绝的 SQLite 运行时表张数 */
  sqliteRuntimeTables: number
  /** 需重启主服务器才生效的表张数 */
  frozenCount: number
  frozenTables: HotReloadFrozenTable[]
  dirtyCount: number
  tables: HotReloadTable[]
  last: HotReloadResult | null
  snapshots: HotReloadSnapshot[]
}

export interface HotReloadStore {
  state: HotReloadState | null
  loading: boolean
  applying: boolean
  error: string | null
  reload: () => void
  /** tables 为空数组 = 全部可重载的静态表 */
  apply: (tables: string[], snapshot?: boolean) => Promise<HotReloadResult>
  restore: (snapshotId?: string) => Promise<HotReloadResult>
}

export function useHotReload(): HotReloadStore {
  const live = hasIpc()
  const [state, setState] = useState<HotReloadState | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!live) {
      setError(t("当前不在启动器窗口里，读不到静态数据清单"))
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const reply = await call<HotReloadState>("hotreloadState")
        setState(reply ?? null)
        setError(
          reply && reply.supported === false ? t("这台机器的服务端没有 gameStore") : null
        )
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setLoading(false)
      }
    })()
  }, [live])

  useEffect(() => {
    reload()
  }, [reload])

  const apply = useCallback(
    async (tables: string[], snapshot = true): Promise<HotReloadResult> => {
      if (!live) return { ok: false, reason: t("当前不在启动器窗口里") }
      setApplying(true)
      try {
        const reply = await call<HotReloadResult>("hotreloadApply", {
          tables,
          snapshot,
        })
        return reply ?? { ok: false, reason: "后端没有回包" }
      } catch (reason) {
        return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) }
      } finally {
        setApplying(false)
        reload()
      }
    },
    [live, reload]
  )

  const restore = useCallback(
    async (snapshotId?: string): Promise<HotReloadResult> => {
      if (!live) return { ok: false, reason: t("当前不在启动器窗口里") }
      setApplying(true)
      try {
        const reply = await call<HotReloadResult>("hotreloadRestore", snapshotId)
        return reply ?? { ok: false, reason: "后端没有回包" }
      } catch (reason) {
        return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) }
      } finally {
        setApplying(false)
        reload()
      }
    },
    [live, reload]
  )

  return { state, loading, applying, error, reload, apply, restore }
}
