/** 服务端生命周期状态。 */
export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed"

/** 冷启动分段。启动器按顺序推进，每段有独立权重决定进度条节奏。 */
export interface BootStage {
  id: string
  label: string
  detail: string
  weight: number
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

/** 日志模块标签，日志中心按它做过滤。 */
export type LogModule = "星图" | "市场" | "战斗" | "网络" | "AI" | "账号" | "存档" | "内核"

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  module: LogModule
  message: string
  /** 出错时的堆栈/上下文，日志详情面板展示。 */
  trace?: string
}

export interface MetricSample {
  t: number
  /** CPU 占用百分比。 */
  cpu: number
  /** 内存占用 MB。 */
  mem: number
  /** 每秒 tick 数。 */
  tick: number
  /** 在线人数。 */
  players: number
  /** 网络吞吐 Mbps。 */
  net: number
  /** 单 tick 平均耗时 ms。 */
  frameMs: number
}

export interface UniverseConfig {
  serverName: string
  port: number
  maxPlayers: number
  adminPassword: string
  /** 世界规模 */
  systems: number
  securitySpread: number
  npcDensity: number
  /** 成长倍率 */
  expRate: number
  skillRate: number
  iskRate: number
  lootRate: number
  /** 经济 */
  marketTax: number
  orderRefresh: number
  npcSpread: number
  /** 运行 */
  tickRate: number
  autoSaveMinutes: number
  pvpEnabled: boolean
  friendlyFire: boolean
  persistentWorld: boolean
}

export type AccountStatus = "online" | "offline" | "banned"

export type Faction = "加达里" | "米玛塔尔" | "艾玛" | "盖伦特"

export type AccountRole = "管理员" | "军团指挥" | "玩家" | "观察者"

export interface Account {
  id: string
  username: string
  character: string
  corp: string
  faction: Faction
  role: AccountRole
  isk: number
  skillPoints: number
  securityStatus: number
  status: AccountStatus
  shipName: string
  solarSystem: string
  playtimeHours: number
  lastSeen: number
  createdAt: number
  note: string
}

export type BackupKind = "手动" | "自动" | "启动前"

export interface Backup {
  id: string
  label: string
  createdAt: number
  sizeMb: number
  kind: BackupKind
  version: string
  note: string
  /** 快照时刻的在线人数，回滚前用来判断影响面。 */
  playersAt: number
}

export interface ModEntry {
  id: string
  name: string
  author: string
  /** 作者标识。认人靠它，不靠署名——署名谁都能填成别人的。老条目没有这个字段。 */
  authorId?: string
  version: string
  category: string
  enabled: boolean
  /** 加载顺序，数字小的先加载。 */
  order: number
  sizeMb: number
  desc: string
  /** 与哪些模组存在冲突（模组 id）。 */
  conflicts: string[]
}

/** 一条版本记录：作者当时写的更新说明，连同版本号和时间一起攒下来。 */
export interface ModVersionEntry {
  version: string
  /** 作者自己写的更新说明。首个版本没有说明，就是空串。 */
  changelog: string
  /** 这一版上架的时间。 */
  at: number
}

/** 一条玩家评价：别人写的和本机自己写的那条共用这个形状。 */
export interface ModReview {
  /** 写评价的人。署名是个自由文本，认人另看作者标识。 */
  author: string
  /** 写这条时的评分，1–5。 */
  stars: number
  text: string
  at: number
}

/**
 * 本机自己写的那条评价。作者名不存进来 —— 它从当前作者档案取，
 * 改了署名之后，别人的评价列表里不会留下旧名字。
 */
export interface MyReview {
  text: string
  at: number
}

/** 模组市场里的一条目录项。市场是本地索引，安装之后才会进入模组清单。 */
export interface MarketMod {
  id: string
  name: string
  author: string
  /** 作者标识。认人靠它，不靠署名。种子目录里的条目没有这个字段，视为「不是本机的」。 */
  authorId?: string
  /** 市场收录的最新版本；与本地已装版本不一致即表示可更新。 */
  version: string
  category: string
  sizeMb: number
  desc: string
  /** 详情弹窗里的分段介绍。 */
  readme: string[]
  /** 功能要点，详情里逐条列出。 */
  highlights: string[]
  /** 与哪些模组 id 互斥。 */
  conflicts: string[]
  tags: string[]
  downloads: number
  /** 0–5 分，一位小数。本机打过分的，这里已经是把自己那一票算进去之后的平均分。 */
  rating: number
  ratingCount: number
  /** 本机自己打的分，1–5 的整数；没打过分就没有。 */
  myRating?: number
  /**
   * 没算本机这一票时的原始评分与人数。改分时用它重算，
   * 不然每改一次都会在上一次的结果上再叠一票，分数会越走越偏。
   */
  baseRating?: number
  baseRatingCount?: number
  /** 别人写的评价，从新到旧。本机自己写的那条单独放 myReview。 */
  reviews?: ModReview[]
  /** 本机写的评价正文。没写过就没有。 */
  myReview?: MyReview
  updatedAt: number
  /** 官方精选，列表里优先展示。 */
  featured: boolean
  /** 是否需要重启服务端才能生效。 */
  requiresRestart: boolean
  /** 作者自己写的更新说明，详情里以「本次更新」单列。没发过更新就没有。 */
  changelog?: string
  /** 逐版攒下来的更新记录，从最早排到最新。没发过更新、也没被种子数据写过的就没有。 */
  history?: ModVersionEntry[]
  /** 源码 / 下载地址，选填，只作登记用。 */
  repo?: string
  /**
   * 作者自己下架了这条。下架后市场目录不再对外展示，只有作者本人还看得见，
   * 可以随时重新上架；已经装了的人本地副本不受影响。
   */
  delisted?: boolean
}

/** 提交到市场的模组在审核流水线里的位置。 */
export type SubmissionStatus = "pending" | "reviewing" | "published"

/** 用户提交到市场的模组。审核通过后会转成一条 MarketMod 上架。 */
export interface ModSubmission {
  id: string
  name: string
  author: string
  /** 作者标识。提交时盖上去，通过审核后跟着上架，用来认「这条是不是本机作者发的」。 */
  authorId?: string
  /** 更新说明，只在「更新自己已上架的模组」时填。 */
  changelog?: string
  version: string
  category: string
  sizeMb: number
  desc: string
  readme: string[]
  highlights: string[]
  tags: string[]
  conflicts: string[]
  requiresRestart: boolean
  /** 源码 / 下载地址，选填，只作登记用。 */
  repo: string
  submittedAt: number
  status: SubmissionStatus
  /** 审核进度 0–100。 */
  progress: number
}

/** 提交表单收集到的内容，流水线字段由引擎补齐。 */
export type ModSubmissionDraft = Omit<
  ModSubmission,
  "id" | "submittedAt" | "status" | "progress"
>

/** 新建模组表单收集到的内容：在上架资料之上，多两个开关决定建好之后干什么。 */
export type ModDraft = ModSubmissionDraft & {
  /** 建好后是否立即启用。 */
  enabled: boolean
  /** 建好后是否顺手提交到市场审核。 */
  publish: boolean
}

/** 下载 / 安装任务，进度 0–100。 */
export interface InstallTask {
  id: string
  progress: number
  /** 首次安装还是升级到新版本。 */
  mode: "install" | "update"
}
