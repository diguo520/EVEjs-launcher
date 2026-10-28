/**
 * 「有未保存改动」的全局登记处（H4，2026-10-28）。
 *
 * 起因：切页时整棵子树会被卸载（`App.tsx` 的 `<main key={view}>`），而草稿以前只活在页面内
 * state 里 —— 改了 20 条参数、切去别的页看一眼回来，保存条就显示「没有未保存的改动」，改动无声消失。
 * 现在两件事一起做：
 *
 *   1. 草稿本体放**模块级会话缓存**（见 `hooks/use-game-config.ts`、`pages/config-page.tsx`），切页也在；
 *   2. 各页面把「有没有改动」登记到这里，窗口关闭时由 App 挂的 `beforeunload` 拦住。
 *
 * `beforeunload` 的提示文案由**浏览器**给（我们只 preventDefault + 清空 returnValue），
 * 所以这条修复不需要新增任何 i18n 条目 —— 本仓有「用户可见中文必须命中 en 目录」的硬门禁。
 */
const dirty = new Map<string, boolean>()

/** 某个页面（用稳定的 scope 名）登记自己的未保存状态 */
export function markUnsaved(scope: string, value: boolean): void {
  if (value) dirty.set(scope, true)
  else dirty.delete(scope)
}

/** 现在有没有任何页面留着未保存的改动（窗口关闭时用） */
export function hasUnsaved(): boolean {
  return dirty.size > 0
}

/** 草稿之间的比较：两边都是「键 → 文本」的扁平对象，序列化比即够用 */
export function sameDraft(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
