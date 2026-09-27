/**
 * 模组页的纯逻辑：冲突判定、审核读数、市场筛选、版本号推导。
 * 与 React 无关，方便单独验证；组件只负责渲染。
 */
import {
  GAME_VERSIONS,
  MOD_AUTHOR,
  type ModEntry,
  type ModReview,
  type ModReviewState,
} from "@/lib/mock"

/* ---------------- 分类与筛选 ---------------- */

/** 模组分类白名单（数据源里的 cat 取值） */
export const MOD_CATEGORIES = ["玩法", "经济", "AI", "画面", "工具"] as const

/** 分类筛选的「全部」哨兵值 */
export const ALL_CATEGORY = "all"

/* ---------------- 建骨架用的模板 ---------------- */

/** 创建模组时可选的骨架模板 */
export interface ModTemplate {
  id: string
  name: string
  /** 模板包体积，选之前先知道要下多少东西 */
  size: string
  /** 一句话说明这个模板建出来能干什么 */
  desc: string
}

export const MOD_TEMPLATES: ModTemplate[] = [
  {
    id: "blank",
    name: "空白模组",
    size: "2 MB",
    desc: "只有清单和一个入口文件，适合从零写起",
  },
  {
    id: "gameplay",
    name: "玩法调整",
    size: "6 MB",
    desc: "预置规则钩子，改数值、加机制都从这里下手",
  },
]

export const DEFAULT_TEMPLATE = MOD_TEMPLATES[0].id

/** 找不到就退回第一个，模板被删掉时表单不至于开天窗 */
export function templateOf(id: string): ModTemplate {
  return MOD_TEMPLATES.find((item) => item.id === id) ?? MOD_TEMPLATES[0]
}

/** 市场列表的安装状态筛选 */
export type MarketFilter = "all" | "available" | "installed"

export const MARKET_FILTER_LABEL: Record<MarketFilter, string> = {
  all: "全部",
  available: "未安装",
  installed: "已安装",
}

export const MARKET_FILTER_ORDER: MarketFilter[] = [
  "all",
  "available",
  "installed",
]

export type ModTab = "installed" | "mine" | "market"

/* ---------------- 上架与冲突 ---------------- */

export const FALLBACK_CONFLICT_REASON =
  "两者注册了同一份运行时钩子，同时启用会互相覆盖。"

/** 是否已上架到市场：非本地模组默认已上架，本地模组看审核状态 */
export function isPublished(mod: ModEntry): boolean {
  return (mod.review ?? "approved") === "approved"
}

export function reasonOf(mod: ModEntry, other: ModEntry): string {
  return (
    mod.conflictReason?.[other.id] ??
    other.conflictReason?.[mod.id] ??
    FALLBACK_CONFLICT_REASON
  )
}

/** 双方都已安装并启用 → 真实冲突 */
export function activeConflicts(mods: ModEntry[], mod: ModEntry): ModEntry[] {
  if (!mod.installed || !mod.enabled || !mod.conflicts) return []
  return mods.filter(
    (other) =>
      mod.conflicts!.includes(other.id) && other.installed && other.enabled
  )
}

/** 本模组尚未安装，但已启用的模组里有它的冲突项 → 安装前预警 */
export function pendingConflicts(mods: ModEntry[], mod: ModEntry): ModEntry[] {
  if (mod.installed || !mod.conflicts) return []
  return mods.filter(
    (other) =>
      mod.conflicts!.includes(other.id) && other.installed && other.enabled
  )
}

export interface ConflictPair {
  a: ModEntry
  b: ModEntry
  reason: string
}

/** 全库去重后的冲突组，每组只出现一次 */
export function collectConflictPairs(mods: ModEntry[]): ConflictPair[] {
  const seen = new Set<string>()
  const pairs: ConflictPair[] = []
  mods.forEach((a) => {
    if (!a.installed || !a.enabled || !a.conflicts) return
    a.conflicts.forEach((otherId) => {
      const b = mods.find((item) => item.id === otherId)
      if (!b || !b.installed || !b.enabled) return
      const key = [a.id, b.id].sort().join("|")
      if (seen.has(key)) return
      seen.add(key)
      pairs.push({ a, b, reason: reasonOf(a, b) })
    })
  })
  return pairs
}

/* ---------------- 审核状态 ---------------- */

export function isReviewing(mod: ModEntry): boolean {
  return mod.review === "reviewing"
}

