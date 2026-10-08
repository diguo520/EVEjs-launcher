import { useCallback, useEffect, useMemo, useState } from "react"

import { t } from "@/lib/i18n"
import { call, hasIpc } from "@/lib/ipc"
import {
  draftDiff,
  draftOf,
  valueToText,
  type GameConfigDefinition,
  type GameConfigDraft,
  type GameConfigSnapshot,
} from "@/lib/game-config-model"

export interface GameConfigSaveReply {
  ok: boolean
  reason?: string
  /** 写前备份落在服务端 _local/config-backups/ 下的目录 */
  backupDir?: string
  /** 这次实际改写了哪几个域文件 */
  saved?: string[]
}

export interface GameConfigState {
  /** 读通道还没回来（或服务端没有配置系统）时为 null */
  snapshot: GameConfigSnapshot | null
  definitions: GameConfigDefinition[]
  /** 磁盘上的当前值（基准，用于比对改动） */
  values: Record<string, unknown>
  defaults: Record<string, unknown>
  sources: Record<string, string>
  /** 被环境变量接管的键：改文件对这些项不生效 */
  envOverrides: string[]
  draft: GameConfigDraft
  loading: boolean
  saving: boolean
  /** 读通道给的可读原因（支持=false 时是"这台机器的服务端没有配置系统"） */
  error: string | null
  setValue: (key: string, text: string) => void
  /** 把某一项改回服务端默认值（只改草稿，保存后才落盘） */
  resetToDefault: (def: GameConfigDefinition) => void
  /** 放弃全部未保存改动 */
  discard: () => void
  reload: () => void
  /** 提交改动：只发真正变了的键 */
  save: () => Promise<GameConfigSaveReply>
  /** 当前未保存的补丁与校验错误 */
  pending: { patch: Record<string, unknown>; errors: Record<string, string> }
}

/**
 * 宇宙参数的数据源：读写都走后端的两条通道。
 *
 * 浏览器里（没有桥）不假装成功：读拿不到就停在空态，保存直接回「不在启动器里」。
 */
export function useGameConfig(): GameConfigState {
  const live = hasIpc()
  const [snapshot, setSnapshot] = useState<GameConfigSnapshot | null>(null)
  const [draft, setDraft] = useState<GameConfigDraft>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!live) {
      setError(t("当前不在启动器窗口里，读不到服务端配置"))
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const reply = await call<GameConfigSnapshot>("gameConfigRead")
        setSnapshot(reply ?? null)
        if (!reply || reply.ok !== true) {
          setError(reply?.reason ?? "后端没有回包")
          setDraft({})
        } else {
          setError(null)
          setDraft(draftOf(reply.values))
        }
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

  // 稳定的引用：下面每一处 useMemo / useCallback 都拿它当依赖，
  // 直接写 `snapshot?.definitions ?? []` 会让依赖每渲染一次就变一次。
  const definitions = useMemo(() => snapshot?.definitions ?? [], [snapshot])
  const values = useMemo(() => snapshot?.values ?? {}, [snapshot])

  const setValue = useCallback((key: string, text: string) => {
    setDraft((prev) => ({ ...prev, [key]: text }))
  }, [])

  const resetToDefault = useCallback((def: GameConfigDefinition) => {
    setDraft((prev) => ({ ...prev, [def.key]: valueToText(def.defaultValue) }))
  }, [])

  const discard = useCallback(() => {
    setDraft(draftOf(snapshot?.values))
  }, [snapshot])

  const pending = draftDiff(definitions, draft, values)

  const save = useCallback(async (): Promise<GameConfigSaveReply> => {
    if (!live) return { ok: false, reason: t("当前不在启动器窗口里") }
    const diff = draftDiff(definitions, draft, values)
    const invalid = Object.values(diff.errors)
    if (invalid.length > 0) return { ok: false, reason: invalid[0] }
    if (Object.keys(diff.patch).length === 0) {
      return { ok: false, reason: t("没有需要保存的改动") }
    }
    setSaving(true)
    try {
      const reply = await call<GameConfigSnapshot>("gameConfigSave", diff.patch)
      if (!reply) return { ok: false, reason: "后端没有回包" }
      if (reply.ok !== true) {
        return { ok: false, reason: reply.reason ?? t("服务端拒绝了这次写入") }
      }
      // 写成功后用服务端回读的值当新基准：磁盘才是真相，界面不自己猜
      setSnapshot((prev) => (prev ? { ...prev, values: reply.values ?? prev.values, sources: reply.sources ?? prev.sources } : prev))
      setDraft(draftOf(reply.values ?? values))
      return { ok: true, backupDir: reply.backupDir, saved: reply.saved }
    } catch (reason) {
      return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      setSaving(false)
    }
  }, [live, definitions, draft, values])

  return {
    snapshot,
    definitions,
    values,
    defaults: snapshot?.defaults ?? {},
    sources: snapshot?.sources ?? {},
    envOverrides: snapshot?.envOverrides ?? [],
    draft,
    loading,
    saving,
    error,
    setValue,
    resetToDefault,
    discard,
    reload,
    save,
    pending,
  }
}
