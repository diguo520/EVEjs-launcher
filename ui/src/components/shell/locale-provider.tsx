import * as React from "react"

import {
  getActiveLocale,
  LOCALES,
  readStoredLocale,
  setActiveLocale,
  translate,
  translateInline,
  writeStoredLocale,
  type LocaleCode,
} from "@/lib/i18n"

interface LocaleContextValue {
  locale: LocaleCode
  setLocale: (code: LocaleCode) => void
  /** 取一条带插值的文案（静态文案不用它，翻译桥会处理） */
  t: (text: string, vars?: Record<string, string | number>) => string
  languages: typeof LOCALES
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null)

/** 界面文案翻译桥：跳过这些容器里的文字（日志、代码、用户数据） */
const SKIP_SELECTOR = "[data-i18n-skip],pre,code,textarea,script,style"
/** 会出现在界面上、需要跟随语言的属性 */
const TEXT_ATTRIBUTES = ["title", "placeholder", "aria-label", "alt"] as const

const originals = new WeakMap<Text, string>()
const attributeOriginals = new WeakMap<Element, Map<string, string>>()

function shouldSkip(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null
  if (!element) return true
  if (element.closest(SKIP_SELECTOR)) return true
  const tag = element.tagName
  return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT"
}

/**
 * 就地翻译一个文本节点。
 *
 * 只动 `data`，不重建节点：React 认的是自己那几个文本节点，节点被换掉之后
 * 它的后续更新就写不进真实 DOM 了（时钟、进度条这类每秒都刷的地方会当场暴露）。
 */
function translateTextNode(node: Text, locale: LocaleCode): void {
  if (shouldSkip(node)) return
  const current = node.data
  const next = translateInline(current, locale)
  if (next === null || next === current) return
  if (!originals.has(node)) originals.set(node, current)
  node.data = next
}

function restoreTextNode(node: Text): void {
  const original = originals.get(node)
  if (original !== undefined && node.data !== original) node.data = original
}

function translateAttributes(element: Element, locale: LocaleCode): void {
  for (const name of TEXT_ATTRIBUTES) {
    const value = element.getAttribute(name)
    if (!value) continue
    const next = translateInline(value, locale)
    if (next === null) continue
    if (next === value) continue
    let saved = attributeOriginals.get(element)
    if (!saved) { saved = new Map(); attributeOriginals.set(element, saved) }
    if (!saved.has(name)) saved.set(name, value)
    element.setAttribute(name, next)
  }
}

function restoreAttributes(element: Element): void {
  const saved = attributeOriginals.get(element)
  if (!saved) return
  for (const [name, value] of saved) if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

function walk(root: Node, locale: LocaleCode, restoreFirst: boolean): void {
  if (root instanceof Text) {
    if (restoreFirst) restoreTextNode(root)
    translateTextNode(root, locale)
    return
  }
  if (!(root instanceof Element) && !(root instanceof Document) && !(root instanceof DocumentFragment)) return
  if (root instanceof Element) {
    if (restoreFirst) restoreAttributes(root)
    translateAttributes(root, locale)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text) {
      if (restoreFirst) restoreTextNode(node)
      translateTextNode(node, locale)
    } else if (node instanceof Element) {
      if (restoreFirst) restoreAttributes(node)
      translateAttributes(node, locale)
    }
    node = walker.nextNode()
  }
}

/**
 * 把「中文原文」换成当前语言：
 *   1) 切换语言时先把上一次的原文写回（否则中英会串味），再翻一遍；
 *   2) 之后 React 每次重渲染都由 MutationObserver 补翻 —— 文案在源码里是中文字面量，
 *      重渲染会把译文覆盖回中文，观察器负责再翻一次。
 *
 * 只处理**静态文案**（目录里逐字命中的那些）。带插值的动态文案（`安装包 {0}`）
 * 走 `t()` 显式调用：那类文本 React 会拆成多个节点，桥没法在不破坏节点的前提下改写。
 */
function LocaleBridge({ locale }: { locale: LocaleCode }) {
  React.useEffect(() => {
    const body = document.body
    if (!body) return
    walk(body, locale, true)
    let frame = 0
    const pending = new Set<Node>()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") pending.add(record.target)
        else for (const node of record.addedNodes) pending.add(node)
      }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        for (const node of pending) {
          if (!node.isConnected) continue
          walk(node, locale, false)
        }
        pending.clear()
      })
    })
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [locale])
  return null
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<LocaleCode>(() => readStoredLocale())

  // 渲染期同步模块级语言：非 React 代码（日志、toast、事件回调）里的 `t()` 靠它取当前语言。
  // 必须在子节点渲染前生效，所以放在这里而不是 useEffect 里。
  setActiveLocale(locale)

  const setLocale = React.useCallback((code: LocaleCode) => {
    writeStoredLocale(code)
    setLocaleState(code)
  }, [])

  /**
   * 文案取值函数**刻意做成稳定引用**：读的是模块级的当前语言，而不是闭包里的 locale。
   * 事件回调里常有 `useCallback(fn, [])` 这种空依赖写法，若 `t` 随语言变化换引用，
   * 那些回调会一直拿着**切语言之前**的那份 `t`（toast 里就会冒出一句旧语言）。
   * 稳定引用 + 模块级 locale 让两边都成立：随时取到当前语言，依赖表也不用改。
   */
  const t = React.useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(getActiveLocale(), text, vars),
    []
  )

  React.useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale
  }, [locale])

  const value = React.useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      languages: LOCALES,
    }),
    [locale, setLocale, t]
  )

  return (
    <LocaleContext.Provider value={value}>
      <LocaleBridge locale={locale} />
      {children}
    </LocaleContext.Provider>
  )
}

export function useLocale(): LocaleContextValue {
  const value = React.useContext(LocaleContext)
  if (!value) throw new Error("useLocale 必须在 LocaleProvider 内使用")
  return value
}
