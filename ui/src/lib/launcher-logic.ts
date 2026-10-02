/**
 * 启动器账号页的纯逻辑：种族血统表、角色槽规则、登录判定与状态迁移。
 * 与 React 无关，方便单独验证；组件只负责渲染。
 */
import { t } from "@/lib/i18n"

/** 每个账号的角色槽上限 —— 与官方登录器一致 */
export const MAX_CHARACTERS_PER_ACCOUNT = 3

/** 新角色的起始技能点 */
export const STARTING_SP = 400_000

export type AccountStatus = "READY" | "NEW" | "SUSPENDED"
export type AccountRole = "ADMIN" | "GM" | "PLAYER"
export type RaceId = "caldari" | "minmatar" | "amarr" | "gallente"
export type Gender = "male" | "female"

export interface Character {
  id: string
  name: string
  /**
   * 种族 / 血统 / 性别现在从服务端角色表读（raceID / bloodlineID / gender），
   * 经 raceFromId / bloodlineFromId / genderFromCode 换算；服务端没记录就不画，不编。
   */
  race?: RaceId
  bloodline?: string
  gender?: Gender
  ship: string
  sp: number
  /** 角色钱包余额（ISK）；账号卡片底部的合计按它加总 */
  isk?: number
  /** 所在地：星系 + 停靠点，给搜索与其它读通用 */
  location: string
  /** 只取星系名；角色卡片底部那一行要的是「角色所在星系」 */
  system?: string
  online: boolean
  bornAt: string
  /** 游戏内肖像 data URL（后端 accounts:list 提供），有就优先画这张位图 */
  avatar?: string
  /** 军团 / 联盟：id 用来拼本地图片服务的徽标地址，名字只做提示 */
  corporationId?: number
  corporationName?: string
  /** 军团短标识（tickerName）；没有专属徽标时卡片画它 */
  corporationTicker?: string
  allianceId?: number
  allianceName?: string
  /** 联盟简称（shortName）；没有专属徽标时卡片画它 */
  allianceTicker?: string
  /** 本次上线的时间戳；在线时长按它算。老存档里没有这个字段，读盘时会补上 */
  onlineSince?: number
}

export interface Account {
  id: string
  name: string
  role: AccountRole
  status: AccountStatus
  createdAt: string
  lastLogin: string
  characters: Character[]
  /**
   * 本机 `launcher-settings.json` 里有没有这个账号的密码密文（后端 `hasStoredCredential`）。
   *
   * 密文只落在**建号那台机器**上：别的启动器建的号、直接在服务端建的号，本机都没有，
   * 「一键进游戏」必然失败 —— 这时要问一次密码（`login:start` 带 remember，输完补存到本机）。
   * 后端没给这个字段时留 `undefined`，按「先试一键」处理。
   */
  hasStoredCredential?: boolean
}

/* ---------------- 种族 / 血统 ---------------- */

export interface RaceEntry {
  id: RaceId
  name: string
  nameEn: string
  bloodlines: string[]
  /** 新手护卫舰 */
  ship: string
  shipEn: string
  /** 出生星系 */
  system: string
  /** 头像色调，只用设计 token */
  tone: "primary" | "warning" | "success" | "destructive"
}

export const RACES: RaceEntry[] = [
  {
    id: "caldari",
    name: "加达里",
    nameEn: "Caldari",
    bloodlines: ["西威雷", "德泰斯", "阿楚拉"],
    ship: "朱鹭",
    shipEn: "Ibis",
    system: "Jita IV-4",
    tone: "primary",
  },
  {
    id: "minmatar",
    name: "米玛塔尔",
    nameEn: "Minmatar",
    bloodlines: ["布鲁特", "塞比斯托尔", "维赫罗基尔"],
    ship: "收割者",
    shipEn: "Reaper",
    system: "Rens VI-8",
    tone: "destructive",
  },
  {
    id: "amarr",
    name: "艾玛",
    nameEn: "Amarr",
    bloodlines: ["艾玛", "尼-库尼", "卡尼德"],
    ship: "因帕罗",
    shipEn: "Impairor",
    system: "Amarr VIII",
    tone: "warning",
  },
  {
    id: "gallente",
    name: "盖伦特",
    nameEn: "Gallente",
    bloodlines: ["盖伦特", "因塔基", "金梅"],
    ship: "维拉托",
    shipEn: "Velator",
    system: "Dodixie IX-20",
    tone: "success",
  },
]

export function raceOf(id: RaceId): RaceEntry {
  return RACES.find((r) => r.id === id) ?? RACES[0]
}

