/**
 * 模组页的纯逻辑：冲突判定、审核读数、市场筛选、版本号推导。
 * 与 React 无关，方便单独验证；组件只负责渲染。
 */
import { pinyin } from "pinyin-pro"

import { t } from "@/lib/i18n"
import type { RawModPreflightReport } from "@/lib/ipc"
import {
  GAME_VERSIONS,
  type ModEntry,
  type ModReview,
  type ModReviewState,
} from "@/lib/mock"

/* ---------------- 分类与筛选 ---------------- */

/** 模组分类白名单（数据源里的 cat 取值） */
export const MOD_CATEGORIES = ["玩法", "经济", "AI", "画面", "工具"] as const

/** 分类筛选的「全部」哨兵值 */
export const ALL_CATEGORY = "all"

/* ---------------- 建骨架：模板与标识 ---------------- */

/**
 * 骨架落盘的四个文件：对齐现役版的 TEMPLATE_FILES，
 * 也是「将生成」预览与后端 `mods:templates` 里的同一份清单。
 */
export const SKELETON_FILES = [
  "evejs-launcher.mod.json",
  "loader.js",
  "README.md",
  "CHANGELOG.md",
]

/**
 * 模板卡片要展示的字段。真值来自后端 `mods:templates`（名称 / 说明 / 文件清单 / 体积），
 * 这份结构让没有后端时的纯前端预览也能用同一套渲染。
 */
export interface ModTemplateCard {
  id: string
  name: string
  desc: string
  /** 生成的文件（相对模组根） */
  files: string[]
  /** 文件个数；后端给了就用后端的 */
  fileCount?: number
  /** 骨架落盘的真实体积（字节），后端按示例 draft 算出来的参考值 */
  sizeBytes?: number
}

/**
 * 没有后端时的兜底模板（纯前端预览用）：名称与文件清单与后端
 * `scaffold.rs::SCAFFOLD_TEMPLATES` 对齐。有后端时一律以后端 `mods:templates` 为准。
 */
export const FALLBACK_MOD_TEMPLATES: ModTemplateCard[] = [
  {
    id: "broadcast",
    name: "Welcome Broadcast (Example)",
    desc: "加载模组后会在游戏本地聊天框看到一条「欢迎回来，飞行员」的信息。",
    files: SKELETON_FILES,
  },
  {
    id: "blank",
    name: "Blank Skeleton",
    desc: "同样的加载骨架，业务逻辑留空，适合从零写起",
    files: SKELETON_FILES,
  },
]

/** 字节数写成一眼能读的量级；拿不到就画破折号，不编数字 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 模板卡片上的体积读数：N 个文件 · 约 6.2 KB（后端没给体积时只报文件数） */
export function templateSizeLabel(template: ModTemplateCard): string {
  const count = template.fileCount ?? template.files.length
  const bytes = template.sizeBytes ?? 0
  return bytes > 0
    ? t("{count} 个文件 · 约 {size}", { count, size: formatBytes(bytes) })
    : t("{count} 个文件", { count })
}

/**
 * 标识（目录名）的固定命名空间：界面上写作 `EVEJS-`，磁盘上统一小写 `evejs-`。
 * 作者只填后面那一段，拼出来的完整 id 就是模组目录名。
 */
export const EVEJS_ID_PREFIX = "EVEJS-"
export const EVEJS_ID_PREFIX_LC = "evejs-"

/** 作者自己输入的那一段只允许小写字母、数字与短横 */
export const MOD_ID_PATTERN = /^[a-z0-9-]+$/

/**
 * 从模组名派生标识（目录名那一段）：名字里本来就有拉丁字母数字就照旧用它
 * （老数据 `sansha-incursion` 就是这么来的），否则把中文转成拼音音节。
 * 一个可用字符都推不出来时返回空串，由表单拦住提交。
 */
export function modIdFromName(name: string): string {
  const direct = slugifyModId(name)
  if (direct) return direct
  const syllables = pinyin(name, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
  })
  return slugifyModId(syllables.join(" "))
}

/** 完整标识：`evejs-` + 作者输入 */
export function withEvejsPrefix(userPart: string): string {
  return `${EVEJS_ID_PREFIX_LC}${userPart}`
}

