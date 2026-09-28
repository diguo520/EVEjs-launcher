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
    throw new Error(`window.api.${name} 不可用（当前不在启动器里？）`)
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
  readmePath?: string
  manifestPath?: string
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
  evejsVersions?: string[]
  readme?: string[]
  highlights?: string[]
  downloads?: number
  cdnHits?: number
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
  blocked?: { id: string; evejsVersions?: string[] }[]
  delisted?: { id: string; displayName?: string; reason?: string }[]
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
  moderationReason?: string | null
  moderatedBy?: string
  moderatedAt?: string
  /** 审核 PR 的状态：open（审核中）/ merged（已合并）/ closed（被关闭）；没查过就是空 */
  reviewPrState?: string
  /** 审核 PR 的编号 */
  reviewPrNumber?: string
  /** 上次成功开出审核 PR 的时间（epoch ms） */
  reviewSubmittedAt?: number
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