/**
 * 服务端角色表里的 raceID 是静态数据主键：1 加达里 / 2 米玛塔尔 / 4 艾玛 / 8 盖伦特
 * （取自服务端 characterCreationRaces 静态表）。别的值一律当没记录，不猜。
 */
const RACE_BY_ID: Record<number, RaceId> = {
  1: "caldari",
  2: "minmatar",
  4: "amarr",
  8: "gallente",
}

export function raceFromId(id: number | null | undefined): RaceId | undefined {
  return typeof id === "number" ? RACE_BY_ID[id] : undefined
}

/** 服务端 characterCreationBloodlines 静态表的 12 条血统，中文名与启动器里已有的一致 */
const BLOODLINE_BY_ID: Record<number, string> = {
  1: "德泰斯",
  2: "西威雷",
  3: "塞比斯托尔",
  4: "布鲁特",
  5: "艾玛",
  6: "尼-库尼",
  7: "盖伦特",
  8: "因塔基",
  11: "阿楚拉",
  12: "金梅",
  13: "卡尼德",
  14: "维赫罗基尔",
}

export function bloodlineFromId(id: number | null | undefined): string | undefined {
  return typeof id === "number" ? BLOODLINE_BY_ID[id] : undefined
}

/**
 * 性别服务端只写 0 / 1 / 2（characterIdentity.normalizeCharacterGender）。
 * 1 在两套约定里都是男性，0 与 2 分别是两套约定里的女性，所以这样换算不会认错。
 */
export function genderFromCode(code: number | null | undefined): Gender | undefined {
  if (code === 1) return "male"
  if (code === 0 || code === 2) return "female"
  return undefined
}

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  READY: "就绪",
  NEW: "待初始化",
  SUSPENDED: "已停用",
}

export const ACCOUNT_STATUS_ORDER: AccountStatus[] = ["READY", "NEW", "SUSPENDED"]

export const ACCOUNT_ROLE_LABEL: Record<AccountRole, string> = {
  ADMIN: "管理员",
  GM: "GM",
  PLAYER: "玩家",
}

export const GENDER_LABEL: Record<Gender, string> = {
  male: "男性",
  female: "女性",
}

export const GENDER_ORDER: Gender[] = ["male", "female"]

/* ---------------- 判定结果 ---------------- */

export interface Guard {
  ok: boolean
  reason: string
  /**
   * `ok: true`，但这次操作还等着用户补一次密码：数据层已经把请求挂起，弹窗接管了
   * （见 `PendingCredential`）。调用方这时**不要**再提示「正在拉起客户端」。
   */
  needsPassword?: boolean
}

const ALLOW: Guard = { ok: true, reason: "" }

/**
 * 后端那句「本机没存过这个账号的密码」的原文 —— `accounts.rs::launch_stored` 在设置文件里
 * 找不到 DPAPI 密文时回的就是它。界面上不能只把这句话显示出来：得让用户**输一次密码**。
 */
export function missingStoredCredential(reason: string): boolean {
  return String(reason ?? "").includes("未找到已保存的登录凭据")
}

/**
 * 进游戏前要不要先问一次密码。
 *
 * 只有**明确知道**本机没有密文（`hasStoredCredential === false`）才提前问，省掉一次注定失败的往返；
 * 字段缺失（老后端 / 种子数据）按「有」处理，真失败了再靠 `missingStoredCredential(reason)` 兜底 ——
 * 宁可多试一次，也别让本来能一键进的号被弹窗拦住。
 */
export function needsPasswordOnce(account: Pick<Account, "hasStoredCredential">): boolean {
  return account.hasStoredCredential === false
}

/** 挂起中的「补一次密码」：用户输完后按 `mode` 接着走原来的意图 */
export interface PendingCredential {
  accountId: string
  /** 进游戏要直达的角色；null = 只想把客户端拉到角色创建界面 */
  characterId: string | null
  mode: "enter" | "create"
}

const deny = (reason: string): Guard => ({ ok: false, reason })

/* ---------------- 角色槽 ---------------- */

export function freeSlots(account: Account): number {
  return Math.max(0, MAX_CHARACTERS_PER_ACCOUNT - account.characters.length)
}

export function isFull(account: Account): boolean {
  return account.characters.length >= MAX_CHARACTERS_PER_ACCOUNT
}

/** 同账号内当前在线的那个角色（一个账号同时只允许一个） */
export function onlineCharacter(account: Account): Character | null {
  return account.characters.find((c) => c.online) ?? null
}

/** 到游戏里建号要走的几步，槽位里按这个顺序把进度显示出来 */
export type InGameStep = "launching" | "editing" | "syncing"

