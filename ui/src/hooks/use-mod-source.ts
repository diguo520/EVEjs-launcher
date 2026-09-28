/**
 * 模组页的数据源：把 `mods:*` 系列真通道包成一份 React 状态。
 *
 * 设计口径（与 use-launcher / use-config 一致）：
 *   - 没有桥（浏览器里跑原型）就完全不碰 IPC，页面继续用原型自带演示数据；
 *   - 只读调用一律 callOr 兜底，一次失败不掀翻整页；
 *   - 写动作走真通道，成功后就 reload 一遍拿权威结果（不做本地猜测）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { call, callOr, hasIpc, subscribe } from "@/lib/ipc"
import type {
  RawAuthorState,
  RawMarketList,
  RawMarketMod,
  RawModList,
  RawMyMods,
  RawMySubmissions,
  RawPublishProgress,
  RawTokenCheck,
  RawTokenSave,
  RawSubmissionItem,
  RawTokenStatus,
  RawAck,
  RawDownloadProgress,
  RawModTemplate,
  RawReadme,
} from "@/lib/ipc"
import { buildMods, latestSubmission, sourceRepoIds } from "@/lib/mod-source"
import type { PublishCredential } from "@/lib/mod-logic"
import type { ModEntry } from "@/lib/mock"

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
  /** 市场索引里的条目数（页头那个「索引 N 条」） */
  marketCount: number
  /** 索引里因「与当前服务端版本不兼容」被隐藏的条目数 */
  marketBlockedCount: number
  /** 后端判兼容性用的本机 EveJS 版本（marketList 回包的 evejsVersion） */
  marketEvejsVersion: string
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
  setAuthorName: (name: string) => Promise<RawAck>
  exportKey: () => Promise<RawAck>
  importKey: () => Promise<RawAck>
  openKeyFolder: () => Promise<RawAck>
  saveToken: (token: string) => Promise<RawTokenSave>
  clearToken: () => Promise<RawAck>
  checkToken: () => Promise<RawTokenCheck>
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
  const [list, setList] = useState<RawModList | null>(null)
  const [market, setMarket] = useState<RawMarketList | null>(null)
  const [mine, setMine] = useState<RawMyMods | null>(null)
  const [submissions, setSubmissions] = useState<RawMySubmissions | null>(null)
  const [author, setAuthor] = useState<RawAuthorState | null>(null)
  const [tokenStatus, setTokenStatus] = useState<RawTokenStatus | null>(null)
  const [templates, setTemplates] = useState<RawModTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [publishProgress, setPublishProgress] = useState<RawPublishProgress | null>(null)
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle")
  const [downloadProgress, setDownloadProgress] = useState<Record<string, RawDownloadProgress>>({})

  /** 提交期间要读到最新的 mods（folder 映射用） */
  const listRef = useRef<RawModList | null>(null)
  listRef.current = list

  const load = useCallback(async () => {
    if (!ipc) return
    setLoading(true)
    const [nextList, nextMarket, nextMine, nextSubs, nextAuthor, nextToken, nextTemplates] =
      await Promise.all([
        callOr<RawModList>("modsList", null),
        callOr<RawMarketList>("modsMarketList", null),
        callOr<RawMyMods>("modsMyMods", null),
        callOr<RawMySubmissions>("modsMySubmissions", null),
        callOr<RawAuthorState>("authorGet", null),
        callOr<RawTokenStatus>("modsGithubTokenStatus", null),
        callOr<{ ok: boolean; templates: RawModTemplate[] }>("modsTemplates", null),
      ])
    setList(nextList)
    setMarket(nextMarket)
    setMine(nextMine)
    setSubmissions(nextSubs)
    setAuthor(nextAuthor)
    setTokenStatus(nextToken)
    setTemplates(nextTemplates?.templates ?? [])
    setLoaded(true)
    setLoading(false)
  }, [ipc])

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
    () => buildMods({ list, market, mine }),
    [list, market, mine]
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
        const reply = (await call<boolean>("shellOpenExternal", url)) ?? false
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
      setPublishPhase("register")
      setPublishProgress({ stage: "提交版本审核 PR（GitHub）", percent: 88 })
      const registered = await callOr<{ ok: boolean; reason?: string; prUrl?: string }>(
        "modsRegisterSource",
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
    marketCount: market?.mods?.length ?? 0,
    marketBlockedCount: market?.blocked?.length ?? 0,
    marketEvejsVersion: market?.evejsVersion ?? "",
    dataDir: author?.dataDir ?? "",
    authorSince: typeof author?.author?.since === "number" ? author.author.since : 0,
    lastSubmissionOf: (id: string) => latestSubmission(submissions?.items, id),
    openAuthoringDoc,
    openExternal,
    templates,
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
