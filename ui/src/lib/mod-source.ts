/**
 * 真回包 → 模组页视图模型（ModEntry）的纯换算，与 React / IPC 无关，可单独验证。
 *
 * 三个来源合并成一份列表（沿用原型的「一份列表 + 三个页签」结构）：
 *   - `mods:marketList`  市场索引：市场上有什么、最新版本、下载量；
 *   - `mods:list`        本地扫描：本机 mods/ 里装了什么、启用没有、签名状态；
 *   - `mods:myMods`      本机作者身份相关条目：我创建的走到哪一步（草稿/审核中/已上架/已下架）。
 *
 * 后端没有的东西一律留空（评分、评论、权限清单），页面会画「暂无」，不编数字。
 */
import { getActiveLocale, type LocaleCode } from "./i18n"
import type {
  LocalizedReason,
  RawMarketList,
  RawMarketMod,
  RawMod,
  RawModList,
  RawMyModItem,
  RawMyMods,
  RawSubmissionItem,
} from "./ipc"
import { FEATURES_HEADING, compareVersions, readmeParagraphs } from "./mod-logic"
import type { ModChangelog, ModEntry, ModReviewState } from "./mock"

const BYTES_PER_MB = 1024 * 1024

/** 字节 → MB（保留一位小数）；0 / 缺失都给 0 */
export function toMB(bytes: number | undefined | null): number {
  if (!bytes || bytes <= 0) return 0
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10
}

/** 毫秒时间戳 → YYYY-MM-DD；拿不到就给空串（页面显示 —） */
export function isoDate(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return ""
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `mods:myMods` 的状态 → 页面上的审核状态 */
export function reviewStateOf(status: string): ModReviewState {
  switch (status) {
    case "draft":
      return "draft"
    case "submitted":
      return "reviewing"
    case "update-pending":
    case "listed":
      return "approved"
    case "delisted":
      return "delisted"
    case "rejected":
      return "rejected"
    default:
      // "local"：本机有这个文件夹，但还没提交过
      return "draft"
  }
}

/** 版本说明文本 → 详情页的条目：按行拆，去掉 Markdown 列表符号 */
export function changelogItems(text: string | undefined | null): string[] {
  if (typeof text !== "string") return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*·]\s*/, ""))
    .filter(Boolean)
}

/**
 * 正文 + 功能要点 → 详情页读的段落数组（与编辑表单写出去的是同一套格式）。
 * 索引分片里 `readme` 只放「详细介绍」的段落，要点另存在 `highlights`，这里合成一段；
 * 手写 README 没有小节标题时 `readme` 已经是整篇，那就原样用，别再加一遍标题。
 */
export function readmeOf(
  detail: string[] | undefined,
  highlights: string[] | undefined
): string[] {
  const paragraphs = (detail ?? []).filter(
    (item) => typeof item === "string" && item.trim().length > 0
  )
  if (paragraphs.some((item) => item.trim() === FEATURES_HEADING)) return paragraphs
  const features = (highlights ?? []).filter(
    (item) => typeof item === "string" && item.trim().length > 0
  )
  return readmeParagraphs(paragraphs.join("\n\n"), features)
}

/** 市场索引的「当前版本说明 + 更早版本 history」→ 版本历史（最新的在前） */
export function marketChangelog(mod: RawMarketMod): ModChangelog[] {
  const out: ModChangelog[] = []
  if (mod.version) {
    out.push({
      version: mod.version,
      date: mod.publishedAt || "",
      items: changelogItems(mod.changelog),
    })
  }
  const history = Array.isArray(mod.history) ? mod.history : []
  // 后端往 history 里是按时间追加的，倒着读才是「最新的在前」
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    if (!item || typeof item.version !== "string" || !item.version) continue
    out.push({
      version: item.version,
      date: isoDate(typeof item.at === "number" ? item.at : 0),
      items: changelogItems(item.changelog),
    })
  }
  return out
}

/**
 * 提交台账 → 版本历史（最新的在前，同一个版本只留最新一条）。
 * 这是作者自己的逐版本记录：本地草稿、审核中、已上架的版本都在里面，
 * 索引要等审核合并才更新，改完信息后想看历史只能靠它。
 */
export function submissionChangelog(
  items: RawSubmissionItem[] | undefined,
  id: string
): ModChangelog[] {
  const seen = new Set<string>()
  return (items ?? [])
    .filter((item) => item?.id === id && typeof item.version === "string" && item.version)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .filter((item) => {
      if (seen.has(item.version)) return false
      seen.add(item.version)
      return true
    })
    .map((item) => ({
      version: item.version,
      date: isoDate(item.createdAt),
      items: changelogItems(item.changelog),
    }))
}