export const IN_GAME_STEP_ORDER: InGameStep[] = ["launching", "editing", "syncing"]

export const IN_GAME_STEP_LABEL: Record<InGameStep, string> = {
  launching: "正在拉起客户端",
  editing: "正在角色创建界面",
  syncing: "正在取回角色",
}

export const IN_GAME_STEP_HINT: Record<InGameStep, string> = {
  launching: "客户端启动中，稍候转到角色创建界面",
  editing: "角色在游戏内捏好，会自动占上这个槽位",
  syncing: "角色已建好，正在同步回启动器",
}

export interface InGameCreation {
  accountId: string
  step: InGameStep
}

/**
 * 角色只在游戏内创建，启动器这边只负责把客户端拉起来。
 * 所以能不能建号，看的是「客户端进得去吗」：账号没停用、槽位没满、
 * 账号里也没有别的角色占着客户端。
 */
export function canCreateInGame(account: Account): Guard {
  if (account.status === "SUSPENDED") return deny("账号已停用，进不去客户端")
  if (isFull(account)) {
    return deny(`槽位已满，已无法再建号`)
  }
  const other = onlineCharacter(account)
  if (other) return deny(t("同账号的 {name} 正在线上，先让它下线", { name: other.name }))
  return ALLOW
}

export function canLogin(account: Account, character: Character): Guard {
  if (account.status === "SUSPENDED") return deny("账号已停用，无法登录")
  if (character.online) return deny(t("{name} 已经在线上", { name: character.name }))
  const other = onlineCharacter(account)
  if (other) return deny(t("同账号的 {name} 正在线上，请先让它下线", { name: other.name }))
  return ALLOW
}

/** 账号里有角色在线时不许删，否则客户端还在跑、账号却没了 */
export function canDeleteAccount(account: Account): Guard {
  const online = onlineCharacter(account)
  if (online) return deny(t("账号内的 {name} 正在线上，请先让它下线", { name: online.name }))
  return ALLOW
}

/* ---------------- 状态迁移（纯函数，返回新账号） ---------------- */

export function loginCharacter(
  account: Account,
  characterId: string,
  stamp: string,
  at: number
): Account {
  return {
    ...account,
    status: account.status === "NEW" ? "READY" : account.status,
    lastLogin: stamp,
    characters: account.characters.map((c) =>
      c.id === characterId ? { ...c, online: true, onlineSince: at } : c
    ),
  }
}

export function logoutCharacter(account: Account, characterId: string): Account {
  return {
    ...account,
    characters: account.characters.map((c) =>
      c.id === characterId ? { ...c, online: false, onlineSince: undefined } : c
    ),
  }
}

export interface CharacterDraft {
  name: string
  race: RaceId
  bloodline: string
  gender: Gender
}

export function createCharacter(
  account: Account,
  draft: CharacterDraft,
  id: string,
  bornAt: string
): Account {
  const race = raceOf(draft.race)
  const character: Character = {
    id,
    name: draft.name,
    race: draft.race,
    bloodline: draft.bloodline || race.bloodlines[0],
    gender: draft.gender,
    ship: race.ship,
    sp: STARTING_SP,
    location: race.system,
    online: false,
    bornAt,
  }
  return { ...account, characters: [...account.characters, character] }
}

/**
 * 游戏内建号时捏出来的角色池：启动器不提供捏人界面，
 * 这些是客户端那边建好后同步回来的角色，取第一个还没被占用的名字。
 */
const IN_GAME_PILOTS: CharacterDraft[] = [
  { name: "Aria Vex", race: "caldari", bloodline: "德泰斯", gender: "female" },
  { name: "Corvin Hale", race: "gallente", bloodline: "因塔基", gender: "male" },
  { name: "Mira Solace", race: "minmatar", bloodline: "布鲁特", gender: "female" },
  { name: "Dain Oryx", race: "amarr", bloodline: "卡尼德", gender: "male" },
  { name: "Yuki Ferro", race: "caldari", bloodline: "阿楚拉", gender: "female" },
  { name: "Rook Severin", race: "gallente", bloodline: "金梅", gender: "male" },
  { name: "Talia Voss", race: "minmatar", bloodline: "维赫罗基尔", gender: "female" },
  { name: "Ivar Mechan", race: "amarr", bloodline: "尼-库尼", gender: "male" },
]

