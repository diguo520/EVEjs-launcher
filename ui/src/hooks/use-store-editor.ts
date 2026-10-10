import { useCallback, useEffect, useMemo, useState } from "react"

import { t } from "@/lib/i18n"
import { call, hasIpc } from "@/lib/ipc"
import {
  addOffer as addOfferToAuthority,
  applyEdits,
  centsPerPlexOf,
  changedRowIDs,
  draftErrorsOf,
  draftOfRow,
  knownGoodImages,
  removeOffers,
  rowsOf,
  type StoreAuthority,
  type StoreEditorSnapshot,
  type StoreItemInfo,
  type StoreNewOfferDraft,
  type StoreOfferEdit,
} from "@/lib/store-editor-model"

export interface StoreSaveReply {
  ok: boolean
  reason?: string
}

export interface StoreEditorState {
  snapshot: StoreEditorSnapshot | null
  /** 工作副本 = 磁盘上的整棵 + 新上架的 − 删掉的（保存前只存在内存里） */
  authority: StoreAuthority | null
  centsPerPlex: number
  /** 客户端「没有图标」时的占位图路径；界面用它把已知能用的图挑出来 */
  placeholderImageUrl: string
  /** 现有 offer 里已经证明能显示的图片路径 */
  knownImages: string[]
  drafts: Record<string, StoreOfferEdit>
  loading: boolean
  saving: boolean
  error: string | null
  /** 未保存的行：改过的 + 新上架的 + 删掉的 */
  pendingIDs: string[]
  addedIDs: string[]
  removedIDs: string[]
  firstError: string | null
  editOffer: (id: string, patch: Partial<StoreOfferEdit>) => void
  addOffer: (draft: StoreNewOfferDraft) => string | null
  /** 删除一件商品（货架 / 商品目录 / 收银台一起删） */
  removeOffer: (id: string) => void
  lookupItems: (typeIDs: number[]) => Promise<StoreItemInfo[]>
  discard: () => void
  reload: () => void
  save: () => Promise<StoreSaveReply>
}

function draftsOf(authority: StoreAuthority | null | undefined, centsPerPlex: number) {
  const out: Record<string, StoreOfferEdit> = {}
  for (const row of rowsOf(authority ?? undefined)) {
    out[row.id] = draftOfRow(row, centsPerPlex)
  }
  return out
}

/**
 * 商城的读写：读 `storeEditor:read`、写 `storeEditor:save`、查物品 `storeEditor:itemLookup`。
 *
 * 为什么工作副本要单独留一份：上架是往权威数据里**加**记录、删除是**拿掉**记录
 * （都不是改字段），而"未保存"的原判定是"草稿与磁盘不一致" —— 新加/删掉的行两边一致，
 * 会被判成没改动、保存按钮永远是灰的。所以 addedIDs / removedIDs 各记一笔，
 * 保存成功后连同工作副本一起重置。
 *
 * 服务在跑时后端会拒绝写，这里把原因原样透出来。
 */