/* ---------------- 评分与评论 ---------------- */

export interface RatingSummary {
  /** 综合评分（未取整）；没人打分为 0 */
  average: number
  /** 评分人数，含只打分不写评论的玩家 */
  count: number
}

/**
 * 综合评分。打分的人远多于写评论的人，所以评分与评论条数是两个口径：
 * 评分读模组上的汇总值，评论读 reviews 数组，卡片、详情、筛选都走这里，
 * 保证全站只有一处口径。
 */
export function ratingOf(mod: ModEntry): RatingSummary {
  return { average: mod.ratingAvg, count: mod.ratingCount }
}

/** 写了评论的人数，和评分人数不是一回事 */
export function reviewCount(mod: ModEntry): number {
  return mod.reviews.length
}

/* ---------------- 评分增减 ---------------- */

/**
 * 投一票新评分。综合分按人数加权回算，不直接改小数，
 * 避免连续打分后误差越滚越大。
 */
export function rateAdd(
  mod: ModEntry,
  stars: number
): Pick<ModEntry, "ratingAvg" | "ratingCount"> {
  const count = mod.ratingCount + 1
  const total = mod.ratingAvg * mod.ratingCount + stars
  return { ratingAvg: total / count, ratingCount: count }
}

/** 改自己那一票：总人数不变，只把旧分换成新分 */
export function rateReplace(
  mod: ModEntry,
  oldStars: number,
  newStars: number
): Pick<ModEntry, "ratingAvg" | "ratingCount"> {
  if (mod.ratingCount <= 0) return { ratingAvg: mod.ratingAvg, ratingCount: mod.ratingCount }
  const total = mod.ratingAvg * mod.ratingCount - oldStars + newStars
  return { ratingAvg: total / mod.ratingCount, ratingCount: mod.ratingCount }
}

/** 撤回自己那一票：没人剩了就回到未评分状态 */
export function rateRemove(
  mod: ModEntry,
  stars: number
): Pick<ModEntry, "ratingAvg" | "ratingCount"> {
  const count = mod.ratingCount - 1
  if (count <= 0) return { ratingAvg: 0, ratingCount: 0 }
  const total = mod.ratingAvg * mod.ratingCount - stars
  return { ratingAvg: total / count, ratingCount: count }
}

/* ---------------- 时间 ---------------- */

/**
 * 从模组名推一个候选标识：转小写、空格与符号收成短横、掐掉推不出来的字符。
 * 名字里没有字母数字时返回空串（中文名就是这种情况），这时得作者自己起一个。
 */
export function slugifyModId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/**
 * 密钥指纹的短形式（keyId）：去掉分组空格取末 12 位。
 * 完整指纹太长，界面上一行放不下；keyId 够认人，也是通行叫法。
 */
export function keyIdOf(fingerprint: string): string {
  const hex = fingerprint.replace(/[^0-9a-fA-F]/g, "")
  return hex.length >= 12 ? hex.slice(-12).toLowerCase() : fingerprint
}

/**
 * 令牌在界面上只露头尾，中间打点。已保存的令牌不回填明文，
 * 这一串是用来确认「存的是哪一把」，而不是把密钥摊在屏幕上。
 */
export function maskToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length <= 10) return "•".repeat(trimmed.length)
  return `${trimmed.slice(0, 4)}${"•".repeat(6)}${trimmed.slice(-4)}`
}

/**
 * 发布凭据。手动粘的长期令牌会一直留着；设备授权换来的临时凭据一小时后失效，
 * 本机不留能长期用的东西——两者在界面上的说法与风险都不一样，所以分开记。
 */
export interface PublishCredential {
  kind: "pat" | "device"
  token: string
  /** 临时凭据的到期时间（毫秒时间戳）；长期令牌为 0 */
  expiresAt: number
}

/** 临时凭据的有效期：一小时，够把一次发布做完 */
export const DEVICE_TOKEN_TTL_MS = 60 * 60 * 1000

/** 授权码与临时令牌共用，去掉容易看错的 I / O / 0 / 1 */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function randomCode(length: number): string {
  let out = ""
  for (let i = 0; i < length; i += 1) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return out
}

