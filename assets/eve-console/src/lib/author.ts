/**
 * 本机作者档案。署名是给人看的，作者标识才是认人用的 —— 署名是个自由文本框，
 * 谁都能填成别人的名字，光靠它对不出「这条模组是不是我发的」。
 *
 * 单独存一个键，不跟进度快照混在一起：清进度是「把玩过的重来一遍」，
 * 不该顺手把「你是谁」也清掉。
 */
export interface AuthorProfile {
  /** 本机第一次使用时生成，之后一直不变。 */
  id: string
  /** 显示用的署名，随时可改；改名会同步刷到名下所有模组上。 */
  name: string
  /** 拿到这个身份的时间。 */
  since: number
}

const STORAGE_KEY = "eve-console:author"
const DEFAULT_NAME = "指挥官"
/** 随机尾缀固定 4 位，标识长度才会一致，认回时也才好从里面读回时间。 */
const NOISE_WIDTH = 4
/** 标识长这样：au- + base36 毫秒时间戳 + 4 位随机尾缀。 */
const ID_PATTERN = /^au-[a-z0-9]{6,32}$/i

/* 隐私模式、file:// 直接打开都可能让 localStorage 当场抛错。 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function mintId(): string {
  const stamp = Date.now().toString(36)
  const noise = Math.floor(Math.random() * 36 ** NOISE_WIDTH)
    .toString(36)
    .padStart(NOISE_WIDTH, "0")
  return `au-${stamp}${noise}`
}

/** 这串文本能不能当作者标识用。认回身份前先过一道，免得把随手粘的东西写进档案。 */
export function isValidAuthorId(value: string): boolean {
  return ID_PATTERN.test(value.trim())
}

/**
 * 标识里编着当初生成的毫秒时间戳，认回旧身份时顺手把「启用时间」也还原回去，
 * 而不是显示成今天。读不出来就返回 null，调用方按现在算。
 */
export function authorSinceFromId(id: string): number | null {
  const body = id.trim().replace(/^au-/i, "").toLowerCase()
  /* 尾缀长度不固定（早期生成的可能不足 4 位），从长到短试：
     多截一位会让时间戳乘 36 冲到未来，少截一位会除 36 掉回 2001 年以前，
     只有截对了才落在合理区间里。 */
  for (let noise = NOISE_WIDTH; noise >= 1; noise--) {
    const stamp = body.slice(0, body.length - noise)
    if (stamp.length === 0) continue
    const ms = Number.parseInt(stamp, 36)
    if (ms > 978_307_200_000 && ms < Date.now() + 31_536_000_000) return ms
  }
  return null
}

/* 没有本机存储时也得有个稳定标识，模块级缓存保证一次会话里不会变来变去。 */
let fallback: AuthorProfile | null = null

/** 读本机作者档案。读不到就现发一个（纯读，落盘交给调用方的 effect）。 */
export function loadAuthor(): AuthorProfile {
  const store = storage()
  if (store) {
    try {
      const raw = store.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AuthorProfile>
        if (typeof parsed.id === "string" && parsed.id !== "" && typeof parsed.name === "string") {
          return {
            id: parsed.id,
            name: parsed.name,
            since: typeof parsed.since === "number" ? parsed.since : Date.now(),
          }
        }
      }
    } catch {
      /* 存档坏了就当作没有，下面现发一个 */
    }
  }

  if (!fallback) fallback = { id: mintId(), name: DEFAULT_NAME, since: Date.now() }
  return fallback
}

export function saveAuthor(profile: AuthorProfile): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(profile))
  } catch {
    /* 写不进去也没什么可补救的，忽略 */
  }
}
