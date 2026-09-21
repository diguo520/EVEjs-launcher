import type {
  Account,
  Backup,
  MarketMod,
  ModEntry,
  ModSubmission,
  UniverseConfig,
} from "./types"
import { DEFAULT_CONFIG } from "./seed"

/**
 * 存进本机的是「玩家改得动的那部分」：宇宙参数、账号、快照、模组清单、
 * 市场目录与待审提交。日志、采样、运行时长、下载队列都是运行态，
 * 重开时本来就该从零开始，不写进去。
 */
export interface ProgressPayload {
  config: UniverseConfig
  accounts: Account[]
  backups: Backup[]
  mods: ModEntry[]
  market: MarketMod[]
  submissions: ModSubmission[]
}

export interface ProgressSnapshot extends ProgressPayload {
  version: number
  savedAt: number
}

const STORAGE_KEY = "eve-console:progress"
/** 存档结构变了就整份丢掉重来，免得半截数据把界面撑坏。 */
const STORAGE_VERSION = 1

/* 隐私模式、file:// 直接打开、配额写满，都可能让 localStorage 当场抛错。
   存不了就当没这回事，不能让它把控制台带崩。 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 读本机存档；没有、坏了、或版本对不上都返回 null，调用方退回种子数据。 */
export function loadProgress(): ProgressSnapshot | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ProgressSnapshot>
    if (parsed.version !== STORAGE_VERSION) return null
    if (
      !isPlainObject(parsed.config) ||
      !Array.isArray(parsed.accounts) ||
      !Array.isArray(parsed.backups) ||
      !Array.isArray(parsed.mods) ||
      !Array.isArray(parsed.market) ||
      !Array.isArray(parsed.submissions)
    ) {
      return null
    }
    return {
      version: STORAGE_VERSION,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      // 拿默认配置兜底：以后加了新字段，老存档读出来也不会缺项。
      config: { ...DEFAULT_CONFIG, ...parsed.config },
      accounts: parsed.accounts,
      backups: parsed.backups,
      mods: parsed.mods,
      market: parsed.market,
      submissions: parsed.submissions,
    }
  } catch {
    return null
  }
}

/** 写一次存档，成功返回 true。写不进去（无痕模式、配额满）返回 false。 */
export function saveProgress(payload: ProgressPayload): boolean {
  const store = storage()
  if (!store) return false
  try {
    const snapshot: ProgressSnapshot = {
      version: STORAGE_VERSION,
      savedAt: Date.now(),
      ...payload,
    }
    store.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

export function clearProgress(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    /* 清不掉也没什么可补救的，忽略 */
  }
}
