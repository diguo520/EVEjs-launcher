import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUpCircle,
  BadgeCheck,
  BookOpen,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { SectionHeading, StatTile } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { listSeparator } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ModCard } from "@/components/modules/mod-card"
import { ModToolbar } from "@/components/modules/mod-toolbar"
import { ModDetailDialog } from "@/components/modules/mod-detail-dialog"
import { ModFormDialog } from "@/components/modules/mod-form-dialog"
import { ModAuthorDialog } from "@/components/modules/mod-author-dialog"
import { ModAuthoringDialog } from "@/components/modules/mod-authoring-dialog"
import { ModClaimDialog } from "@/components/modules/mod-claim-dialog"
import {
  ModSubmitDialog,
  type ModSubmitDialogProps,
} from "@/components/modules/mod-submit-dialog"
import { ConflictBanner, ReviewBanner } from "@/components/modules/mod-banners"
import { ModOverlapPanel } from "@/components/modules/mod-overlap-panel"
import { ModPreflightPanel } from "@/components/modules/mod-preflight-panel"
import { useModDownloads, type DownloadTask } from "@/hooks/use-mod-downloads"
import { shouldOfferClaim } from "@/lib/mod-claim"
import { markAuthoringDocSeen, needsAuthoringDocPulse } from "@/lib/mod-doc-seen"
import { useModSource, type PublishOutcome } from "@/hooks/use-mod-source"
import {
  ALL_CATEGORY,
  DEFAULT_SIGNATURE_PUBLISH_HINT,
  activeConflicts,
  publishIntervalRemaining,
  reviewPrStateLabel,
  submitCooldownRemaining,
  collectConflictPairs,
  filterMods,
  hasOwnSignature,
  hasUpdate,
  isPublished,
  usesDefaultSignature,
  isReviewing,
  pendingConflicts,
  overlapFlag,
  overlapReport,
  marketCounts as countMarket,
  mineCounts as countMine,
  sortMods,
  targetVersionOf,
  type MarketFilter,
  type MineFilter,
  type ModSort,
  type NewModInput,
  type ModTab,
  type RatingFilter,
} from "@/lib/mod-logic"
import { formatMB, type ModEntry } from "@/lib/mock"
import type { ViewId } from "@/components/shell/nav-config"

const MOD_TABS: ModTab[] = ["installed", "preflight", "mine", "market"]

const TAB_LABEL: Record<ModTab, string> = {
  installed: "已安装",
  preflight: "启动预检",
  mine: "我创建的",
  market: "模组市场",
}

/** 索引「算旧」的阈值：进市场页签时超过它没同步过就强制联网拉一次（后端自动 TTL 同为 2 分钟） */
const MARKET_STALE_MS = 2 * 60 * 1000

