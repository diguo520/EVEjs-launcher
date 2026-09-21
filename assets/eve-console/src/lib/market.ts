import { formatDateTime } from "./format"
import type {
  InstallTask,
  MarketMod,
  ModEntry,
  ModReview,
  ModSubmission,
  ModVersionEntry,
} from "./types"

/** 市场条目在页面里的完整状态：目录本身 + 本地装了什么 + 正在跑什么。 */
export interface MarketItem {
  entry: MarketMod
  /** 本地已装条目，未安装时为 undefined。 */
  installed?: ModEntry
  /** installed 表示已装且是最新版；update 表示本地版本落后；reviewing 是自己在审的提交。 */
  status: "available" | "installed" | "update" | "reviewing"
  /** 下载进度，或审核进度（status 为 reviewing 时），0–100；没有任务时为 undefined。 */
  progress?: number
  /** 与本地已启用模组撞车的名字，非空即需要提醒。 */
  clashes: string[]
  /** 本机作者自己发的条目。认的是作者标识，跟署名写了什么无关。 */
  mine: boolean
  /** 审核中的那条提交是「新上架」还是「给已有条目提新版」。 */
  reviewKind?: "new" | "update"
}

export interface MarketViewInput {
  market: MarketMod[]
  mods: ModEntry[]
  installQueue: InstallTask[]
  submissions: ModSubmission[]
  /** 本机作者标识，用来认「哪些是自己发的」。 */
  authorId: string
}

/**
 * 把市场目录、本地清单、下载队列与待审提交对齐成卡片能直接用的形态。
 *
 * 纯函数：所有判断都摆在一处，页面只负责渲染。作者更新自己已上架的模组时，
 * 提交与目录条目共用同一个 id —— 那种提交不再另起一张卡，而是把原卡改成「审核中」。
 */
export function buildMarketItems({
  market,
  mods,
  installQueue,
  submissions,
  authorId,
}: MarketViewInput): MarketItem[] {
  const localById = new Map(mods.map((mod) => [mod.id, mod]))
  const enabledById = new Map(mods.filter((mod) => mod.enabled).map((mod) => [mod.id, mod]))
  const taskById = new Map(installQueue.map((task) => [task.id, task]))
  const submissionById = new Map(submissions.map((item) => [item.id, item]))
  const listedIds = new Set(market.map((entry) => entry.id))

  /* 认人靠作者标识，不靠署名 —— 署名是个自由文本，填成谁都行。 */
  const isMine = (id?: string) => id !== undefined && id === authorId

  /* 下架的条目对别人等于不存在；作者本人还看得见，好把「重新上架」的入口留住。 */
  const listed = market
    .filter((entry) => !entry.delisted || isMine(entry.authorId))
    .map((entry): MarketItem => {
      const installed = localById.get(entry.id)
      const task = taskById.get(entry.id)
      const pending = submissionById.get(entry.id)
      const reviewing = pending !== undefined && pending.status !== "published"
      return {
        entry,
        installed,
        status: reviewing
          ? "reviewing"
          : !installed
            ? "available"
            : installed.version === entry.version
              ? "installed"
              : "update",
        progress: reviewing ? pending.progress : task?.progress,
        clashes: entry.conflicts
          .filter((id) => enabledById.has(id))
          .map((id) => enabledById.get(id)?.name ?? id),
        mine: isMine(entry.authorId),
        reviewKind: reviewing ? "update" : undefined,
      }
    })

  /* 还没上架的提交按临时条目混进目录；更新已有条目的已经并进上面那一轮了。 */
  const pending = submissions
    .filter((item) => item.status !== "published" && !listedIds.has(item.id))
    .map((item): MarketItem => ({
      entry: marketEntryFromSubmission(item),
      status: "reviewing",
      progress: item.progress,
      clashes: [],
      mine: isMine(item.authorId),
      reviewKind: "new",
    }))

  return [...listed, ...pending]
}

/** 作者视角下自己名下的一条模组：本地建的、在审的、上架的、下架的都收在这一处。 */
export interface MyModItem {
  id: string
  name: string
  author: string
  version: string
  category: string
  desc: string
  sizeMb: number
  /** local 是只在本地、还没提交过；delisted 是上架过又被作者自己撤下来的。 */
  status: "local" | "reviewing" | "listed" | "delisted"
  /** 审核进度 0–100，只有 reviewing 时有。 */
  progress?: number
  /** 在审的这条是「新上架」还是「给已有条目提新版」。 */
  reviewKind?: "new" | "update"
  /** 市场侧的数据；一次都没上架过就没有。 */
  entry?: MarketMod
  /** 本地清单里有它（自己建的，或者装过）。 */
  local?: ModEntry
  /** 市场条目的更新时间；纯本地条目没有时间，排到最后。 */
  updatedAt: number
}

export interface MyModsInput {
  mods: ModEntry[]
  market: MarketMod[]
  submissions: ModSubmission[]
  /** 本机作者标识。只认它，署名写成什么都不影响归属。 */
  authorId: string
}