/** 已有模组的标识是不是这套命名空间（老模组可能是 `mod-xxx`） */
export function hasEvejsPrefix(id: string): boolean {
  return id.toLowerCase().startsWith(EVEJS_ID_PREFIX_LC)
}

/** 把完整标识拆回作者输入那一段（没有前缀的老模组原样返回） */
export function stripEvejsPrefix(id: string): string {
  return hasEvejsPrefix(id) ? id.slice(EVEJS_ID_PREFIX_LC.length) : id
}

/**
 * 标识那一段的问题描述：没问题返回 null。
 * 表单里的内联提醒与提交前的校验共用这一份，两处口径不会跑偏。
 */
export function modIdIssue(userPart: string): string | null {
  if (!userPart) return "请填写模组标识"
  if (userPart.startsWith("-") || userPart.endsWith("-")) {
    return "模组标识不能以短横开头或结尾"
  }
  if (!MOD_ID_PATTERN.test(userPart)) {
    return "模组标识只能包含小写字母、数字与短横"
  }
  return null
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

export type ModTab = "installed" | "preflight" | "mine" | "market"

/* ---------------- 上架与冲突 ---------------- */

export const FALLBACK_CONFLICT_REASON =
  "两者注册了同一份运行时钩子，同时启用会互相覆盖。"

/**
 * 是否已上架到市场（决定它出不出现在「模组市场」页签、以及能不能点安装）。
 *
 * 只认一件事：**这条在不在市场索引里**。
 *   - `inMarket === false`：本地扫到、索引里没有（自己塞进 mods/ 的第三方包）→ 未上架；
 *   - `inMarket === true`：索引里挂着它就是上架了 —— 不能再拿本机审核状态去否掉它。
 *     「我创建的」里那条台账记录（status=draft）说的是「我手里这一版还没提交」，
 *     不是「市场里那一版没上架」。2026-09-28 报障：作者自己的 evejs-automining 明明
 *     在市场里可安装，却被本地台账的 draft 顶掉审核状态 → 市场页签只剩 2 条（索引里 3 条），
 *     连安装按钮一起没了。删掉的那条 `review` 判定还会误伤「新版本审核中、旧版仍在架」。
 *   - `undefined`：原型/演示数据，按老语义走（不传就算是已上架）。
 */
export function isPublished(mod: ModEntry): boolean {
  if (mod.inMarket === false) return false
  if (mod.inMarket === true) return true
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

/* ---------------- 疑似重叠（改同一份服务端文件 / 撞同一个注入标记） ---------------- */

export interface OverlapMarkerRef {
  folder: string
  id: string
}

export interface OverlapMarker {
  /** 服务端相对路径，例如 src/network/tcp/handshake.js */
  target: string
  /** 补丁脚本里声明的注入标记，例如 // evejs-inject:login-reward */
  marker: string
  /** 引用它的模组（folder 是本地 mods/ 目录名，id 是清单里的标识） */
  mods: OverlapMarkerRef[]
}

export interface OverlapReport {
  /** 同文件 + 同标记：后注册的那个会被静默跳过，只有一个能生效 */
  markers: OverlapMarker[]
  /** 只是被多个模组改同一份服务端文件（标记不同，能共存）的处数 */
  sharedOnly: number
  /** 卷进标记冲突的模组（folder || id）：卡片右上角要打红标 */
  conflictKeys: string[]
  /** 只是和别人改了同一份服务端文件的模组（folder || id）：卡片上打黄标 */
  sharedKeys: string[]
}

/**
 * 从启动前预检的静态回包里挑出「疑似重叠」。
 *
 * 重叠 ≠ 冲突：多个模组改同一份服务端文件是**设计允许**的 —— 注入总线按 slot 依次串链，
 * 每一层只往末尾追加自己那一段。真正会互相顶掉的只有一种：**同一份文件 + 同一个注入标记**，
 * 后注册的那层看到标记已经在源码里，就整段跳过自己，既不报错也不生效。
 *
 * 所以这里把两类分开：`markers` 能定位到具体模组，界面才敢让用户「停用其中一个」；
 * `sharedOnly` 只是个计数，只做提示、不催用户动手。已被标记冲突覆盖的文件不重复计入。
 */
export function overlapReport(report: RawModPreflightReport | null): OverlapReport {
  const markers: OverlapMarker[] = []
  const covered = new Set<string>()
  const conflictKeys: string[] = []
  const sharedKeys: string[] = []
  for (const row of report?.markerConflicts ?? []) {
    const mods = (row.mods ?? []).filter((item) => item && (item.folder || item.id))
    if (mods.length < 2) continue
    covered.add(row.target)
    for (const ref of mods) {
      const key = ref.folder || ref.id
      if (!conflictKeys.includes(key)) conflictKeys.push(key)
    }
    markers.push({ target: row.target, marker: row.marker, mods })
  }
  let sharedOnly = 0
  for (const item of report?.targets ?? []) {
    if (!item.shared || covered.has(item.file)) continue
    sharedOnly += 1
    for (const ref of item.mods ?? []) {
      const key = ref.folder || ref.id
      if (conflictKeys.includes(key) || sharedKeys.includes(key)) continue
      sharedKeys.push(key)
    }
  }
  return { markers, sharedOnly, conflictKeys, sharedKeys }
}

/** 按 (folder, id) 在模组列表里找本地记录；找不到（例如已停用、清单缺失）就返回 null */
export function modByFolderOrId(
  mods: ModEntry[],
  ref: OverlapMarkerRef
): ModEntry | null {
  return (
    mods.find((item) => Boolean(item.folder) && item.folder === ref.folder) ??
    mods.find((item) => item.id === ref.id) ??
    null
  )
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

/**
 * 从评论列表本身算聚合分。
 *
 * 服务端的聚合表（`ratings.json`）与模组分片用的是**同一份 SQL、同一个 hidden 过滤**，
 * 所以分片里就是该模组的全部评价，两者口径逐字一致。差别在时效：分片在写完评价后
 * 立刻重算（Worker 里 `ctx.waitUntil(rebuildSnapshots)`），聚合表要等索引下一次刷新 ——
 * 拿分片算，用户刚投的那一票马上就能在汇总行看到，不会「打了分平均分不动」。
 */
export function ratingFromReviews(
  reviews: ModReview[]
): Pick<ModEntry, "ratingAvg" | "ratingCount" | "ratingHistogram"> {
  const histogram = [0, 0, 0, 0, 0]
  let sum = 0
  let count = 0
  for (const review of reviews) {
    const stars = Math.round(review.stars)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) continue
    histogram[stars - 1] += 1
    sum += stars
    count += 1
  }
  return {
    ratingAvg: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
    ratingCount: count,
    ratingHistogram: histogram,
  }
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
  // 真令牌不回填明文：界面上只报「已在盘上」，不假装知道它的样子
  if (cred.kind === "pat") return cred.token ? maskToken(cred.token) : "GitHub 令牌 · 已保存"
  const left = minutesLeft(cred, now)
  return left > 0 ? t("设备授权 · 剩余 {minutes} 分钟", { minutes: left }) : "设备授权 · 已过期"
}

/* ---------------- 发布前置条件 ---------------- */

/**
 * 署名输入框里的占位提示：只是告诉你这里填什么，不是默认值——
 * 署名一开始就是空的，谁的名字也不会预先替你填上。
 *
 * 后端给「没填过」的历史身份也留了同一串字（`src-tauri/src/author.rs` 的 DEFAULT_NAME），
 * 它跟占位提示是同一个字符串：读回来一律按「还没填」处理，见 signatureDraft。
 */
export const AUTHOR_NAME_PLACEHOLDER = "指挥官"

/** 名字是不是后端给「还没填写」身份用的默认署名。 */
export function usesDefaultSignature(name: string): boolean {
  return name.trim() === AUTHOR_NAME_PLACEHOLDER
}

/**
 * 输入框里该显示成什么：占位提示这串字不算真署名。
 *
 * 后端把「没填过」的默认名写成了同一个字符串，这里要认出来还原成空 ——
 * 否则输入框里显示的就是一个替你填好的预设，而不是灰色占位提示。
 */
export function signatureDraft(name: string): string {
  const trimmed = name.trim()
  return usesDefaultSignature(trimmed) ? "" : trimmed
}

/** 署名填过没有：空白不算填，占位提示也不算 */
export function hasOwnSignature(name: string): boolean {
  return signatureDraft(name).length > 0
}

/** 本地还没填署名时，先挂这个名顶在作者栏上，别留下一片空白 */
export const UNSIGNED_AUTHOR = "未署名"

/** 用在作者栏、评价、回复上的名字：署名没填就退回「未署名」 */
export function displayAuthor(name: string): string {
  return signatureDraft(name) || UNSIGNED_AUTHOR
}

/**
 * 同一模组两次提交之间的最短间隔：与 Rust 侧 `SUBMIT_COOLDOWN_MS` 一致（改一边记得改另一边）。
 * 目的是防止连着重复提交 —— 同一版反复点会刷新同一条 PR、也会重复推 Release。
 */
export const SUBMIT_COOLDOWN_MS = 30 * 60 * 1000

/** 距下次可提交还剩多少毫秒；0＝现在就能提交。计时起点是上次**成功**开 PR 的时间。 */
export function submitCooldownRemaining(
  submission: { submittedAt?: number } | undefined | null,
  now: number
): number {
  const at = submission?.submittedAt
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return 0
  return Math.max(0, SUBMIT_COOLDOWN_MS - Math.max(0, now - at))
}

/**
 * 两次发布之间的最短间隔：60 秒。与 Rust 侧 `PUBLISH_INTERVAL_MS` 一致（改一边记得改另一边）。
 *
 * 和上面那条「同一模组 30 分钟」不是一个维度：那条管的是反复提交同一个模组，这条管的是
 * **连着发布**（不同模组也算）—— 一次发布要打包、推仓库、建 Release、传 ZIP、开审核 PR，
 * 紧接着再发一次会撞上 GitHub 限流，两条 PR 还会抢同一次索引重建。
 * 计时起点是上一次发布**走完**的时刻。
 */
export const PUBLISH_INTERVAL_MS = 60 * 1000

/** 距可以再次发布还剩多少毫秒；0＝现在就能发。`at`＝上一次发布走完的时刻。 */
export function publishIntervalRemaining(
  at: number | null | undefined,
  now: number
): number {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return 0
  return Math.max(0, PUBLISH_INTERVAL_MS - Math.max(0, now - at))
}

/** 秒级间隔说成人话：60 秒这种粒度用分钟会算成「还剩约 1 分钟」，等于没说 */
export function intervalText(remainingMs: number): string {
  return t("还剩 {seconds} 秒", { seconds: Math.max(1, Math.ceil(remainingMs / 1000)) })
}

/** 冷却剩余时间说成人话 */
export function cooldownText(remainingMs: number): string {
  return t("还剩约 {minutes} 分钟", { minutes: Math.max(1, Math.ceil(remainingMs / 60000)) })
}

/** 审核 PR 的状态说法：后端复查回来的 `reviewPrState` */
export function reviewPrStateLabel(state: string | undefined | null): string {
  if (state === "merged") return "已合并"
  if (state === "closed") return "PR 已关闭"
  if (state === "open") return "审核中"
  return "状态未确认"
}

/** 默认署名只允许本地创建与测试，发布到市场前必须去改掉。 */
export const DEFAULT_SIGNATURE_PUBLISH_HINT =
  "默认署名「指挥官」只用于本地测试，不能发布到市场；请先改成你自己的署名。"

/** 提交前必须解决的一件事：说清缺什么、去哪补 */
export interface PublishBlocker {
  id: "signature" | "token" | "cooldown" | "interval"
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
  cooldownMs,
  intervalMs,
}: {
  credential: PublishCredential | null
  name: string
  now: number
  /** 距上次提交还差多少毫秒（0/空＝不受限） */
  cooldownMs?: number
  /** 距上次发布走完还差多少毫秒（0/空＝不受限）：两次发布之间的 60 秒间隔 */
  intervalMs?: number
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = []
  if (typeof cooldownMs === "number" && cooldownMs > 0) {
    blockers.push({
      id: "cooldown",
      label: "提交间隔",
      title: "距上次提交不到 30 分钟",
      hint: t("同一个模组两次提交至少间隔 30 分钟，{left}再试。", {
        left: cooldownText(cooldownMs),
      }),
    })
  }
  if (typeof intervalMs === "number" && intervalMs > 0) {
    blockers.push({
      id: "interval",
      label: "发布间隔",
      title: "距上次发布不到 60 秒",
      hint: t("两次发布之间至少间隔 60 秒（{left}）再试。", {
        left: intervalText(intervalMs),
      }),
    })
  }
  if (!hasOwnSignature(name)) {
    const defaultSignature = usesDefaultSignature(name)
    blockers.push({
      id: "signature",
      label: "署名",
      title: "还没填署名",
      hint: defaultSignature
        ? t(DEFAULT_SIGNATURE_PUBLISH_HINT)
        : "署名会印在模组的作者栏上，先在「令牌配置」里填上你自己的署名。",
    })
  }
  if (!isCredentialLive(credential, now)) {
    blockers.push({
      id: "token",
      label: "发布凭据",
      title: credential ? "GitHub 令牌已过期" : "还没配置 GitHub 令牌",
      // 「发布凭据」和「GitHub 令牌」是两个叫法一件事，这里把话说明白
      hint: credential
        ? "发布凭据就是你那把 GitHub 令牌，已经过期了，在「令牌配置」里重新授权一次。"
        : "发布凭据就是你自己的 GitHub 令牌：源码要推到你名下的仓库，先在「令牌配置」里配好。",
    })
  }
  return blockers
}

/* ---------------- 提交发布流水线 ---------------- */

/**
 * 提交一版模组要走的环节：
 *   ① 打包（离线）→ ② 推到**作者自己名下的 GitHub 仓库**（建仓库 + 发 Release + 上传 ZIP）
 *   → ③ 往索引仓库提一条**版本审核 PR**（更新 `mods/<id>.json` 分片；首次的 PR 里
 *   还多一份 `sources.json` 收录登记）。合并之后索引 CI 重建，市场才换到这一版。
 * credLive 由提交前的前置检查保证为真，留着这个参数是为了把环节算得明白。
 */
export type PublishStageId = "pack" | "repo" | "upload" | "register"

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
  pack: { pending: "本地打包安装包", running: "正在打包", done: "安装包已生成" },
  repo: { pending: "准备你的源码仓库", running: "正在准备仓库", done: "仓库已就绪" },
  upload: {
    pending: "发布 Release 并上传安装包",
    running: "正在上传安装包",
    done: "Release 已发布",
  },
  register: {
    pending: "提交版本审核 PR",
    running: "正在提交审核 PR",
    done: "版本审核 PR 已提交",
  },
}

/**
 * 这一次提交实际要走的环节。
 * 作者的源码仓库按模组建：这个模组还没推过源码就先建仓库，推过就只推新版本；
 * 但**每一版**最后都要往索引仓库提一条版本审核 PR —— 合并后市场才更新。
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
    // 每一版都提（首次的 PR 里多一份 sources.json 收录登记）
    ids.push("register")
  }
  return ids.map((id) => ({ id, ...STAGE_TEXT[id] }))
}

/**
 * 作者自己的源码仓库：一个模组一个仓库，仓库名跟着模组 id。
 * 真用户名要等发布回包里带出来，所以这里 owner 可传；没传就按「你的 GitHub 账号」说话，
 * 不拿原型里的占位账号冒充用户。
 */
export function sourceRepo(modId: string, owner?: string): string {
  return `${owner && owner.trim() ? owner.trim() : t("你的 GitHub 账号")}/${modId}`
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
  if (days <= 30) return t("{days} 天前", { days })
  if (days < 365)
    return t("{months} 个月前", { months: Math.min(11, Math.max(1, Math.round(days / 30))) })
  return t("{years} 年前", { years: Math.max(1, Math.round(days / 365)) })
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
  // 默认勾上：建完就生成 loader.js（可加载的模组），不勾才是 loader.js.disabled。
  // 按维护者要求改过默认值：新建模组默认启用，省掉「建完还得去列表里启用一次」这一步。
  enableAfterCreate: true,
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

/**
 * 列表里只占一行的简介：超过 60 字（SAFE_DESC_LENGTH）截断并补省略号。
 * 「发布到市场」的模组清单一行放不下更多，全文字挂在行的 title 上，
 * 鼠标停上去仍能看到完整简介。
 */
export function clampDesc(text: string | undefined | null, limit = SAFE_DESC_LENGTH): string {
  const trimmed = (text ?? "").trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) + "…" : trimmed
}

/** 创建表单的报错：第二行用来补充说明，没内容就不显示 */
export interface NewModError {
  message: string
  detail?: string
}

/**
 * 创建表单的校验：`id` 传作者自己填的那一段（不含 EVEJS- 前缀），
 * 返回第一条错误，没问题返回 null。
 */
export function validateNewMod(
  input: { name: string; id: string },
  existingIds: string[]
): NewModError | null {
  if (!input.name.trim()) return { message: "请填写模组名" }
  const part = input.id.trim()
  if (!part) {
    return {
      message: "这个模组名推不出可用的标识",
      detail: "名字里要有字母、数字或中文；中文会自动转成拼音。",
    }
  }
  const issue = modIdIssue(part)
  if (issue) {
    return issue === "模组标识只能包含小写字母、数字与短横"
      ? { message: issue, detail: "中文、大写字母、空格与下划线都不行。" }
      : { message: issue }
  }
  const fullId = withEvejsPrefix(part)
  if (existingIds.includes(fullId)) {
    return {
      message: "这个标识已经被占用了",
      detail: t("{id} 已在本地模组库里，换个模组名再试。", { id: fullId }),
    }
  }
  return null
}

/** 标签输入：逗号、中文逗号或空白分隔，去空去重，最多 5 个 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,，\s]+/)) {
    const item = part.trim()
    if (item) seen.add(item)
  }
  return [...seen].slice(0, 5)
}

/** 关联模组 id：逗号、中文逗号或空白分隔，去空去重；不设上限。 */
export function parseIdList(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,，\s]+/)) {
    const item = part.trim()
    if (item) seen.add(item)
  }
  return [...seen]
}