/** 客户端建号的结果：候选池里第一个没被占用的名字，全占满就按序号另起一个 */
export function pickInGamePilot(accounts: Account[]): CharacterDraft {
  const free = IN_GAME_PILOTS.find((p) => !characterNameTaken(accounts, p.name))
  if (free) return free

  const used = new Set(
    accounts.flatMap((a) => a.characters.map((c) => c.name.toLowerCase()))
  )
  for (let n = 1; n <= 99; n++) {
    const name = `Capsuleer ${String(n).padStart(2, "0")}`
    if (!used.has(name.toLowerCase())) return { ...IN_GAME_PILOTS[0], name }
  }
  return { ...IN_GAME_PILOTS[0], name: `Capsuleer ${Date.now()}` }
}

export function removeCharacter(account: Account, characterId: string): Account {
  return {
    ...account,
    characters: account.characters.filter((c) => c.id !== characterId),
  }
}

/** 删账号连角色一起走：角色只存在于账号内，不单独留档 */
export function removeAccount(accounts: Account[], accountId: string): Account[] {
  return accounts.filter((a) => a.id !== accountId)
}

/* ---------------- 校验 ---------------- */

/** 账号名：字母数字与 _ . - */
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/

export function characterNameTaken(accounts: Account[], name: string): boolean {
  const key = name.trim().toLowerCase()
  return accounts.some((a) =>
    a.characters.some((c) => c.name.toLowerCase() === key)
  )
}

export function validateAccountName(name: string, accounts: Account[]): Guard {
  const v = name.trim()
  if (!v) return deny("请输入账号名")
  if (!ACCOUNT_NAME_RE.test(v)) {
    return deny("账号名需 3–20 位，只能用字母、数字、下划线、点或连字符")
  }
  if (accounts.some((a) => a.name.toLowerCase() === v.toLowerCase())) {
    return deny(t("账号名「{name}」已存在", { name: v }))
  }
  return ALLOW
}

/* ---------------- 读数与筛选 ---------------- */

export interface AccountStats {
  accounts: number
  characters: number
  online: number
  freeSlots: number
  suspended: number
  avg: string
}

export function accountStats(accounts: Account[]): AccountStats {
  const characters = accounts.reduce((n, a) => n + a.characters.length, 0)
  const online = accounts.reduce(
    (n, a) => n + a.characters.filter((c) => c.online).length,
    0
  )
  const capacity = accounts.length * MAX_CHARACTERS_PER_ACCOUNT
  return {
    accounts: accounts.length,
    characters,
    online,
    freeSlots: Math.max(0, capacity - characters),
    suspended: accounts.filter((a) => a.status === "SUSPENDED").length,
    avg: accounts.length ? (characters / accounts.length).toFixed(1) : "0.0",
  }
}

/** 账号里各角色钱包余额的合计（没记录的按 0 算） */
export function totalIsk(account: Account): number {
  return account.characters.reduce((sum, c) => sum + (c.isk ?? 0), 0)
}

export type StatusFilter = AccountStatus | "ALL"

export function matchesQuery(account: Account, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (account.name.toLowerCase().includes(q)) return true
  return account.characters.some(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.ship.toLowerCase().includes(q) ||
      c.location.toLowerCase().includes(q)
  )
}

export function filterAccounts(
  accounts: Account[],
  query: string,
  status: StatusFilter
): Account[] {
  return accounts.filter(
    (a) => (status === "ALL" || a.status === status) && matchesQuery(a, query)
  )
}

/* ---------------- 展示辅助 ---------------- */

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * 徽标映射的键：`kind:id`（与外壳 accounts:logotypes 的 kind 同名）。
 * 军团与联盟的 id 空间是分开的，所以键里必须带 kind。
 */
export function logotypeKey(kind: "corporations" | "alliances", id: number): string {
  return `${kind}:${id}`
}

/**
 * 徽标位上的短标识（军团 ticker / 联盟简称）。
 *
 * 服务端对「没有专属徽标」的军团与联盟回的是同一张兜底图，画出来军团和联盟一模一样，
 * 所以那种情况改画短标识。徽标位只有 20px 高，截 4 个字符；拿不到就回 "?"，
 * 不留一个空方块。
 */
export function logotypeTick(short: string | null | undefined): string {
  const text = (short ?? "").trim()
  return text ? text.slice(0, 4).toUpperCase() : "?"
}

/** ISK 合计按千分位原样展示：钱包数字要能一眼对上，不做 K/M/B 缩写 */
export function formatIsk(isk: number): string {
  return Math.round(Number.isFinite(isk) ? isk : 0).toLocaleString("en-US")
}

export function formatSp(sp: number): string {
  if (sp >= 1_000_000) return `${(sp / 1_000_000).toFixed(2)}M`
  if (sp >= 1_000) return `${(sp / 1_000).toFixed(1)}K`
  return String(sp)
}