export function useStoreEditor(): StoreEditorState {
  const live = hasIpc()
  const [snapshot, setSnapshot] = useState<StoreEditorSnapshot | null>(null)
  const [authority, setAuthority] = useState<StoreAuthority | null>(null)
  const [addedIDs, setAddedIDs] = useState<string[]>([])
  const [removedIDs, setRemovedIDs] = useState<string[]>([])
  const [placeholderImageUrl, setPlaceholderImageUrl] = useState("")
  const [drafts, setDrafts] = useState<Record<string, StoreOfferEdit>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const centsPerPlex = useMemo(() => centsPerPlexOf(snapshot?.config), [snapshot])

  const applySnapshot = useCallback((reply: StoreEditorSnapshot) => {
    const nextAuthority = reply.authority ?? null
    setAuthority(nextAuthority)
    setDrafts(draftsOf(nextAuthority, centsPerPlexOf(reply.config)))
    setAddedIDs([])
    setRemovedIDs([])
  }, [])

  const reload = useCallback(() => {
    if (!live) {
      setError(t("当前不在启动器窗口里，读不到服务端配置"))
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const reply = await call<StoreEditorSnapshot>("storeEditorRead")
        setSnapshot(reply ?? null)
        if (!reply || reply.ok !== true) {
          setError(reply?.reason ?? "后端没有回包")
          setAuthority(null)
          setDrafts({})
          setAddedIDs([])
          setRemovedIDs([])
        } else {
          setError(null)
          applySnapshot(reply)
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setLoading(false)
      }
    })()
  }, [live, applySnapshot])

  useEffect(() => {
    reload()
  }, [reload])

  const editOffer = useCallback((id: string, patch: Partial<StoreOfferEdit>) => {
    setDrafts((prev) => {
      const current = prev[id]
      if (!current) return prev
      return { ...prev, [id]: { ...current, ...patch } }
    })
  }, [])

  const addOffer = useCallback(
    (draft: StoreNewOfferDraft): string | null => {
      const before = new Set(rowsOf(authority ?? undefined).map((row) => row.id))
      const next = addOfferToAuthority(authority ?? undefined, draft, centsPerPlex)
      if (!next) return null
      const added = rowsOf(next).find((row) => !before.has(row.id))
      setAuthority(next)
      setDrafts(draftsOf(next, centsPerPlex))
      if (added) {
        setAddedIDs((prev) => (prev.includes(added.id) ? prev : [...prev, added.id]))
        // 同一个 storeOfferID 之前被删过又加回来，墓碑要撤掉
        setRemovedIDs((prev) => prev.filter((id) => id !== added.id))
      }
      return added ? added.id : null
    },
    [authority, centsPerPlex],
  )

  const removeOffer = useCallback(
    (id: string) => {
      const next = removeOffers(authority ?? undefined, [id])
      if (!next) return
      setAuthority(next)
      setDrafts((prev) => {
        const copy = { ...prev }
        delete copy[id]
        return copy
      })
      setAddedIDs((prev) => prev.filter((item) => item !== id))
      // 从没落过盘（本次才加的）不需要墓碑；磁盘上有的才要记着删
      const onDisk = rowsOf(snapshot?.authority ?? undefined).some((row) => row.id === id)
      if (onDisk) setRemovedIDs((prev) => (prev.includes(id) ? prev : [...prev, id]))
    },
    [authority, snapshot],
  )

  const lookupItems = useCallback(
    async (typeIDs: number[]): Promise<StoreItemInfo[]> => {
      if (!live || typeIDs.length === 0) return []
      try {
        const reply = await call<{ ok: boolean; items?: StoreItemInfo[]; placeholderImageUrl?: string }>(
          "storeEditorItemLookup",
          typeIDs,
        )
        if (reply?.ok !== true) return []
        if (typeof reply.placeholderImageUrl === "string") {
          setPlaceholderImageUrl(reply.placeholderImageUrl)
        }
        return reply.items ?? []
      } catch {
        return []
      }
    },
    [live],
  )

  const discard = useCallback(() => {
    setAuthority(snapshot?.authority ?? null)
    setDrafts(draftsOf(snapshot?.authority, centsPerPlex))
    setAddedIDs([])
    setRemovedIDs([])
  }, [snapshot, centsPerPlex])

  const pendingIDs = useMemo(() => {
    const changed = changedRowIDs(authority ?? undefined, drafts, centsPerPlex)
    return [...new Set([...addedIDs, ...removedIDs, ...changed])].sort((a, b) => a.localeCompare(b))
  }, [authority, drafts, centsPerPlex, addedIDs, removedIDs])

  const firstError = useMemo(() => {
    for (const id of pendingIDs) {
      const draft = drafts[id]
      if (!draft) continue
      const errors = draftErrorsOf(draft)
      if (errors.length > 0) return errors[0]
    }
    return null
  }, [pendingIDs, drafts])

  const knownImages = useMemo(
    () => knownGoodImages(snapshot?.authority ?? undefined, placeholderImageUrl),
    [snapshot, placeholderImageUrl],
  )

  const save = useCallback(async (): Promise<StoreSaveReply> => {
    if (!live) return { ok: false, reason: t("当前不在启动器窗口里") }
    if (firstError) return { ok: false, reason: firstError }
    if (pendingIDs.length === 0) return { ok: false, reason: t("没有需要保存的改动") }
    // 工作副本里已经包含了新增与删除，直接整棵写回
    const next = applyEdits(authority ?? undefined, drafts, centsPerPlex)
    if (!next) return { ok: false, reason: t("读不到商城目录") }

    setSaving(true)
    try {
      const reply = await call<StoreEditorSnapshot>("storeEditorSave", next)
      if (!reply) return { ok: false, reason: "后端没有回包" }
      if (reply.ok !== true) {
        return { ok: false, reason: reply.reason ?? t("服务端拒绝了这次写入") }
      }
      setSnapshot((prev) => ({ ...(prev ?? { ok: true }), ...reply }))
      applySnapshot(reply)
      return { ok: true }
    } catch (reason) {
      return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      setSaving(false)
    }
  }, [live, firstError, pendingIDs.length, authority, drafts, centsPerPlex, applySnapshot])

  return {
    snapshot,
    authority,
    centsPerPlex,
    placeholderImageUrl,
    knownImages,
    drafts,
    loading,
    saving,
    error,
    pendingIDs,
    addedIDs,
    removedIDs,
    firstError,
    editOffer,
    addOffer,
    removeOffer,
    lookupItems,
    discard,
    reload,
    save,
  }
}