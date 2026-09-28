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
import type {
  RawMarketList,
  RawMarketMod,
  RawMod,
  RawModList,
  RawMyModItem,
  RawMyMods,
  RawSubmissionItem,
} from "./ipc"
import type { ModEntry, ModReviewState } from "./mock"

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
    readme: Array.isArray(mod.readme) ? mod.readme : [],
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

/** 「我创建的」条目叠加到已有视图模型上 */
export function applyMine(entry: ModEntry, item: RawMyModItem): ModEntry {
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
  const note = item.moderationReason
  if (typeof note === "string" && note.length > 0) next.reviewNote = note
  return next
}

/** 合并三个来源；同 id 后面的来源覆盖前面的字段 */
export function buildMods(input: {
  list?: RawModList | null
  market?: RawMarketList | null
  mine?: RawMyMods | null
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
    byId.set(item.id, applyMine(previous, item))
  }

  // 市场最新版本：与本地版本不同才挂「可更新」
  const marketVersion = new Map<string, string>()
  for (const mod of input.market?.mods ?? []) {
    if (mod?.id) marketVersion.set(mod.id, mod.version || "")
  }
  return [...byId.values()].map((entry) => {
    const latest = marketVersion.get(entry.id)
    if (!latest) return entry
    if (!entry.installed) return { ...entry, latest: undefined }
    return { ...entry, latest: latest !== entry.version ? latest : undefined }
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
