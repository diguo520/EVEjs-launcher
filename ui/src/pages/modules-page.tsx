import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowUpCircle,
  BadgeCheck,
  BookOpen,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { SectionHeading, StatTile } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ModCard } from "@/components/modules/mod-card"
import { ModToolbar } from "@/components/modules/mod-toolbar"
import { ModDetailDialog } from "@/components/modules/mod-detail-dialog"
import { ModFormDialog } from "@/components/modules/mod-form-dialog"
import { ModAuthorDialog } from "@/components/modules/mod-author-dialog"
import { ModAuthoringDialog } from "@/components/modules/mod-authoring-dialog"
import {
  ModSubmitDialog,
  type ModSubmitDialogProps,
} from "@/components/modules/mod-submit-dialog"
import { ConflictBanner, ReviewBanner } from "@/components/modules/mod-banners"
import { useModDownloads, type DownloadTask } from "@/hooks/use-mod-downloads"
import { useModSource, type PublishOutcome } from "@/hooks/use-mod-source"
import {
  ALL_CATEGORY,
  activeConflicts,
  collectConflictPairs,
  filterMods,
  hasUpdate,
  isPublished,
  isReviewing,
  pendingConflicts,
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

const MOD_TABS: ModTab[] = ["installed", "mine", "market"]

const TAB_LABEL: Record<ModTab, string> = {
  installed: "已安装",
  mine: "我创建的",
  market: "模组市场",
}

/** 后端还没有的市场社区能力，统一回一句实话，别假装做完了 */
const NOT_WIRED = "当前启动器还没接上这项市场服务能力"

export function ModulesPage({
  serverRoot,
  onNavigate,
}: {
  /** 配置里的服务端根目录：模组目录相对它定位 */
  serverRoot: string
  onNavigate: (view: ViewId) => void
}) {
  /* ---------------- 真数据源 ---------------- */

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
  const [docOpen, setDocOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitTarget, setSubmitTarget] = useState<string | null>(null)
  const [conflictDismissed, setConflictDismissed] = useState(false)
  const [importing, setImporting] = useState(false)
  const [creatingModsFolder, setCreatingModsFolder] = useState(false)

  /* ---------------- 下载队列 ---------------- */

  const handleDownloadDone = useCallback((task: DownloadTask) => {
    if (task.kind === "install") {
      toast.success(`「${task.name}」安装完成`, {
        description: `v${task.targetVersion} 已启用，重启对应服务后生效。`,
      })
    } else {
      toast.success(`「${task.name}」已更新到 ${task.targetVersion}`, {
        description: `旧版本 ${task.fromVersion} 已备份，重启对应服务后生效。`,
      })
    }
  }, [])

  const handleDownloadFailed = useCallback((mod: ModEntry, reason: string) => {
    toast.error(`「${mod.name}」下载失败`, { description: reason })
  }, [])

  const downloads = useModDownloads(
    handleDownloadDone,
    handleDownloadFailed,
    source.downloadProgress
  )

  /* ---------------- 冲突 ---------------- */

  const conflictPairs = useMemo(() => collectConflictPairs(mods), [mods])

  const conflictKey = conflictPairs.map((p) => `${p.a.id}|${p.b.id}`).join(",")

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

  const tabCount: Record<ModTab, number> = {
    installed: installedCount,
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
      toast.error(next ? `启用 ${mod.name} 失败` : `停用 ${mod.name} 失败`, {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    toast(next ? `已启用 ${mod.name}` : `已停用 ${mod.name}`)
  }

  async function disableMod(mod: ModEntry) {
    setMods((prev) =>
      prev.map((item) => (item.id === mod.id ? { ...item, enabled: false } : item))
    )
    await source.setEnabled(keyOf(mod), false)
    toast(`已停用 ${mod.name}`, { description: "冲突已解除，重启对应服务后生效。" })
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
    toast(`已停用 ${ids.size} 个冲突模组`, {
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
    toast(`开始下载「${mod.name}」`, {
      description: `${formatMB(mod.sizeMB)} · 来自模组市场`,
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
    toast(`开始更新「${mod.name}」`, {
      description: `${mod.version} → ${targetVersion} · ${formatMB(mod.sizeMB)}`,
    })
  }

  async function uninstallMod(mod: ModEntry) {
    downloads.cancel(mod.id)
    const reply = await source.uninstall(keyOf(mod))
    if (!reply.ok) {
      toast.error(`卸载 ${mod.name} 失败`, {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    toast(`已卸载 ${mod.name}`)
  }

  /** 发布完成后的收尾：真流程在弹窗里跑，这里只解释结果 */
  function submitMod(mod: ModEntry, payload: { version: string; note: string }, outcome: PublishOutcome) {
    setTab("mine")
    // 有没有开出 PR 只能看发布流程回传的结果：这里再读台账已经晚了一步
    // （publish() 收尾时 reload 过台账，刚提交的记录也会显示成「已登记」）。
    const registered = outcome.registered === true
    const reviewUrl = outcome.reviewUrl
    toast.success("发布完成", {
      description: outcome.repoSlug
        ? `「${mod.name}」${payload.version} 已发布到 ${outcome.repoSlug}${
            registered
              ? "，版本审核 PR 已提交到索引仓库（维护者合并后，市场更新到这一版）"
              : "，但版本审核 PR 没有开出来"
          }。`
        : `「${mod.name}」${payload.version} 已发布到你自己名下的仓库。`,
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

  /* ---------------- 评分与评论：后端还没有这项服务 ---------------- */

  function notWired(action: string) {
    toast(`${action}：${NOT_WIRED}`, {
      description: "评分、评论与作者回复由模组市场服务托管，当前版本尚未接入，界面暂不落任何假数据。",
    })
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
      toast.success(`模组「${name}」已导入`, {
        description: [
          folder ? `已写入 mods/${folder}/` : "已写入 mods/",
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
      toast.error(`模组「${input.name}」创建失败`, {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    setTab("mine")
    await source.reload()
    toast.success(`模组「${input.name}」已创建`, {
      description: `骨架已写入 mods/${input.id}/ · ${input.version}，接着可以发布上架。`,
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
      toast.error(`模组「${input.name}」保存失败`, {
        description: reply.reason ?? "后端没说明原因",
      })
      return
    }
    toast.success(`模组「${input.name}」已保存`, {
      description: `清单与 README 已更新并重新签名（release 内的模组需要重启主服务器后生效）。`,
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
      description: `「${mod.name}」已从本地模组库移除。`,
    })
  }

  /** 审核由索引仓库的 PR 流程托管：这里把作者带到那条 PR 上 */
  function openReview(mod: ModEntry) {
    const submission = source.lastSubmissionOf(mod.id)
    if (submission?.sourceReviewUrl) {
      void source.openExternal(submission.sourceReviewUrl)
      toast("已打开版本审核 PR", { description: "审核结论以索引仓库那条 PR 的状态为准。" })
      return
    }
    notWired("审核")
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
    if (!authorName.trim()) {
      list.push({
        id: "signature",
        label: "署名",
        hint: "署名会印在模组的作者栏上，先在「作者身份」里填上你自己的署名。",
      })
    }
    if (!credential) {
      list.push({
        id: "token",
        label: "发布凭据",
        hint: "发布凭据就是你自己的 GitHub 令牌：源码要推到你名下的仓库，先在「作者身份」里配好。",
      })
    }
    return list
  }

  const detailMod = mods.find((mod) => mod.id === detailId) ?? null
  const detailTask = downloads.tasks.find((task) => task.modId === detailId)

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
      keyword ? `关键词「${keyword}」` : null,
      category !== ALL_CATEGORY ? `分类「${category}」` : null,
      activeTag ? `标签「${activeTag}」` : null,
    ].filter((part): part is string => part !== null)
    if (active.length > 1) {
      return `${active.join(" + ")} 叠在一起没有结果，去掉其中一个再试。`
    }
    if (keyword) return `没有模组匹配「${keyword}」，清空搜索框再看看。`
    if (category !== ALL_CATEGORY) {
      return `「${category}」分类下没有模组，把分类切回「全部」试试。`
    }
    if (activeTag) {
      return `没有模组带「${activeTag}」标签，点一下筛选条上的标签就能取消。`
    }
    if (tab === "market" && source.marketBlockedCount > 0) {
      return `市场索引里有 ${source.marketBlockedCount} 个模组声明只兼容别的服务端版本（当前 ${source.marketEvejsVersion || "未知"}），已被隐藏；等作者发布兼容版本后就会出现。`
    }
    return "试试更换关键词、分类或标签。"
  })()

  return (
    <div className="space-y-4">
      <SectionHeading
        title="模组市场"
        sub="// MOD MARKETPLACE · MANIFEST SCHEMA 3"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            {source.loaded
              ? `已扫描 ${mods.length} 个模组 · 索引 ${source.marketCount} 条`
              : "正在扫描 mods/ 与市场索引…"}
          </span>
        }
      />

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
                <span className="tabular text-[10px] text-tertiary">
                  {tabCount[item]}
                </span>
                {item === "market" && updatableCount > 0 ? (
                  <span className="tabular flex items-center gap-0.5 rounded-sm border border-primary/35 bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                    <ArrowUpCircle className="size-2.5" />
                    可更新 {updatableCount}
                  </span>
                ) : null}
                {item === "mine" && mineCounts.pending > 0 ? (
                  <span className="tabular flex items-center gap-0.5 rounded-sm border border-warning/35 bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                    <MessageSquare className="size-2.5" />
                    待回复 {mineCounts.pending}
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
          <Button variant="outline" onClick={() => openSubmit(null)}>
            <Send />
            发布模组
          </Button>
          {/* 发布前置没补齐时点一个小黄点：别等进了提交弹窗才发现要配东西 */}
          <Button
            variant="outline"
            onClick={() => setAuthorOpen(true)}
            title={
              pendingBlockers.length > 0
                ? `还差${pendingBlockers
                    .map((item) => item.label)
                    .join("、")}，发布模组前要在这里补齐`
                : undefined
            }
          >
            <BadgeCheck />
            作者身份
            {pendingBlockers.length > 0 ? (
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            ) : null}
          </Button>
          <Button variant="ghost" onClick={() => setDocOpen(true)}>
            <BookOpen />
            模组制作规范
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

      {tab === "mine" ? (
        <ReviewBanner mods={reviewing} onOpenReview={openReview} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="已安装数"
          value={installedCount}
          unit="个"
          tone="telemetry"
          delta={`共 ${mods.length} 个模组在库`}
        />
        <StatTile
          label="已启用数"
          value={enabledCount}
          unit="个"
          tone="success"
          delta={`已停用 ${installedCount - enabledCount} 个`}
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
          void source.reload()
          toast.success("模组列表已刷新", {
            description: `已重新扫描 mods 目录与市场索引 · ${mods.length} 个模组`,
          })
        }}
      />

      {visible.length === 0 ? (
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
              onToggle={(next) => void toggleMod(mod, next)}
              onInstall={() => installMod(mod)}
              onUpdate={() => updateMod(mod)}
              onDetail={() => setDetailId(mod.id)}
              onSubmit={() => openSubmit(mod.id)}
              onUninstall={() => void uninstallMod(mod)}
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
        onAddReview={() => notWired("发布评价")}
        onReply={() => notWired("发布作者回复")}
        onEditReply={() => notWired("修改作者回复")}
        onDeleteReply={() => notWired("删除作者回复")}
        onEditReview={() => notWired("修改评价")}
        onDeleteReview={() => notWired("删除评价")}
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
        progress={source.publishProgress}
        phase={source.publishPhase}
        onSubmitted={handleSubmitted}
      />

      <ModAuthoringDialog
        open={docOpen}
        onOpenChange={setDocOpen}
        onOpenExternal={source.openAuthoringDoc}
      />
    </div>
  )
}
