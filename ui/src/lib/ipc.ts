/**
 * window.api 的薄封装。
 *
 * 这层桥由 Rust 侧 initialization_script 注入（ui/src/api-shim.js，由 scripts/gen-contract.mjs 生成），
 * 通道清单与参数形状见 docs/ipc-contract.md。这里只做三件事：找桥、调用、订阅事件。
 *
 * 为什么要「找不到桥就返回 null」而不是直接 throw：同一个 UI 也要能在浏览器里跑
 * （npm run dev、原型对照），那时网页不在 Tauri WebView 里，没有 window.api。
 * 调用方拿到 null 就退回原型自带的演示数据，而不是整页崩掉。
 */

import { t } from "@/lib/i18n"

type ApiFn = (...args: unknown[]) => unknown

interface LauncherApi {
  [name: string]: ApiFn | undefined
}

/** 取消订阅：与 @tauri-apps/api 的 unlisten 同形 */
export type Unlisten = () => void

function bridge(): LauncherApi | null {
  if (typeof window === "undefined") return null
  const candidate = (window as unknown as { api?: LauncherApi }).api
  return candidate && typeof candidate === "object" ? candidate : null
}

/** 当前是否跑在 Tauri 宿主里（真实启动器窗口） */
export function hasIpc(): boolean {
  return bridge() !== null
}

/**
 * 调一个通道。桥不在、或这个入口不存在时抛错 —— 调用方要么用 callOr 兜底，
 * 要么显式接住并告知用户「这一步需要真实启动器环境」。
 */
export async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const api = bridge()
  const fn = api?.[name]
  if (typeof fn !== "function") {
    throw new Error(t("window.api.{name} 不可用（当前不在启动器里？）", { name }))
  }
  return (await fn.apply(api, args)) as T
}

