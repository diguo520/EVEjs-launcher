import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { call, callOr, hasIpc, subscribe } from "@/lib/ipc"
import {
  mergeEvents,
  parseProbe,
  realmOwner,
  realmPolities,
  sovereigntyView,
  territoryPairsUp,
  EMPTY_SOVEREIGNTY,
  type FactionEvent,
  type FactionProbe,
  type OverviewPayload,
  type RealmPolity,
  type RealmRaw,
  type SovereigntyView,
} from "@/lib/faction-logic"
import { t } from "@/lib/i18n"

/** 失败回包（`{ok:false, reason}`）里的原因；不是失败就返回空串 */
export function reasonOf(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const source = value as { ok?: unknown; reason?: unknown }
  if (source.ok !== false) return ""
  return typeof source.reason === "string" ? source.reason : ""
}

export interface FactionActionReply {
  ok: boolean
  reason: string
  result: unknown
}

export interface FactionController {
  /** 探针结果；null = 还没查过 */
  probe: FactionProbe | null
  checked: boolean
  checking: boolean
  available: boolean
  /** 立刻复查一次（服务端刚起来时不用等下一次轮询） */
  recheck: () => void
  /** 事件流（最新在前，最多 200 条） */
  events: FactionEvent[]
  /** SSE 连接状态；面板可用但 connected=false 说明刚掉线、Rust 侧正在重连 */
  connected: boolean
  streamReason: string
  /** 只读代理：面板任意 `/api/*` */
  api: <T>(path: string, query?: Record<string, unknown>) => Promise<T | null>
  /** GM 写操作 */
  act: (action: string, params?: Record<string, unknown>) => Promise<FactionActionReply>
}

/**
 * 势力推演面板的连接层。
 *
 * 探测与事件流是**两条独立的循环**：
 *   - 探针每 10 s 复查一次 —— 服务端起来 / 停掉都能自动跟上，用户不用重开页面；
 *   - 事件流在面板可用时订阅，断开后由 Rust 侧每 3 s 重连（渲染层只管收 `faction:event`）。
 *
 * 令牌不在这层出现：它只存在于 Rust 侧（见 src-tauri/src/faction.rs）。
 */
export interface FactionStreamOptions {
  /** 初始回补条数（1–500） */
  backlog?: number
  /** 只要这些分组的事件（见模组的 EVENT_GROUPS） */
  group?: string
}

/**
 * `useFaction(options?)` 的 `options` 是**订阅参数**：
 * KM 页要 `{ backlog: 500, group: "combat" }` —— 逐舰损失（loss / killReward）在混合流里太稀疏，
 * 不过滤的话回补 200 条里一条都捞不到，交战场面就永远开天窗。
 */
