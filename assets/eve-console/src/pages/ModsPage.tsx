import { useMemo, useState } from "react"
import { toast } from "sonner"
import { PackagePlus, Upload, UserRound } from "lucide-react"
import { useEngine } from "@/lib/engine"
import type { ModEntry } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ModStats } from "@/components/mods/ModStats"
import { ModToolbar, type ModFilters } from "@/components/mods/ModToolbar"
import { ModConflictBanner, type ModConflictPair } from "@/components/mods/ModConflictBanner"
import { ModList } from "@/components/mods/ModList"
import { ModLoadOrderPanel } from "@/components/mods/ModLoadOrderPanel"
import { MarketStats } from "@/components/mods/MarketStats"
import { MarketToolbar, type MarketFilters } from "@/components/mods/MarketToolbar"
import { MarketInstallQueue } from "@/components/mods/MarketInstallQueue"
import { MarketGrid } from "@/components/mods/MarketGrid"
import { MarketDetailDialog } from "@/components/mods/MarketDetailDialog"
import { ModSubmissionsPanel } from "@/components/mods/ModSubmissionsPanel"
import { MyModStats } from "@/components/mods/MyModStats"
import { MyModList } from "@/components/mods/MyModList"
import { SubmitModDialog, type SubmitModPrefill } from "@/components/mods/SubmitModDialog"
import { CreateModDialog } from "@/components/mods/CreateModDialog"
import { EditModDialog } from "@/components/mods/EditModDialog"
import { AuthorDialog } from "@/components/mods/AuthorDialog"
import { downloadCsv } from "@/lib/csv"
import type { MarketItem, MyModItem } from "@/lib/market"
import { MY_MOD_CSV_HEADERS, buildMarketItems, buildMyMods, myModCsvRows } from "@/lib/market"
import type { ModSubmission } from "@/lib/types"

/** 下架确认需要的信息：两个列表页（我创建的 / 模组市场）都能凑出来。 */
interface DelistTarget {
  id: string
  name: string
  version: string
  /** 本地已装版本，没装就是 undefined。 */
  installedVersion?: string
  /** 当前是不是已经下架了 —— 是的话这一下是重新上架。 */
  delisted: boolean
}

const INITIAL_FILTERS: ModFilters = { query: "", category: "ALL" }
const INITIAL_MARKET_FILTERS: MarketFilters = {
  query: "",
  category: "ALL",
  sort: "hot",
  onlyAvailable: false,
}