function baseEntry(id: string): ModEntry {
  return {
    id,
    name: id,
    version: "",
    author: "",
    cat: "玩法",
    desc: "",
    tags: [],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [],
    downloads: 0,
    ratingAvg: 0,
    ratingCount: 0,
    sizeMB: 0,
    updatedAt: "",
    gameVersion: "",
    perms: [],
    readme: [],
    changelog: [],
  }
}

/** 市场索引条目 → 视图模型 */
export function fromMarket(mod: RawMarketMod): ModEntry {
  return {
    ...baseEntry(mod.id),
    name: mod.displayName || mod.id,
    version: mod.version || "",
    author: mod.author?.name || "",
    cat: mod.category || "玩法",
    desc: mod.description || "",
    tags: Array.isArray(mod.tags) ? mod.tags : [],
    needsRestart: mod.requiresRestart !== false,
    downloads: mod.downloads ?? mod.cdnHits ?? 0,
    sizeMB: toMB(mod.sizeBytes),
    updatedAt: mod.publishedAt || "",
    publishedAt: mod.publishedAt || "",
    gameVersion: mod.evejsVersions?.[0] ?? "",
    readme: readmeOf(mod.readme, mod.highlights),
    changelog: marketChangelog(mod),
    mine: false,
    inMarket: true,
  }
}

/** 本地扫描条目叠加到已有视图模型上 */
export function applyLocal(entry: ModEntry, mod: RawMod): ModEntry {
  return {
    ...entry,
    folder: mod.folder || entry.folder,
    name: mod.displayName || entry.name,
    version: mod.version || entry.version,
    author: mod.authorName || entry.author,
    cat: mod.category || entry.cat,
    desc: mod.description || entry.desc,
    // 本机 README 是作者改完立刻能看到的唯一来源（索引要等审核合并才更新）；
    // 没读到 README 时保留原来那份，别把市场里的正文抹掉
    readme:
      (mod.readme?.length ?? 0) > 0 || (mod.highlights?.length ?? 0) > 0
        ? readmeOf(mod.readme, mod.highlights)
        : entry.readme,
    tags: mod.tags?.length ? mod.tags : entry.tags,
    installed: true,
    enabled: mod.enabled === true,
    sizeMB: mod.sizeBytes ? toMB(mod.sizeBytes) : entry.sizeMB,
    conflicts:
      mod.activeConflicts && mod.activeConflicts.length > 0
        ? mod.activeConflicts
        : entry.conflicts,
    updatedAt: entry.updatedAt || isoDate(mod.updatedAt),
  }
}

/**
 * 审核原因取当前语言的那一份。
 *
 * 索引里的 `moderationReason` / `delistReason` 是 `{ zh, en }`（`build-index.mjs` 原样发布
 * 控制台填的两栏），早期数据则可能是纯字符串。口径与更新说明一致（见 lib/release-notes.ts）：
 * 中文取 zh、其余语言取 en，缺哪边就用另一边兜底。**不能只判断是不是字符串** —— 那样整个
 * 对象会被丢掉，界面上就是「下架 / 拒绝收录的说明理由不显示」。
 */
export function localizedReason(
  value: LocalizedReason | undefined,
  locale: LocaleCode = getActiveLocale()
): string {
  if (typeof value === "string") return value.trim()
  if (!value || typeof value !== "object") return ""
  const zh = typeof value.zh === "string" ? value.zh.trim() : ""
  const en = typeof value.en === "string" ? value.en.trim() : ""
  return locale === "zh" ? zh || en : en || zh
}

/** 「我创建的」条目叠加到已有视图模型上 */
export function applyMine(
  entry: ModEntry,
  item: RawMyModItem,
  locale: LocaleCode = getActiveLocale()
): ModEntry {
  const review = reviewStateOf(item.status)
  const next: ModEntry = {
    ...entry,
    name: item.displayName || entry.name,
    cat: item.category || entry.cat,
    sizeMB: item.sizeBytes ? toMB(item.sizeBytes) : entry.sizeMB,
    updatedAt: entry.updatedAt || isoDate(item.updatedAt),
    mine: true,
    review,
  }
  const note = localizedReason(item.moderationReason, locale)
  if (note.length > 0) next.reviewNote = note
  if (typeof item.reviewPrState === "string" && item.reviewPrState.length > 0) {
    next.reviewPrState = item.reviewPrState
  }
  if (typeof item.reviewPrNumber === "string" && item.reviewPrNumber.length > 0) {
    next.reviewPrNumber = item.reviewPrNumber
  }
  return next
}