export function useFaction(options: FactionStreamOptions = {}): FactionController {
  const [probe, setProbe] = useState<FactionProbe | null>(null)
  const [checked, setChecked] = useState(false)
  const [checking, setChecking] = useState(false)
  const [events, setEvents] = useState<FactionEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [streamReason, setStreamReason] = useState("")
  const inFlight = useRef(false)

  const recheck = useCallback(() => {
    if (!hasIpc() || inFlight.current) {
      if (!hasIpc()) setChecked(true)
      return
    }
    inFlight.current = true
    setChecking(true)
    void callOr<unknown>("factionStatus", null)
      .then((raw) => setProbe(parseProbe(raw)))
      .finally(() => {
        inFlight.current = false
        setChecking(false)
        setChecked(true)
      })
  }, [])

  useEffect(() => {
    recheck()
    const timer = window.setInterval(recheck, 10_000)
    return () => window.clearInterval(timer)
  }, [recheck])

  const available = probe?.available === true
  const streamKey = `${options.backlog ?? ""}|${options.group ?? ""}`

  useEffect(() => {
    if (!hasIpc() || !available) {
      setConnected(false)
      return
    }
    let alive = true
    const offEvent = subscribe("onFactionEvent", (...args) => {
      if (!alive) return
      const payload = args[0]
      if (!payload || typeof payload !== "object") return
      setEvents((previous) => mergeEvents(previous, [payload as FactionEvent]))
    })
    const offState = subscribe("onFactionStreamState", (...args) => {
      if (!alive) return
      const payload = (args[0] ?? {}) as { connected?: unknown; reason?: unknown }
      setConnected(payload.connected === true)
      setStreamReason(typeof payload.reason === "string" ? payload.reason : "")
    })
    const streamOptions: Record<string, unknown> = {}
    if (options.backlog) streamOptions.backlog = options.backlog
    if (options.group) streamOptions.group = options.group
    void callOr("factionStream", null, true, streamOptions)
    return () => {
      alive = false
      offEvent()
      offState()
      void callOr("factionStream", null, false)
    }
    // streamKey 是参数的稳定序列化：对象字面量每次新建，不能直接进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, streamKey])

  const api = useCallback(
    async <T,>(path: string, query?: Record<string, unknown>): Promise<T | null> =>
      await callOr<T>("factionApi", null, path, query),
    []
  )

  const act = useCallback(async (action: string, params?: Record<string, unknown>) => {
    const reply = await callOr<Record<string, unknown>>("factionAction", null, action, params ?? {})
    const ok = reply?.ok === true
    const reason = reasonOf(reply)
    if (!ok) toast.error(reason || t("操作被拒绝"))
    return { ok, reason, result: reply?.result }
  }, [])

  return {
    probe,
    checked,
    checking,
    available,
    recheck,
    events,
    connected,
    streamReason,
    api,
    act,
  }
}

export interface FactionResource<T> {
  data: T | null
  error: string
  loading: boolean
  /** 最近一次拿到数据的时刻（毫秒）；0 = 还没有 */
  updatedAt: number
  reload: () => void
}

/**
 * 拉一个面板只读接口，可选定时轮询。
 *
 * `enabled=false`（面板不可用 / 这个页签没打开）时一动不动，连定时器都不建 ——
 * 面板的接口有的很大（`/api/logistics` 实测 650 KB），没打开的页签不该占这份带宽。
 * `query` 按 JSON 序列化进依赖，调用方可以直接写字面量对象。
 */
export function useFactionData<T>(
  api: FactionController["api"],
  path: string | null,
  options: { query?: Record<string, unknown>; intervalMs?: number; enabled?: boolean } = {}
): FactionResource<T> {
  const { query, intervalMs = 0, enabled = true } = options
  const queryKey = query ? JSON.stringify(query) : ""
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [nonce, setNonce] = useState(0)
  const aliveRef = useRef(true)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!path || !enabled) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const parsed = (queryKey ? JSON.parse(queryKey) : undefined) as Record<string, unknown> | undefined
      try {
        const value = await call<T>("factionApi", path, parsed)
        if (cancelled) return
        const reason = reasonOf(value)
        if (reason) {
          setError(reason)
        } else {
          setData(value)
          setError("")
          setUpdatedAt(Date.now())
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    if (intervalMs <= 0) return () => { cancelled = true }
    const timer = window.setInterval(run, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, path, queryKey, intervalMs, enabled, nonce])

  return { data, error, loading, updatedAt, reload }
}

/** 面板一页最多给 40 个势力（`lib/sim/web/paging.js` 的 MAX_SIZE） */
const OVERVIEW_PAGE = 40

/**
 * `/api/overview` 的完整读数。
 *
 * 面板的势力卡一页最多 40 个，而「势力一览」要能本地搜索 / 排序 / 翻页，所以这里把
 * 4 页一起拉回来拼成一份完整清单（121 个势力约 660 KB），**30 秒**才刷一次 ——
 * 顶栏那几个读数另有 10 秒一次的探针，两者互不牵制。页签关掉就整条停掉。
 */
export function useFactionOverview(
  api: FactionController["api"],
  enabled: boolean
): FactionResource<OverviewPayload> {
  const [data, setData] = useState<OverviewPayload | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const first = await api<OverviewPayload>("/api/overview", { size: OVERVIEW_PAGE })
        if (cancelled) return
        const reason = reasonOf(first)
        if (reason) {
          setError(reason)
          return
        }
        if (!first) return
        const pages = Math.max(1, first.paging?.pages ?? 1)
        let factions = first.factions ?? []
        if (pages > 1) {
          const rest = await Promise.all(
            Array.from({ length: pages - 1 }, (_, index) =>
              api<OverviewPayload>("/api/overview", { size: OVERVIEW_PAGE, page: index + 2 })
            )
          )
          if (cancelled) return
          for (const part of rest) {
            if (part && !reasonOf(part)) factions = factions.concat(part.factions ?? [])
          }
        }
        setData({ ...first, factions })
        setError("")
        setUpdatedAt(Date.now())
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    const timer = window.setInterval(run, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, enabled, nonce])

  return { data, error, loading, updatedAt, reload }
}

/** 一份**已配对**的领土数据（归属列 + 政体清单） */
export interface TerritoryPair {
  owner: Int16Array
  polities: RealmPolity[]
  /** 这一份是什么时候拿到的 */
  at: number
}

/**
 * 领土归属：两份数据必须成对才采用（见 `territoryPairsUp` 的说明）。
 *
 * 为什么不像别的接口那样各拉各的：归属列里的「第几个政体」与政体清单的下标是**同一套编号**，
 * 而领土一变（势力扩地 / 丢星系）编号就重排。两次请求之间若正好赶上变更，
 * 旧的归属列配上新的清单会把整张星图按错误的势力上色 —— 看起来还很"正常"。
 * 所以这里一次拉两份、当场校验；不一致就隔 300ms 重来一次，两次都不一致就保留上一份。
 */
export function useTerritory(
  api: FactionController["api"],
  enabled: boolean,
  expectedCount: number,
  intervalMs = 10_000
): TerritoryPair | null {
  const [pair, setPair] = useState<TerritoryPair | null>(null)

  useEffect(() => {
    if (!enabled || expectedCount <= 0) return
    let cancelled = false
    let retryTimer = 0

    const load = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [realm, list] = await Promise.all([
          api<RealmRaw>("/api/realm"),
          api<unknown>("/api/realm/polities"),
        ])
        if (cancelled) return
        const owner = realmOwner(realm, expectedCount)
        const polities = realmPolities(list)
        if (owner && territoryPairsUp(owner, polities)) {
          setPair({ owner, polities, at: Date.now() })
          return
        }
        await new Promise<void>((resolve) => {
          retryTimer = window.setTimeout(resolve, 300)
        })
        if (cancelled) return
      }
    }

    void load()
    const tick = window.setInterval(() => {
      void load()
    }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(tick)
      window.clearTimeout(retryTimer)
    }
  }, [api, enabled, expectedCount, intervalMs])

  return pair
}

/**
 * 玩家主权（游戏侧）：走 \`faction:sovereignty\` 通道，**不是面板 API**。
 *
 * 模组的政体版图看不到玩家军团 / 联盟的地盘，这份得从游戏库读（侧车 sovereignty-cli.js）。
 * 30 秒一拉：主权声明的变化以分钟计，没必要跟舰队一样密。
 */
export function useSovereignty(enabled: boolean, intervalMs = 30_000): SovereigntyView {
  const [view, setView] = useState<SovereigntyView>(EMPTY_SOVEREIGNTY)

  useEffect(() => {
    if (!enabled || !hasIpc()) return
    let alive = true
    const load = () => {
      void callOr<unknown>("factionSovereignty", null).then((raw) => {
        if (alive && raw) setView(sovereigntyView(raw))
      })
    }
    load()
    const timer = window.setInterval(load, intervalMs)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [enabled, intervalMs])

  return view
}