/** 需要作者处理的排前面：在审 → 在架 → 下架 → 还没上架。 */
const MY_STATUS_RANK: Record<MyModItem["status"], number> = {
  reviewing: 0,
  listed: 1,
  delisted: 2,
  local: 3,
}

/**
 * 攒出「我创建的」那一页：本地建好的、正在审的、已经上架的、自己下架的，
 * 全按作者标识归拢到一处，作者改资料、提版本、上下架都只用看这一个列表。
 *
 * 纯函数，和 buildMarketItems 一样只做判断，页面负责渲染。
 */
export function buildMyMods({ mods, market, submissions, authorId }: MyModsInput): MyModItem[] {
  const localById = new Map(mods.map((mod) => [mod.id, mod]))
  const submissionById = new Map(submissions.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const items: MyModItem[] = []

  const push = (item: MyModItem) => {
    seen.add(item.id)
    items.push(item)
  }

  /* 市场侧先来：上架的、下架的、以及挂在已有条目上的在审更新都在这一轮。 */
  market.forEach((entry) => {
    if (entry.authorId !== authorId) return
    const local = localById.get(entry.id)
    const pending = submissionById.get(entry.id)
    const reviewing = pending !== undefined && pending.status !== "published"
    push({
      id: entry.id,
      name: entry.name,
      author: entry.author,
      version: entry.version,
      category: entry.category,
      desc: entry.desc,
      sizeMb: entry.sizeMb,
      status: reviewing ? "reviewing" : entry.delisted ? "delisted" : "listed",
      progress: reviewing ? pending.progress : undefined,
      reviewKind: reviewing ? "update" : undefined,
      entry,
      local,
      updatedAt: entry.updatedAt,
    })
  })

  /* 还没上架的提交：本地建好后勾了提交，或者单独投的一条新条目。 */
  submissions.forEach((item) => {
    if (item.authorId !== authorId || item.status === "published" || seen.has(item.id)) return
    const local = localById.get(item.id)
    push({
      id: item.id,
      name: item.name,
      author: item.author,
      version: item.version,
      category: item.category,
      desc: item.desc,
      sizeMb: item.sizeMb,
      status: "reviewing",
      progress: item.progress,
      // 本地已经有同 id 的模组，说明这是在给自己建的东西提上架。
      reviewKind: local ? "update" : "new",
      local,
      updatedAt: item.submittedAt,
    })
  })

  /* 本地建好、一次都没提交过的。 */
  mods.forEach((mod) => {
    if (mod.authorId !== authorId || seen.has(mod.id)) return
    push({
      id: mod.id,
      name: mod.name,
      author: mod.author,
      version: mod.version,
      category: mod.category,
      desc: mod.desc,
      sizeMb: mod.sizeMb,
      status: "local",
      local: mod,
      updatedAt: 0,
    })
  })

  return items.sort((a, b) => {
    const rank = MY_STATUS_RANK[a.status] - MY_STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)
  })
}

/** 作者视角下每种状态的文案。列表角标和导出 CSV 共用一套，免得两处叫法不一样。 */
export const MY_STATUS_LABEL: Record<MyModItem["status"], string> = {
  local: "未上架",
  reviewing: "审核中",
  listed: "已上架",
  delisted: "已下架",
}

export const MY_MOD_CSV_HEADERS = [
  "名称",
  "署名",
  "版本",
  "分类",
  "状态",
  "体积(MB)",
  "下载量",
  "评分",
  "评分人数",
  "审核进度",
  "更新时间",
  "源码地址",
  "简介",
]

/** 我创建的清单 → CSV 行。下载量、评分这些只有上架过的才有，没上架就留空。 */
export function myModCsvRows(items: MyModItem[]): (string | number)[][] {
  return items.map((item) => {
    const entry = item.entry
    return [
      item.name,
      item.author,
      item.version,
      item.category,
      MY_STATUS_LABEL[item.status],
      item.sizeMb,
      entry?.downloads ?? "",
      entry && entry.ratingCount > 0 ? entry.rating.toFixed(1) : "",
      entry?.ratingCount ?? "",
      item.status === "reviewing" ? `${Math.round(item.progress ?? 0)}%` : "",
      entry ? formatDateTime(entry.updatedAt) : "",
      entry?.repo ?? "",
      item.desc,
    ]
  })
}

export interface MyModsSummary {
  total: number
  /** 上架过的（在架 + 已下架 + 在审但市场里已有条目）。 */
  published: number
  listed: number
  delisted: number
  reviewing: number
  /** 名下所有上架过的条目的累计下载量。 */
  downloads: number
  hottest?: { name: string; downloads: number }
  /** 按评分人数加权的平均分，一位小数；没人评过就是 0。 */
  rating: number
  ratingCount: number
}

