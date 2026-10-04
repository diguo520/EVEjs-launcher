import { useCallback, useEffect, useRef, useState } from "react"

import {
  callOr,
  hasIpc,
  type RawMarketAdjust,
  type RawMarketAdjustInput,
  type RawMarketBook,
  type RawMarketCatalog,
  type RawMarketOverview,
  type RawMarketTrades,
  type RawMarketTypeInfo,
} from "@/lib/ipc"
import type { LocaleCode } from "@/lib/i18n"
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
  /**
   * 改某站某物品的种子库存价格 / 数量。
   *
   * 成功后就地刷新盘口与总览，**不重拉 2.3 MB 的清单** —— 清单里只有物品名与分类，
   * 价格与库存分别在盘口和总览里。回包是后端原样：`ok=false` 时 `reason` 直接给用户看。
   */
  adjustStock: (input: RawMarketAdjustInput) => Promise<RawMarketAdjust | null>
  /**
   * 取一条物品的简介与属性（悬停卡与右栏「简介 / 属性」页签用）。
   *
   * `typeId = 0` 只预热索引，用于打开页面时把那 ~1.5 s 的 SDE 扫描提前做掉。
   * 回包按 typeId 缓存，切语言整份失效 —— 简介与属性名都是 SDE 按语言给的。
   */
  typeInfo: (typeId: number) => Promise<RawMarketTypeInfo | null>
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
export function useMarket(locale: LocaleCode): MarketStore {
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
  // 简介 / 属性索引是「一次拉全量、之后内存查表」（见 ipc.ts 的 RawMarketTypeInfo）
  const infoCache = useRef(new Map<number, RawMarketTypeInfo>())
  const infoLang = useRef("")

  const loadTrades = useCallback(async () => {
    if (!ipc) return
    setTradesLoading(true)
    const reply = await callOr<RawMarketTrades>("marketTrades", null, TRADE_LIMIT)
    setTrades(reply)
    setTradesLoading(false)
  }, [ipc])

  /** 总览只有几百字节：改完种子库存后刷它，比刷 2.3 MB 的清单划算得多 */
  const loadOverview = useCallback(async () => {
    if (!ipc) return null
    const head = await callOr<RawMarketOverview>("marketOverview", null)
    setOverview(head)
    return head
  }, [ipc])

  const load = useCallback(async () => {
    if (!ipc) {
      setLoading(false)
      setTradesLoading(false)
      return
    }
    setLoading(true)
    setReason(null)

    const head = await loadOverview()
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
  }, [ipc, loadOverview])

  /**
   * 取一条物品的简介与属性。
   *
   * 索引在 Rust 侧按语言常驻内存（`INFO_INDEX`），所以这里也按语言缓存回包：
   * 换语言只丢缓存，下一次调用顺带把新语言的索引建起来。
   */
  const loadTypeInfo = useCallback(
    async (typeId: number) => {
      if (!ipc) return null
      const lang = locale
      if (infoLang.current !== lang) {
        infoLang.current = lang
        infoCache.current.clear()
      }
      if (typeId !== 0) {
        const cached = infoCache.current.get(typeId)
        if (cached) return cached
      }
      const reply = await callOr<RawMarketTypeInfo>("marketTypeInfo", null, typeId, lang)
      if (reply && reply.ok === true && typeId !== 0) infoCache.current.set(typeId, reply)
      return reply
    },
    // locale 是依赖：换语言要换一份缓存与一次预热。**清单那条链路（load → refresh）
    // 不依赖它**，所以换语言不会重拉 2.3 MB 的清单（清单与界面语言无关）
    [ipc, locale]
  )

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

  const adjustStock = useCallback(
    async (input: RawMarketAdjustInput) => {
      if (!ipc) return null
      const reply = await callOr<RawMarketAdjust>("marketAdjustStock", null, input)
      if (reply && reply.ok === true) {
        // 盘口那一行和顶部瓦片（最优买卖价 / 全站库存）都会变：盘口按单个物品重拉（很小），
        // 总览也重拉（几百字节）。清单不动 —— 物品名和分类跟价格、库存无关。
        await selectType(input.typeId)
        await loadOverview()
      }
      return reply
    },
    [ipc, selectType, loadOverview]
  )

  const refresh = useCallback(async () => {
    await load()
    await loadTrades()
  }, [load, loadTrades])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 预热：打开市场页就把 SDE 索引建起来（侧车要扫一遍 ~144 MB 的 types.jsonl，约 1.5 s），
  // 别让第一次悬停干等这一下。locale 进依赖 = 换语言后重新预热，之后拿到的是新语言的简介与属性名。
  useEffect(() => {
    void loadTypeInfo(0)
  }, [loadTypeInfo, locale])

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
    adjustStock,
    typeInfo: loadTypeInfo,
  }
}
