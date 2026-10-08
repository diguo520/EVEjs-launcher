/**
 * 界面多语言（i18n）。
 *
 * 口径**逐条对齐现役 Electron 0.1.28**（`eve-launcher.html` 的 `I18N` / `TRANSLATE`）：
 *   1) 语言集合一致：中文 + en / ja / ko / fr / de / nl / ru；
 *   2) 首次启动跟随系统语言，认不出就用英文（老版 `detectLang()` 的兜底）；
 *   3) 选择存 `localStorage["evejs-language"]` —— 与老版**同一个键**，
 *      老用户切过语言的话，换到新外壳不用再选一次。
 *
 * 目录（catalog）以**中文原文为键**：`zh` 是源语言不需要目录，其余 7 种各一份
 * `ui/src/locales/<code>.json`。缺条目一律回退中文原文（宁可显示中文，也不显示 key）。
 */
/** 语言清单（顺序与老版下拉一致，名称按各自母语显示，永不翻译） */
export const LOCALES = [
  { code: "zh", name: "中文", flagCode: "CN" },
  { code: "en", name: "English", flagCode: "GB" },
  { code: "ja", name: "日本語", flagCode: "JP" },
  { code: "ko", name: "한국어", flagCode: "KR" },
  { code: "fr", name: "Français", flagCode: "FR" },
  { code: "de", name: "Deutsch", flagCode: "DE" },
  { code: "nl", name: "Nederlands", flagCode: "NL" },
  { code: "ru", name: "Русский", flagCode: "RU" },
] as const

export type LocaleCode = (typeof LOCALES)[number]["code"]

/** 与老版共用的存储键：换外壳不丢用户的语言选择 */
export const LOCALE_STORAGE_KEY = "evejs-language"

/** 认不出系统语言时的兜底（老版同口径） */
export const FALLBACK_LOCALE: LocaleCode = "en"

type Catalog = Record<string, string>

type NonChineseLocale = Exclude<LocaleCode, "zh">

/**
 * 目录按需加载：启动时只加载当前语言，切换时再加载目标语言。
 * `translate()` 仍保持同步；未加载的目录暂时回退中文原文，调用方在首屏渲染前
 * 先 `await loadCatalog(initialLocale)` 即可保证首屏不会闪中文。
 */
const CATALOG_LOADERS = {
  en: () => import("@/locales/en.json"),
  ja: () => import("@/locales/ja.json"),
  ko: () => import("@/locales/ko.json"),
  fr: () => import("@/locales/fr.json"),
  de: () => import("@/locales/de.json"),
  nl: () => import("@/locales/nl.json"),
  ru: () => import("@/locales/ru.json"),
} satisfies Record<NonChineseLocale, () => Promise<{ default: Catalog }>>

const CATALOGS: Partial<Record<LocaleCode, Catalog>> = {}
const CATALOG_PROMISES = new Map<LocaleCode, Promise<Catalog>>()

/** 加载并缓存一个语言的目录；同一语言并发调用只读一次磁盘。 */
export async function loadCatalog(code: LocaleCode): Promise<Catalog> {
  if (code === "zh") return {}
  const cached = CATALOGS[code]
  if (cached) return cached
  const pending = CATALOG_PROMISES.get(code)
  if (pending) return pending

  const task = CATALOG_LOADERS[code]()
    .then((module) => {
      const catalog = module.default as Catalog
      CATALOGS[code] = catalog
      return catalog
    })
    .finally(() => {
      CATALOG_PROMISES.delete(code)
    })
  CATALOG_PROMISES.set(code, task)
  return task
}

/** 当前目录是否已加载；`zh` 是源语言，永远视为已就绪。 */
export function isCatalogLoaded(code: LocaleCode): boolean {
  return code === "zh" || Boolean(CATALOGS[code])
}

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && LOCALES.some((item) => item.code === value)
}

export function localeName(code: LocaleCode): string {
  return LOCALES.find((item) => item.code === code)?.name ?? code
}

/** 语言 → 旗子用的国家码（`zh` → `CN`）；LOCALES 里已经登记，这里只是省得各处翻表 */
export function localeFlagCode(code: LocaleCode): string {
  return LOCALES.find((item) => item.code === code)?.flagCode ?? ""
}

/**
 * 少数地区的 ICU 译名太长（香港在中文下是「中国香港特别行政区」），
 * 挂在评论署名里会把那一行撑成两行。只压这几个，其余一律交给 Intl.DisplayNames。
 */
const REGION_NAME_OVERRIDES: Record<string, Partial<Record<LocaleCode, string>>> = {
  HK: {
    zh: "香港",
    en: "Hong Kong",
    ja: "香港",
    ko: "홍콩",
    fr: "Hong Kong",
    de: "Hongkong",
    nl: "Hongkong",
    ru: "Гонконг",
  },
}

/** 查表缓存：评论列表滚动时同一批地区名会被反复问，别每次都造一个 Intl.DisplayNames */
const REGION_NAMES = new Map<string, string>()

/**
 * 国家 / 地区码 → 当前语言的地区名（`DE` → 「德国」/「Germany」）。
 *
 * 用 `Intl.DisplayNames` 而不是自带一张 57 地区 × 8 语言的对照表：译名跟着系统 ICU 走，
 * 一次都不用维护，还省下几 KB —— 冷启动是启动器最在意的指标。拿不到（码不合法、
 * 或者 WebView 太老）就退回地区码本身，宁可显示 `DE` 也不显示空白。
 */
