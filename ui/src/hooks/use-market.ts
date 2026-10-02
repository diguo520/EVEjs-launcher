import { useCallback, useEffect, useRef, useState } from "react"

import {
  callOr,
  hasIpc,
  type RawMarketBook,
  type RawMarketCatalog,
  type RawMarketOverview,
  type RawMarketTrades,
} from "@/lib/ipc"
import { EMPTY_CATALOG, toCatalog, type MarketCatalog } from "@/lib/market-logic"

/** 成交流水一次拉多少条：够证明「库在动」就行，再多是白占内存 */
const TRADE_LIMIT = 60

export interface MarketStore {
  ipc: boolean
  loading: boolean
  /** 库读不到时的原因（服务端还没建种子 / 侧车缺件），界面拿它画提示 */
  reason: string | null
  overview: RawMarketOverview | null
  catalog: MarketCatalog
  catalogLoaded: boolean
  trades: RawMarketTrades | null
  tradesLoading: boolean
  book: RawMarketBook | null
  bookLoading: boolean
  refresh: () => Promise<void>
  refreshTrades: () => Promise<void>
  /** 选物品 = 拉它的盘口明细；传 null 清空选择（右侧改画最近成交） */
  selectType: (typeId: number | null) => Promise<void>
}

/**
 * 市场页的数据源。**每次打开页面都重新拉**，不落任何缓存 —— 库是活的：
 * seed_stock.quantity 与 region_summaries 的最优买卖价会随游戏内成交变化，
 * 缓存下来看到的就不是当下库存了（2026-10-02 用户明确要求）。
 *
 * 为什么 overview 与 catalog 分两次调：overview 几百字节，catalog 是 2.3 MB。
 * 先到的那份就能把瓦片画出来，catalog 到了再填列表；库缺失时也能各自给提示。
 * 两次是**串行**的：两个 node 侧车同时起要多占一份内存，而省下的时间可以忽略。
 */
export function useMarket(): MarketStore {
  const ipc = hasIpc()
  const [loading, setLoading] = useState(ipc)
  const [reason, setReason] = useState<string | null>(null)
  const [overview, setOverview] = useState<RawMarketOverview | null>(null)
  const [catalog, setCatalog] = useState<MarketCatalog>(EMPTY_CATALOG)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [trades, setTrades] = useState<RawMarketTrades | null>(null)
  const [tradesLoading, setTradesLoading] = useState(ipc)
  const [book, setBook] = useState<RawMarketBook | null>(null)
  const [bookLoading, setBookLoading] = useState(false)
  // 详情是「点谁拉谁」：慢请求回来时用户可能已经点了别的物品，
  // 用序号把过期回包丢掉，免得详情面板显示上一个物品的数据
  const bookSeq = useRef(0)

  const loadTrades = useCallback(async () => {
    if (!ipc) return
    setTradesLoading(true)
    const reply = await callOr<RawMarketTrades>("marketTrades", null, TRADE_LIMIT)
    setTrades(reply)
    setTradesLoading(false)
  }, [ipc])

  const load = useCallback(async () => {
    if (!ipc) {
      setLoading(false)
      setTradesLoading(false)
      return
    }
    setLoading(true)
    setReason(null)

    const head = await callOr<RawMarketOverview>("marketOverview", null)
    setOverview(head)
    if (head && head.ok === false) {
      // 库缺失是服务端还没建种子，不是启动器坏了：把侧车给的原话直接透给用户
      setReason(head.reason ?? "市场库不可用")
      setCatalog(EMPTY_CATALOG)
      setCatalogLoaded(false)
      setLoading(false)
      return
    }

    const head2 = await callOr<RawMarketCatalog>("marketCatalog", null)
    if (head2 && head2.ok === false) {
      setReason(head2.reason ?? "市场库不可用")
      setCatalog(EMPTY_CATALOG)
      setCatalogLoaded(false)
    } else {
      setCatalog(toCatalog(head2))
      setCatalogLoaded(true)
    }
    setLoading(false)
  }, [ipc])

  const selectType = useCallback(
    async (typeId: number | null) => {
      bookSeq.current += 1
      const seq = bookSeq.current
      if (!ipc || typeId == null) {
        setBook(null)
        setBookLoading(false)
        return
      }
      setBookLoading(true)
      const reply = await callOr<RawMarketBook>("marketBook", null, typeId)
      if (seq !== bookSeq.current) return
      setBook(reply)
      setBookLoading(false)
    },
    [ipc]
  )

  const refresh = useCallback(async () => {
    await load()
    await loadTrades()
  }, [load, loadTrades])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    ipc,
    loading,
    reason,
    overview,
    catalog,
    catalogLoaded,
    trades,
    tradesLoading,
    book,
    bookLoading,
    refresh,
    refreshTrades: loadTrades,
    selectType,
  }
}