export function ModulesPage({
  serverRoot,
  onNavigate,
}: {
  /** 配置里的服务端根目录：模组目录相对它定位 */
  serverRoot: string
  onNavigate: (view: ViewId) => void
}) {
  /* ---------------- 真数据源 ---------------- */

  const { t } = useLocale()
  const source = useModSource()
  /** 本地副本：真值来自 source.mods，写动作成功后由后端重扫回填 */
  const [mods, setMods] = useState<ModEntry[]>(source.mods)
  useEffect(() => {
    setMods(source.mods)
  }, [source.mods])

  /**
   * 根目录对不对只信后端：mods:list 会回 repoRootLooksValid（服务端主程序在不在那儿）。
   * 这里以前还 && 过一个「配置里的路径是不是写死的那个 E:\\Games\\EveJS-v0.12.8」的假判据，
   * 换到别的版本目录（0.12.9）就必然误报，2026-09-28 那次报障就是它。
   */
  const rootOk = source.rootOk
  /** 根目录对、但目录下还没有 mods/：不是错误，是「还没建」，给一键创建 */
  const modsRootMissing = rootOk && source.loaded && !source.modsExists

  const authorName = source.authorName
  const credential = source.credential
  const sourceRepos = source.sourceRepos

  // 导航里这一项叫「模组市场」，进来就该看到市场，而不是已安装清单
  const [tab, setTab] = useState<ModTab>("market")
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<string>(ALL_CATEGORY)
  /** 点卡片上的标签筛出来的结果，再点同一枚标签就取消 */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all")
  const [mineFilter, setMineFilter] = useState<MineFilter>("all")
  const [sort, setSort] = useState<ModSort>("default")
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all")
  const [detailId, setDetailId] = useState<string | null>(null)
  /** 表单同时管新建与编辑：formTargetId 为空就是新建 */
  const [formOpen, setFormOpen] = useState(false)
  const [formTargetId, setFormTargetId] = useState<string | null>(null)
  const [authorOpen, setAuthorOpen] = useState(false)
  /** 「找回旧模组」：只在真的有待认领的旧模组时才开这个入口 */
  const [claimOpen, setClaimOpen] = useState(false)
  const [docOpen, setDocOpen] = useState(false)
  /** 规范文档有新内容时按钮旁边亮一圈脉冲，点开一次就灭（见 lib/mod-doc-seen） */
  const [docPulse, setDocPulse] = useState(() => needsAuthoringDocPulse())
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitTarget, setSubmitTarget] = useState<string | null>(null)
  const [conflictDismissed, setConflictDismissed] = useState(false)
  const [importing, setImporting] = useState(false)
  const [creatingModsFolder, setCreatingModsFolder] = useState(false)

  /**
   * 两次发布之间的 60 秒：上一次发布**走完**的时刻（0＝还没发过）。
   *
   * 和「同一模组 30 分钟」那条冷却不是一回事：这条挡的是连着发布（换个模组也一样等），
   * 免得连着两次发布撞上 GitHub 限流、两条 PR 抢同一次索引重建。
   */
  const [lastPublishedAt, setLastPublishedAt] = useState(0)
  const [publishClock, setPublishClock] = useState(() => Date.now())
  const publishIntervalMs = publishIntervalRemaining(lastPublishedAt, publishClock)
  const publishCooling = publishIntervalMs > 0
  // 只在倒计时期间每秒走一格：平时不白跑定时器，也不让整页每秒重渲染
  useEffect(() => {
    if (!publishCooling) return
    const timer = window.setInterval(() => setPublishClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [publishCooling])

  /**
   * 进「模组市场」页签就把索引对齐一次：缓存超过 2 分钟才强制联网，正常切页签不打扰。
   *
   * 后端自动路径有 2 分钟 TTL；界面再不传 force 的话，「审核台刚下架 → 市场还挂着」
   * 就只能等 TTL 到点（2026-09-28 报障）。这里只在明显过期时拉，拉一次就记时间。
   */
  const marketSyncedAtRef = useRef(0)
  // 先取出这三个值：依赖表里写 source.xxx 时 exhaustive-deps 会要求把整个 source 也带上
  const marketLoaded = source.loaded
  const marketFetchedAt = source.marketFetchedAt
  const refreshMarket = source.refreshMarket
  useEffect(() => {
    if (tab !== "market" || !marketLoaded) return
    if (marketFetchedAt > 0 && Date.now() - marketFetchedAt < MARKET_STALE_MS) return
    if (Date.now() - marketSyncedAtRef.current < MARKET_STALE_MS) return
    marketSyncedAtRef.current = Date.now()
    void refreshMarket()
  }, [tab, marketLoaded, marketFetchedAt, refreshMarket])

  /** 工具条上的刷新：**真的**强制联网同步索引，再重扫本地 mods/（不再只读缓存却报「已刷新」） */
  async function refreshModsAndMarket() {
    const fresh = await source.refreshMarket()
    await source.reload()
    if (!fresh || fresh.ok !== true) {
      // 连缓存都没有：别把 ok:false 说成「已同步」
      toast.error("索引同步失败", {
        description: fresh?.reason ?? "网络不可用，本地也还没有可用的缓存",
      })
      return
    }
    if (fresh.cached === true) {
      toast.warning("索引同步失败，暂用本地缓存", {
        description: fresh.reason ?? "网络不可用",
      })
      return
    }
    toast.success("市场索引已同步", {
      description: t("索引 {count} 条 · 已重扫本地 mods/", {
        count: fresh?.mods?.length ?? source.marketCount,
      }),
    })
  }

  /* ---------------- 下载队列 ---------------- */

  const handleDownloadDone = useCallback((task: DownloadTask) => {
    if (task.kind === "install") {
      toast.success(t("「{name}」安装完成", { name: task.name }), {
        description: t("v{version} 已启用，重启对应服务后生效。", {
          version: task.targetVersion,
        }),
      })
    } else {
      toast.success(t("「{name}」已更新到 {version}", { name: task.name, version: task.targetVersion }), {
        description: t("旧版本 {version} 已备份，重启对应服务后生效。", {
          version: task.fromVersion,
        }),
      })
    }
  }, [])

  const handleDownloadFailed = useCallback((mod: ModEntry, reason: string) => {
    toast.error(t("「{name}」下载失败", { name: mod.name }), { description: reason })
  }, [])

  const downloads = useModDownloads(
    handleDownloadDone,
    handleDownloadFailed,
    source.downloadProgress
  )

  /* ---------------- 冲突 ---------------- */

  const conflictPairs = useMemo(() => collectConflictPairs(mods), [mods])

  const conflictKey = conflictPairs.map((p) => `${p.a.id}|${p.b.id}`).join(",")

  /** 疑似重叠只读预检回包（静态那半）：同文件 + 同标记才算真冲突，单开一块提示 */
  const overlaps = useMemo(() => overlapReport(source.preflight), [source.preflight])

  // 冲突项发生变化时，把「暂时忽略」重置掉，避免新增冲突被旧状态吞掉
  useEffect(() => {
    setConflictDismissed(false)
  }, [conflictKey])

  /* ---------------- 审核状态 ---------------- */

  const reviewing = useMemo(() => mods.filter(isReviewing), [mods])

  /* ---------------- 列表 ---------------- */

  const marketPool = useMemo(() => mods.filter(isPublished), [mods])

  const marketCounts = useMemo(() => countMarket(marketPool), [marketPool])

  const mineCounts = useMemo(
    () => countMine(mods.filter((mod) => mod.mine)),
    [mods]
  )

  // 排序只在模组市场页签生效，避免切到其他页签后顺序被隐藏状态打乱
  const visible = useMemo(() => {
    const pool = filterMods({
      mods,
      tab,
      marketFilter,
      mine: mineFilter,
      query,
      category,
      rating: ratingFilter,
      tag: activeTag,
    })
    return tab === "market" ? sortMods(pool, sort) : pool
  }, [
    mods,
    tab,
    marketFilter,
    mineFilter,
    query,
    category,
    sort,
    ratingFilter,
    activeTag,
  ])

  const installedCount = mods.filter((mod) => mod.installed).length
  const enabledCount = mods.filter((mod) => mod.installed && mod.enabled).length
  const updatableCount = mods.filter(hasUpdate).length

  /** 「启动预检」上真正要看一眼的条数：标记冲突 + 被跳过的目录 + 版本对不上 */
  const preflightIssues =
    overlaps.markers.length +
    (source.preflight?.ignored.length ?? 0) +
    (source.preflight?.summary.stale ?? 0)

  const tabCount: Record<ModTab, number> = {
    installed: installedCount,
    preflight: preflightIssues,
    mine: mods.filter((mod) => mod.mine).length,
    market: marketPool.length,
  }

  /* ---------------- 操作 ---------------- */

  /** 本地 mods/ 下的目录名；写通道要的是它，缺失时回落到 id */
  const keyOf = (mod: ModEntry) => mod.folder ?? mod.id

  async function toggleMod(mod: ModEntry, next: boolean) {
    setMods((prev) =>
      prev.map((item) => (item.id === mod.id ? { ...item, enabled: next } : item))
    )
    const reply = await source.setEnabled(keyOf(mod), next)
    if (!reply.ok) {
      toast.error(
        next
          ? t("启用 {name} 失败", { name: mod.name })
          : t("停用 {name} 失败", { name: mod.name }),
        {
          description: reply.reason ?? "后端没说明原因",
        }
      )
      return
    }
    toast(next ? t("已启用 {name}", { name: mod.name }) : t("已停用 {name}", { name: mod.name }))
  }

  async function disableMod(mod: ModEntry) {
    setMods((prev) =>
      prev.map((item) => (item.id === mod.id ? { ...item, enabled: false } : item))
    )
    await source.setEnabled(keyOf(mod), false)
    toast(t("已停用 {name}", { name: mod.name }), {
      description: "冲突已解除，重启对应服务后生效。",
    })
  }

  async function disableAllConflicts() {
    const ids = new Set<string>()
    const folders: string[] = []
    conflictPairs.forEach((pair) => {
      for (const mod of [pair.a, pair.b]) {
        if (!ids.has(mod.id)) {
          ids.add(mod.id)
          folders.push(keyOf(mod))
        }
      }
    })
    setMods((prev) =>
      prev.map((mod) => (ids.has(mod.id) ? { ...mod, enabled: false } : mod))
    )
    for (const folder of folders) await source.setEnabled(folder, false)
    toast(t("已停用 {count} 个冲突模组", { count: ids.size }), {
      description: "全部冲突项已停用，重启对应服务后生效。",
    })
  }

  function installMod(mod: ModEntry) {
    const targetVersion = targetVersionOf(mod)
    downloads.start({
      mod,
      kind: "install",
      targetVersion,
      run: () => source.installFromMarket(mod.id),
    })
    toast(t("开始下载「{name}」", { name: mod.name }), {
      description: t("{size} · 来自模组市场", { size: formatMB(mod.sizeMB) }),
    })
  }

  function updateMod(mod: ModEntry) {
    const targetVersion = targetVersionOf(mod)
    downloads.start({
      mod,
      kind: "update",
      targetVersion,
      run: () => source.installFromMarket(mod.id),
    })
    toast(t("开始更新「{name}」", { name: mod.name }), {
      description: t("{from} → {to} · {size}", {
        from: mod.version,
        to: targetVersion,
        size: formatMB(mod.sizeMB),
      }),
    })
  }

  async function uninstallMod(mod: ModEntry) {
    downloads.cancel(mod.id)
    const reply = await source.uninstall(keyOf(mod))
    if (!reply.ok) {
      toast.error(t("卸载 {name} 失败", { name: mod.name }), {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    toast(t("已卸载 {name}", { name: mod.name }))
  }

  /** 发布完成后的收尾：真流程在弹窗里跑，这里只解释结果 */
  function submitMod(mod: ModEntry, payload: { version: string; note: string }, outcome: PublishOutcome) {
    // 「发布模组」按钮从这一刻起进入 60 秒倒计时（RELEASE 已推、PR 已开，再点就是连发）
    if (outcome.ok) setLastPublishedAt(Date.now())
    setTab("mine")
    // 有没有开出 PR 只能看发布流程回传的结果：这里再读台账已经晚了一步
    // （publish() 收尾时 reload 过台账，刚提交的记录也会显示成「已登记」）。
    const registered = outcome.registered === true
    const reviewUrl = outcome.reviewUrl
    // 提交之后**再查一次**那条 PR：只报「已提交」等于没验证
    const prText = (() => {
      if (!registered)
        return t("，但版本审核 PR 没有开出来（去「我创建的」里点这条模组重试）")
      const label = outcome.prNumber
        ? t("审核 PR #{number}", { number: outcome.prNumber })
        : t("审核 PR")
      if (outcome.verified !== true) {
        return t("，{label}已提交，但没能确认它的状态{reason}", {
          label,
          reason: outcome.reviewReason
            ? t("（{reason}）", { reason: outcome.reviewReason })
            : "",
        })
      }
      return t("，{label}{state}（维护者合并后，市场更新到这一版）", {
        label,
        state: t(reviewPrStateLabel(outcome.prState)),
      })
    })()
    toast.success("发布完成", {
      description: outcome.repoSlug
        ? t("「{name}」{version} 已发布到 {repo}{pr}。", {
            name: mod.name,
            version: payload.version,
            repo: outcome.repoSlug,
            pr: prText,
          })
        : t("「{name}」{version} 已发布到你自己名下的仓库。", {
            name: mod.name,
            version: payload.version,
          }),
      ...(reviewUrl
        ? {
            action: {
              label: "查看版本审核 PR",
              onClick: () => void source.openExternal(reviewUrl),
            },
          }
        : {}),
    })
  }

  /* ---------------- 评分与评论 ---------------- */

  /**
   * 评价要带上市场索引里那一版的安装包指纹：服务端拿它确认「这人真的装过」。
   * 本地 mods/ 目录扫不出 sha256，所以指纹只能来自索引 —— 没有就先去刷新市场。
   */
  function reviewTarget(mod: ModEntry) {
    return { version: mod.marketVersion || mod.version || "", pkgSha256: mod.pkgSha256 ?? "" }
  }

  function reviewFailed(title: string, reason: string | undefined) {
    toast.error(title, { description: reason || t("服务端没有说原因，稍后再试。") })
  }

  /** 打分与改分走同一条：服务端按 (模组, 公钥) 覆盖，本来就是一人一票 */
  async function addReview(input: { stars: number; body: string }) {
    const mod = detailMod
    if (!mod) return
    const { version, pkgSha256 } = reviewTarget(mod)
    if (!pkgSha256) {
      toast.warning(t("这一票没有提交"), {
        description: t("拿不到这个版本的安装包指纹，先去模组市场刷新一次索引，再来评价。"),
      })
      return
    }
    const reply = await source.submitReview({
      modId: mod.id,
      version,
      pkgSha256,
      stars: input.stars,
      body: input.body,
    })
    if (!reply.ok) {
      reviewFailed(t("评价没能提交"), reply.reason)
      return
    }
    toast.success(t("评价已提交"), { description: t("你的这一票已经计入平均分。") })
  }

  async function removeReview() {
    const mod = detailMod
    if (!mod) return
    const reply = await source.retractReview(mod.id)
    if (!reply.ok) {
      reviewFailed(t("撤回评价失败"), reply.reason)
      return
    }
    toast(t("评价已撤回"), { description: t("平均分与评分人数一并回退。") })
  }

  /** 发布与修改作者回复同一条通道；鉴权在服务端（签名者必须是该模组的作者） */
  async function addReply(reviewId: string, body: string) {
    const mod = detailMod
    if (!mod) return
    const reply = await source.submitReply({ modId: mod.id, reviewId, body })
    if (!reply.ok) {
      reviewFailed(t("回复没能发布"), reply.reason)
      return
    }
    toast.success(t("回复已发布"))
  }

  async function removeReply(reviewId: string) {
    const mod = detailMod
    if (!mod) return
    const reply = await source.retractReply({ modId: mod.id, reviewId })
    if (!reply.ok) {
      reviewFailed(t("撤回回复失败"), reply.reason)
      return
    }
    toast(t("回复已撤回"))
  }

  /* ---------------- 目录与导入 ---------------- */

  /** 打开服务端根目录下的 mods 目录（后端会先确保它存在） */
  async function openModsDir() {
    const reply = await source.openFolder()
    if (!reply.ok) {
      toast.error("打不开 mods 目录", { description: reply.reason ?? "系统没有返回原因" })
    }
  }

  /**
   * 导入 ZIP：弹系统「打开文件」选包，取消就静默（后端回 canceled:true）。
   * 成功必须重扫列表 —— 导入是真往 mods/ 里落目录，不重扫界面上什么都看不见。
   */
  async function importZip() {
    setImporting(true)
    try {
      const reply = await source.importZip()
      if (reply.canceled === true) return
      if (!reply.ok) {
        toast.error("导入模组包失败", { description: reply.reason ?? "系统没有返回原因" })
        return
      }
      await source.reload()
      const folder = typeof reply.folder === "string" ? reply.folder : ""
      const name =
        typeof reply.displayName === "string" && reply.displayName ? reply.displayName : folder
      toast.success(t("模组「{name}」已导入", { name }), {
        description: [
          folder ? t("已写入 mods/{folder}/", { folder }) : "已写入 mods/",
          reply.disabledAfterImport === true ? "导入的包默认禁用，去列表里启用后才加载" : "",
          reply.trusted === true ? "" : "市场索引里没有这个包的收录记录，来源请自行确认",
        ]
          .filter(Boolean)
          .join(" · "),
      })
    } finally {
      setImporting(false)
    }
  }

  /** 一键补出 mods/：建完重扫，提示条自己会消失 */
  async function createModsFolder() {
    setCreatingModsFolder(true)
    try {
      const reply = await source.createFolder()
      if (!reply.ok) {
        toast.error("创建 mods 目录失败", { description: reply.reason ?? "系统没有返回原因" })
        return
      }
      await source.reload()
      toast.success("已创建 mods 目录", {
        description: "把模组放进去，服务端下一次启动就会加载。",
      })
    } finally {
      setCreatingModsFolder(false)
    }
  }

  /* ---------------- 创建 / 编辑 ---------------- */

  /** 创建草稿：真落到 mods/<id>/，清单与骨架由后端脚手架生成 */
  async function createMod(input: NewModInput) {
    const reply = await source.createMod({
      templateId: input.template,
      id: input.id,
      displayName: input.name,
      version: input.version,
      description: input.desc,
      category: input.cat,
      tags: input.tags,
      highlights: input.features,
      readme: input.readme,
      conflicts: input.conflicts,
      requiresRestart: input.build.restart,
      // ⚠️ 后端（与现役版 modScaffold.createMod 一致）读的键名是 enabled / sign，
      // 不是界面内部的 enableAfterCreate / signAfterCreate —— 传错名字的后果是
      // 「勾了立即启用，落盘还是 loader.js.disabled」（2026-09-28 报障的根因）。
      enabled: input.build.enableAfterCreate,
      sign: input.build.signAfterCreate,
    })
    if (!reply.ok) {
      toast.error(t("模组「{name}」创建失败", { name: input.name }), {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    setTab("mine")
    await source.reload()
    toast.success(t("模组「{name}」已创建", { name: input.name }), {
      description: t("骨架已写入 mods/{id}/ · {version}，接着可以发布上架。", {
        id: input.id,
        version: input.version,
      }),
      action: { label: "去发布", onClick: () => openSubmit(input.id) },
    })
  }

  /** 表单提交：有目标就是改信息，没有就是新建 */
  async function saveMod(input: NewModInput) {
    const target = formTargetId
      ? mods.find((mod) => mod.id === formTargetId)
      : null
    if (!target) {
      await createMod(input)
      return
    }
    // 真落盘：后端只改「非身份字段」（显示名 / 简介 / 分类 / 标签 / 冲突 / 重启语义 + README），
    // id、version、author、signature 一律不碰，改完由后端重签（签名失败会整份回滚）。
    const reply = await source.updateMeta(keyOf(target), {
      displayName: input.name,
      description: input.desc,
      category: input.cat,
      tags: input.tags,
      conflicts: input.conflicts,
      requiresRestart: input.build.restart,
      readme: input.readme,
      highlights: input.features,
    })
    if (!reply.ok) {
      toast.error(t("模组「{name}」保存失败", { name: input.name }), {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    toast.success(t("模组「{name}」已保存", { name: input.name }), {
      description: `清单与 README 已更新并重新签名（release 内的模组需要重启主服务器后生效）。`,
    })
  }

  /** 移除一条已经无效的投稿记录：只清本机台账（后端不碰 GitHub 与市场索引） */
  async function forgetSubmission(mod: ModEntry) {
    const reply = await source.forgetSubmission(mod.id)
    if (!reply.ok) {
      toast.error(t("没能移除提交记录"), { description: reply.reason ?? "后端没说明原因" })
      return
    }
    toast(t("提交记录已移除"), {
      description: t("「{name}」不再出现在「我创建的」里；在本地重建同名模组再刷新，就能重新提交上架。", {
        name: mod.name,
      }),
    })
  }

  /** 还没提交过的草稿可以直接删掉，上架之后就得走卸载了 */
  async function deleteDraft(mod: ModEntry) {
    const reply = await source.uninstall(keyOf(mod))
    setDetailId(null)
    if (!reply.ok) {
      toast.error("草稿删除失败", { description: reply.reason ?? "后端没说明原因" })
      return
    }
    toast("草稿已删除", {
      description: t("「{name}」已从本地模组库移除。", { name: mod.name }),
    })
  }

  /** 规范弹窗：点开就算看过，脉冲提示不再亮 —— 只提示一次，别天天闪 */
  function openAuthoringDoc() {
    setDocOpen(true)
    if (docPulse) {
      markAuthoringDocSeen()
      setDocPulse(false)
    }
  }

  function openSubmit(id: string | null) {
    // 从卡片或创建成功的提示进来时目标已经确定，只有工具栏那个入口需要先看看有没有可提交的
    if (id === null) {
      const pool = mods.filter((mod) => mod.mine)
      if (pool.length === 0) {
        toast("没有可发布的模组", {
          description: "本地还没有你自己创建的模组，先创建一个再发布。",
        })
        return
      }
    }
    setSubmitTarget(id)
    setSubmitOpen(true)
  }

  // 不在候选里过滤「审核中」：新流程下一次发布只是往自己的仓库推一版 + 发 Release，
  // 审核状态只描述「上一版合并了没有」，不该挡住发新版（旧写法会把发过一次的模组永久藏起来，
  // 用户就再也选不中它了 —— 2026-09-28 报障）。审核状态在卡片上照旧用徽标显示。
  const submitCandidates = useMemo(() => mods.filter((mod) => mod.mine), [mods])

  /** 发布前置还差什么（署名、GitHub 令牌）：入口上的黄点与提交弹窗都看它 */
  const pendingBlockers = publishBlockersList()

  function publishBlockersList() {
    const list: { id: string; label: string; hint: string }[] = []
    if (!hasOwnSignature(authorName)) {
      list.push({
        id: "signature",
        label: "署名",
        hint: usesDefaultSignature(authorName)
          ? t(DEFAULT_SIGNATURE_PUBLISH_HINT)
          : "署名会印在模组的作者栏上，先在「令牌配置」里填上你自己的署名。",
      })
    }
    if (!credential) {
      list.push({
        id: "token",
        label: "发布凭据",
        hint: "发布凭据就是你自己的 GitHub 令牌：源码要推到你名下的仓库，先在「令牌配置」里配好。",
      })
    }
    return list
  }

  const detailMod = mods.find((mod) => mod.id === detailId) ?? null
  const detailTask = downloads.tasks.find((task) => task.modId === detailId)

  /**
   * 评论正文按需拉：聚合分跟着市场索引一起回来（卡片上的分数、排序、评分分档都吃它），
   * 正文更大，所以等真的打开详情弹窗再拉一次。
   *
   * 交给 `source.openReviews` 自己拿捏「先渲染、再后台追一次」：内存里有就立刻出画面，
   * 同一条分片 60 秒内只真联网一次，所以这里不必再自己防重。
   */
  const detailModId = detailMod?.id ?? null
  const detailInMarket = detailMod?.inMarket === true
  const openReviews = source.openReviews
  useEffect(() => {
    if (!detailModId || !detailInMarket) return
    openReviews(detailModId)
  }, [detailModId, detailInMarket, openReviews])

  const handleSubmitted: ModSubmitDialogProps["onSubmitted"] = (
    mod,
    payload,
    outcome
  ) => submitMod(mod, payload, outcome)

  /**
   * 空列表时那句解释要跟真正挡路的筛选项对得上——几个筛选一起用时，
   * 指着一个没问题的条件让用户去改，比不说还糟。
   */
  const emptyHint = (() => {
    const keyword = query.trim()
    const active = [
      keyword ? t("关键词「{value}」", { value: keyword }) : null,
      category !== ALL_CATEGORY ? t("分类「{value}」", { value: category }) : null,
      activeTag ? t("标签「{value}」", { value: activeTag }) : null,
    ].filter((part): part is string => part !== null)
    if (active.length > 1) {
      return t("{list} 叠在一起没有结果，去掉其中一个再试。", { list: active.join(" + ") })
    }
    if (keyword) return t("没有模组匹配「{value}」，清空搜索框再看看。", { value: keyword })
    if (category !== ALL_CATEGORY) {
      return t("「{value}」分类下没有模组，把分类切回「全部」试试。", { value: category })
    }
    if (activeTag) {
      return t("没有模组带「{value}」标签，点一下筛选条上的标签就能取消。", { value: activeTag })
    }
    if (tab === "market" && source.marketBlockedCount > 0) {
      return t(
        "市场索引里有 {count} 个模组声明只兼容别的服务端版本（当前 {version}），已被隐藏；等作者发布兼容版本后就会出现。",
        { count: source.marketBlockedCount, version: source.marketEvejsVersion || t("未知") }
      )
    }
    return "试试更换关键词、分类或标签。"
  })()

  /** 最近一次索引同步失败了吗（marketReason 只在失败时非空）：黄条与页头标注都看它 */
  const marketFallback = source.marketReason !== ""

  /** 页头那半句「索引 HH:MM 更新」：让用户一眼看出手里这份是不是旧缓存 */
  const marketFreshness = (() => {
    if (!source.loaded) return ""
    if (source.marketRefreshing) return t(" · 正在同步索引…")
    if (!source.marketFetchedAt) return ""
    const at = new Date(source.marketFetchedAt)
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    return t(" · 索引 {time} 更新{cached}", {
      time: hhmm,
      cached: marketFallback ? t("（本地缓存）") : "",
    })
  })()

  return (
    <div className="space-y-4">
      <SectionHeading
        title="模组市场"
        sub="// MOD MARKETPLACE · MANIFEST SCHEMA 3"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            {source.loaded
              ? t("已扫描 {scanned} 个模组 · 索引 {indexed} 条{freshness}", {
                  scanned: mods.length,
                  indexed: source.marketCount,
                  freshness: marketFreshness,
                })
              : "正在扫描 mods/ 与市场索引…"}
          </span>
        }
      />

      {/* 网络拉不动、只能吃缓存（或者连缓存都没有）时说实话：标明现状，并给一个一键重试 */}
      {tab === "market" && marketFallback ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/45 bg-warning/[0.07] px-3 py-2.5">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
            {source.marketCached
              ? t("模组市场现在显示的是本地缓存{fetched}", {
                  fetched: source.marketFetchedAt
                    ? t("（{time} 拉取）", {
                        time: new Date(source.marketFetchedAt).toLocaleString(),
                      })
                    : "",
                })
              : "模组市场索引本地还没有缓存，也没能从网上拉到"}
            {source.marketReason ? t("：{reason}", { reason: source.marketReason }) : "。"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={source.marketRefreshing}
            onClick={() => void refreshModsAndMarket()}
          >
            {source.marketRefreshing ? <Loader2 className="animate-spin" /> : null}
            {source.marketRefreshing ? "同步中…" : "重新同步索引"}
          </Button>
        </div>
      ) : null}

      {/* 根目录不对是全局问题，摆在最上面：下面每张卡片能不能装、建出来的骨架落在哪儿都看它 */}
      {rootOk ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/45 bg-destructive/[0.07] px-3 py-2.5">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
            服务端根目录现在指向{" "}
            <span className="tabular break-all text-destructive">
              {source.repoRoot || serverRoot || "（空）"}
            </span>
            ，这个目录里找不到服务端主程序，模组骨架建过去服务端也加载不到。
          </span>
          <Button size="sm" variant="outline" onClick={() => onNavigate("config")}>
            去改根目录
          </Button>
        </div>
      )}

      {/* 根目录对了但还没有 mods/：服务端不会加载任何模组，给一键创建而不是让用户自己去翻目录 */}
      {modsRootMissing ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/45 bg-warning/[0.07] px-3 py-2.5">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
            <span className="tabular break-all text-foreground">
              {source.repoRoot || serverRoot}
            </span>{" "}
            下还没有 <span className="tabular text-warning">mods/</span> 文件夹，服务端不会加载任何模组。
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={creatingModsFolder}
            onClick={() => void createModsFolder()}
          >
            {creatingModsFolder ? <Loader2 className="animate-spin" /> : null}
            {creatingModsFolder ? "正在创建…" : "自动创建 mods/"}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* min-w-0：这一行是 flex，页签不压缩的话窄窗会被它顶出横向滚动 */}
        <Tabs value={tab} onValueChange={(value) => setTab(value as ModTab)} className="min-w-0">
          <TabsList>
            {MOD_TABS.map((item) => (
              <TabsTrigger key={item} value={item}>
                {TAB_LABEL[item]}
                {item === "preflight" ? (
                  preflightIssues > 0 ? (
                    <span className="tabular flex items-center gap-0.5 rounded-sm border border-warning/35 bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                      {preflightIssues}
                    </span>
                  ) : null
                ) : (
                  <span className="tabular text-[10px] text-tertiary">
                    {tabCount[item]}
                  </span>
                )}
                {item === "market" && updatableCount > 0 ? (
                  <span className="tabular flex items-center gap-0.5 rounded-sm border border-primary/35 bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                    <ArrowUpCircle className="size-2.5" />
                    {t("可更新 {count}", { count: updatableCount })}
                  </span>
                ) : null}
                {item === "mine" && mineCounts.pending > 0 ? (
                  <span className="tabular flex items-center gap-0.5 rounded-sm border border-warning/35 bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                    <MessageSquare className="size-2.5" />
                    {t("待回复 {count}", { count: mineCounts.pending })}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="min-w-2 flex-1" />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setFormTargetId(null)
              setFormOpen(true)
            }}
          >
            <Plus />
            创建模组
          </Button>
          {/* 发布一次之后按钮自己进 60 秒倒计时：连点会重复推 Release、抢同一次索引重建 */}
          <Button
            variant="outline"
            disabled={publishCooling}
            onClick={() => openSubmit(null)}
            title={
              publishCooling
                ? t("距上次发布还差 {seconds} 秒，倒计时结束才能再发一次", {
                    seconds: Math.ceil(publishIntervalMs / 1000),
                  })
                : undefined
            }
          >
            <Send />
            {publishCooling
              ? t("发布模组 · {seconds}s", { seconds: Math.ceil(publishIntervalMs / 1000) })
              : "发布模组"}
          </Button>
          {/*
            重装系统 / 换电脑后本机换了身份：配了令牌的人一直能看到这个入口（认领本来就要令牌，
            核验仓库写权限），本机还扫到候选的话，没配令牌的人也能看到 —— 见 lib/mod-claim.ts。
          */}
          {shouldOfferClaim(source.claims, source.tokenStatus?.hasToken === true) ? (
            <Button variant="outline" onClick={() => setClaimOpen(true)}>
              <History />
              找回旧模组
            </Button>
          ) : null}
          {/* 发布前置没补齐时点一个小黄点：别等进了提交弹窗才发现要配东西 */}
          <Button
            variant="outline"
            onClick={() => setAuthorOpen(true)}
            title={
              pendingBlockers.length > 0
                ? t("还差{list}，发布模组前要在这里补齐", {
                    list: pendingBlockers.map((item) => t(item.label)).join(listSeparator()),
                  })
                : undefined
            }
          >
            <BadgeCheck />
            令牌配置
            {pendingBlockers.length > 0 ? (
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            ) : null}
          </Button>
          <Button
            variant="ghost"
            onClick={openAuthoringDoc}
            title={docPulse ? t("规范文档有新内容，点开看看") : undefined}
          >
            <BookOpen />
            模组制作规范
            {docPulse ? (
              /* 一圈向外扩散的光环 + 小点：沿用「有新版本」那套提示语言，点开即灭 */
              <span className="relative ml-0.5 inline-flex size-1.5" aria-hidden="true">
                <span className="mc-pulse size-1.5 rounded-full bg-primary" />
                <span className="update-pulse-ring absolute -inset-1 rounded-full" />
              </span>
            ) : null}
          </Button>
        </div>
      </div>

      {conflictDismissed ? null : (
        <ConflictBanner
          pairs={conflictPairs}
          onDisable={disableMod}
          onDisableAll={disableAllConflicts}
          onDismiss={() => setConflictDismissed(true)}
        />
      )}

      {tab === "mine" ? <ReviewBanner mods={reviewing} /> : null}

      {tab === "preflight" ? null : (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="已安装数"
          value={installedCount}
          unit="个"
          tone="telemetry"
          delta={t("共 {count} 个模组在库", { count: mods.length })}
        />
        <StatTile
          label="已启用数"
          value={enabledCount}
          unit="个"
          tone="success"
          delta={t("已停用 {count} 个", { count: installedCount - enabledCount })}
        />
        <StatTile
          label="可更新数"
          value={updatableCount}
          unit="个"
          tone="primary"
          delta="市场已发布新版本"
        />
        <StatTile
          label="冲突数"
          value={conflictPairs.length}
          unit="组"
          tone={conflictPairs.length ? "destructive" : "foreground"}
          delta={
            conflictPairs.length ? "需停用其中一个" : "未检测到加载冲突"
          }
        />
        <StatTile
          label="收录待审"
          value={reviewing.length}
          unit="个"
          tone={reviewing.length ? "warning" : "foreground"}
          delta={
            reviewing.length
              ? "等索引仓库合并版本审核 PR"
              : "暂无待审的版本审核 PR"
          }
        />
      </div>
      )}

      {tab === "preflight" ? null : (
      <ModToolbar
        query={query}
        category={category}
        onQueryChange={setQuery}
        onCategoryChange={setCategory}
        marketFilter={tab === "market" ? marketFilter : undefined}
        onMarketFilterChange={tab === "market" ? setMarketFilter : undefined}
        marketCounts={marketCounts}
        mineFilter={tab === "mine" ? mineFilter : undefined}
        onMineFilterChange={tab === "mine" ? setMineFilter : undefined}
        mineCounts={mineCounts}
        sort={tab === "market" ? sort : undefined}
        onSortChange={tab === "market" ? setSort : undefined}
        rating={tab === "market" ? ratingFilter : undefined}
        onRatingChange={tab === "market" ? setRatingFilter : undefined}
        tag={activeTag}
        onTagChange={setActiveTag}
        onOpenModsDir={() => void openModsDir()}
        onImportZip={() => void importZip()}
        importing={importing}
        onRefresh={() => {
          void refreshModsAndMarket()
        }}
      />
      )}

      {tab === "preflight" ? (
        <>
          <ModOverlapPanel report={overlaps} mods={mods} onDisable={disableMod} />
          <ModPreflightPanel
            report={source.preflight}
            dryRun={source.preflightDryRun}
            running={source.preflightRunning}
            onRun={(dryRun) => void source.runPreflight(dryRun)}
          />
        </>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <p className="text-[13px] text-tertiary">没有匹配的模组</p>
          <p className="mt-1 text-[11px] text-tertiary/80">
            {tab === "market" && marketFilter === "installed"
              ? "当前筛选只看已安装，切换到「全部」查看市场里的其他模组。"
              : tab === "mine" && mineFilter === "pending"
                ? "你的模组下面没有待回复的评价，都回完了。"
                : tab === "market" && ratingFilter !== "all"
                  ? "这个评分分档下没有模组，换个分档或选「全部评分」。"
                  : emptyHint}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((mod) => (
            <ModCard
              key={mod.id}
              mod={mod}
              task={downloads.tasks.find((task) => task.modId === mod.id)}
              conflicts={activeConflicts(mods, mod)}
              pendingConflicts={pendingConflicts(mods, mod)}
              overlap={overlapFlag(overlaps, mod)}
              onToggle={(next) => void toggleMod(mod, next)}
              onInstall={() => installMod(mod)}
              onUpdate={() => updateMod(mod)}
              onDetail={() => setDetailId(mod.id)}
              onSubmit={() => openSubmit(mod.id)}
              onUninstall={() => void uninstallMod(mod)}
              onForget={() => void forgetSubmission(mod)}
              onCancelDownload={() => downloads.cancel(mod.id)}
              onResolveConflict={(other) => void disableMod(other)}
              activeTag={activeTag}
              onTagClick={(tag) =>
                setActiveTag((current) => (current === tag ? null : tag))
              }
            />
          ))}
        </div>
      )}

      <ModDetailDialog
        mod={detailMod}
        open={detailId !== null}
        onOpenChange={(next) => {
          if (!next) setDetailId(null)
        }}
        task={detailTask}
        conflicts={detailMod ? activeConflicts(mods, detailMod) : []}
        pendingConflicts={detailMod ? pendingConflicts(mods, detailMod) : []}
        onInstall={() => detailMod && installMod(detailMod)}
        onUpdate={() => detailMod && updateMod(detailMod)}
        onUninstall={() => {
          if (detailMod) void uninstallMod(detailMod)
          setDetailId(null)
        }}
        onEdit={() => {
          const id = detailId
          setDetailId(null)
          setFormTargetId(id)
          setFormOpen(true)
        }}
        onDeleteDraft={() => detailMod && void deleteDraft(detailMod)}
        onSubmit={() => {
          const id = detailId
          setDetailId(null)
          openSubmit(id)
        }}
        onCancelDownload={() => detailId && downloads.cancel(detailId)}
        onResolveConflict={(other) => void disableMod(other)}
        onAddReview={(input) => void addReview(input)}
        onReply={(reviewId, body) => void addReply(reviewId, body)}
        onEditReply={(reviewId, body) => void addReply(reviewId, body)}
        onDeleteReply={(reviewId) => void removeReply(reviewId)}
        onEditReview={(_reviewId, input) => void addReview(input)}
        onDeleteReview={() => void removeReview()}
      />

      <ModFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mod={formTargetId ? (mods.find((mod) => mod.id === formTargetId) ?? null) : null}
        existingIds={mods.map((mod) => mod.id)}
        onSubmit={(input) => void saveMod(input)}
        serverRoot={source.repoRoot || serverRoot}
        rootOk={rootOk}
        templates={source.templates}
      />

      <ModAuthorDialog
        open={authorOpen}
        onOpenChange={setAuthorOpen}
        name={authorName}
        authorId={source.authorId}
        keyId={source.keyId}
        privateKeyExists={source.privateKeyExists}
        dataDir={source.dataDir}
        since={source.authorSince}
        tokenStatus={source.tokenStatus}
        onSaveName={source.setAuthorName}
        onSaveToken={source.saveToken}
        onClearToken={() => void source.clearToken()}
        onCheckToken={source.checkToken}
        onExportKey={() => void source.exportKey()}
        onImportKey={() => void source.importKey()}
        onOpenKeyFolder={() => void source.openKeyFolder()}
      />

      <ModSubmitDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        candidates={submitCandidates}
        preselectId={submitTarget}
        authorName={authorName}
        credential={credential}
        sourceRepos={sourceRepos}
        onOpenAuthor={() => setAuthorOpen(true)}
        onPublish={(mod, payload) =>
          source.publish({
            mod,
            version: payload.version,
            note: payload.note,
            // 留空 = 交给后端按模组 id 在你的账号下取仓库名；用户不用自己想仓库名
            repo: "",
          })
        }
          cooldownRemaining={(id) => submitCooldownRemaining(source.lastSubmissionOf(id), Date.now())}
        intervalRemainingMs={publishIntervalMs}
        progress={source.publishProgress}
        phase={source.publishPhase}
        onSubmitted={handleSubmitted}
      />

      <ModAuthoringDialog
        open={docOpen}
        onOpenChange={setDocOpen}
        onOpenExternal={source.openAuthoringDoc}
      />

      <ModClaimDialog
        open={claimOpen}
        onOpenChange={setClaimOpen}
        privateKeyExists={source.privateKeyExists}
        onLoad={source.loadClaims}
        onClaim={source.claimMod}
        onCheckToken={source.checkToken}
        onOpenToken={() => {
          setClaimOpen(false)
          setAuthorOpen(true)
        }}
        onImportKey={() => void source.importKey()}
      />
    </div>
  )
}
