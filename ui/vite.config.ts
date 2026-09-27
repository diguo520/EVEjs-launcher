// 原型（assets/）的 vite.config.ts 原样移植，只加三处 Tauri 适配，其余一律不动：
//   1. base: "./"      —— Tauri 把这一页放在 ui/dist/react/ 下，资源引用必须是相对路径
//   2. build.outDir    —— 产物出到 ui/app-dist，再由 scripts/check-app.mjs 发布到 ui/dist/react
//   3. root            —— 显式写死为 ui/，避免从别处调用时 root 漂移
// rhSourcePlugin（可视化编辑用的 data-rh-src 注入）保留：它 apply: 'serve'，只影响 dev。
//
// ?? 用 Write 改这个文件是禁区。需要 Read + Edit 局部改:
//   - 改 alias / 改 server 端口: 无对应字段
//   - 加别的 plugin: 在 plugins 数组里追加, 但 rhSourcePlugin() 必须留在第 0 位 (enforce: 'pre' 保证它在 react/oxc 之前跑)
//   - 需要删 rhSourcePlugin 那段函数体时, 也不要删 @babel/parser / @babel/traverse / magic-string 这几个 import
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { parse as babelParse } from '@babel/parser'
import _traverse from '@babel/traverse'
import MagicString from 'magic-string'

// @babel/traverse 在不同 bundler 下的 ESM/CJS interop 形态不一样, 这里取 default.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse

// rh-visual-edit: 本地 Vite plugin, 给每个 JSX 元素加 data-rh-src="<rel>:<line>:<col>".
// 不依赖 @vitejs/plugin-react 的 babel hook (plugin-react v6+ 走的是 oxc, 不再接受 babel 选项).
function rhSourcePlugin() {
  return {
    name: 'rh-source',
    enforce: 'pre' as const,
    apply: 'serve' as const,
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0]
      if (!/\.(jsx|tsx)$/.test(cleanId)) return null
      if (cleanId.includes('/node_modules/')) return null
      let ast: any
      try {
        ast = babelParse(code, {
          sourceType: 'module',
          allowReturnOutsideFunction: true,
          plugins: ['jsx', 'typescript'],
        })
      } catch {
        return null
      }
      const cwd = process.cwd()
      const rel = cleanId.startsWith(cwd + '/') ? cleanId.slice(cwd.length + 1) : cleanId
      const filename = rel.replace(/\\/g, '/')
      const ms = new MagicString(code)
      traverse(ast, {
        JSXOpeningElement(p: any) {
          const node = p.node
          const loc = node.loc
          if (!loc) return
          const exists = node.attributes.some(
            (a: any) => a.type === 'JSXAttribute' && a.name && a.name.name === 'data-rh-src',
          )
          if (exists) return
          const nameNode = node.name
          if (!nameNode || nameNode.end == null) return
          // TSX 的 <Foo<T> /> 合法; 但若插在 typeArguments 之后, 会变成
          // <Foo data-rh-src="..."<T> /> 让 oxc/babel 解析失败.
          const insertEnd =
            (node.typeArguments && node.typeArguments.end) ??
            (node.typeParameters && node.typeParameters.end) ??
            nameNode.end
          ms.appendRight(
            insertEnd,
            ` data-rh-src="${filename}:${loc.start.line}:${loc.start.column}"`,
          )
        },
      })
      if (!ms.hasChanged()) return null
      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: true, source: id }),
      }
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [rhSourcePlugin(), react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'app-dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    allowedHosts: ['.runninghub.cn', '.vibex.cn'],
    host: '0.0.0.0',
    port: 8000,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 8000,
  },
})