export function countryName(code: string, locale: LocaleCode): string {
  const upper = String(code ?? "").trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return ""
  const key = locale + ":" + upper
  const cached = REGION_NAMES.get(key)
  if (cached !== undefined) return cached
  let name = REGION_NAME_OVERRIDES[upper]?.[locale] ?? ""
  if (!name) {
    try {
      name = new Intl.DisplayNames([locale], { type: "region" }).of(upper) || upper
    } catch {
      name = upper
    }
  }
  REGION_NAMES.set(key, name)
  return name
}

/**
 * BCP-47 语言标签 → 我们支持的语言码。
 * 只按主语言匹配（`zh-Hans-CN` / `zh-TW` 都算中文，`en-GB` 算英文）。
 */
export function matchLocale(tag: string | null | undefined): LocaleCode | null {
  if (!tag) return null
  const primary = tag.toLowerCase().split(/[-_]/)[0]
  if (!primary) return null
  const found = LOCALES.find((item) => item.code === primary)
  return found ? found.code : null
}

/** 按浏览器/系统的语言偏好挑一个（顺序即优先级），都不认就用英文 */
export function detectLocale(languages: readonly string[]): LocaleCode {
  for (const tag of languages) {
    const matched = matchLocale(tag)
    if (matched) return matched
  }
  return FALLBACK_LOCALE
}

/** 系统语言偏好：WebView 里的 `navigator.languages` 就是操作系统那一份 */
function systemLocales(): readonly string[] {
  if (typeof navigator === "undefined") return []
  const list = navigator.languages
  if (Array.isArray(list) && list.length > 0) return list
  return navigator.language ? [navigator.language] : []
}

/** 已存的选择优先；没存过（或存的值不认识）才跟随系统语言 */
export function resolveLocale(stored: string | null | undefined, languages: readonly string[]): LocaleCode {
  return isLocaleCode(stored) ? stored : detectLocale(languages)
}

export function readStoredLocale(): LocaleCode {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), systemLocales())
  } catch {
    return detectLocale(systemLocales())
  }
}

export function writeStoredLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code)
  } catch {
    // 隐私模式等拿不到 localStorage：本次会话照常生效，只是记不住
  }
}

/**
 * 取一条文案：`{name}` 形式的占位符按 vars 替换，缺的占位符原样保留。
 * 目录里没有的条目回退原文（中文），调用方不必为「还没翻译」写兜底分支。
 */
export function translate(code: LocaleCode, text: string, vars?: Record<string, string | number>): string {
  const catalog = CATALOGS[code]
  const hit = catalog ? catalog[text] : undefined
  const out = hit ?? text
  if (!vars) return out
  return out.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  )
}

/**
 * 翻译**一个文本节点**的内容：命中目录就返回替换后的整串，没命中返回 null。
 *
 * 只换掉去掉首尾空白之后的那一段，前后的空白原样保留 —— JSX 里
 * `{" "}` 与换行缩进带来的间距全靠它，吃掉一个空格两段文字就粘在一起了。
 * 键按「折叠空白」匹配，所以 JSX 里跨行的文案与目录里的单行键是同一条。
 */
export function translateInline(text: string, code: LocaleCode): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const hit = translate(code, trimmed.replace(/\s+/g, " "))
  if (hit === trimmed.replace(/\s+/g, " ")) return null
  const lead = text.length - text.trimStart().length
  const trail = text.length - text.trimEnd().length
  return text.slice(0, lead) + hit + (trail > 0 ? text.slice(text.length - trail) : "")
}

/**
 * 这条文案在目录里有没有条目。
 *
 * 与 `translate` 的区别：日语「保存」等条目译文与原文相同（同形汉字），
 * 用「译文 != 原文」判断会误判成没翻；门禁要的是「条目在不在」。
 */
export function hasEntry(code: LocaleCode, text: string): boolean {
  const catalog = CATALOGS[code]
  if (!catalog) return false
  return Object.prototype.hasOwnProperty.call(catalog, text.trim().replace(/\s+/g, " "))
}

/** 目录条目数（门禁与自检用：能一眼看出某种语言翻到哪了） */
export function catalogSize(code: LocaleCode): number {
  return code === "zh" ? 0 : Object.keys(CATALOGS[code] ?? {}).length
}

/**
 * 当前生效的语言（模块级）。
 *
 * 静态文案由 `LocaleBridge` 自动翻；**带插值的动态文案**（`索引 {0} 条`）必须显式调用
 * `t()` —— 那类文本 React 会拆成多个节点，桥没法在不破坏节点的前提下改写。
 * React 组件里优先用 `useLocale().t`（换语言会重渲染）；事件回调、日志生成、toast
 * 这类不在渲染期跑的代码用这里导出的 `t()`。
 */
let activeLocale: LocaleCode = "zh"

/** 由 `LocaleProvider` 在渲染期同步；默认中文（zh）＝原文，未接提供者时行为不变 */
export function setActiveLocale(code: LocaleCode): void {
  activeLocale = code
}

export function getActiveLocale(): LocaleCode {
  return activeLocale
}

/** 取一条**当前语言**的文案（`{name}` 占位符按 vars 替换）；目录缺条目回退中文原文 */
export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(activeLocale, text, vars)
}

/**
 * 列表分隔符：中文用顿号，其余语言用逗号。
 *
 * 纯排版，不进目录 —— 顿号是中文标点，英文 / 日文界面里冒出来很突兀。
 */
export function listSeparator(): string {
  return activeLocale === "zh" ? "、" : ", "
}