/** 作者总览：名下有多少、被下载过多少次、评分怎么样、还有几条在审。 */
export function summarizeMyMods(items: MyModItem[]): MyModsSummary {
  let listed = 0
  let delisted = 0
  let reviewing = 0
  let published = 0
  let downloads = 0
  let ratingSum = 0
  let ratingCount = 0
  let hottest: MyModsSummary["hottest"]

  items.forEach((item) => {
    if (item.status === "listed") listed++
    else if (item.status === "delisted") delisted++
    else if (item.status === "reviewing") reviewing++

    const entry = item.entry
    if (!entry) return
    published++
    /* 下架过的下载量也是真发生过的，一并算进累计。 */
    downloads += entry.downloads
    ratingSum += entry.rating * entry.ratingCount
    ratingCount += entry.ratingCount
    if (!hottest || entry.downloads > hottest.downloads) {
      hottest = { name: entry.name, downloads: entry.downloads }
    }
  })

  return {
    total: items.length,
    published,
    listed,
    delisted,
    reviewing,
    downloads,
    hottest,
    rating: ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 10) / 10,
    ratingCount,
  }
}

/** 详情里的一条评价：内容照搬，只多一个「是不是自己写的」标记。 */
export interface ReviewView extends ModReview {
  mine: boolean
}

/**
 * 把别人的评价和本机自己写的那条拼成一列，自己的钉在最前面。
 *
 * 本机那条的作者名从当前作者档案取，不存进目录里 —— 改了署名之后，
 * 列表上跟着改，不会留一个谁也不认识的名字。星级也直接用 myRating，
 * 跟打分器是同一个数，不会出现「打 4 分、写着 5 分的评价」。
 */
export function buildReviews(entry: MarketMod, authorName: string): ReviewView[] {
  const mine: ReviewView[] = entry.myReview
    ? [
        {
          author: authorName,
          stars: entry.myRating ?? 0,
          text: entry.myReview.text,
          at: entry.myReview.at,
          mine: true,
        },
      ]
    : []
  return [...mine, ...(entry.reviews ?? []).map((review) => ({ ...review, mine: false }))]
}

/** 评价条数：别人的加上本机自己写的。列表角标和详情标题共用。 */
export function reviewCount(entry: MarketMod): number {
  return (entry.reviews?.length ?? 0) + (entry.myReview ? 1 : 0)
}

/** 审核进度 → 阶段文案。前段排队，过半转人工复核。 */
export function reviewStageLabel(progress: number): string {
  if (progress >= 100) return "已上架"
  if (progress >= 45) return "人工复核中"
  return "排队中"
}

/**
 * 把这一版追加到版本记录后面。
 *
 * 老条目还没有历史字段，先用它当前的版本号起个头 —— 不然第一次更新之后翻回去
 * 只剩新版一条，上一版发过什么就查不到了。版本号没变（只是改了资料）就覆盖最后
 * 一条，免得堆出一串同名版本。
 */
function appendVersion(
  previous: MarketMod | undefined,
  submission: ModSubmission,
): ModVersionEntry[] {
  if (!previous) {
    return [{ version: submission.version, changelog: "", at: submission.submittedAt }]
  }
  const base = previous.history ?? [
    { version: previous.version, changelog: previous.changelog ?? "", at: previous.updatedAt },
  ]
  const next: ModVersionEntry = {
    version: submission.version,
    changelog: submission.changelog?.trim() ?? "",
    at: Date.now(),
  }
  const last = base[base.length - 1]
  return last && last.version === next.version ? [...base.slice(0, -1), next] : [...base, next]
}

/**
 * 把一条提交转成市场目录项。审核中先用它渲染临时卡片，
 * 通过之后原样上架 —— 两个阶段看到的是同一份内容，不会出现「上架后描述变了」。
 *
 * 传 previous 表示这是「作者更新自己已上架的条目」：资料换成新的，
 * 下载量、评分、精选标记这些攒下来的东西得接着算，不能归零。
 */
export function marketEntryFromSubmission(
  submission: ModSubmission,
  previous?: MarketMod,
): MarketMod {
  return {
    history: appendVersion(previous, submission),
    id: submission.id,
    name: submission.name,
    author: submission.author,
    authorId: submission.authorId ?? previous?.authorId,
    version: submission.version,
    category: submission.category,
    sizeMb: submission.sizeMb,
    desc: submission.desc,
    readme: submission.readme,
    highlights: submission.highlights,
    conflicts: submission.conflicts,
    tags: submission.tags,
    // 新上架的条目还没有任何数据，卡片会按「新上架」渲染。
    downloads: previous?.downloads ?? 0,
    rating: previous?.rating ?? 0,
    ratingCount: previous?.ratingCount ?? 0,
    // 本机那一票跟着条目走，作者发新版不该把读者的评分洗掉。
    myRating: previous?.myRating,
    baseRating: previous?.baseRating,
    baseRatingCount: previous?.baseRatingCount,
    // 评价同理：作者发新版是作者的事，别人写过的话不该跟着消失。
    reviews: previous?.reviews,
    myReview: previous?.myReview,
    updatedAt: previous ? Date.now() : submission.submittedAt,
    featured: previous?.featured ?? false,
    requiresRestart: submission.requiresRestart,
    // 只有更新才带说明；新上架时保持空，详情里不会多出一块「本次更新」。
    changelog: submission.changelog,
    repo: submission.repo || previous?.repo,
    /* 下架状态跟着条目走：作者改完资料过审之后，它应该还是下架的，
       不会因为一次编辑就悄悄重新出现在别人的市场里。 */
    delisted: previous?.delisted,
  }
}
