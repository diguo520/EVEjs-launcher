/**
 * 模组页的数据源：把 `mods:*` 系列真通道包成一份 React 状态。
 *
 * 设计口径（与 use-launcher / use-config 一致）：
 *   - 没有桥（浏览器里跑原型）就完全不碰 IPC，页面继续用原型自带演示数据；
 *   - 只读调用一律 callOr 兜底，一次失败不掀翻整页；
 *   - 写动作走真通道，成功后就 reload 一遍拿权威结果（不做本地猜测）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useLocale } from "@/components/shell/locale-provider"
import { call, callOr, hasIpc, subscribe } from "@/lib/ipc"
import type {
  RawAuthorState,
  RawClaimCandidates,
  RawClaimResult,
  RawMarketList,
  RawMarketMod,
  RawModList,
  RawModPreflightDryRun,
  RawModPreflightReport,
  RawMyMods,
  RawMySubmissions,
  RawPublishProgress,
  RawReviewShard,
  RawWriteAck,
  RawTokenCheck,
  RawTokenSave,
  RawSubmissionItem,
  RawTokenStatus,
  RawAck,
  RawDownloadProgress,
  RawModTemplate,
  RawReadme,
} from "@/lib/ipc"
import { CLAIM_PAGE_SIZE, CLAIM_SCOPE_DEFAULT, type ClaimQuery } from "@/lib/mod-claim"
import { buildMods, latestSubmission, reviewsOf, sourceRepoIds } from "@/lib/mod-source"
import { planReviewLoad } from "@/lib/review-sync"
import type { PublishCredential } from "@/lib/mod-logic"
import type { ModEntry, ModReview } from "@/lib/mock"

/**
 * 写完评价 / 回复后二次拉取评论的等待：服务端是写成功之后才异步重算快照的，
 * 立刻拉大概率还是旧的那份。
 */
const REVIEW_REFRESH_DELAY_MS = 1500

/** 一次提交要走的真流程：先打包（离线）→ 推到作者自己的仓库 → 提交版本审核 PR */
export interface PublishInput {
  mod: ModEntry
  version: string
  note: string
  /** 作者自己名下的仓库（首次发布会用它建仓库）；页面按 sourceRepos 决定 */
  repo: string
}

export interface PublishOutcome {
  ok: boolean
  reason?: string
  /** 走到哪一步了（给 toast 用） */
  step: "prepare" | "publish" | "register" | "done"
  repoUrl?: string
  releaseUrl?: string | null
  /** GitHub 上的 owner/repo（发布回包里带出来的真名，展示用） */
  repoSlug?: string
  /**
   * 这次有没有真的往索引仓库开出 PR（每一版都开，首次多一份 sources.json 登记）。
   * 必须由发布流程回传：页面在 publish() 之后会 reload 一遍台账，
   * 那时再读台账判断「提过没有」已经晚了一步 ——2026-09-28 报障：
   * 首次发布完成了却提示「没有 PR」。
   */
  registered?: boolean
  /** 版本审核 PR 的地址（每一步都该有；失败时为空） */
  reviewUrl?: string
  /** 后端复查那条 PR 的结果：PR 地址是真的，但没能确认状态时为 false */
  verified?: boolean
  prNumber?: string
  /** open（审核中）/ merged（已合并）/ closed（被关闭） */
  prState?: string
  /** 复查失败的原因（verified=false 时才有） */
  reviewReason?: string
}

/** 发布流水线当前在哪一环：进度环由它 + 真进度百分比共同决定 */
export type PublishPhase = "idle" | "prepare" | "publish" | "register" | "done" | "failed"

