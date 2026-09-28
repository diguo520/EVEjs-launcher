/**
 * 启动器更新说明（更新清单里的 `changelog`）的解析与分组。
 *
 * 形状与现役 Electron 0.1.28 的 `changelogForLanguage()` 逐条对齐（launcher-bridge.js）：
 *   1) `{ zh: [{ type, text }], en: [...] }` —— 双语，新外壳与现役版都用这个；
 *   2) `[{ type, text }]` —— 单语言数组（老清单的写法）。
 * 认不出来就回空数组 —— 界面宁可什么都不写，也不编内容。
 */
import type { ReleaseNoteGroup } from "@/lib/mock"

interface RawNote {
  type?: unknown
  text?: unknown
}

/** 分组口径按原型：新增 → 优化 → 修复 */
const GROUPS = [
  { type: "new", group: "新增" },
  { type: "opt", group: "优化" },
  { type: "fix", group: "修复" },
] as const

/** 契约外的 type（老清单可能带别的值）：收进「其它」，原型对认不出的分组本来就有兜底图标 */
const FALLBACK_GROUP = "其它"

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isBilingual(node: unknown): node is Record<string, unknown> {
  return (
    typeof node === "object" &&
    node !== null &&
    !Array.isArray(node) &&
    ("zh" in node || "en" in node)
  )
}

/**
 * 从清单的 `changelog` 里取出当前语言那一份。
 * 双语对象优先取本语言，缺了退回另一种；单语言数组原样返回。
 */
export function changelogForLanguage(value: unknown, language: "zh" | "en" = "zh"): unknown[] {
  if (Array.isArray(value)) {
    // 只包了一层 { zh, en } 的数组（老清单偶尔这么写）先拆开
    if (value.length === 1 && isBilingual(value[0])) {
      const wrapped = value[0]
      return asArray(wrapped[language] ?? wrapped.en ?? wrapped.zh)
    }
    return value
  }
  if (isBilingual(value)) {
    return asArray(value[language] ?? value.en ?? value.zh)
  }
  return []
}

/** 把逐条说明按 type 分组，顺序固定「新增 / 优化 / 修复 / 其它」 */
export function groupNotes(notes: unknown): ReleaseNoteGroup[] {
  const items: { type: string; text: string }[] = []
  for (const note of asArray(notes)) {
    if (typeof note !== "object" || note === null) continue
    const { type, text } = note as RawNote
    if (typeof text !== "string" || !text.trim()) continue
    items.push({ type: typeof type === "string" ? type : "", text: text.trim() })
  }

  const groups: ReleaseNoteGroup[] = []
  for (const { type, group } of GROUPS) {
    const list = items.filter((item) => item.type === type).map((item) => item.text)
    if (list.length > 0) groups.push({ group, items: list })
  }
  const known = new Set<string>(GROUPS.map((item) => item.type))
  const rest = items.filter((item) => !known.has(item.type)).map((item) => item.text)
  if (rest.length > 0) groups.push({ group: FALLBACK_GROUP, items: rest })
  return groups
}

/** 清单里的一版说明 → 弹窗直接可用的一组：一次把语言与分组都处理好 */
export function releaseNotesFrom(changelog: unknown, language: "zh" | "en" = "zh"): ReleaseNoteGroup[] {
  return groupNotes(changelogForLanguage(changelog, language))
}