/* ---------------- 加载顺序（已安装页） ---------------- */

/**
 * 已安装页的展示分组：启用的排在前面、停用的排在后面，两段内部都保持用户设定的顺序。
 *
 * 只影响「怎么显示」。**加载顺序永远取用户那一份完整顺序**，跟启不启用无关 ——
 * 所以关掉一个模组不用手动重排，重新打开它还会回到原来的位置。
 */
export function groupByEnabled(mods: ModEntry[]): ModEntry[] {
  const enabled: ModEntry[] = []
  const disabled: ModEntry[] = []
  for (const mod of mods) (mod.enabled ? enabled : disabled).push(mod)
  return [...enabled, ...disabled]
}

/**
 * 拖拽落位：把 `id` 挪到 `targetId` 的前面或后面，其余保持原序。
 * 任一 id 不在列表里就原样返回 —— 不猜、不吞。
 */
export function moveWithin(
  list: string[],
  id: string,
  targetId: string,
  after: boolean
): string[] {
  if (id === targetId) return list
  const target = list.indexOf(targetId)
  if (!list.includes(id) || target < 0) return list
  const next = list.filter((item) => item !== id)
  const at = next.indexOf(targetId)
  next.splice(after ? at + 1 : at, 0, id)
  return next
}

/**
 * 把「启用段拖过之后的新顺序」合并回完整顺序。
 *
 * 做法：停用的条目**留在原位不动**，只把启用段按新顺序填回它原来占的那些槽位。
 * 这样两个诉求同时成立：
 *   - 关掉一个模组不用重排（它的槽位还在，重新打开就回原位）；
 *   - 也不会因为"停用的都排到末尾"把用户已经拖过的顺序冲掉。
 *
 * 长度对不上（调用方拿到的启用列表已经过期）就原样返回，宁可不改也不猜。
 */