export interface ModSourceState {
  mods: ModEntry[]
  loading: boolean
  /** 至少成功加载过一次 */
  loaded: boolean
  /** 服务端根目录（模组目录相对它定位） */
  repoRoot: string
  rootOk: boolean
  /** 服务端根目录下有没有 mods/ 文件夹（没有时界面提示一键创建） */
  modsExists: boolean
  /** 本机作者身份 */
  authorId: string
  authorName: string
  keyId: string
  privateKeyExists: boolean
  /** GitHub 令牌（DPAPI 落盘） */
  tokenStatus: RawTokenStatus | null
  /** 已有源码仓库的模组 id */
  sourceRepos: string[]
  /** 重装系统后要找回的旧模组（本机由别的身份签名的那些） */
  claims: RawClaimCandidates | null
  /** 市场索引里的条目数（页头那个「索引 N 条」） */
  marketCount: number
  /** 索引里因「与当前服务端版本不兼容」被隐藏的条目数 */
  marketBlockedCount: number
  /** 后端判兼容性用的本机 EveJS 版本（marketList 回包的 evejsVersion） */
  marketEvejsVersion: string
  /** 索引缓存写入时间（毫秒时间戳）；0 = 还没成功拉到过 */
  marketFetchedAt: number
  /** 这份索引是不是「网络不可用时的本地缓存」 */
  marketCached: boolean
  /** 回退到缓存的原因（marketCached 为 true 时才有） */
  marketReason: string
  /** 正在强制联网同步索引 */
  marketRefreshing: boolean
  /** 强制联网同步一次索引（绕过 TTL），返回这次的原始回包 */
  refreshMarket: () => Promise<RawMarketList | null>
  /** 评价源这次到底取没取到（读不到时市场照常出，只是没有评分） */
  ratingsAvailable: boolean
  ratingsReason: string
  /** 某个模组的评论是否已经拉回来过 */
  reviewsLoaded: (id: string) => boolean
  /** 按需拉某个模组的评论正文（force 绕过缓存；写完评论 / 回复之后的重拉也走它） */
  loadReviews: (id: string, force?: boolean) => Promise<void>
  /**
   * 打开详情弹窗时的评论入口：**先渲染、再在后台追一次**（别人刚写的评论、作者刚发的回复只会
   * 出现在新快照里）。判断口径见 `@/lib/review-sync`，同一模组 60 秒内只真联网一次。
   */
  openReviews: (id: string) => void
  /** 打分 / 改分。`pkgSha256` 是市场索引里那一版的安装包指纹，服务端据此确认「真的装过」 */
  submitReview: (input: {
    modId: string
    version: string
    pkgSha256: string
    stars: number
    body: string
  }) => Promise<RawWriteAck>
  /** 撤回自己那条评价（打分与评论一起撤） */
  retractReview: (modId: string) => Promise<RawWriteAck>
  /** 作者回复 / 改回复。鉴权在服务端：签名用的 keyId 必须命中该模组的作者 */
  submitReply: (input: { modId: string; reviewId: string; body: string }) => Promise<RawWriteAck>
  /** 撤回作者回复 */
  retractReply: (input: { modId: string; reviewId: string }) => Promise<RawWriteAck>
  /** 举报一条评价：服务端只入库、不自动处置 */
  reportReview: (input: { modId: string; reviewId: string; reason: string }) => Promise<RawWriteAck>
  /** 作者身份数据目录（author:get.dataDir） */
  dataDir: string
  /** 身份创建时间（毫秒时间戳） */
  authorSince: number
  /** 某个模组最近一次提交台账（审核入口要拿里面的 PR 地址） */
  lastSubmissionOf: (id: string) => RawSubmissionItem | null
  /** 打开模组制作规范文档（后端会确保文档存在再打开） */
  openAuthoringDoc: () => Promise<RawAck>
  /** 用系统浏览器打开外链（审核 PR 等） */
  openExternal: (url: string) => Promise<RawAck>
  /** 骨架模板（真后端给的那几套） */
  templates: RawModTemplate[]
  /** 启动前预检（静态部分）：被忽略的目录 + 共享服务端文件 + 基线指纹 */
  preflight: RawModPreflightReport | null
  /** 最近一次干跑结果（没跑过就是 null） */
  preflightDryRun: RawModPreflightDryRun | null
  preflightRunning: boolean
  /** 跑一次预检；`dryRun` 会真的在一个一次性 Node 进程里 require 一遍 loader */
  runPreflight: (dryRun?: boolean) => Promise<RawModPreflightReport | RawModPreflightDryRun | null>
  /** 转成发布凭据：老用户升级过来时，这一步是无感的（令牌已在盘上） */
  credential: PublishCredential | null
  /** 市场索引里的原始条目（安装时整条回传给后端） */
  marketById: Record<string, RawMarketMod>
  reload: () => Promise<void>
  setEnabled: (folder: string, enabled: boolean) => Promise<RawAck>
  uninstall: (folder: string) => Promise<RawAck>
  sign: (folder: string) => Promise<RawAck>
  createFolder: () => Promise<RawAck>
  importZip: () => Promise<RawAck>
  openFolder: () => Promise<RawAck>
  openModFolder: (folder: string) => Promise<RawAck>
  readme: (folder: string) => Promise<RawReadme | null>
  saveText: (defaultName: string, content: string) => Promise<RawAck>
  installFromMarket: (id: string) => Promise<RawAck>
  createMod: (draft: Record<string, unknown>) => Promise<RawAck>
  /** 编辑已有模组的信息（本工程扩展通道；改完后端会重签） */
  updateMeta: (folder: string, patch: Record<string, unknown>) => Promise<RawAck>
  /**
   * 移除某个模组的本机投稿记录（该 id 的全部版本）。
   *
   * 只动本机台账，不碰 GitHub 仓库 / Release / 审核 PR / 市场索引 —— 作者之后在本地
   * 重建同名模组（id 不变）刷新一下，就能重新走「首次提交」上架。不可撤销。
   */
  forgetSubmission: (id: string) => Promise<RawAck>
  setAuthorName: (name: string) => Promise<RawAck>
  exportKey: () => Promise<RawAck>
  importKey: () => Promise<RawAck>
  openKeyFolder: () => Promise<RawAck>
  saveToken: (token: string) => Promise<RawTokenSave>
  clearToken: () => Promise<RawAck>
  checkToken: () => Promise<RawTokenCheck>
  /** 认领一个旧模组：核验仓库归属 → 落认领记录 */
  claimMod: (folder: string) => Promise<RawClaimResult>
  /** 找回旧模组：按页 + 关键字取候选（后端分页，界面不一次要上万条） */
  loadClaims: (opts?: ClaimQuery) => Promise<RawClaimCandidates | null>
  publish: (input: PublishInput) => Promise<PublishOutcome>
  /** 真进度：`mod:publishProgress` 的最后一条 */
  publishProgress: RawPublishProgress | null
  /** 发布流水线当前在哪一环（决定进度清单把哪一行点亮） */
  publishPhase: PublishPhase
  /** 最后一条下载进度（按模组 id 索引） */
  downloadProgress: Record<string, RawDownloadProgress>
}