/** 合并三个来源；同 id 后面的来源覆盖前面的字段 */
export function buildMods(input: {
  list?: RawModList | null
  market?: RawMarketList | null
  mine?: RawMyMods | null
  /** 提交台账：作者自己的逐版本记录，用来补「版本历史」 */
  submissions?: RawSubmissionItem[] | null
  /** 当前界面语言：审核原因按它取 zh / en（与更新说明同口径） */
  locale?: LocaleCode
}): ModEntry[] {
  const byId = new Map<string, ModEntry>()

  for (const mod of input.market?.mods ?? []) {
    if (!mod || typeof mod.id !== "string" || !mod.id) continue
    byId.set(mod.id, fromMarket(mod))
  }

  for (const mod of input.list?.mods ?? []) {
    const id = mod.id || mod.folder
    if (!id) continue
    const previous = byId.get(id) ?? { ...baseEntry(id), inMarket: false }
    byId.set(id, applyLocal(previous, mod))
  }

  for (const item of input.mine?.items ?? []) {
    if (!item?.id) continue
    const previous = byId.get(item.id) ?? { ...baseEntry(item.id), inMarket: false }
    byId.set(item.id, applyMine(previous, item, input.locale))
  }

  // 版本历史：作者自己的逐版本台账最全（本地草稿、审核中、没上架的版本都在里面），
  // 台账里没有的 id 才退回索引带的那一份
  for (const [id, entry] of byId) {
    const fromLedger = submissionChangelog(input.submissions ?? undefined, id)
    if (fromLedger.length > 0) byId.set(id, { ...entry, changelog: fromLedger })
  }

  // 市场最新版本：**严格高于**本地版本才挂「可更新」。
  // 只比「不一样」会把降级当成升级（本地 1.0.5、市场 1.0.4 时挂出 1.0.5 → 1.0.4，2026-09-30 报障）。
  const marketVersion = new Map<string, string>()
  for (const mod of input.market?.mods ?? []) {
    if (mod?.id) marketVersion.set(mod.id, mod.version || "")
  }
  return [...byId.values()].map((entry) => {
    const latest = marketVersion.get(entry.id)
    if (!latest) return entry
    if (!entry.installed) return { ...entry, latest: undefined }
    return {
      ...entry,
      latest: compareVersions(latest, entry.version) > 0 ? latest : undefined,
    }
  })
}

/** 已经有源码仓库的模组 id（提交台账里 sourceRepo 非空，或索引里已上架过） */
export function sourceRepoIds(
  mine: RawMyMods | null | undefined,
  submissions: RawSubmissionItem[] | undefined,
  localMods?: { id?: string; sourceRepo?: string }[] | null
): string[] {
  const ids = new Set<string>()
  for (const item of mine?.items ?? []) {
    if (item.sourceRepo) ids.add(item.id)
  }
  for (const item of submissions ?? []) {
    if (item.sourceRepo) ids.add(item.id)
  }
  // 本地模组目录里的 .evejs-source.json（scan 读出来的 mod.sourceRepo）同样是「已经有源码仓库」的凭据：
  // 台账只记得住发布成功的那一版，换过数据目录 / 清过 cache 之后就缺了，只认台账会导致
  // 每次发布都会重开一条「版本审核 PR」，但**建仓库**这一步不该重复做
  //（2026-09-28 报障：发布过却说没提交过审核）。
  for (const mod of localMods ?? []) {
    if (mod?.id && mod.sourceRepo) ids.add(mod.id)
  }
  return [...ids]
}

/** 某模组最近一次提交台账（没有就 null） */
export function latestSubmission(
  submissions: RawSubmissionItem[] | undefined,
  id: string
): RawSubmissionItem | null {
  const matches = (submissions ?? []).filter((item) => item.id === id)
  if (matches.length === 0) return null
  return matches.reduce((best, item) => (item.createdAt > best.createdAt ? item : best))
}

/** 列表里所有分类（按出现顺序去重），给筛选下拉用 */
export function categoriesOf(mods: ModEntry[]): string[] {
  const seen: string[] = []
  for (const mod of mods) {
    if (mod.cat && !seen.includes(mod.cat)) seen.push(mod.cat)
  }
  return seen
}