export function mergeEnabledOrder(
  allIds: string[],
  enabledIds: string[],
  newEnabledOrder: string[]
): string[] {
  if (enabledIds.length !== newEnabledOrder.length) return allIds
  if (enabledIds.length === 0) return allIds
  const pool = [...newEnabledOrder]
  const enabled = new Set(enabledIds)
  return allIds.map((id) => (enabled.has(id) ? (pool.shift() ?? id) : id))
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
export const FEATURES_HEADING = "功能要点"
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
  // 「启动预检」页签没有模组清单，内容全在面板里
  if (tab === "preflight") pool = []
  else if (tab === "installed") pool = mods.filter((mod) => mod.installed)
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

/**
 * 版本号比较：逐段比数字、短的一侧补 0，预发布视为小于正式版。
 *
 * 口径与外壳的 `mods::registry::compare_version`、以及现役 Electron 版的 `compareVersion`
 * 一致，免得渲染层和外壳对「有没有新版」给出互相打架的答案。
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const trimmed = value.trim().replace(/^[vV]/, "")
    const dash = trimmed.indexOf("-")
    const core = dash >= 0 ? trimmed.slice(0, dash) : trimmed
    const pre = dash >= 0 ? trimmed.slice(dash + 1) : ""
    // 非数字段取前缀数字（"12abc" → 12），整段没数字按 0，对齐 Number.parseInt 的容错
    const nums = core.split(".").map((part) => {
      const parsed = Number.parseInt(/^\d+/.exec(part)?.[0] ?? "", 10)
      return Number.isNaN(parsed) ? 0 : parsed
    })
    return { nums, pre }
  }
  const a = parse(left)
  const b = parse(right)
  const width = Math.max(a.nums.length, b.nums.length)
  for (let index = 0; index < width; index += 1) {
    const lhs = a.nums[index] ?? 0
    const rhs = b.nums[index] ?? 0
    if (lhs !== rhs) return lhs < rhs ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * 是否存在可安装的新版本：已安装、市场有这一条、且市场版本**严格高于**本地版本。
 *
 * 不能只判断「两边版本不一样」（2026-09-30 报障）：本地比市场新时（作者本机是 1.0.5、
 * 市场还停在 1.0.4），旧写法会挂出「有新版本 1.0.5 → 1.0.4」，还把「更新」按钮接成了降级。
 */
export function hasUpdate(mod: ModEntry): boolean {
  return (
    mod.installed &&
    mod.latest !== undefined &&
    compareVersions(mod.latest, mod.version) > 0
  )
}

/** 某个模组在市场上的目标版本：有新版就装新版 */
export function targetVersionOf(mod: ModEntry): string {
  return mod.latest ?? mod.version
}

/**
 * 已安装、且市场登记的那一版与本地不一致时，返回市场那一版；一致 / 未安装 / 市场没有这条 → undefined。
 *
 * version 在已安装时是本地那一版（见 mod-source.buildMods），市场那一版另存在 marketVersion。
 * 不并列显示的话，「本机 1.0.10、市场还停在 1.0.7」在界面上只剩一个数字，作者没法判断市场
 * 到底收没收到新版本（2026-09-30 报障）。
 */
export function marketVersionDiff(mod: ModEntry): string | undefined {
  if (!mod.installed || !mod.marketVersion || !mod.version) return undefined
  return compareVersions(mod.marketVersion, mod.version) === 0 ? undefined : mod.marketVersion
}

/* ---------------- 版本号 ---------------- */

/**
 * 版本号形状校验，与外壳 `mods::scaffold::is_semver_like` 同一套规则：
 * 点分数字段 + 可选的 `-预发布` / `+构建` 尾巴。弹窗先挡一道，免得白跑一次打包。
 */
export function isSemverLike(version: string): boolean {
  const separator = version.search(/[-+]/)
  const head = separator === -1 ? version : version.slice(0, separator)
  const tail = separator === -1 ? null : version.slice(separator + 1)
  if (!head) return false
  if (!head.split(".").every((part) => /^[0-9]+$/.test(part))) return false
  if (tail === null) return true
  return tail.length > 0 && /^[0-9A-Za-z.-]+$/.test(tail)
}

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

/** 卡片上的重叠标记：真冲突（同文件 + 同标记）压过只是重叠 */
export type OverlapFlag = "conflict" | "shared"

/** 这条模组在预检里的重叠状态；没它的事就返回 null（卡片不打标） */
export function overlapFlag(report: OverlapReport, mod: ModEntry): OverlapFlag | null {
  const key = mod.folder ?? mod.id
  if (report.conflictKeys.includes(key)) return "conflict"
  if (report.sharedKeys.includes(key)) return "shared"
  return null
}