/** 启动器时间戳：2026-09-26 14:05 */
export function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** formatStamp 的反向解析，老存档里只有这行字、没有时间戳时用它兜底 */
export function parseStamp(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  return new Date(+y, +mo - 1, +d, +h, +mi).getTime()
}

/** 出生日期：2026-09-26 */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时长读数：不到 1 分钟 / 42 分钟 / 3 小时 20 分钟 / 2 天 5 小时 */
export function formatDuration(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return "不到 1 分钟"
  if (min < 60) return t("{minutes} 分钟", { minutes: min })
  const hours = Math.floor(min / 60)
  if (hours < 24) {
    const rest = min % 60
    return rest
      ? t("{hours} 小时 {minutes} 分钟", { hours, minutes: rest })
      : t("{hours} 小时", { hours })
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours
    ? t("{days} 天 {hours} 小时", { days, hours: restHours })
    : t("{days} 天", { days })
}

/** 这个角色在线多久了；不在线（或不知道什么时候上线的）返回 null */
export function onlineDuration(character: Character, now: number): string | null {
  if (!character.online || typeof character.onlineSince !== "number") return null
  return formatDuration(now - character.onlineSince)
}

/**
 * 老存档里在线的角色没有 onlineSince，读盘时补齐：
 * 优先按账号的上次登录时间倒推，实在没有就当刚刚上线，免得时长从负数开始算。
 */
export function normalizeAccounts(accounts: Account[]): Account[] {
  return accounts.map((a) => ({
    ...a,
    characters: a.characters.map((c) =>
      c.online && typeof c.onlineSince !== "number"
        ? { ...c, onlineSince: parseStamp(a.lastLogin) ?? Date.now() }
        : c
    ),
  }))
}

/* ---------------- 演示种子 ---------------- */

/** 每次调用返回全新副本，避免组件改到模块级常量 */
export function seedAccounts(): Account[] {
  return [
    {
      id: "acc-1001",
      name: "capsuleer",
      role: "ADMIN",
      createdAt: "2026-03-04",
      lastLogin: "2026-09-26 13:40",
      status: "READY",
      characters: [
        {
          id: "chr-01",
          name: "Kaede Tanaka",
          race: "caldari",
          bloodline: "西威雷",
          gender: "female",
          ship: "Machariel",
          sp: 12847331,
          location: "New Caldari",
          online: true,
          bornAt: "2026-03-04",
          // 客户端昨晚起就没关过：在线时长按账号上次登录时间倒推
          onlineSince: parseStamp("2026-09-26 13:40") ?? undefined,
        },
        {
          id: "chr-02",
          name: "Rei Ayanami",
          race: "caldari",
          bloodline: "德泰斯",
          gender: "female",
          ship: "Tengu",
          sp: 8412006,
          location: "Jita IV-4",
          online: false,
          bornAt: "2026-03-11",
        },
        {
          id: "chr-03",
          name: "Sora Hoshino",
          race: "gallente",
          bloodline: "因塔基",
          gender: "male",
          ship: "Retriever",
          sp: 3198470,
          location: "Perimeter",
          online: false,
          bornAt: "2026-06-02",
        },
      ],
    },
    {
      id: "acc-1002",
      name: "industrialist",
      role: "GM",
      createdAt: "2026-05-19",
      lastLogin: "2026-09-25 22:07",
      status: "READY",
      characters: [
        {
          id: "chr-04",
          name: "Mika Sorrel",
          race: "minmatar",
          bloodline: "塞比斯托尔",
          gender: "female",
          ship: "Ishtar",
          sp: 9633102,
          location: "Dodixie IX-20",
          online: false,
          bornAt: "2026-05-19",
        },
        {
          id: "chr-05",
          name: "Nell Ferrow",
          race: "amarr",
          bloodline: "尼-库尼",
          gender: "male",
          ship: "Catalyst",
          sp: 2210884,
          location: "Rens VI-8",
          online: false,
          bornAt: "2026-07-08",
        },
      ],
    },
    {
      id: "acc-1003",
      name: "tester",
      role: "PLAYER",
      createdAt: "2026-09-26",
      lastLogin: "—",
      status: "NEW",
      characters: [
        {
          id: "chr-06",
          name: "Probe Unit 07",
          race: "gallente",
          bloodline: "金梅",
          gender: "male",
          ship: "Rifter",
          sp: 42300,
          location: "Hek VIII-12",
          online: false,
          bornAt: "2026-09-26",
        },
      ],
    },
    {
      id: "acc-1004",
      name: "voidrunner",
      role: "PLAYER",
      createdAt: "2026-08-30",
      lastLogin: "2026-09-18 09:12",
      status: "SUSPENDED",
      characters: [],
    },
  ]
}