/** 调一个通道，失败/无桥时给兜底值：只读类调用用这个，别让一次失败掀翻整页 */
export async function callOr<T>(
  name: string,
  fallback: T | null,
  ...args: unknown[]
): Promise<T | null> {
  try {
    const value = await call<T>(name, ...args)
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** 订阅一个事件通道；桥不在时返回空操作，调用方不用写分支 */
export function subscribe(name: string, handler: (...args: unknown[]) => void): Unlisten {
  const api = bridge()
  const fn = api?.[name]
  if (typeof fn !== "function") return () => {}
  const result = fn.call(api, handler)
  if (typeof result === "function") return result as Unlisten
  return () => {}
}

/* ------------------------------------------------------------------
   通道返回形状（来自真机探针 .parity-out/s9-probe，见 docs/S9 记录）
   ------------------------------------------------------------------ */

/** services:list 与 services:changed 的元素 */
export interface RawService {
  id: string
  name: string
  /** idle | starting | running | stopping | error */
  state: string
  pid?: number | null
  message?: string | null
  /** 进程第一次被记录的时刻（毫秒）：运行时长由它算；端口被外部占用时是 null */
  startedAt?: number | null
  /** 占整机 CPU 的百分比：后端采样间隔不够时是 null（界面画 —） */
  cpuPercent?: number | null
  /** 进程内存（MB） */
  memMB?: number | null
}

/** metrics:get */
export interface RawMetrics {
  cpuPercent: number
  memUsedGB: number
  memTotalGB: number
  virtualMemUsedGB: number
  virtualMemTotalGB: number
  diskRoot: string
  diskUsedGB: number
  diskTotalGB: number
  netBytesPerSec: number
  onlinePlayers: number | null
  gpuPercent: number | null
  gpuDedicatedUsedGB: number | null
  gpuDedicatedTotalGB: number | null
  gpuSharedUsedGB: number | null
  gpuMemoryUsedGB: number | null
  gpuMemoryTotalGB: number | null
  volumes: { root: string; usedGB: number; totalGB: number; freeGB: number; percent: number }[]
}

/** log:read：服务端主日志（server/logs/server.log）的原始行 */
export interface RawServerLog {
  ok: boolean
  exists: boolean
  path: string
  size: number
  mtime: number | null
  lines: string[]
}

/** env:check 的单项 */
export interface RawEnvCheck {
  key: string
  label: string
  message: string
  ok: boolean
  warn?: boolean
}

/** env:check */
export interface RawEnvReport {
  repoRoot: string
  totalCount: number
  passCount: number
  checks: RawEnvCheck[]
  node: { ok: boolean; version: string }
  sys: { level: string; message: string; memGB: number; memRaw: number; cpuThreads: number }
}

/** init:state 与 init:changed：初始化任务（自检里的「修复」走这里） */
export interface RawInitState {
  busy: boolean
  key: string | null
  label: string
  progress: number | null
}

/** 老启动器数据接管台账（app:info.legacy） */
export interface RawLegacyAdoption {
  adopted: boolean
  /** 接管过来的条目（相对 _launcher/data 的路径） */
  items: string[]
  /** 来源数据目录 */
  source: string | null
  /** 没接管的原因（隔离模式 / 无候选目录） */
  skipped: string
}

/** app:info */
export interface RawAppInfo {
  name: string
  version: string
  evejsVersion: string
  phase: string
  platform: string
  repoRoot: string
  legacy?: RawLegacyAdoption
}

/** config:get */
export interface RawConfigBundle {
  server: {
    ports: { game: number; images: number; gateway: number }
    sourceFile: string
  }
  client: {
    clientPath: string
    clientExe: string
    caPem: string
    proxyUrl: string
    safeGraphics: string
    safeWindowed: string
    sourceFile: string
  }
}

/** health:ping：游戏端口的往返时延（服务没起时 ms 为 null） */
export interface RawHealthPing {
  ok: boolean
  port: number
  ms: number | null
}

/** health:check：四个端口的存活探针 */
export interface RawHealth {
  game: boolean
  images: boolean
  gateway: boolean
  market: boolean
}

/** update:state / update:changed */
export interface RawUpdateState {
  state: string
  currentVersion: string
  latestVersion?: string
  channel?: string
  size?: number
  downloaded?: number
  percent?: number
  speed?: number
  message?: string
}
/** update:check：更新检查的真结果（含这一版的更新说明 changelog） */
export interface RawUpdateCheck {
  ok: boolean
  available: boolean
  currentVersion: string
  latestVersion?: string
  /** 更新包字节数（清单里 platforms[key].size） */
  size?: number
  /** 清单的 publishedAt */
  date?: string
  channel?: string
  /** 逐条更新说明：{ zh: [{ type, text }], en: [...] }，或单语言数组 */
  changelog?: unknown
  manifestUrl?: string
  /** ok=false 时的原因（没配更新源 / 验签不过 / 网络失败…） */
  reason?: string
}

/* ------------------------------------------------------------------
   S9b：账号 / 数据库 / 模组 / 设置（回包形状取自真机探针，见 docs/S9 记录）
   ------------------------------------------------------------------ */

/** accounts:list 的单个角色（服务端 `roles[]`） */
export interface RawRole {
  characterId: string
  characterName: string
  avatar?: string
  shipName?: string
  shipTypeID?: number
  skillPoints?: number
  isk?: number
  securityStatus?: number
  location?: {
    label?: string
    solarSystemName?: string
    stationName?: string
  }
  /** 静态数据主键：1 加达里 / 2 米玛塔尔 / 4 艾玛 / 8 盖伦特；没记录为 null */
  raceID?: number | null
  /** static characterCreationBloodlines 主键；没记录为 null */
  bloodlineID?: number | null
  /** 服务端只写 0 / 1 / 2；没记录为 null */
  gender?: number | null
  corporationID?: number | null
  corporationName?: string | null
  /** 军团短标识（tickerName）；服务端没有专属徽标时界面画它 */
  corporationTicker?: string | null
  allianceID?: number | null
  allianceName?: string | null
  /** 联盟简称（shortName）；服务端没有专属徽标时界面画它 */
  allianceTicker?: string | null
}

export interface RawAccount {
  accountId: number | string
  accountKey: string
  banned: boolean
  isGM: boolean
  hasStoredCredential: boolean
  roles: RawRole[]
}

export interface RawAccountList {
  ok: boolean
  reason?: string
  data?: RawAccount[]
}

/**
 * accounts:logotypes 的一条：军团 / 联盟的**专属**徽标。
 * dataUrl 为 null = 服务端没有这个实体的专属徽标（界面画短标识，不画兜底图）。
 */
export interface RawLogotype {
  kind: string
  id: number | string
  dataUrl: string | null
}

export interface RawLogotypeList {
  ok: boolean
  reason?: string
  data?: RawLogotype[]
}

/** accounts:checkRunning：客户端进程是否在跑（端口扫描） */
export interface RawAccountRunning {
  running: boolean
  ports?: number[]
  listening?: number[]
}

/** 写通道统一回包：{ok, reason?}，有的还带更细的字段 */
export interface RawAck {
  ok: boolean
  reason?: string
  [key: string]: unknown
}

/** database:overview 的 tables[] */
export interface RawDbTableInfo {
  name: string
  columns: number
  indexes: number
  rows: number
  sizeBytes: number
}

export interface RawDbOverview {
  ok: boolean
  reason?: string
  path: string
  sizeBytes: number
  tableCount: number
  totalRows: number
  journalMode: string
  pageCount: number
  pageSize: number
  modifiedAt: number
  tables: RawDbTableInfo[]
}

/** database:table 的列定义（直接来自 SQLite PRAGMA table_info） */
export interface RawDbColumn {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

export interface RawDbTable {
  ok: boolean
  reason?: string
  table: string
  columns: RawDbColumn[]
  primaryKeys: RawDbColumn[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
}

export interface RawDbBackup {
  name: string
  sizeBytes?: number
  createdAt?: number
}

export interface RawDbBackups {
  ok: boolean
  reason?: string
  directory: string
  backups: RawDbBackup[]
}

/** mods:list 的单个模组 */
export interface RawMod {
  id: string
  folder: string
  dir: string
  displayName: string
  version: string
  description: string
  category: string
  tags: string[]
  authorId: string
  authorName: string
  enabled: boolean
  kind: string
  valid: boolean
  supported: boolean
  error: string
  unsupportedReason: string
  signatureState: string
  signatureError: string
  signatureKeyId: string
  sizeBytes: number
  loadAfter: string[]
  loadBefore: string[]
  missingRequires: string[]
  activeConflicts: string[]
  modules: string[]
  source: string
  sourceRepo: string
  sourceVersion: string
  updatedAt: number
  /** README 正文段落（后端与上架同一套解析，作者改完立刻可见） */
  readme?: string[]
  /** README 里「功能要点」的条目 */
  highlights?: string[]
  readmePath?: string
  manifestPath?: string
}

/**
 * mods:preflight 的「被忽略的目录」：`mods/<目录>` 下没有 evejs-launcher.mod.json 时
 * 扫描器整目录跳过，界面上既不报错也不出现，必须单独列出来。
 */
export interface RawModIgnoredDir {
  folder: string
  /** nested = 清单在 subFolder 那一层（把内容挪上来即可）；no-manifest = 目录里有 loader 却没清单 */
  reasonKind: "nested" | "no-manifest" | string
  subFolder: string
  loaderFiles: string[]
  sizeBytes: number
}

export interface RawModPreflightMod {
  folder: string
  id: string
  enabled: boolean
  /** ok=基线认得当前文件；stale=声明了基线但一个都对不上（多半会静默跳过）；unknown=没声明基线；missing-file=服务端没有这份文件 */
  verdict: "ok" | "stale" | "unknown" | "missing-file" | string
  declaredFingerprints: number
}

export interface RawModPreflightTarget {
  file: string
  /** 被 ≥2 个启用中的模组引用（重叠不等于冲突，只是「疑似」） */
  shared: boolean
  mods: RawModPreflightMod[]
}

/** 同一份服务端文件 + 同一个注入标记：后注册的模组会被静默跳过，只有一个能生效 */
export interface RawModPreflightMarker {
  /** 服务端相对路径，例如 src/network/tcp/handshake.js */
  target: string
  /** 补丁脚本里声明的注入标记，例如 // evejs-inject:login-reward */
  marker: string
  /** 引用它的模组（folder 是本地 mods/ 目录名，id 是清单里的标识） */
  mods: { folder: string; id: string }[]
}

/** mods:preflight（不带 dryRun）的静态回包 */
export interface RawModPreflightReport {
  ok: boolean
  dryRun: false
  reason?: string
  root?: string
  ignored: RawModIgnoredDir[]
  targets: RawModPreflightTarget[]
  /** 同文件 + 同标记的真冲突：两边只有一个能生效，界面单独开一块提示 */
  markerConflicts?: RawModPreflightMarker[]
  summary: {
    ignored: number
    targets: number
    shared: number
    stale: number
    /** 实际列进 targets[] 的条数（超上限时会被截断，先排序再截） */
    sharedListed?: number
    /** 注入标记冲突的条数（同文件 + 同标记；超过上限会被截断） */
    markerConflicts?: number
    staleListed?: number
    scannedMods: number
  }
}

export interface RawModPreflightLoader {
  id: string
  path: string
  ok: boolean
  reason: string
  ms: number
}

/** mods:preflight（dryRun: true）的干跑回包：一次性 Node 进程里 require 一遍 loader */
export interface RawModPreflightDryRun {
  ok: boolean
  dryRun: true
  reason?: string
  root?: string
  loaders?: RawModPreflightLoader[]
  failed?: number
  /** 整个 Node 进程的墙钟耗时（也就是「加载这批模组花了多少秒」） */
  elapsedMs?: number
  loadersMs?: number
  output?: string[]
}

export interface RawModList {
  ok: boolean
  exists: boolean
  mods: RawMod[]
  order: string[]
  conflicts: string[]
  root: string
  repoRoot: string
  repoRootLooksValid: boolean
  stats: { total: number; enabled: number; disabled: number; conflicts: number; bytes: number }
}

/**
 * 审核原因：索引里既可能是纯字符串（老数据），也可能是 `{ zh, en }`（`build-index.mjs`
 * 原样发布控制台填的两栏）。界面按当前语言取一条，见 lib/mod-source.ts 的 `localizedReason`。
 */
export type LocalizedReason = string | { zh?: string; en?: string } | null

/** 市场索引里的一条（mods:marketList 的 mods[] / index.mods[]） */
export interface RawMarketMod {
  id: string
  displayName: string
  version: string
  description: string
  category: string
  tags: string[]
  author?: { id?: string; name?: string; keyId?: string }
  sizeBytes?: number
  sha256?: string
  downloadUrls?: { url: string; mirror?: string; priority?: number }[]
  downloadUrlsCount?: number
  repo?: string
  source?: string
  requiresRestart?: boolean
  delisted?: boolean
  featured?: boolean
  publishedAt?: string
  changelog?: string
  /** 更早版本的历史（上一版提交过才会有；现役版恒为 []） */
  history?: { version?: string; changelog?: string; at?: number }[]
  evejsVersions?: string[]
  readme?: string[]
  highlights?: string[]
  downloads?: number
  cdnHits?: number
  /* ---- 评价与评分：由 infra/ 那个评价服务的快照并进来（见 src-tauri/src/mods/ratings.rs）---- */
  /** 综合分（未取整）；没人打分为 0 */
  ratingAvg?: number
  /** 打过分的人数（含只打分不写评论的） */
  ratingCount?: number
  /** 写了评论的人数 —— 界面上「玩家评价 · N 条」用的是它，不是 ratingCount */
  ratingWithText?: number
  /** 1..5 星的分布（下标 0 是 1 星） */
  ratingHistogram?: number[]
}

/** mods:reviews —— 某个模组的评论正文快照 */
export interface RawReview {
  id: string
  /** 评论者的公钥指纹：本机身份的 keyId，用来认「哪条是我写的」 */
  keyId?: string
  author?: string
  corp?: string
  /** 评论者所在国家 / 地区码（ISO 3166-1 alpha-2）：界面据此显示「来自 <地区> 的玩家」 */
  country?: string
  stars: number
  version?: string
  date?: string
  body?: string
  edited?: boolean
  mine?: boolean
  reply?: { date?: string; body?: string; edited?: boolean }
}

/** 评价写通道（modsReviewSubmit / modsReplySubmit / …）的回包：成功就 ok，失败带 reason */
export interface RawWriteAck {
  ok: boolean
  reason?: string
  /** 真正受理这次写入的服务地址（配了多个写地址时用来排查） */
  server?: string
  reportId?: string
}

export interface RawReviewShard {
  ok: boolean
  modId?: string
  reviews?: RawReview[]
  reason?: string
  cached?: boolean
  fetchedAt?: number
}

/** sponsors:snapshot —— 补给线（赞助人）名单快照，与评分走同一套读法（src-tauri/src/sponsors.rs） */
export interface RawSponsorsSnapshot {
  ok: boolean
  /** 名单条目。名字与金额是**用户数据**，界面不翻译；currency 是三位字母币种码 */
  sponsors?: { id?: string; name?: string; amount?: unknown; currency?: string }[]
  /** 服务端算出这份快照的时刻（epoch ms） */
  generatedAt?: number
  /** true = 这次给的是本地缓存（源没连上或还没到有效期） */
  cached?: boolean
  source?: string | null
  fetchedAt?: number
  reason?: string | null
}

export interface RawMarketList {
  ok: boolean
  reason?: string
  source?: string
  cached?: boolean
  fetchedAt?: number
  evejsVersion?: string
  indexUrls?: string[]
  mods: RawMarketMod[]
  /** 评价源的可用性：读不到时市场照常出，只是没有评分 */
  ratings?: { available?: boolean; source?: string; reason?: string; cached?: boolean }
  blocked?: { id: string; evejsVersions?: string[] }[]
  delisted?: { id: string; displayName?: string; reason?: LocalizedReason }[]
  updates?: { id: string; from?: string; to?: string }[]
}

/** mods:templates */
export interface RawModTemplate {
  id: string
  name: string
  category: string
  desc: string
  tags: string[]
  highlights: string[]
  requiresRestart: boolean
  files: string[]
  /** 生成的文件个数（后端一并给出，省得前端再算） */
  fileCount?: number
  /** 骨架落盘的真实体积（字节）：后端按示例 draft 量出来的参考值 */
  sizeBytes?: number
}

/** mods:myMods 的一条 */
export interface RawMyModItem {
  id: string
  displayName: string
  version: string
  category: string
  /** local | draft | submitted | update-pending | listed | delisted | rejected */
  status: string
  folder: string
  localVersion: string
  listedVersion: string
  signed: boolean
  sourceRepo: string
  prUrl: string
  sizeBytes: number
  updatedAt: number
  moderationAction?: string
  moderationReason?: LocalizedReason
  moderatedBy?: string
  moderatedAt?: string
  /** 审核 PR 的状态：open（审核中）/ merged（已合并）/ closed（被关闭）；没查过就是空 */
  reviewPrState?: string
  /** 审核 PR 的编号 */
  reviewPrNumber?: string
  /** 上次成功开出审核 PR 的时间（epoch ms） */
  reviewSubmittedAt?: number
  /**
   * 这条记录是不是**本机当前署名**投的。
   *
   * 台账（my-submissions.json）按机器存、不按身份存：重装系统 / 换过身份之后里面还留着
   * 旧身份的投稿，那些是 false。界面据此只给「本机署名」的那条提供「移除记录」。
   */
  own?: boolean
  /**
   * 只剩记录撑着：本地 mods/ 里没有这个文件夹、市场索引里也没这条 ——
   * 被驳回 / 已下架 / 审核中而本地已删。界面据此在卡片上给出「移除记录」入口。
   */
  recordOnly?: boolean
}

export interface RawMyMods {
  ok: boolean
  reason?: string
  hidden: number
  items: RawMyModItem[]
}

/** mods:mySubmissions 的一条（提交台账） */
export interface RawSubmissionItem {
  id: string
  version: string
  displayName: string
  changelog?: string
  zipPath: string
  sha256: string
  sizeBytes: number
  status: string
  prUrl: string
  branch: string
  sourceRepo: string
  sourceReviewUrl: string
  createdAt: number
  /** 上次**成功**开出审核 PR 的时间（epoch ms）：没成功过就是空，也是 30 分钟冷却的计时起点 */
  submittedAt?: number
  /** 那条审核 PR 的编号（校验通过时才有） */
  reviewPrNumber?: string
  /** 那条审核 PR 的状态：open（审核中）/ merged（已合并）/ closed（被关闭） */
  reviewPrState?: string
  /** 上次复查这条 PR 的时间（epoch ms）：按 30 分钟节流 */
  reviewCheckedAt?: number
}

export interface RawMySubmissions {
  ok: boolean
  indexRepo: string
  items: RawSubmissionItem[]
}

/**
 * mods:claimCandidates 的一条：本机 mods/ 里由**别的身份**署名、仓库地址还解析得出来的模组。
 *
 * 已经认领过的不在这里：认领成功那一刻它就回到「我创建的」了，继续留在找回列表里
 * 只会让人以为没认领上（2026-09-30 报障）。
 */
export interface RawClaimItem {
  id: string
  folder: string
  displayName: string
  version: string
  /** 清单里声明的作者标识（旧身份的那一个） */
  declaredAuthorId: string
  declaredKeyId: string
  declaredAuthorName: string
  /** 这个模组的仓库（索引登记 > 本地市场标记 > 发布台账） */
  repo: string
  /** 仓库地址是从哪解析出来的：index | source | ledger | 空 */
  repoSource?: string
  /** 仓库主人（用于判断「这个像是你的」） */
  repoOwner?: string
  /** 不能认领的原因 */
  reason?: string
}

/** mods:claimCandidates */
export interface RawClaimCandidates {
  ok: boolean
  reason?: string
  /** 本页的可认领条目（后端排好序再切片，翻页不重不漏）；已认领的不再回传 */
  items: RawClaimItem[]
  /** 解析不出仓库的条目不再回传（只给数量，见 `skippedCount`）；保留字段兼容旧回包 */
  skipped: RawClaimItem[]
  /** 搜索命中的总条数（跨页，用来算「加载更多」还剩几条） */
  total?: number
  /** 连仓库地址都解析不出来的条数（暂时无法认领） */
  skippedCount?: number
  /** 仓库不在令牌账号名下、被范围挡掉的条数（界面据此给「查看全部」） */
  foreignCount?: number
  /** 后端实际用的范围：mine | all（登录名还没核验出来时不会筛） */
  scope?: string
  /** 后端缓存里的令牌登录名（没核验过就是空串） */
  login?: string
  /** 没配 GitHub 令牌：连归属都核验不了，界面给一条「去配置令牌」的出路 */
  needsToken?: boolean
  /** 本页的起始偏移与页大小（后端原样回显，界面据此核对） */
  offset?: number
  limit?: number
}

/** mods:claimMod */
export interface RawClaimResult {
  ok: boolean
  reason?: string
  /** 没配 GitHub 令牌（或令牌失效）时给界面一个明确的出口 */
  needsToken?: boolean
  id?: string
  repo?: string
  login?: string
  /** owner | push */
  verifiedBy?: string
  alreadyClaimed?: boolean
}

/** mods:githubToken* */
export interface RawTokenStatus {
  hasToken: boolean
  encrypted: boolean
  path: string
  reason?: string
}

export interface RawTokenSave {
  ok: boolean
  encrypted: boolean
  reason?: string
}

export interface RawTokenCheck {
  ok: boolean
  login?: string
  reason?: string
}

/** author:get */
export interface RawAuthorProfile {
  id: string
  name: string
  since: number
  keyId: string
  publicKey: string
  privateKeyPath: string
}

export interface RawAuthorState {
  ok: boolean
  reason?: string
  dataDir?: string
  privateKeyExists?: boolean
  author?: RawAuthorProfile
}

/** mods:submitPrepare */
export interface RawSubmissionRecord {
  id: string
  version: string
  displayName: string
  changelog: string
  zipPath: string
  sha256: string
  sizeBytes: number
  status: string
  prUrl: string
  branch: string
  sourceRepo: string
  sourceReviewUrl: string
  createdAt: number
}

export interface RawSubmitPrepare {
  ok: boolean
  reason?: string
  item?: RawSubmissionRecord
}

/** mods:publishOwnRepo / mods:submitGithub */
export interface RawPublishResult {
  ok: boolean
  reason?: string
  owner?: string
  repo?: string
  repoUrl?: string
  releaseUrl?: string | null
  assetUrl?: string
  repoCreated?: boolean
  prUrl?: string
  branch?: string
  compareUrl?: string
  forkRepo?: string
  login?: string
}

/** mods:readme */
export interface RawReadme {
  ok: boolean
  reason?: string
  path: string
  text: string
}

/** mods:authoringDocText */
export interface RawAuthoringDoc {
  ok: boolean
  path: string
  text: string
}

/** settings:get（返回设置文件里的键值，没有任何键时是 {}） */
export type RawSettings = Record<string, unknown>

/** mod:downloadProgress 的载荷 */
export interface RawDownloadProgress {
  id: string
  downloaded: number
  total: number | null
  percent: number | null
  mirror: string
}

/** mod:publishProgress 的载荷 */
export interface RawPublishProgress {
  stage: string
  percent: number
}
/* ------------------------------------------------------------------
   物品 / 市场浏览器（market:*，本工程扩展，契约见 contract/extensions.json）
   ------------------------------------------------------------------ */

/**
 * 市场库总览。库是**活库**：counts.touched 是被游戏内成交真正扣减过库存的品种数，
 * lastChangeAt 是最近一次成交时刻 —— 这两个数字会随着游戏里买卖而变化，
 * 也是「界面读的不是随包快照」的直接证据。
 */
export interface RawMarketOverview {
  ok: boolean
  /** false = 这台机器没带市场侧车（打包缺件）；库缺失走 ok:false + reason */
  supported?: boolean
  reason?: string
  path?: string
  sizeBytes?: number
  modifiedAt?: number
  journalMode?: string
  region?: { id: number; name: string }
  systems?: { id: number; name: string; security: number }[]
  counts?: {
    types: number
    stations: number
    systems: number
    stockRows: number
    buyRows: number
    liveOrders: number
    fills: number
    trades: number
    /** 库存被成交扣减过的品种数（> 0 就说明这个库在用） */
    touched: number
    historyDays: number
  }
  lastChangeAt?: string | null
  manifest?: {
    generatedAt: string
    selectionLabel: string
    seedQuantity: number
    historyDays: number
    markupPercent: number
  } | null
}

/**
 * catalog 里的一行物品，**紧凑数组**而不是对象：
 * [typeId, mgId, groupId, catId, name, basePrice, volume, portionSize,
 *  bestAsk, askQty, askStation, bestBid, bidQty, bidStation]
 *
 * 19,352 行 × 14 列，展开成对象要多占好几倍内存（启动器对内存敏感），
 * 所以保持数组原样过 IPC，由 market-logic.ts 装成 Int32Array / Float64Array。
 */
export type RawMarketTypeRow = [
  number,
  number,
  number,
  number,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

/** 分类树节点：[marketGroupID, parentGroupID(-1 = 根), 中文名, 英文名] */
export type RawMarketTreeRow = [number, number, string, string]

/** market:catalog */
export interface RawMarketCatalog {
  ok: boolean
  supported?: boolean
  reason?: string
  path?: string
  modifiedAt?: number
  region?: { id: number; name: string }
  /** false = 没找到运行时 SDE，分类树为空（列表退化成平铺，不影响物品本身） */
  sde?: boolean
  stations?: {
    station_id: number
    station_name: string
    solar_system_id: number
    solar_system_name: string
    security: number
  }[]
  tree?: RawMarketTreeRow[]
  /** [groupId, 中文名, 英文名] */
  groups?: [number, string, string][]
  /** [categoryId, 中文名, 英文名] */
  categories?: [number, string, string][]
  types?: RawMarketTypeRow[]
}

/** market:book 的盘口摘要（region_summaries 的一行） */
export interface RawMarketSummary {
  bestAsk: number
  askQty: number
  askStation: number
  bestBid: number
  bidQty: number
  bidStation: number
  updatedAt: string
}

/** market:book 的一个空间站库存行。quantity < initialQuantity 就是这个品种真被买过 */
export interface RawMarketStockRow {
  stationId: number
  stationName: string
  systemName: string
  price: number
  quantity: number
  initialQuantity: number
  updatedAt: string
}

/** market:book 的价格史一天 */
export interface RawMarketHistoryPoint {
  day: string
  low: number
  high: number
  avg: number
  volume: number
  orders: number
}

/** market:book 的成交回执（market_fill_receipts 的 response_json） */
export interface RawMarketFill {
  at: string
  price: number
  quantity: number
  stationId: number
  bid: boolean
}

/** market:book */
export interface RawMarketBook {
  ok: boolean
  supported?: boolean
  reason?: string
  path?: string
  region?: { id: number; name: string }
  type?: {
    typeId: number
    mgId: number
    groupId: number
    catId: number
    name: string
    groupName: string
    basePrice: number
    volume: number
    portionSize: number
  }
  summary?: RawMarketSummary | null
  stock?: RawMarketStockRow[]
  /** 玩家挂单（market_orders 里状态还是 open 的）。当前种子库没有，恒为空数组 */
  orders?: unknown[]
  history?: RawMarketHistoryPoint[]
  fills?: RawMarketFill[]
}

/** market:trades 的一行成交流水 */
export interface RawMarketTradeRow {
  at: string
  typeId: number
  name: string
  price: number
  quantity: number
  stationId: number
  stationName: string
  bid: boolean
}

/** market:trades */
export interface RawMarketTrades {
  ok: boolean
  supported?: boolean
  reason?: string
  path?: string
  rows?: RawMarketTradeRow[]
}
