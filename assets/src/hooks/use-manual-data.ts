import { useEffect, useState } from "react"

import {
  toItems,
  toNpcs,
  toTemplates,
  type ItemRow,
  type NpcRow,
  type TemplateRow,
} from "@/lib/manual-logic"

/**
 * 手册里三张大表（模板 5944 / 物品 26896 / NPC 5620）只在对应标签页打开时才拉取。
 * 数据跟着页面同源走，不走第三方请求；解析结果缓存到模块级，切回标签页不再重解析。
 */
const LOADERS = {
  templates: () => import("@/data/templates.json?raw"),
  items: () => import("@/data/items.json?raw"),
  npcs: () => import("@/data/npcs.json?raw"),
} as const

export type ManualKind = keyof typeof LOADERS

interface KindMap {
  templates: TemplateRow
  items: ItemRow
  npcs: NpcRow
}

const MAPPERS: { [K in ManualKind]: (raw: unknown) => KindMap[K][] } = {
  templates: toTemplates,
  items: toItems,
  npcs: toNpcs,
}

// 索引签名用宽类型存，读出来时按 kind 断言回具体行型——kind 决定了解析器，这是安全的
const cache: Partial<Record<ManualKind, unknown[]>> = {}
const pending: Partial<Record<ManualKind, Promise<unknown[]>>> = {}

function load<K extends ManualKind>(kind: K): Promise<KindMap[K][]> {
  const inflight = pending[kind]
  if (inflight) return inflight as Promise<KindMap[K][]>

  const task = LOADERS[kind]()
    .then((mod) => {
      const parsed = MAPPERS[kind](JSON.parse((mod as { default: string }).default))
      // 缓存写在这里而不是 hook 里：预取也走同一条路径，才能真正省掉重复解析
      cache[kind] = parsed
      return parsed
    })
    .catch((err: unknown) => {
      delete pending[kind]
      throw err
    })

  pending[kind] = task
  return task
}

export interface ManualDataState<T> {
  rows: T[]
  loading: boolean
  failed: boolean
}

/**
 * 提前把大表拉下来：鼠标移到标签页上就开始下载，点开时就不用等。
 * 失败不抛错——真正打开标签页时 hook 会再试一次。
 */
export function preloadManualData<K extends ManualKind>(kind: K): Promise<void> {
  if (cache[kind]) return Promise.resolve()
  return load(kind).then(
    () => undefined,
    () => undefined
  )
}

/**
 * `enabled` 为 false 时不发起加载——指令生成器的联想表要等用户真的开始输入才拉，
 * 否则一进手册页就会把物品大表拖下来。
 */
export function useManualData<K extends ManualKind>(
  kind: K,
  enabled = true
): ManualDataState<KindMap[K]> {
  const [rows, setRows] = useState<KindMap[K][]>(
    () => (cache[kind] as KindMap[K][] | undefined) ?? []
  )
  const [loading, setLoading] = useState(() => enabled && !cache[kind])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const cached = cache[kind] as KindMap[K][] | undefined
    if (cached) {
      setRows(cached)
      setLoading(false)
      return
    }
    if (!enabled) {
      setLoading(false)
      return
    }

    let alive = true
    setLoading(true)
    setFailed(false)

    load(kind)
      .then((parsed) => {
        if (!alive) return
        setRows(parsed)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setFailed(true)
        setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [kind, enabled])

  return { rows, loading, failed }
}