/** 一次性设备授权码，形如 WDJB-MJHT */
export function makeDeviceCode(): string {
  const raw = randomCode(8)
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

/** 授权成功后拿到的临时令牌，形如 gho_ 开头的一串 */
export function makeDeviceToken(): string {
  return `gho_${randomCode(36).toLowerCase()}`
}

/** 临时凭据还剩多少分钟；长期令牌不按分钟算，已过期返回 0 */
export function minutesLeft(cred: PublishCredential, now: number): number {
  if (cred.kind !== "device" || cred.expiresAt <= 0) return 0
  return Math.max(0, Math.ceil((cred.expiresAt - now) / 60000))
}

/** 凭据还能不能用：长期令牌一直在，临时凭据要看过没过期 */
export function isCredentialLive(
  cred: PublishCredential | null,
  now: number
): boolean {
  if (!cred) return false
  return cred.kind === "pat" || cred.expiresAt > now
}

/** 凭据在界面上的一句话说法：长期令牌只露掩码，临时凭据报剩余时间 */
export function credentialLabel(cred: PublishCredential, now: number): string {
  if (cred.kind === "pat") return maskToken(cred.token)
  const left = minutesLeft(cred, now)
  return left > 0 ? `设备授权 · 剩余 ${left} 分钟` : "设备授权 · 已过期"
}

/* ---------------- 发布前置条件 ---------------- */

/**
 * 署名输入框里的占位提示：只是告诉你这里填什么，不是默认值——
 * 署名一开始就是空的，谁的名字也不会预先替你填上。
 */
export const AUTHOR_NAME_PLACEHOLDER = "指挥官"

/** 署名填过没有：只有空白不算填 */
export function hasOwnSignature(name: string): boolean {
  return name.trim().length > 0
}

/** 本地还没填署名时，先挂这个名顶在作者栏上，别留下一片空白 */
export const UNSIGNED_AUTHOR = "未署名"

/** 用在作者栏、评价、回复上的名字：署名没填就退回「未署名」 */
export function displayAuthor(name: string): string {
  return name.trim() || UNSIGNED_AUTHOR
}

/** 提交前必须解决的一件事：说清缺什么、去哪补 */
export interface PublishBlocker {
  id: "signature" | "token"
  /** 这一项的名词说法，用来拼「还差 X、Y」 */
  label: string
  /** 缺的是什么 */
  title: string
  /** 为什么缺它不能提交，以及去哪儿补 */
  hint: string
}

/**
 * 提交的硬门槛：署名得是自己的，GitHub 令牌得能用。
 * 源码是推到作者自己名下的仓库里的，这两样缺了发布根本走不通，
 * 所以不再留「照样能交审核」的口子——缺什么就挡住什么。
 */
export function publishBlockers({
  credential,
  name,
  now,
}: {
  credential: PublishCredential | null
  name: string
  now: number
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = []
  if (!hasOwnSignature(name)) {
    blockers.push({
      id: "signature",
      label: "署名",
      title: "还没填署名",
      hint: "署名会印在模组的作者栏上，先在「作者身份」里填上你自己的署名。",
    })
  }
  if (!isCredentialLive(credential, now)) {
    blockers.push({
      id: "token",
      label: "发布凭据",
      title: credential ? "GitHub 令牌已过期" : "还没配置 GitHub 令牌",
      // 「发布凭据」和「GitHub 令牌」是两个叫法一件事，这里把话说明白
      hint: credential
        ? "发布凭据就是你那把 GitHub 令牌，已经过期了，在「作者身份」里重新授权一次。"
        : "发布凭据就是你自己的 GitHub 令牌：源码要推到你名下的仓库，先在「作者身份」里配好。",
    })
  }
  return blockers
}

/* ---------------- 提交发布流水线 ---------------- */

/**
 * 提交一版模组要走的环节：本地打包 → （建仓库）→ 推源码 → 交审核。
 * 源码那两环是把包推到作者自己的仓库去，按模组算：推过就只推新版本。
 * credLive 由提交前的前置检查保证为真，留着这个参数是为了把环节算得明白。
 */
export type PublishStageId = "pack" | "repo" | "upload" | "submit"

export interface PublishStage {
  id: PublishStageId
  /** 还没轮到时显示的说法 */
  pending: string
  /** 正在进行时的说法 */
  running: string
  /** 完成后的说法 */
  done: string
}

const STAGE_TEXT: Record<PublishStageId, Omit<PublishStage, "id">> = {
  pack: { pending: "打包安装包", running: "正在打包", done: "打包成功" },
  repo: { pending: "创建源码仓库", running: "创建仓库中", done: "仓库已创建" },
  upload: { pending: "上传源码", running: "正在上传", done: "上传成功" },
  submit: { pending: "提交审核", running: "正在提交审核", done: "提交完成" },
}

/**
 * 这一次提交实际要走的环节。
 * 作者的源码仓库按模组建：这个模组还没推过源码就先建仓库，推过就只推新版本。
 */
export function publishStages({
  credLive,
  repoReady,
}: {
  credLive: boolean
  repoReady: boolean
}): PublishStage[] {
  const ids: PublishStageId[] = ["pack"]
  if (credLive) {
    if (!repoReady) ids.push("repo")
    ids.push("upload")
  }
  ids.push("submit")
  return ids.map((id) => ({ id, ...STAGE_TEXT[id] }))
}

/** 作者自己的源码仓库：一个模组一个仓库，仓库名跟着模组 id */
export function sourceRepo(modId: string): string {
  return `${MOD_AUTHOR.id}/${modId}`
}

/** 打包产物的文件名，进度里直接把包名点出来 */
export function packageFileName(modId: string, version: string): string {
  return `${modId}-${version}.zip`
}

/**
 * 同一个环节的进度提示原地更新（进行中→完成）：
 * 一次提交最多四条提示，不用刷一屏。
 */
export function publishToastId(stage: PublishStageId): string {
  return `mod-publish-${stage}`
}

/** 今天的日期，YYYY-MM-DD */
export function todayISO(): string {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/** 两个 YYYY-MM-DD 之间差多少天，未来日期按 0 算 */
export function daysAgo(date: string, today: string): number {
  const then = Date.parse(`${date}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(then) || Number.isNaN(now)) return 0
  return Math.max(0, Math.round((now - then) / 86400000))
}

/** 评论上的相对时间：今天 / 昨天 / N 天前 / N 个月前 / N 年前 */
export function relativeDate(date: string, today: string): string {
  const days = daysAgo(date, today)
  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  // 满 30 天仍说「30 天前」，31 天才进位到「1 个月前」；月份最多说到 11 个月
  if (days <= 30) return `${days} 天前`
  if (days < 365) return `${Math.min(11, Math.max(1, Math.round(days / 30)))} 个月前`
  return `${Math.max(1, Math.round(days / 365))} 年前`
}

/* ---------------- 评论列表的分档与排序 ---------------- */

export type ReviewFilter = "all" | "pending" | "good" | "bad" | "replied"

export const REVIEW_FILTER_LABEL: Record<ReviewFilter, string> = {
  all: "全部",
  pending: "待回复",
  good: "好评",
  bad: "差评",
  replied: "作者已回复",
}

export const REVIEW_FILTER_ORDER: ReviewFilter[] = [
  "all",
  "pending",
  "good",
  "bad",
  "replied",
]

/** 「待回复」只有模组作者用得上，别人的模组不摆这个入口 */
export function reviewFilterOrder(mod: ModEntry): ReviewFilter[] {
  return mod.mine
    ? REVIEW_FILTER_ORDER
    : REVIEW_FILTER_ORDER.filter((item) => item !== "pending")
}

/** 好评 4★ 及以上、差评 3★ 及以下，与星级分布条的档位口径一致 */
export function matchReviewFilter(
  review: ModReview,
  filter: ReviewFilter
): boolean {
  if (filter === "all") return true
  // 别人写的、作者还没回的，才是作者真正要做的事
  if (filter === "pending") return !review.mine && !review.reply
  if (filter === "good") return review.stars >= 4
  if (filter === "bad") return review.stars <= 3
  return Boolean(review.reply)
}

/** 每个分档各有多少条，直接标在筛选按钮上 */
export function countReviewFilters(
  reviews: ModReview[]
): Record<ReviewFilter, number> {
  return {
    all: reviews.length,
    pending: reviews.filter((review) => !review.mine && !review.reply).length,
    good: reviews.filter((review) => review.stars >= 4).length,
    bad: reviews.filter((review) => review.stars <= 3).length,
    replied: reviews.filter((review) => review.reply).length,
  }
}

export type ReviewSort = "recent" | "high" | "low"

export const REVIEW_SORT_LABEL: Record<ReviewSort, string> = {
  recent: "最新",
  high: "高分优先",
  low: "低分优先",
}

export const REVIEW_SORT_ORDER: ReviewSort[] = ["recent", "high", "low"]

/** 每种排序都带日期兜底键：同分时顺序也稳定，不会来回跳 */
export function sortReviews(
  reviews: ModReview[],
  sort: ReviewSort
): ModReview[] {
  const sorted = [...reviews]
  if (sort === "recent") {
    return sorted.sort((a, b) => b.date.localeCompare(a.date))
  }
  if (sort === "high") {
    return sorted.sort(
      (a, b) => b.stars - a.stars || b.date.localeCompare(a.date)
    )
  }
  return sorted.sort((a, b) => a.stars - b.stars || b.date.localeCompare(a.date))
}

/** 这条评论是不是针对当前版本写的；老版本的评论标出来，避免误导 */
export function isStaleReview(review: ModReview, mod: ModEntry): boolean {
  return review.version !== mod.version
}

/** 别人写了、作者还没回复的评价条数，提醒作者去哪儿回复 */
export function pendingReplies(mod: ModEntry): number {
  return mod.reviews.filter((review) => !review.mine && !review.reply).length
}

/* ---------------- 作者：创建草稿与审核结果 ---------------- */

/** 创建时的构建选项：骨架落地后要不要重启、启用、签名 */
export interface ModBuildOptions {
  /** 清单里声明需要重启服务端才生效 */
  restart: boolean
  /** 建好后直接启用（否则骨架留成 loader.js.disabled，默认不加载） */
  enableAfterCreate: boolean
  /** 建好后立刻签名，提交审核时不用再补签 */
  signAfterCreate: boolean
}

export const DEFAULT_BUILD_OPTIONS: ModBuildOptions = {
  restart: true,
  enableAfterCreate: false,
  signAfterCreate: true,
}

/** 创建/编辑模组表单的输入；编辑时 id 与 version 原样带回 */
export interface NewModInput {
  name: string
  id: string
  version: string
  cat: string
  /** 简介：市场卡片上的一句话 */
  desc: string
  tags: string[]
  /** 建骨架用的模板 id */
  template: string
  /** 详细介绍原文，写进 README，空行分段 */
  readme: string
  /** 功能要点，每行一条，写进 README */
  features: string[]
  /** 与之冲突的模组 id，可留空 */
  conflicts: string[]
  /** 创建时的构建选项；编辑不重新生成骨架，带默认值即可 */
  build: ModBuildOptions
}

/** 描述与功能说明都留空时的兜底文案，新建与编辑共用一套 */
export const EMPTY_MOD_DESC = "还没有填写描述。"
export const EMPTY_MOD_README = "还没有填写功能说明。"

/**
 * 卡片上的简介只显示三行（12px 字、行高 19.5px）。
 * 最窄的常见窗口（820px 上下）一行大约放得下 20 个汉字，三行就是 60 个 ——
 * 写在这个数以内，任何窗口宽度下卡片都不会省略；再长也不会丢，详情里能看到全文。
 */
export const SAFE_DESC_LENGTH = 60

/** 模组 ID 只允许小写字母、数字与短横 */
export const MOD_ID_PATTERN = /^[a-z0-9-]+$/

/** 创建表单的报错：第二行用来补充说明，没内容就不显示 */
export interface NewModError {
  message: string
  detail?: string
}

/** 创建表单的校验：返回第一条错误，没问题返回 null */
export function validateNewMod(
  input: { name: string; id: string },
  existingIds: string[]
): NewModError | null {
  if (!input.name.trim()) return { message: "请填写模组名" }
  const id = input.id.trim()
  if (!id) return { message: "请填写模组 ID" }
  if (!MOD_ID_PATTERN.test(id)) {
    return { message: "模组 ID 只能包含小写字母、数字和短横" }
  }
  if (existingIds.includes(id)) {
    return {
      message: "这个 ID 已经被占用了",
      detail: `${id} 已在本地模组库里，换一个 ID 再试。`,
    }
  }
  return null
}

/** 逗号分隔的输入 → 去空去重的列表；limit 给标签这类有上限的字段用 */
function parseCommaList(raw: string, limit?: number): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,，]/)) {
    const item = part.trim()
    if (item) seen.add(item)
  }
  const list = [...seen]
  return limit === undefined ? list : list.slice(0, limit)
}

/** 标签输入：英文或中文逗号分隔，去空去重，最多 5 个 */
export function parseTags(raw: string): string[] {
  return parseCommaList(raw, 5)
}

/** 冲突模组 id：逗号分隔，去空去重；不设上限，冲突本来就该照实写全 */
export function parseIdList(raw: string): string[] {
  return parseCommaList(raw)
}

/**
 * 冲突声明的检查结果。都不拦提交——冲突对象可能还没建出来，
 * 也不排除将来由别人发布——所以在表单里只做提示。
 */
export interface ConflictCheck {
  /** 把自己写进了冲突列表，这条声明没有意义 */
  self: boolean
  /** 本地模组库里找不到的 id，多半是拼错了 */
  unknown: string[]
}

export function checkConflicts(
  ids: string[],
  selfId: string,
  knownIds: string[]
): ConflictCheck {
  const self = selfId !== "" && ids.includes(selfId)
  return {
    self,
    unknown: ids.filter((id) => id !== selfId && !knownIds.includes(id)),
  }
}

/** 功能要点：每行一条，空行丢掉 */
export function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** README 里功能要点那一段的标题与条目前缀，写和读都用同一套 */
const FEATURES_HEADING = "功能要点"
const FEATURE_BULLET = "· "

/**
 * README 正文段落：详细介绍按空行分段，功能要点另起一段、每条一行。
 * 详情页是按段落渲染的，要点拆成独立段落才不会挤成一坨。
 */
export function readmeParagraphs(intro: string, features: string[]): string[] {
  const paragraphs = intro
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (features.length > 0) {
    paragraphs.push(
      FEATURES_HEADING,
      ...features.map((item) => `${FEATURE_BULLET}${item}`)
    )
  }
  return paragraphs
}

/** 正文兜底：作者没写详细介绍与要点时用简介顶上，详情页不至于空着 */
function readmeOrFallback(
  intro: string,
  features: string[],
  desc: string
): string[] {
  const paragraphs = readmeParagraphs(intro, features)
  if (paragraphs.length > 0) return paragraphs
  return [desc.trim() || EMPTY_MOD_README]
}

/** 草稿的初始体积，创建后可在本地继续改 */
const DRAFT_SIZE_MB = 0.1

/**
 * 把创建表单变成一条草稿模组：未安装、未上架、没有评分也没有评论，
 * 字段口径跟市场里的模组完全一致，后续的提交、审核、上架都不用特殊处理。
 */
export function draftMod(
  input: NewModInput,
  today: string,
  author: string = ""
): ModEntry {
  const desc = input.desc.trim()
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    // 署名还没填的草稿先挂「未署名」，别在作者栏留一片空白
    author: displayAuthor(author),
    cat: input.cat,
    desc: desc || EMPTY_MOD_DESC,
    tags: input.tags,
    installed: false,
    // 骨架默认是禁用状态（loader.js.disabled），勾了「建好后立即启用」才反过来
    enabled: input.build.enableAfterCreate,
    needsRestart: input.build.restart,
    reviews: [],
    downloads: 0,
    ratingAvg: 0,
    ratingCount: 0,
    sizeMB: DRAFT_SIZE_MB,
    updatedAt: today,
    // 表单不再收集这两项：新骨架按最新的服务端版本声明，权限留空
    gameVersion: GAME_VERSIONS[0],
    perms: [],
    readme: readmeOrFallback(input.readme, input.features, desc),
    changelog: [{ version: input.version, date: today, items: ["初始版本"] }],
    conflicts: input.conflicts.length > 0 ? input.conflicts : undefined,
    mine: true,
    review: "draft",
  }
}

/** 编辑模组信息：ID 与版本不走这里，改版本要走「发布新版本」 */
export interface ModPatch {
  name: string
  cat: string
  desc: string
  tags: string[]
  /** 详细介绍原文，空行分段 */
  readme: string
  /** 功能要点，每行一条 */
  features: string[]
  /** 与之冲突的模组 id，可留空 */
  conflicts: string[]
}

/**
 * 改模组信息。正文由作者在表单里直接维护，不再拿简介去猜。
 * 兼容服务端与权限不在表单里，原样保留，不会被改信息顺手抹掉。
 * 也不动 updatedAt：改说明不算发版，免得市场里的「最近更新」排序被搅乱。
 */
export function applyModPatch(mod: ModEntry, patch: ModPatch): ModEntry {
  const desc = patch.desc.trim()
  return {
    ...mod,
    name: patch.name,
    cat: patch.cat,
    desc: desc || mod.desc,
    tags: patch.tags,
    readme: readmeOrFallback(patch.readme, patch.features, desc),
    conflicts: patch.conflicts.length > 0 ? patch.conflicts : undefined,
  }
}

/**
 * 编辑时把已有正文拆回两个输入框：正文还是自动生成的那句（等于简介或占位符）
 * 就留空，让作者从零写，免得把占位符当成自己写的内容带上去。
 * 「功能要点」那段按写出去的格式读回来，作者不用手动改格式。
 */
export function editableReadme(mod: ModEntry): {
  intro: string
  features: string[]
} {
  const auto =
    mod.readme.length === 1 &&
    (mod.readme[0] === mod.desc || mod.readme[0] === EMPTY_MOD_README)
  if (auto) return { intro: "", features: [] }

  const intro: string[] = []
  const features: string[] = []
  let inFeatures = false
  for (const paragraph of mod.readme) {
    if (paragraph === FEATURES_HEADING) {
      inFeatures = true
      continue
    }
    if (inFeatures && paragraph.startsWith(FEATURE_BULLET)) {
      features.push(paragraph.slice(FEATURE_BULLET.length).trim())
      continue
    }
    // 要点段后面又冒出普通段落，说明作者正文里也写了「功能要点」四个字，照原样留着
    inFeatures = false
    intro.push(paragraph)
  }
  return { intro: intro.join("\n\n"), features }
}

/**
 * 详情页把正文拆成两块看：先一列能扫的功能要点，再是作者写的正文。
 * 正文还是自动生成的那句（等于简介或占位符）时两样都是空的，那就整段照原样显示，
 * 服务端少给一段、作者只写了正文没写要点，详情页都不会空着。
 */
export function readmeSections(mod: ModEntry): {
  features: string[]
  paragraphs: string[]
} {
  const { intro, features } = editableReadme(mod)
  const paragraphs = intro
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (paragraphs.length === 0 && features.length === 0) {
    return { features: [], paragraphs: mod.readme }
  }
  return { features, paragraphs }
}

/** 审核的两种走向 */
export type ReviewResult = "approved" | "rejected"

/** 演示用的驳回原因：真实审核里这段由人工填写 */
export const DEMO_REJECT_NOTE =
  "功能说明里没有写清权限用途，补充后可以重新提交。"

/** 审核出结果后的新状态：通过就上架，驳回就留下原因等作者改 */
export function applyReviewResult(mod: ModEntry, result: ReviewResult): ModEntry {
  if (result === "approved") {
    return {
      ...mod,
      review: "approved",
      submittedAt: undefined,
      reviewNote: undefined,
    }
  }
  return {
    ...mod,
    review: "rejected",
    submittedAt: undefined,
    reviewNote: DEMO_REJECT_NOTE,
  }
}

/* ---------------- 列表筛选 ---------------- */

/* ---------------- 评分分档 ---------------- */

/** 市场列表的评分筛选 */
export type RatingFilter = "all" | "gte45" | "gte40" | "lt40"

export const RATING_FILTER_LABEL: Record<RatingFilter, string> = {
  all: "全部评分",
  gte45: "4.5 分以上",
  gte40: "4.0 分以上",
  lt40: "4.0 分以下",
}

export const RATING_FILTER_ORDER: RatingFilter[] = [
  "all",
  "gte45",
  "gte40",
  "lt40",
]

/** 还没有人评分的模组不进任何分档，避免「4.0 分以下」混进一堆空白 */
export function matchRating(mod: ModEntry, filter: RatingFilter): boolean {
  if (filter === "all") return true
  const { average, count } = ratingOf(mod)
  if (count === 0) return false
  if (filter === "gte45") return average >= 4.5
  if (filter === "gte40") return average >= 4
  return average < 4
}

/* ---------------- 市场排序 ---------------- */

/** 市场列表的排序方式 */
export type ModSort = "default" | "rating" | "updated" | "downloads"

export const MOD_SORT_LABEL: Record<ModSort, string> = {
  default: "默认排序",
  rating: "评分最高",
  updated: "最近更新",
  downloads: "下载最多",
}

export const MOD_SORT_ORDER: ModSort[] = [
  "default",
  "rating",
  "updated",
  "downloads",
]

/** 按选定口径排序；评分并列时用下载量兜底，保证顺序稳定 */
export function sortMods(mods: ModEntry[], sort: ModSort): ModEntry[] {
  if (sort === "default") return mods
  const sorted = [...mods]
  sorted.sort((a, b) => {
    if (sort === "rating") {
      const gap = ratingOf(b).average - ratingOf(a).average
      if (gap !== 0) return gap
      return b.downloads - a.downloads
    }
    if (sort === "downloads") return b.downloads - a.downloads
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return sorted
}

export function marketCounts(pool: ModEntry[]): Record<MarketFilter, number> {
  return {
    all: pool.length,
    available: pool.filter((mod) => !mod.installed).length,
    installed: pool.filter((mod) => mod.installed).length,
  }
}

/** 「我创建的」页签的筛选：先把还有评价没回的挑出来 */
export type MineFilter = "all" | "pending"

export const MINE_FILTER_LABEL: Record<MineFilter, string> = {
  all: "全部",
  pending: "待回复",
}

export const MINE_FILTER_ORDER: MineFilter[] = ["all", "pending"]

export function matchMineFilter(mod: ModEntry, filter: MineFilter): boolean {
  return filter === "all" || pendingReplies(mod) > 0
}

export function mineCounts(pool: ModEntry[]): Record<MineFilter, number> {
  return {
    all: pool.length,
    pending: pool.filter((mod) => pendingReplies(mod) > 0).length,
  }
}

export function filterMods({
  mods,
  tab,
  marketFilter,
  mine = "all",
  query,
  category,
  rating = "all",
  tag = null,
}: {
  mods: ModEntry[]
  tab: ModTab
  marketFilter: MarketFilter
  /** 待回复筛选，仅「我创建的」页签生效 */
  mine?: MineFilter
  query: string
  category: string
  /** 评分分档，仅模组市场页签生效 */
  rating?: RatingFilter
  /** 标签筛选：点卡片上的标签就按这个筛，空表示不限 */
  tag?: string | null
}): ModEntry[] {
  let pool: ModEntry[]
  if (tab === "installed") pool = mods.filter((mod) => mod.installed)
  else if (tab === "mine") pool = mods.filter((mod) => mod.mine)
  else pool = mods.filter(isPublished)

  if (tab === "market" && marketFilter !== "all") {
    pool = pool.filter((mod) =>
      marketFilter === "installed" ? mod.installed : !mod.installed
    )
  }

  if (tab === "mine" && mine !== "all") {
    pool = pool.filter((mod) => matchMineFilter(mod, mine))
  }

  if (tab === "market" && rating !== "all") {
    pool = pool.filter((mod) => matchRating(mod, rating))
  }

  const keyword = query.trim().toLowerCase()
  return pool.filter((mod) => {
    if (category !== ALL_CATEGORY && mod.cat !== category) return false
    if (tag && !mod.tags.includes(tag)) return false
    if (!keyword) return true
    return (
      mod.name.toLowerCase().includes(keyword) ||
      mod.id.toLowerCase().includes(keyword) ||
      mod.author.toLowerCase().includes(keyword) ||
      mod.tags.some((t) => t.toLowerCase().includes(keyword))
    )
  })
}

/** 是否存在可安装的新版本：已安装、市场有更新、且与本地版本不同 */
export function hasUpdate(mod: ModEntry): boolean {
  return (
    mod.installed && mod.latest !== undefined && mod.latest !== mod.version
  )
}

/** 某个模组在市场上的目标版本：有新版就装新版 */
export function targetVersionOf(mod: ModEntry): string {
  return mod.latest ?? mod.version
}

/* ---------------- 版本号 ---------------- */

/** 1.4.2 → 1.5.0；0.9.0 → 0.10.0 */
export function bumpVersion(version: string): string {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10))
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return version
  const [major, minor] = parts
  return `${major}.${minor + 1}.0`
}

/* ---------------- 下载阶段 ---------------- */

export type DownloadPhase = "downloading" | "verifying" | "installing"

/** 进度百分比 → 阶段：下载 0-82，校验 82-94，解包 94-100 */
export function phaseOf(progress: number): DownloadPhase {
  if (progress < 82) return "downloading"
  if (progress < 94) return "verifying"
  return "installing"
}

/**
 * 每 tick（120ms）推进的百分比。体积按开方参与，让 3 MB 的小包约 2 秒、
 * 190 MB 的大包约 5 秒走完，避免大包在演示里等到失去耐心。
 */
export function stepFor(sizeMB: number): number {
  return 100 / (14 + Math.sqrt(Math.max(0, sizeMB)) * 2.2)
}

/** 审核状态的展示文案顺序，供徽章分组使用 */
export const REVIEW_ORDER: ModReviewState[] = [
  "draft",
  "reviewing",
  "approved",
  "rejected",
]