export function ModsPage() {
  const {
    mods,
    market,
    installQueue,
    submissions,
    now,
    toggleMod,
    moveMod,
    createMod,
    installMod,
    updateMod,
    uninstallMod,
    cancelInstall,
    submitMod,
    withdrawSubmission,
    author,
    updateOwnMod,
    delistMod,
    relistMod,
    rateMod,
    clearRating,
    saveReview,
    clearReview,
  } = useEngine()

  const [filters, setFilters] = useState<ModFilters>(INITIAL_FILTERS)
  const [marketFilters, setMarketFilters] = useState<MarketFilters>(INITIAL_MARKET_FILTERS)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<MarketItem | null>(null)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [authorOpen, setAuthorOpen] = useState(false)
  /** 正在改资料的那条市场条目。 */
  const [editId, setEditId] = useState<string | null>(null)
  /** 等着确认下架的条目。上架不用确认，下架要。 */
  const [pendingDelist, setPendingDelist] = useState<DelistTarget | null>(null)
  /** 把本地建好的模组提交上架时，带过去的资料与要沿用的 id。 */
  const [submitPrefill, setSubmitPrefill] = useState<{
    id: string
    draft: SubmitModPrefill
  } | null>(null)

  const patchFilters = (patch: Partial<ModFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }))
  const patchMarketFilters = (patch: Partial<MarketFilters>) =>
    setMarketFilters((prev) => ({ ...prev, ...patch }))

  /** 全量按加载顺序升序，移动 / 首尾判断都以它为基准。 */
  const sortedMods = useMemo(() => [...mods].sort((a, b) => a.order - b.order), [mods])

  const indexById = useMemo(
    () => new Map(sortedMods.map((mod, index) => [mod.id, index])),
    [sortedMods],
  )

  /**
   * 冲突判定：模组 A 已启用，且 A.conflicts 命中另一个同样已启用的模组 B，
   * 则 A 与 B 都计入冲突（即使只有一方声明了互斥）。
   */
  const { conflictMap, conflictPairs } = useMemo(() => {
    const byId = new Map(mods.map((mod) => [mod.id, mod]))
    const enabledIds = new Set(mods.filter((mod) => mod.enabled).map((mod) => mod.id))
    const map = new Map<string, string[]>()
    const pairs: ModConflictPair[] = []
    const seenPairs = new Set<string>()

    const addName = (id: string, otherName: string) => {
      const names = map.get(id) ?? []
      if (!names.includes(otherName)) names.push(otherName)
      map.set(id, names)
    }

    sortedMods.forEach((mod) => {
      if (!mod.enabled) return
      mod.conflicts.forEach((otherId) => {
        if (otherId === mod.id || !enabledIds.has(otherId)) return
        const other = byId.get(otherId)
        if (!other) return
        addName(mod.id, other.name)
        addName(otherId, mod.name)
        const pairKey = [mod.id, otherId].sort().join("|")
        if (seenPairs.has(pairKey)) return
        seenPairs.add(pairKey)
        pairs.push({ a: mod, b: other })
      })
    })

    return { conflictMap: map, conflictPairs: pairs }
  }, [mods, sortedMods])

  const conflictModCount = conflictMap.size

  const visibleMods = useMemo(() => {
    const needle = filters.query.trim().toLowerCase()
    return sortedMods.filter((mod) => {
      if (filters.category !== "ALL" && mod.category !== filters.category) return false
      if (needle === "") return true
      return [mod.name, mod.author, mod.desc].join(" ").toLowerCase().includes(needle)
    })
  }, [sortedMods, filters])

  const enabledMods = useMemo(() => sortedMods.filter((mod) => mod.enabled), [sortedMods])

  const pendingEnable = visibleMods.filter((mod) => !mod.enabled).length
  const pendingDisable = visibleMods.filter((mod) => mod.enabled).length

  const handleToggle = (mod: ModEntry) => {
    // 启用前先提示会跟谁撞上，避免用户开了才发现冲突。
    if (!mod.enabled) {
      const enabledIds = new Set(mods.filter((m) => m.enabled).map((m) => m.id))
      const clashNames = mod.conflicts
        .filter((otherId) => enabledIds.has(otherId))
        .map((otherId) => mods.find((m) => m.id === otherId)?.name ?? otherId)
      if (clashNames.length > 0) {
        toast.warning(`「${mod.name}」与 ${clashNames.join("、")} 存在冲突`)
      }
    }
    toggleMod(mod.id)
  }

  /** toggleMod 是取反，所以只对状态不符的条目调用。 */
  const handleBulk = (targetEnabled: boolean) => {
    const targets = visibleMods.filter((mod) => mod.enabled !== targetEnabled)
    if (targets.length === 0) {
      toast.info(targetEnabled ? "当前列表已全部启用" : "当前列表已全部停用")
      return
    }
    targets.forEach((mod) => toggleMod(mod.id))
    toast[targetEnabled ? "success" : "warning"](
      targetEnabled ? `已启用 ${targets.length} 个模组` : `已停用 ${targets.length} 个模组`,
    )
  }

  /* ---------------- 模组市场 ---------------- */

  const marketItems = useMemo<MarketItem[]>(
    () =>
      buildMarketItems({
        market,
        mods,
        installQueue,
        submissions,
        authorId: author.id,
      }),
    [market, mods, installQueue, submissions, author.id],
  )

  const visibleMarket = useMemo(() => {
    const needle = marketFilters.query.trim().toLowerCase()
    const list = marketItems.filter((item) => {
      if (marketFilters.onlyAvailable && item.status === "installed") return false
      if (marketFilters.category !== "ALL" && item.entry.category !== marketFilters.category) {
        return false
      }
      if (needle === "") return true
      const haystack = [
        item.entry.name,
        item.entry.author,
        item.entry.desc,
        item.entry.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(needle)
    })

    const sorted = [...list]
    sorted.sort((a, b) => {
      // 自己提交的条目钉在最前面，别被排序冲散。
      const aPinned = a.status === "reviewing"
      const bPinned = b.status === "reviewing"
      if (aPinned !== bPinned) return aPinned ? -1 : 1

      switch (marketFilters.sort) {
        case "rating":
          return b.entry.rating - a.entry.rating || b.entry.ratingCount - a.entry.ratingCount
        case "recent":
          return b.entry.updatedAt - a.entry.updatedAt
        case "size":
          return a.entry.sizeMb - b.entry.sizeMb
        default:
          return b.entry.downloads - a.entry.downloads
      }
    })
    return sorted
  }, [marketItems, marketFilters])

  /* 作者自己的作品清单：本地建的、在审的、上架的、下架的都在这一页。 */
  const myMods = useMemo<MyModItem[]>(
    () => buildMyMods({ mods, market, submissions, authorId: author.id }),
    [mods, market, submissions, author.id],
  )
  const myReviewingCount = myMods.filter((item) => item.status === "reviewing").length

  const actionableCount = visibleMarket.filter(
    (item) => item.status === "available" || item.status === "update",
  ).length
  const updatableCount = marketItems.filter((item) => item.status === "update").length
  const pendingSubmissions = submissions.filter((item) => item.status !== "published").length

  const detailItem = marketItems.find((item) => item.entry.id === detailId) ?? null
  const editEntry = market.find((entry) => entry.id === editId) ?? null

  const handleInstall = (item: MarketItem) => {
    installMod(item.entry.id)
    if (item.clashes.length > 0) {
      toast.warning(`「${item.entry.name}」与已启用的 ${item.clashes.join("、")} 冲突`, {
        description: "已加入下载队列，装好后先别急着启用",
      })
      return
    }
    toast.success(`开始下载「${item.entry.name}」`, {
      description: `${item.entry.sizeMb} MB · 完成后自动写入模组清单`,
    })
  }

  const handleUpdate = (item: MarketItem) => {
    updateMod(item.entry.id)
    toast.success(`正在更新「${item.entry.name}」`, {
      description: `${item.installed?.version ?? "本地版本"} → ${item.entry.version}`,
    })
  }

  const handleCancel = (item: MarketItem) => {
    cancelInstall(item.entry.id)
    toast.info(`已取消「${item.entry.name}」的下载`)
  }

  const handleWithdraw = (id: string, name: string) => {
    withdrawSubmission(id)
    toast.info(`已撤回「${name}」的提交`)
  }

  const handleWithdrawSubmission = (submission: ModSubmission) => {
    withdrawSubmission(submission.id)
    toast.info(`已撤回「${submission.name}」的提交`)
  }

  /* 下架要过一道确认：这是对外的动作，点了别人就搜不到了。上架是往回走，直接执行。 */
  const handleToggleListing = (target: DelistTarget) => {
    if (target.delisted) {
      relistMod(target.id)
      toast.success(`「${target.name}」已重新上架`, {
        description: "市场目录里又能看到它了，下载量和评分都还在",
      })
      return
    }
    setPendingDelist(target)
  }

  const confirmDelist = () => {
    if (!pendingDelist) return
    delistMod(pendingDelist.id)
    toast.warning(`已下架「${pendingDelist.name}」`, {
      description: "市场里不再展示，已经装了的人不受影响",
    })
    setPendingDelist(null)
  }

  /* 打分 / 改分 / 收回：三件事在引擎里是同一个动作，这里只负责说一声。 */
  const handleRate = (id: string, name: string, stars: number) => {
    const previous = market.find((entry) => entry.id === id)?.myRating
    rateMod(id, stars)
    toast.success(`给「${name}」打了 ${stars} 分`, {
      description:
        previous === undefined
          ? "已经计入它的平均分"
          : previous === stars
            ? "跟原来一样，分数没变"
            : `原来打的是 ${previous} 分，已经改成 ${stars} 分`,
    })
  }

  const handleClearRating = (id: string, name: string) => {
    const hadReview = market.find((entry) => entry.id === id)?.myReview !== undefined
    clearRating(id)
    toast.info(`已收回对「${name}」的评分`, {
      description: hadReview
        ? "平均分回到别人打出来的样子，你写的那条评价也一并撤了"
        : "它的平均分回到别人打出来的样子",
    })
  }

  const handleSaveReview = (id: string, name: string, text: string) => {
    saveReview(id, text)
    toast.success(`已发布对「${name}」的评价`, { description: "可以在详情页最下面看到" })
  }

  const handleClearReview = (id: string, name: string) => {
    clearReview(id)
    toast.info(`已删除对「${name}」的评价`, { description: "打的分还留着" })
  }

  /* 导出清单：给自己留个账，也方便搬到别处。 */
  const handleExportMyMods = () => {
    if (myMods.length === 0) {
      toast.warning("还没有创建过模组，没有可导出的内容")
      return
    }
    downloadCsv("eve-my-mods.csv", MY_MOD_CSV_HEADERS, myModCsvRows(myMods))
    toast.success(`已导出 ${myMods.length} 个模组`)
  }

  /* 本地建好的模组要上架：把已经填过的资料带进表单，id 沿用，过审后不会多出一个副本。 */
  const handleSubmitOwn = (item: MyModItem) => {
    setSubmitPrefill({
      id: item.id,
      draft: {
        name: item.name,
        version: item.version,
        category: item.category,
        sizeMb: item.sizeMb,
        desc: item.desc,
        conflicts: item.local?.conflicts ?? [],
      },
    })
  }

  const confirmUninstall = () => {
    if (!pendingUninstall) return
    uninstallMod(pendingUninstall.entry.id)
    toast.warning(`已卸载「${pendingUninstall.entry.name}」`, {
      description: "已从模组清单移除，磁盘上的文件保留",
    })
    setPendingUninstall(null)
  }

  return (
    <Tabs defaultValue="installed" className="flex flex-col gap-4">
      {/* 两个动作按钮就挂在「模组市场」标签旁边：无论停在哪个页签都能随手新建或投稿。 */}
      <div className="flex flex-wrap items-center gap-2">
        <TabsList>
          <TabsTrigger value="installed">已安装 · {mods.length}</TabsTrigger>
          <TabsTrigger value="mine">
            我创建的 · {myMods.length}
            {myReviewingCount > 0 ? (
              <span className="ml-1 rounded-sm bg-primary/20 px-1 py-0 font-mono text-[10px] text-primary">
                {myReviewingCount} 审核中
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="market">
            模组市场 · {market.length}
            {updatableCount > 0 ? (
              <span className="ml-1 rounded-sm bg-amber-500/20 px-1 py-0 font-mono text-[10px] text-amber-300">
                {updatableCount} 可更新
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <Button variant="primary" size="md" onClick={() => setSubmitOpen(true)}>
          <Upload className="h-3.5 w-3.5" />
          提交模组
          {pendingSubmissions > 0 ? (
            <span className="rounded-sm bg-primary-foreground/20 px-1 font-mono text-[10px] tabular-nums">
              {pendingSubmissions} 审核中
            </span>
          ) : null}
        </Button>

        <Button variant="outline" size="md" onClick={() => setCreateOpen(true)}>
          <PackagePlus className="h-3.5 w-3.5" />
          创建模组
        </Button>

        {/* 作者身份挂在动作区末尾：市场里那些「我的」角标就是按它认出来的。 */}
        <Button variant="ghost" size="md" onClick={() => setAuthorOpen(true)}>
          <UserRound className="h-3.5 w-3.5" />
          {author.name}
        </Button>
      </div>

      <TabsContent value="installed" className="flex flex-col gap-4">
        <ModStats
          mods={mods}
          conflictCount={conflictPairs.length}
          conflictModCount={conflictModCount}
        />

        <ModConflictBanner pairs={conflictPairs} />

        <ModToolbar
          filters={filters}
          onFiltersChange={patchFilters}
          pendingEnable={pendingEnable}
          pendingDisable={pendingDisable}
          resultCount={visibleMods.length}
          totalCount={mods.length}
          onEnableAll={() => handleBulk(true)}
          onDisableAll={() => handleBulk(false)}
        />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <ModList
            mods={visibleMods}
            totalCount={mods.length}
            conflictMap={conflictMap}
            indexById={indexById}
            onToggle={handleToggle}
            onMove={(mod, dir) => moveMod(mod.id, dir)}
          />
          <div className="xl:sticky xl:top-0 xl:self-start">
            <ModLoadOrderPanel mods={enabledMods} />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="mine" className="flex flex-col gap-4">
        <MyModStats items={myMods} />

        <MyModList
          items={myMods}
          now={now}
          onCreate={() => setCreateOpen(true)}
          onSubmit={handleSubmitOwn}
          onEdit={(item) => setEditId(item.id)}
          onToggleListing={(item) =>
            handleToggleListing({
              id: item.id,
              name: item.name,
              version: item.version,
              installedVersion: item.local?.version,
              delisted: item.status === "delisted",
            })
          }
          onWithdraw={(item) => handleWithdraw(item.id, item.name)}
          onOpenDetail={(item) => setDetailId(item.id)}
          onExport={handleExportMyMods}
        />
      </TabsContent>

      <TabsContent value="market" className="flex flex-col gap-4">
        <MarketStats items={marketItems} />

        <MarketInstallQueue tasks={installQueue} market={market} onCancel={cancelInstall} />

        <MarketToolbar
          filters={marketFilters}
          onFiltersChange={patchMarketFilters}
          resultCount={visibleMarket.length}
          totalCount={market.length}
          actionableCount={actionableCount}
        />

        <ModSubmissionsPanel
          submissions={submissions}
          now={now}
          onWithdraw={handleWithdrawSubmission}
        />

        <MarketGrid
          items={visibleMarket}
          now={now}
          totalCount={market.length}
          onInstall={handleInstall}
          onUpdate={handleUpdate}
          onUninstall={setPendingUninstall}
          onCancel={handleCancel}
          onWithdraw={(item) => handleWithdraw(item.entry.id, item.entry.name)}
          onOpenDetail={(item) => setDetailId(item.entry.id)}
          onEdit={(item) => setEditId(item.entry.id)}
          onToggleListing={(item) =>
            handleToggleListing({
              id: item.entry.id,
              name: item.entry.name,
              version: item.entry.version,
              installedVersion: item.installed?.version,
              delisted: item.entry.delisted === true,
            })
          }
        />
      </TabsContent>

      <MarketDetailDialog
        item={detailItem}
        now={now}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
        onInstall={() => detailItem && handleInstall(detailItem)}
        onUpdate={() => detailItem && handleUpdate(detailItem)}
        onUninstall={() => {
          if (!detailItem) return
          // 先收起详情再弹确认，避免两层遮罩叠在一起抢焦点。
          setDetailId(null)
          setPendingUninstall(detailItem)
        }}
        onWithdraw={() => {
          if (!detailItem) return
          setDetailId(null)
          handleWithdraw(detailItem.entry.id, detailItem.entry.name)
        }}
        onEdit={() => {
          if (!detailItem) return
          // 先收起详情再开编辑，避免两层遮罩叠在一起抢焦点。
          setDetailId(null)
          setEditId(detailItem.entry.id)
        }}
        onToggleListing={() => {
          if (!detailItem) return
          setDetailId(null)
          handleToggleListing({
            id: detailItem.entry.id,
            name: detailItem.entry.name,
            version: detailItem.entry.version,
            installedVersion: detailItem.installed?.version,
            delisted: detailItem.entry.delisted === true,
          })
        }}
        onRate={(stars) => {
          if (!detailItem) return
          handleRate(detailItem.entry.id, detailItem.entry.name, stars)
        }}
        onClearRating={() => {
          if (!detailItem) return
          handleClearRating(detailItem.entry.id, detailItem.entry.name)
        }}
        onSaveReview={(text) => {
          if (!detailItem) return
          handleSaveReview(detailItem.entry.id, detailItem.entry.name, text)
        }}
        onClearReview={() => {
          if (!detailItem) return
          handleClearReview(detailItem.entry.id, detailItem.entry.name)
        }}
        authorName={author.name}
      />

      <SubmitModDialog
        open={submitOpen || submitPrefill !== null}
        onOpenChange={(open) => {
          if (open) return
          setSubmitOpen(false)
          setSubmitPrefill(null)
        }}
        market={market}
        authorName={author.name}
        prefill={submitPrefill?.draft}
        onSubmit={(draft) => {
          // 从本地模组发起的，沿用它的 id：过审后市场条目和本地清单是同一条。
          if (submitPrefill) submitMod(draft, submitPrefill.id)
          else submitMod(draft)
        }}
      />

      <CreateModDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        market={market}
        authorName={author.name}
        onCreate={createMod}
      />

      <EditModDialog
        open={editId !== null}
        onOpenChange={(open) => {
          if (!open) setEditId(null)
        }}
        entry={editEntry}
        onSubmit={updateOwnMod}
      />

      <AuthorDialog open={authorOpen} onOpenChange={setAuthorOpen} />

      <Modal
        open={pendingDelist !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelist(null)
        }}
        title="下架模组"
        description="把自己发的条目从市场目录里撤下来。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelist(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmDelist}>
              确认下架
            </Button>
          </>
        }
      >
        {pendingDelist ? (
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              即将下架{" "}
              <span className="font-semibold text-foreground">{pendingDelist.name}</span>（
              {pendingDelist.version}）。
            </p>
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed">
              <p>· 市场目录里不再展示，别人搜不到也装不了。</p>
              <p>
                · 已经装了的人本地副本保留
                {pendingDelist.installedVersion
                  ? `（你本地这份 ${pendingDelist.installedVersion} 也在）`
                  : ""}
                ，但不会再收到更新提示。
              </p>
              <p>· 随时可以重新上架，下载量、评分和精选标记都不会清零。</p>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUninstall(null)
        }}
        title="卸载模组"
        description="从本地模组清单里移除这个条目。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingUninstall(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmUninstall}>
              确认卸载
            </Button>
          </>
        }
      >
        {pendingUninstall ? (
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              即将卸载{" "}
              <span className="font-semibold text-foreground">{pendingUninstall.entry.name}</span>
              （{pendingUninstall.installed?.version ?? pendingUninstall.entry.version}）。
            </p>
            <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed">
              卸载只会把它从模组清单移除，随时可以在市场里重新装回来。当前状态：
              <span className="text-foreground">
                {pendingUninstall.installed?.enabled ? "已启用" : "已停用"}
              </span>
              。
            </p>
          </div>
        ) : null}
      </Modal>
    </Tabs>
  )
}
