import { parse } from "@babel/parser"
import traverseModule from "@babel/traverse"
import { describe, expect, it } from "vitest"

import en from "@/locales/en.json"

/**
 * 源码级 i18n 门禁：把 `.ts/.tsx` 里会被翻译桥看到的中文提取出来，
 * 再要求 **en 目录必须逐条命中**。其它语言的键集合一致性由 `i18n.test.ts`
 * 的目录对齐测试保证，两边合起来就能阻止「界面补了中文、语言目录忘了补」。
 *
 * 例外只在源码旁边写 `i18n-exempt: <原因>`，不要靠测试里维护一堆匿名白名单。
 * 这样以后扫描代码时，豁免原因仍留在它真正属于的位置。
 */

// @babel/traverse 在 ESM/CJS 下的 interop 形态不统一；这里与 vite.config.ts 保持同一取法。
const traverse = ((traverseModule as any).default ?? traverseModule) as typeof traverseModule
/**
 * 已知边界（M11，2026-10-28）：这道门禁只扫 ui/src 下的 .ts/.tsx 源码字面量，
 * `ui/src/data/*.json` 这类数据目录不在管辖范围内。实测边界值：
 *
 *   items.json     27357 条中文串里 27338 条不在 en 目录（名称/分类）
 *   npcs.json       5152 / 5153
 *   templates.json  3443 / 3445
 *
 * 后果：非中文界面在「指令手册 / 异常模板 / 击杀榜」这类直接显示数据名的位置会露中文
 * （物品市场是反例，它按 locale 取 namePair，口径不一致）。
 *
 * 为什么不在这次改掉：这是**数据翻译缺口**（两万七千条名字没有英文），不是门禁能修的。
 * 所以这里把边界写明白，而不是假装看不见 —— 翻译补齐后应把数据目录纳入门禁。
 */
const CHINESE = /[\u3400-\u9fff\uf900-\ufaff]/
const SOURCES = import.meta.glob(
  ["./../*.{ts,tsx}", "./../**/*.{ts,tsx}"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function isExempt(code: string, start: number | null | undefined): boolean {
  if (start == null) return false
  const before = code.slice(Math.max(0, start - 240), start)
  return before.split(/\r?\n/).slice(-3).some((line) => line.includes("i18n-exempt"))
}

describe("i18n source AST gate", () => {
  it("所有源码里的用户可见中文都命中 en 目录，或明确标注 i18n-exempt", () => {
    const catalogKeys = new Set(Object.keys(en))
    const missing: string[] = []

    for (const [file, code] of Object.entries(SOURCES)) {
      if (file.includes("/locales/") || file.endsWith("api-shim.generated.ts")) continue
      if (/\.test\.(ts|tsx)$/.test(file)) continue
      let ast
      try {
        ast = parse(code, {
          sourceType: "module",
          plugins: ["jsx", "typescript"],
          errorRecovery: true,
        })
      } catch {
        continue
      }

      const add = (raw: string | null | undefined, node: any) => {
        if (!raw || !CHINESE.test(raw)) return
        if (isExempt(code, node?.start)) return
        const text = normalize(raw)
        if (!text || catalogKeys.has(text)) return
        const line = node?.loc?.start?.line ?? 1
        missing.push(`${file}:${line} ${text}`)
      }

      traverse(ast as any, {
        StringLiteral(path: any) {
          add(path.node.value, path.node)
        },
        JSXText(path: any) {
          add(path.node.value, path.node)
        },
        TemplateElement(path: any) {
          add(path.node.value.cooked ?? path.node.value.raw, path.node)
        },
      })
    }

    expect(
      missing,
      "源码里有中文没有进入 en 目录。补翻译，或在源码旁写 `// i18n-exempt: 原因`。"
    ).toEqual([])
  })
})
