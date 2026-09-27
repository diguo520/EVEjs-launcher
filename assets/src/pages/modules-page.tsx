import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowUpCircle,
  BadgeCheck,
  BookOpen,
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
import {
  ModSubmitDialog,
  type ModSubmitDialogProps,
} from "@/components/modules/mod-submit-dialog"
import { ConflictBanner, ReviewBanner } from "@/components/modules/mod-banners"
import { useModDownloads, type DownloadTask } from "@/hooks/use-mod-downloads"
import {
  ALL_CATEGORY,
  activeConflicts,
  applyModPatch,
  applyReviewResult,
  collectConflictPairs,
  draftMod,
  filterMods,
  hasUpdate,
  isPublished,
  isReviewing,
  credentialLabel,
  displayAuthor,
  isCredentialLive,
  publishBlockers,
  publishToastId,
  sourceRepo,
  type PublishCredential,
  marketCounts as countMarket,
  mineCounts as countMine,
  pendingConflicts,
  rateAdd,
  rateRemove,
  rateReplace,
  sortMods,
  targetVersionOf,
  todayISO,
  type MarketFilter,
  type MineFilter,
  type ModSort,
  type NewModInput,
  type ReviewResult,
  type ModTab,
  type RatingFilter,
} from "@/lib/mod-logic"
import {
  MODS,
  MOD_AUTHOR,
  REVIEW_WINDOW_MINUTES,
  formatMB,
  isServerRootValid,
  type ModEntry,
} from "@/lib/mock"
import type { ViewId } from "@/components/shell/nav-config"

const MOD_TABS: ModTab[] = ["installed", "mine", "market"]

const TAB_LABEL: Record<ModTab, string> = {
  installed: "已安装",
  mine: "我创建的",
  market: "模组市场",
}

function nowLabel(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}