/** 把本地文件夹名映射回 id（本地扫描给的是 folder，提交要走 id） */
function folderOf(mods: ModEntry[], id: string, list: RawModList | null): string {
  const hit = (list?.mods ?? []).find((item) => item.id === id)
  if (hit?.folder) return hit.folder
  return mods.find((item) => item.id === id)?.id ?? id
}

export function useModSource(): ModSourceState {
  const ipc = hasIpc()
  /** 当前界面语言：审核原因按它取 zh / en，切语言时要跟着重算（见 mods 的 useMemo 依赖） */
  const { locale } = useLocale()
  const [list, setList] = useState<RawModList | null>(null)
  const [market, setMarket] = useState<RawMarketList | null>(null)
  /** 「这份索引是不是缓存、什么时候拉的」：页头与提示条都要用它说实话 */
  const [marketFetchedAt, setMarketFetchedAt] = useState(0)
  const [marketCached, setMarketCached] = useState(false)
  const [marketReason, setMarketReason] = useState("")
  const [marketRefreshing, setMarketRefreshing] = useState(false)
  const [mine, setMine] = useState<RawMyMods | null>(null)
  const [submissions, setSubmissions] = useState<RawMySubmissions | null>(null)
  const [claims, setClaims] = useState<RawClaimCandidates | null>(null)
  const [author, setAuthor] = useState<RawAuthorState | null>(null)
  const [tokenStatus, setTokenStatus] = useState<RawTokenStatus | null>(null)
  const [templates, setTemplates] = useState<RawModTemplate[]>([])
  /** 启动前预检：静态部分随 load() 一起来，干跑只在用户点按钮时才跑 */
  const [preflight, setPreflight] = useState<RawModPreflightReport | null>(null)
  const [preflightDryRun, setPreflightDryRun] = useState<RawModPreflightDryRun | null>(null)
  const [preflightRunning, setPreflightRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [publishProgress, setPublishProgress] = useState<RawPublishProgress | null>(null)
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle")
  const [downloadProgress, setDownloadProgress] = useState<Record<string, RawDownloadProgress>>({})
  /** 已经拉回来的评论正文：只在打开过详情的模组上才有键 */
  const [reviewsById, setReviewsById] = useState<Record<string, ModReview[]>>({})

  /** 每个模组最近一次「真的打了网络」的评论拉取时刻（epoch ms），给 openReviews 的冷却用 */
  const reviewFetchedAt = useRef(new Map<string, number>())

  /** 提交期间要读到最新的 mods（folder 映射用） */
  const listRef = useRef<RawModList | null>(null)
  listRef.current = list

  /**
   * 索引回包 → 状态：条目与「这份是不是缓存」的元信息一起收。
   *
   * ok:false（没网、本地又没有缓存）只有一句 reason、没有 mods：拿它覆盖会把界面上
   * 已经在显示的清单清成 0 条。所以这种情况只记原因，列表留给上一份好数据。
   */
  const applyMarket = useCallback((next: RawMarketList | null) => {
    if (!next) return
    const reason = typeof next.reason === "string" ? next.reason : ""
    if (next.ok !== true) {
      setMarketReason(reason)
      return
    }
    setMarket(next)
    setMarketCached(next.cached === true)
    setMarketReason(reason)
    setMarketFetchedAt(typeof next.fetchedAt === "number" ? next.fetchedAt : 0)
  }, [])

  /**
   * 强制同步索引：`force=true` 时后端才绕过 TTL 联网。
   *
   * 市场页签与工具条的刷新必须走这条 —— 普通 load() 传的是 noforce，只会读那份缓存，
   * 「审核台刚下架、市场还挂着」时点刷新没反应就是它（2026-09-28 报障）。
   */
  const refreshMarket = useCallback(async (): Promise<RawMarketList | null> => {
    if (!ipc) return null
    setMarketRefreshing(true)
    try {
      const next = await callOr<RawMarketList>("modsMarketList", null, true)
      applyMarket(next)
      return next
    } finally {
      setMarketRefreshing(false)
    }
  }, [ipc, applyMarket])

  /**
   * 按需拉评论正文。返回的评论**只进内存**（不落盘、不进索引缓存）：
   * 正文是附加信息，丢了顶多详情页空一下，重开弹窗就再拉一次。
   *
   * 已经拉过且不是强制刷新就直接返回 —— 详情弹窗每次开关都打一次接口太浪费。
   * 回包 `cached === false` 说明这一趟真打了网络，记下时刻，给 openReviews 的冷却用。
   */
  const loadReviews = useCallback(
    async (id: string, force = false) => {
      if (!ipc || !id) return
      if (!force && reviewsById[id]) return
      const reply = await callOr<RawReviewShard>("modsReviews", null, id, force)
      if (!reply || reply.ok !== true) return
      if (reply.cached === false) reviewFetchedAt.current.set(id, Date.now())
      setReviewsById((prev) => ({ ...prev, [id]: reviewsOf(reply.reviews) }))
    },
    [ipc, reviewsById]
  )

  /**
   * 打开详情弹窗时的评论入口 —— 先渲染、再在后台追一次。
   *
   * 分片的本地缓存 TTL 是 30 分钟，光读缓存的话，别人刚写的评论、作者刚发的回复要等到
   * **下次重启启动器**才看得见；这里就在打开详情的当口补一次联网。失败照旧保持界面现状，
   * 不清空也不报错（评论是附加信息，读不到顶多详情页少一段正文）。
   */
  const openReviews = useCallback(
    (id: string) => {
      if (!ipc || !id) return
      const now = Date.now()
      const plan = planReviewLoad({
        inMemory: Boolean(reviewsById[id]),
        fetchedAt: reviewFetchedAt.current.get(id) ?? 0,
        now,
      })
      if (plan === "skip") return
      // 强刷这一趟**先记账再发请求**：离网时 Rust 会回退到本地那份缓存（回包 `cached: true`），
      // 要是等回包才记账，「内存里有、又拉不到新的」会让这个 effect 一圈圈重跑。
      if (plan === "sync") reviewFetchedAt.current.set(id, now)
      void loadReviews(id, plan === "sync")
    },
    [ipc, reviewsById, loadReviews]
  )

  /**
   * 写完之后把评论重新拉一遍。
   *
   * 读路径是一份**静态快照**，服务端在写成功之后才异步重算（Worker 里 `ctx.waitUntil`），
   * 所以写完立刻拉很可能还是旧的。这里拉一次、等一会儿再拉一次，而且**不等它**：
   * 界面先给出「提交成功」，一两秒后自己那一条就挂上来。
   */
  const refreshReviewsAfterWrite = useCallback(
    async (id: string) => {
      await loadReviews(id, true)
      await new Promise((done) => setTimeout(done, REVIEW_REFRESH_DELAY_MS))
      await loadReviews(id, true)
    },
    [loadReviews]
  )

  /** 五个写通道的公共收尾：签名与限流都在后端，这里只负责「成功就刷新、失败带原因回来」 */
  const writeReviewAction = useCallback(
    async (channel: string, args: unknown, modId: string): Promise<RawWriteAck> => {
      const reply = (await callOr<RawWriteAck>(channel, null, args)) ?? {
        ok: false,
        reason: "没有回包",
      }
      if (reply.ok) void refreshReviewsAfterWrite(modId)
      return reply
    },
    [refreshReviewsAfterWrite]
  )

  const submitReview = useCallback(
    (input: { modId: string; version: string; pkgSha256: string; stars: number; body: string }) =>
      writeReviewAction("modsReviewSubmit", input, input.modId),
    [writeReviewAction]
  )

  const retractReview = useCallback(
    (modId: string) => writeReviewAction("modsReviewRetract", { modId }, modId),
    [writeReviewAction]
  )

  const submitReply = useCallback(
    (input: { modId: string; reviewId: string; body: string }) =>
      writeReviewAction("modsReplySubmit", input, input.modId),
    [writeReviewAction]
  )

  const retractReply = useCallback(
    (input: { modId: string; reviewId: string }) =>
      writeReviewAction("modsReplyRetract", input, input.modId),
    [writeReviewAction]
  )

  const reportReview = useCallback(
    (input: { modId: string; reviewId: string; reason: string }) =>
      writeReviewAction("modsReportReview", input, input.modId),
    [writeReviewAction]
  )

  const load = useCallback(async () => {
    if (!ipc) return
    setLoading(true)
    const [nextList, nextMarket, nextMine, nextSubs, nextAuthor, nextToken, nextTemplates, nextClaims, nextPreflight] =
      await Promise.all([
        callOr<RawModList>("modsList", null),
        callOr<RawMarketList>("modsMarketList", null),
        callOr<RawMyMods>("modsMyMods", null),
        callOr<RawMySubmissions>("modsMySubmissions", null),
        callOr<RawAuthorState>("authorGet", null),
        callOr<RawTokenStatus>("modsGithubTokenStatus", null),
        callOr<{ ok: boolean; templates: RawModTemplate[] }>("modsTemplates", null),
        callOr<RawClaimCandidates>("modsClaimCandidates", null, {
          offset: 0,
          limit: CLAIM_PAGE_SIZE,
          // 页头入口的判据是「本机有没有别人署名的模组」：范围用全部，
          // 免得组织名下仓库的作者（owner 不是登录名）连入口都看不见
          scope: "all",
        }),
        callOr<RawModPreflightReport>("modsPreflight", null),
      ])
    setList(nextList)
    applyMarket(nextMarket)
    setMine(nextMine)
    setSubmissions(nextSubs)
    setAuthor(nextAuthor)
    setTokenStatus(nextToken)
    setTemplates(nextTemplates?.templates ?? [])
    setClaims(nextClaims)
    setPreflight(nextPreflight)
    setLoaded(true)
    setLoading(false)
  }, [ipc, applyMarket])

  /**
   * 运行一次预检。
   *
   * `dryRun` 会把 loader 放进一个一次性 Node 进程里真的 require 一遍 —— 这是唯一能提前
   * 抓出「加载期抛错 → 服务端起不来」的办法，但会执行模组的加载期代码，所以只在用户点按钮
   * 时才走。静态那半（被忽略的目录 / 共享文件 / 基线指纹）不执行任何模组代码，随 load() 自动刷新。
   */
  const runPreflight = useCallback(
    async (dryRun = false) => {
      if (!ipc) return null
      setPreflightRunning(true)
      try {
        if (dryRun) {
          const reply = await callOr<RawModPreflightDryRun>("modsPreflight", null, { dryRun: true })
          setPreflightDryRun(reply)
          return reply
        }
        const reply = await callOr<RawModPreflightReport>("modsPreflight", null)
        setPreflight(reply)
        return reply
      } finally {
        setPreflightRunning(false)
      }
    },
    [ipc]
  )

  useEffect(() => {
    void load()
  }, [load])

  /** 进度事件：下载与发布都由后端推过来，页面只负责画 */
  useEffect(() => {
    if (!ipc) return
    const offDownload = subscribe("onModDownloadProgress", (payload) => {
      const item = payload as RawDownloadProgress | undefined
      if (!item || typeof item.id !== "string") return
      setDownloadProgress((prev) => ({ ...prev, [item.id]: item }))
    })
    const offPublish = subscribe("onModPublishProgress", (payload) => {
      const item = payload as RawPublishProgress | undefined
      if (!item || typeof item.stage !== "string") return
      setPublishProgress(item)
    })
    return () => {
      offDownload()
      offPublish()
    }
  }, [ipc])

  const mods = useMemo(
    // 提交台账也带上：详情页的「版本历史」在索引更新前只能靠作者的逐版本记录
    () =>
      buildMods({
        list,
        market,
        mine,
        submissions: submissions?.items,
        reviews: reviewsById,
        locale,
      }),
    [list, market, mine, submissions, reviewsById, locale]
  )

  const marketById = useMemo(() => {
    const map: Record<string, RawMarketMod> = {}
    for (const item of market?.mods ?? []) {
      if (item?.id) map[item.id] = item
    }
    return map
  }, [market])

  const sourceRepos = useMemo(
    // 第三个来源是本地 mods/ 扫描出来的 .evejs-source.json（见 mod-source.ts 的注释）
    () => sourceRepoIds(mine, submissions?.items, list?.mods),
    [mine, submissions, list]
  )

  const credential = useMemo<PublishCredential | null>(() => {
    if (!tokenStatus?.hasToken) return null
    // 真令牌没有到期时间（kind = pat 时 expiresAt 不参与判定）
    return { kind: "pat", token: "", expiresAt: 0 }
  }, [tokenStatus])

  const reload = useCallback(async () => {
    await load()
  }, [load])

  /** 写动作的统一包装：调真通道 → 成功后重载 */
  const act = useCallback(
    async (name: string, ...args: unknown[]): Promise<RawAck> => {
      try {
        const reply = (await call<RawAck>(name, ...args)) ?? { ok: false, reason: "没有回包" }
        if (reply.ok) await load()
        return reply
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    [load]
  )

  const setEnabled = useCallback(
    (folder: string, enabled: boolean) => act("modsSetEnabled", folder, enabled),
    [act]
  )
  const uninstall = useCallback((folder: string) => act("modsUninstall", folder), [act])
  const sign = useCallback((folder: string) => act("modsSign", folder), [act])
  const createFolder = useCallback(() => act("modsCreateFolder"), [act])
  const importZip = useCallback(() => act("modsImportZip"), [act])
  const openFolder = useCallback(() => act("modsOpenFolder"), [act])
  const openModFolder = useCallback((folder: string) => act("modsOpenModFolder", folder), [act])
  const saveText = useCallback(
    (defaultName: string, content: string) => act("modsSaveText", defaultName, content),
    [act]
  )
  const createMod = useCallback(
    (draft: Record<string, unknown>) => act("modsCreate", draft),
    [act]
  )
  const updateMeta = useCallback(
    (folder: string, patch: Record<string, unknown>) => act("modsUpdateMeta", folder, patch),
    [act]
  )
  const forgetSubmission = useCallback((id: string) => act("modsForgetSubmission", id), [act])
  const setAuthorName = useCallback((name: string) => act("authorSetName", name), [act])
  const exportKey = useCallback(() => act("authorExportKey"), [act])
  const importKey = useCallback(async (): Promise<RawAck> => {
    const reply = await act("authorImportKey")
    return reply
  }, [act])
  const openKeyFolder = useCallback(() => act("authorOpenKeyFolder"), [act])
  const openAuthoringDoc = useCallback(() => act("modsOpenAuthoringDoc"), [act])
  const openExternal = useCallback(
    async (url: string): Promise<RawAck> => {
      if (!url) return { ok: false, reason: "没有可打开的地址" }
      try {
        const reply = (await call<boolean>("openExternal", url)) ?? false
        return { ok: reply === true, reason: reply === true ? undefined : "系统拒绝了这次打开" }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    []
  )
  const clearToken = useCallback(() => act("modsGithubTokenClear"), [act])

  const readme = useCallback(async (folder: string) => {
    return callOr<RawReadme>("modsReadme", null, folder)
  }, [])

  const saveToken = useCallback(
    async (token: string): Promise<RawTokenSave> => {
      const reply = await callOr<RawTokenSave>("modsGithubTokenSave", null, token)
      await load()
      return reply ?? { ok: false, encrypted: false, reason: "没有回包" }
    },
    [load]
  )

  const checkToken = useCallback(async (): Promise<RawTokenCheck> => {
    return (await callOr<RawTokenCheck>("modsGithubTokenCheck", null)) ?? { ok: false }
  }, [])

  /**
   * 认领一个旧模组：后端核验「这个模组的仓库是不是你的」之后落认领记录。
   * 核验不过就原样返回原因（界面照实说），成功后重载 —— 「我创建的」与候选列表都会变。
   */
  const claimMod = useCallback(
    async (folder: string): Promise<RawClaimResult> => {
      const reply = (await callOr<RawClaimResult>("modsClaimMod", null, folder)) ?? {
        ok: false,
        reason: "没有回包",
      }
      if (reply.ok) await load()
      return reply
    },
    [load]
  )

  /**
   * 候选列表按页取：候选是「本机装了多少别人的模组」的量级（上万条也常见），
   * 一次全量回给界面等于让 WebView 渲染上万个 DOM 子树。
   *
   * 这里**不动**页头入口用的那份状态（`claims`）：入口的判据是「本机有没有别人署名的
   * 模组」，范围是 `all`（见 `load`），而弹窗用的是 `mine`；两边范围不同，谁后写谁赢
   * 就会让入口忽隐忽现。入口的刷新只由 `load()`（开机、认领成功、手动刷新）负责。
   */
  const loadClaims = useCallback(
    async (opts: ClaimQuery = {}): Promise<RawClaimCandidates | null> => {
      const query = opts.query ?? ""
      const offset = opts.offset ?? 0
      return await callOr<RawClaimCandidates>("modsClaimCandidates", null, {
        offset,
        limit: opts.limit ?? CLAIM_PAGE_SIZE,
        query,
        scope: opts.scope ?? CLAIM_SCOPE_DEFAULT,
      })
    },
    []
  )

  const installFromMarket = useCallback(
    async (id: string): Promise<RawAck> => {
      const entry = marketById[id]
      if (!entry) return { ok: false, reason: "市场索引里没有这一条（先刷新市场列表）" }
      try {
        const reply = (await call<RawAck>("modsMarketInstall", entry)) ?? { ok: false }
        await load()
        return reply
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    [marketById, load]
  )

  /**
   * 真提交：① 打包（离线）② 推到作者自己的仓库 ③ 往索引仓库提交版本审核 PR。
   *
   * ③ **每一版都走**：首次的 PR 里多一份 `sources.json` 收录登记，之后的版本只更新
   * `mods/<id>.json` 分片（同一条 `release/<id>` 分支，所以后续版本是刷新同一条 PR）。
   */
  const publish = useCallback(
    async (input: PublishInput): Promise<PublishOutcome> => {
      const folder = folderOf([], input.mod.id, listRef.current)
      setPublishPhase("prepare")
      setPublishProgress({ stage: "本地打包（离线）", percent: 2 })
      const prepared = await callOr<{ ok: boolean; reason?: string }>(
        "modsSubmitPrepare",
        null,
        {
          folder,
          // 版本号以这里填的为准：外壳会先把它写回模组清单，再重签、打包，
          // 否则 ZIP 内的清单、索引分片和 Release tag 会各说各的版本（2026-09-30 报障）
          version: input.version,
          changelog: input.note,
          repo: input.repo,
          // 高亮与正文留空：README 里已经写好了，后端会自己从 README 抽
        }
      )
      if (!prepared?.ok) {
        setPublishProgress(null)
        setPublishPhase("failed")
        return { ok: false, step: "prepare", reason: prepared?.reason ?? "打包失败" }
      }
      setPublishPhase("publish")
      const published = await callOr<{
        ok: boolean
        reason?: string
        owner?: string
        repo?: string
        repoUrl?: string
        releaseUrl?: string | null
      }>("modsPublishOwnRepo", null, input.mod.id, input.version, input.repo, "")
      if (!published?.ok) {
        setPublishProgress(null)
        setPublishPhase("failed")
        return { ok: false, step: "publish", reason: published?.reason ?? "推送失败", registered: false }
      }
      const slug = published.owner && published.repo ? `${published.owner}/${published.repo}` : undefined
      /** 版本审核 PR 的地址：只在这一步刚跑过时才有 */
      let reviewUrl: string | undefined
      let verified = false
      let prNumber = ""
      let prState = ""
      let reviewReason = ""
      setPublishPhase("register")
      setPublishProgress({ stage: "提交版本审核 PR（GitHub）", percent: 88 })
      const registered = await callOr<{
        ok: boolean
        reason?: string
        prUrl?: string
        verified?: boolean
        prNumber?: string
        prState?: string
        reviewReason?: string
      }>("modsRegisterSource",
        null,
        input.mod.id,
        input.version
      )
      if (!registered?.ok) {
        setPublishProgress(null)
        setPublishPhase("failed")
        return {
          ok: false,
          step: "register",
          reason: registered?.reason ?? "版本审核 PR 提交失败",
          repoUrl: published.repoUrl,
          repoSlug: slug,
          registered: false,
        }
      }
      reviewUrl = typeof registered.prUrl === "string" && registered.prUrl ? registered.prUrl : undefined
      verified = registered.verified === true
      prNumber = typeof registered.prNumber === "string" ? registered.prNumber : ""
      prState = typeof registered.prState === "string" ? registered.prState : ""
      reviewReason = typeof registered.reviewReason === "string" ? registered.reviewReason : ""
      setPublishProgress({ stage: "完成", percent: 100 })
      setPublishPhase("done")
      await load()
      return {
        ok: true,
        step: "done",
        repoUrl: published.repoUrl,
        releaseUrl: published.releaseUrl ?? null,
        repoSlug: slug,
        registered: true,
        reviewUrl,
        verified,
        prNumber,
        prState,
        reviewReason,
      }
    },
    [load]
  )

  return {
    mods,
    loading,
    loaded,
    repoRoot: list?.repoRoot ?? "",
    rootOk: list?.repoRootLooksValid !== false,
    modsExists: list?.exists === true,
    authorId: author?.author?.id ?? "",
    authorName: author?.author?.name ?? "",
    keyId: author?.author?.keyId ?? "",
    privateKeyExists: author?.privateKeyExists === true,
    tokenStatus,
    sourceRepos,
    claims,
    claimMod,
    loadClaims,
    marketCount: market?.mods?.length ?? 0,
    marketBlockedCount: market?.blocked?.length ?? 0,
    marketEvejsVersion: market?.evejsVersion ?? "",
    marketFetchedAt,
    marketCached,
    marketReason,
    marketRefreshing,
    refreshMarket,
    ratingsAvailable: market?.ratings?.available === true,
    ratingsReason: market?.ratings?.reason ?? "",
    reviewsLoaded: (id: string) => Boolean(reviewsById[id]),
    loadReviews,
    openReviews,
    submitReview,
    retractReview,
    submitReply,
    retractReply,
    reportReview,
    dataDir: author?.dataDir ?? "",
    authorSince: typeof author?.author?.since === "number" ? author.author.since : 0,
    lastSubmissionOf: (id: string) => latestSubmission(submissions?.items, id),
    openAuthoringDoc,
    openExternal,
    templates,
    preflight,
    preflightDryRun,
    preflightRunning,
    runPreflight,
    credential,
    marketById,
    reload,
    setEnabled,
    uninstall,
    sign,
    createFolder,
    importZip,
    openFolder,
    openModFolder,
    readme,
    saveText,
    installFromMarket,
    createMod,
    updateMeta,
    forgetSubmission,
    setAuthorName,
    exportKey,
    importKey,
    openKeyFolder,
    saveToken,
    clearToken,
    checkToken,
    publish,
    publishProgress,
    publishPhase,
    downloadProgress,
  }
}
