import { useCallback, useEffect, useMemo, useState } from "react"

import { t } from "@/lib/i18n"
import { call, hasIpc } from "@/lib/ipc"
import { markUnsaved, sameDraft } from "@/lib/unsaved"
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
/**
 * 草稿的**会话级缓存**（H4）：页面切走时整棵子树会被卸载，草稿只放 useState 里就一起没了。
 * 放模块级 → 切页、重挂载都还在；save / discard / reload 时按各自语义改写它。
 */
let DRAFT_CACHE: GameConfigDraft | null = null
/** 服务端最近一次给的那份草稿：用来判断「当前草稿有没有改动」 */
let SERVER_DRAFT: GameConfigDraft | null = null

/** 缓存里那份草稿是不是已经被改过（用于重挂载时**不要**覆盖用户的改动） */
function cacheHasEdits(): boolean {
  return DRAFT_CACHE !== null && SERVER_DRAFT !== null && !sameDraft(DRAFT_CACHE, SERVER_DRAFT)
}

export function useGameConfig(): GameConfigState {
  const live = hasIpc()
  const [snapshot, setSnapshot] = useState<GameConfigSnapshot | null>(null)
  const [draft, setDraftState] = useState<GameConfigDraft>(() => DRAFT_CACHE ?? {})
  /** 包一层：每次改动都同步进模块缓存，切页回来还在（H4）；值/更新函数两种写法都支持 */
  const setDraft = useCallback(
    (next: GameConfigDraft | ((prev: GameConfigDraft) => GameConfigDraft)) => {
      setDraftState((prev) => {
        const value = typeof next === "function" ? next(prev) : next
        DRAFT_CACHE = value
        return value
      })
    },
    []
  )
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
          // 读失败也别把草稿清空（H4）：那等于替用户丢掉他刚改的东西
          if (!cacheHasEdits()) setDraft({})
        } else {
          setError(null)
          const fresh = draftOf(reply.values)
          // 切页回来会重挂载并自动 reload：**有未保存改动时不能用服务端值覆盖草稿**，
          // 否则「悄悄丢改动」只是换了个地方发生（H4）
          const keepEdits = cacheHasEdits()
          SERVER_DRAFT = fresh
          if (!keepEdits) setDraft(fresh)
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
    const fresh = draftOf(snapshot?.values)
    SERVER_DRAFT = fresh
    setDraft(fresh)
  }, [snapshot])

  const pending = draftDiff(definitions, draft, values)

  /**
   * 登记「本页有未保存改动」（H4）：窗口关闭时由 App 的 beforeunload 拦住。
   * 注意**不在卸载时清掉** —— 草稿还在模块缓存里，切页不算「离开」；
   * 只有 save / discard 之后（本地不再脏）才该归零。
   */
  const localDirty = !sameDraft(draft, SERVER_DRAFT ?? {})
  useEffect(() => {
    markUnsaved("game-config", localDirty)
  }, [localDirty])

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
      const fresh = draftOf(reply.values ?? values)
      SERVER_DRAFT = fresh
      setDraft(fresh)
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