export function ModulesPage({
  serverRoot,
  onNavigate,
}: {
  /** 配置里的服务端根目录：模组目录相对它定位 */
  serverRoot: string
  onNavigate: (view: ViewId) => void
}) {
  const [mods, setMods] = useState<ModEntry[]>(MODS)
  /** 根目录指错地方，模组建出来也没人加载，页面上得先说这件事 */
  const rootOk = isServerRootValid(serverRoot)
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
  /**
   * 本地署名：一开始是空的（「指挥官」只是输入框里的占位提示，不是默认值），
   * 作者身份里填过之后，新模组与发表的评价都跟着用这个名字；
   * 没填就发布不了，提交那一步会把它当作前置条件拦下来。
   */
  const [authorName, setAuthorName] = useState("")
  /** 发布凭据：跟签名私钥分开存，导出密钥时不会带上它 */
  const [credential, setCredential] = useState<PublishCredential | null>(null)
  /**
   * 已经有源码仓库的模组：源码是按模组推到作者自己的仓库里的，
   * 第一次带凭据提交时建仓库，之后各版本都推同一个仓库。
   * 初值取交过审核的（上架中 / 审核中 / 被驳回都推过源码），草稿还没推过。
   */
  const [sourceRepos, setSourceRepos] = useState<string[]>(() =>
    MODS.filter((mod) => mod.mine && mod.review !== "draft").map((mod) => mod.id)
  )
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitTarget, setSubmitTarget] = useState<string | null>(null)
  const [conflictDismissed, setConflictDismissed] = useState(false)

  /* ---------------- 下载队列 ---------------- */

  const handleDownloadDone = useCallback((task: DownloadTask) => {
    setMods((prev) =>
      prev.map((mod) =>
        mod.id === task.modId
          ? {
              ...mod,
              installed: true,
              enabled: true,
              needsRestart: true,
              version: task.targetVersion,
            }
          : mod
      )
    )
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

  const downloads = useModDownloads(handleDownloadDone)

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

  function toggleMod(mod: ModEntry, next: boolean) {
    setMods((prev) =>
      prev.map((item) => (item.id === mod.id ? { ...item, enabled: next } : item))
    )
    toast(next ? `已启用 ${mod.name}` : `已停用 ${mod.name}`)
  }

  function disableMod(mod: ModEntry) {
    setMods((prev) =>
      prev.map((item) => (item.id === mod.id ? { ...item, enabled: false } : item))
    )
    toast(`已停用 ${mod.name}`, { description: "冲突已解除，重启对应服务后生效。" })
  }

  function disableAllConflicts() {
    const ids = new Set<string>()
    conflictPairs.forEach((pair) => {
      ids.add(pair.a.id)
      ids.add(pair.b.id)
    })
    setMods((prev) =>
      prev.map((mod) => (ids.has(mod.id) ? { ...mod, enabled: false } : mod))
    )
    toast(`已停用 ${ids.size} 个冲突模组`, {
      description: "全部冲突项已停用，重启对应服务后生效。",
    })
  }

  function installMod(mod: ModEntry) {
    const targetVersion = targetVersionOf(mod)
    downloads.start({ mod, kind: "install", targetVersion })
    toast(`开始下载「${mod.name}」`, {
      description: `${formatMB(mod.sizeMB)} · 来自模组市场`,
    })
  }

  function updateMod(mod: ModEntry) {
    const targetVersion = targetVersionOf(mod)
    downloads.start({ mod, kind: "update", targetVersion })
    toast(`开始更新「${mod.name}」`, {
      description: `${mod.version} → ${targetVersion} · ${formatMB(mod.sizeMB)}`,
    })
  }

  function uninstallMod(mod: ModEntry) {
    downloads.cancel(mod.id)
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? { ...item, installed: false, enabled: false, needsRestart: false }
          : item
      )
    )
    toast(`已卸载 ${mod.name}`)
  }

  function submitMod(mod: ModEntry, payload: { version: string; note: string }) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? {
              ...item,
              review: "reviewing",
              version: payload.version,
              // 待审版本还不能装，清掉市场更新提示，免得出现「1.5.0 → 1.5.0」
              latest: undefined,
              submittedAt: nowLabel(),
            }
          : item
      )
    )
    setTab("mine")
    const now = Date.now()
    // 提交那一步已经拦过凭据了，走到这里它一定是能用的；源码推上去了，
    // 这个模组的仓库也就存在了，下次提交只剩推新版本
    const synced = isCredentialLive(credential, now)
    if (synced) {
      setSourceRepos((prev) =>
        prev.includes(mod.id) ? prev : [...prev, mod.id]
      )
    }
    // 接手提交弹窗里那条「正在提交审核」，原地换成结果，别再多出一条提示
    toast.success("提交完成", {
      id: publishToastId("submit"),
      description: synced
        ? `「${mod.name}」${payload.version} 已进入审核队列；源码用 ${credentialLabel(
            credential!,
            now
          )} 推送到 ${sourceRepo(mod.id)}，人工审核通常需要 ${REVIEW_WINDOW_MINUTES} 分钟。`
        : `「${mod.name}」${payload.version} 已进入审核队列；授权没能生效，源码没推上去，人工审核通常需要 ${REVIEW_WINDOW_MINUTES} 分钟。`,
    })
  }

  /** 发布评价：写文字可选，只打分也算一票 */
  function addReview(mod: ModEntry, input: { stars: number; body: string }) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? {
              ...item,
              ...rateAdd(item, input.stars),
              reviews: [
                {
                  id: `${item.id}-local-${item.reviews.length + 1}`,
                  author: displayAuthor(authorName),
                  corp: MOD_AUTHOR.corp,
                  stars: input.stars,
                  date: todayISO(),
                  version: item.version,
                  body: input.body,
                  mine: true,
                },
                ...item.reviews,
              ],
            }
          : item
      )
    )
    toast.success("评价已发布", {
      description: input.body
        ? `已记为 ${input.stars} 星，该模组的平均分与评分人数同步更新。`
        : `已记为 ${input.stars} 星，没写文字也会计入平均分。`,
    })
  }

  function replyToReview(mod: ModEntry, reviewId: string, body: string) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? {
              ...item,
              reviews: item.reviews.map((review) =>
                review.id === reviewId && !review.reply
                  ? { ...review, reply: { date: todayISO(), body } }
                  : review
              ),
            }
          : item
      )
    )
    toast.success("已发布作者回复", {
      description: `以「${mod.author}」的身份回复，会显示在这条评价下面。`,
    })
  }

  /** 作者改自己的回复：直接替换旧回复，并标一句「已编辑」 */
  function editReply(mod: ModEntry, reviewId: string, body: string) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? {
              ...item,
              reviews: item.reviews.map((review) =>
                review.id === reviewId && review.reply && item.mine
                  ? {
                      ...review,
                      reply: {
                        date: todayISO(),
                        body,
                        edited: true,
                      },
                    }
                  : review
              ),
            }
          : item
      )
    )
    toast.success("回复已更新", {
      description: "新的回复已经替换掉旧的那条。",
    })
  }

  /** 作者撤掉自己的回复，评价本身不受影响 */
  function deleteReply(mod: ModEntry, reviewId: string) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id
          ? {
              ...item,
              reviews: item.reviews.map((review) =>
                review.id === reviewId && item.mine
                  ? { ...review, reply: undefined }
                  : review
              ),
            }
          : item
      )
    )
    toast("回复已删除", {
      description: "这条评价下面不再显示作者回复。",
    })
  }

  /** 只能改自己写的那条；改了星级就把自己那一票换掉，总人数不变 */
  function editReview(
    mod: ModEntry,
    reviewId: string,
    input: { stars: number; body: string }
  ) {
    setMods((prev) =>
      prev.map((item) => {
        if (item.id !== mod.id) return item
        const target = item.reviews.find(
          (review) => review.id === reviewId && review.mine
        )
        if (!target) return item
        return {
          ...item,
          ...rateReplace(item, target.stars, input.stars),
          reviews: item.reviews.map((review) =>
            review.id === reviewId
              ? { ...review, stars: input.stars, body: input.body, edited: true }
              : review
          ),
        }
      })
    )
    toast.success("评价已更新", {
      description:
        input.stars === mod.reviews.find((r) => r.id === reviewId)?.stars
          ? "文字已更新，平均分不受影响。"
          : "星级已更新，平均分同步重算。",
    })
  }

  /** 只能删自己写的那条；删掉后自己那一票也撤回 */
  function deleteReview(mod: ModEntry, reviewId: string) {
    setMods((prev) =>
      prev.map((item) => {
        if (item.id !== mod.id) return item
        const target = item.reviews.find(
          (review) => review.id === reviewId && review.mine
        )
        if (!target) return item
        return {
          ...item,
          ...rateRemove(item, target.stars),
          reviews: item.reviews.filter((review) => review.id !== reviewId),
        }
      })
    )
    toast("评价已删除", {
      description: "你投的那一票已撤回，评分人数与平均分同步回退。",
    })
  }

  /** 创建草稿：先落在本地模组库，提交审核前都还在自己手上 */
  function createMod(input: NewModInput) {
    const created = draftMod(input, todayISO(), authorName)
    setMods((prev) => [created, ...prev])
    setTab("mine")
    // 建完就停在草稿里没有下文，提示里直接给一步「提交审核」，不用再去卡片上找
    toast.success(`模组「${input.name}」已创建`, {
      description: `骨架已写入 mods/${input.id}/ · ${input.version}，接着可以提交上架审核。`,
      action: { label: "提交审核", onClick: () => openSubmit(created.id) },
    })
  }

  /** 表单提交：有目标就是改信息，没有就是新建 */
  function saveMod(input: NewModInput) {
    const target = formTargetId
      ? mods.find((mod) => mod.id === formTargetId)
      : null

    if (!target) {
      createMod(input)
      return
    }

    setMods((prev) =>
      prev.map((item) =>
        item.id === target.id ? applyModPatch(item, input) : item
      )
    )
    toast.success(`「${input.name}」信息已更新`, {
      description: `${input.id} · ${input.cat} 分类`,
    })
  }

  /** 还没提交过的草稿可以直接删掉，上架之后就得走卸载了 */
  function deleteDraft(mod: ModEntry) {
    setMods((prev) => prev.filter((item) => item.id !== mod.id))
    setDetailId(null)
    toast("草稿已删除", {
      description: `「${mod.name}」已从本地模组库移除。`,
    })
  }

  /** 本地演示：人工审核那一步直接出结果，通过就上架 */
  function resolveReview(mod: ModEntry, result: ReviewResult) {
    setMods((prev) =>
      prev.map((item) =>
        item.id === mod.id ? applyReviewResult(item, result) : item
      )
    )
    if (result === "approved") {
      toast.success(`「${mod.name}」已通过审核`, {
        description: "已上架到模组市场，其他玩家现在可以安装了。",
      })
    } else {
      toast.error(`「${mod.name}」审核未通过`, {
        description: "按驳回原因改完后可以重新提交。",
      })
    }
  }

  function openSubmit(id: string | null) {
    // 从卡片或创建成功的提示进来时目标已经确定，只有工具栏那个入口需要先看看有没有可提交的
    if (id === null) {
      const pool = mods.filter((mod) => mod.mine && mod.review !== "reviewing")
      if (pool.length === 0) {
        toast("没有可提交的模组", {
          description: "本地创建的模组都已在审核队列里。",
        })
        return
      }
    }
    setSubmitTarget(id)
    setSubmitOpen(true)
  }

  const submitCandidates = useMemo(
    () => mods.filter((mod) => mod.mine && mod.review !== "reviewing"),
    [mods]
  )

  /** 发布前置还差什么（署名、GitHub 令牌）：入口上的黄点与提交弹窗都看它 */
  const pendingBlockers = publishBlockers({
    credential,
    name: authorName,
    now: Date.now(),
  })

  const detailMod = mods.find((mod) => mod.id === detailId) ?? null
  const detailTask = downloads.tasks.find((task) => task.modId === detailId)

  const handleSubmitted: ModSubmitDialogProps["onSubmitted"] = (
    mod,
    payload
  ) => submitMod(mod, payload)

  /**
   * 空列表时那句解释要跟真正挡路的筛选项对得上——几个筛选一起用时，
   * 指着一个没问题的条件让用户去改，比不说还糟。
   * 页签自带的那几档（只看已安装、待回复、评分分档）在下面按页签说。
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
    return "试试更换关键词、分类或标签。"
  })()

  return (
    <div className="space-y-4">
      <SectionHeading
        title="模组市场"
        sub="// MOD MARKETPLACE · MANIFEST SCHEMA 3"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            本地演示数据 · 下载与审核均为模拟
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
              {serverRoot || "（空）"}
            </span>
            ，模组骨架会建到这个目录下，服务端加载不到；主服务器依赖与市场服务二进制也已经找不到了。
          </span>
          <Button size="sm" variant="outline" onClick={() => onNavigate("config")}>
            去改根目录
          </Button>
        </div>
      )}

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
            提交模组
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
          <Button
            variant="ghost"
            onClick={() =>
              toast("已打开模组制作规范", {
                description: "MANIFEST schema 3 · 含钩子白名单与上架条款",
              })
            }
          >
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
        <ReviewBanner mods={reviewing} onResolve={resolveReview} />
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
          label="审核中"
          value={reviewing.length}
          unit="个"
          tone={reviewing.length ? "warning" : "foreground"}
          delta={
            reviewing.length
              ? `通常 ${REVIEW_WINDOW_MINUTES} 分钟出结果`
              : "暂无待审模组"
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
        onRefresh={() =>
          toast.success("模组列表已刷新", {
            description: `已扫描 mods 目录 · ${mods.length} 个模组`,
          })
        }
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
              onToggle={(next) => toggleMod(mod, next)}
              onInstall={() => installMod(mod)}
              onUpdate={() => updateMod(mod)}
              onDetail={() => setDetailId(mod.id)}
              onSubmit={() => openSubmit(mod.id)}
              onUninstall={() => uninstallMod(mod)}
              onCancelDownload={() => downloads.cancel(mod.id)}
              onResolveConflict={disableMod}
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
          if (detailMod) uninstallMod(detailMod)
          setDetailId(null)
        }}
        onEdit={() => {
          const id = detailId
          setDetailId(null)
          setFormTargetId(id)
          setFormOpen(true)
        }}
        onDeleteDraft={() => detailMod && deleteDraft(detailMod)}
        onSubmit={() => {
          const id = detailId
          setDetailId(null)
          openSubmit(id)
        }}
        onCancelDownload={() => detailId && downloads.cancel(detailId)}
        onResolveConflict={disableMod}
        onAddReview={(input) => detailMod && addReview(detailMod, input)}
        onReply={(reviewId, body) =>
          detailMod && replyToReview(detailMod, reviewId, body)
        }
        onEditReply={(reviewId, body) =>
          detailMod && editReply(detailMod, reviewId, body)
        }
        onDeleteReply={(reviewId) =>
          detailMod && deleteReply(detailMod, reviewId)
        }
        onEditReview={(reviewId, input) =>
          detailMod && editReview(detailMod, reviewId, input)
        }
        onDeleteReview={(reviewId) =>
          detailMod && deleteReview(detailMod, reviewId)
        }
      />

      <ModFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mod={formTargetId ? (mods.find((mod) => mod.id === formTargetId) ?? null) : null}
        existingIds={mods.map((mod) => mod.id)}
        onSubmit={saveMod}
        serverRoot={serverRoot}
      />

      <ModAuthorDialog
        open={authorOpen}
        onOpenChange={setAuthorOpen}
        name={authorName}
        onSaveName={setAuthorName}
        credential={credential}
        onSaveCredential={setCredential}
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
        onSubmitted={handleSubmitted}
      />
    </div>
  )
}
