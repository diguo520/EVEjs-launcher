/**
 * 把工程源码打成一个 zip，放到 public/ 下，界面上「设置 → 关于 → 下载源码包」用的就是它。
 *
 *   node scripts/pack-source.mjs [输出文件名]
 *
 * 优先用系统的 zip，没有就退回 python3 的 zipfile；两者都没有会直接报错退出。
 * 依赖目录、构建产物、日志、打包产物自身都不进包。
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const outName = process.argv[2] ?? "evejs-command-src.zip"
const outFile = path.join(root, "public", outName)

/** 相对工程根目录的路径，一律用 / 分隔，zip 与 python 都认 */
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-ssr",
  "logs",
  ".rh",
  "project",
  ".git",
  ".vscode",
  ".idea",
])

function collect(dir = ".") {
  const rel = path.relative(root, path.join(root, dir))
  const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const child = dir === "." ? e.name : `${dir}/${e.name}`
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(childRel)) continue
      files.push(...collect(child))
      continue
    }
    // 打包产物自己不进包；顺便跳过本地临时文件与系统垃圾
    if (childRel === `public/${outName}`) continue
    if (e.name === ".DS_Store" || e.name.endsWith(".local")) continue
    files.push(childRel)
  }
  return files
}

const files = collect()
if (files.length === 0) {
  console.error("没有找到要打包的文件，确认一下是不是在工程根目录跑的")
  process.exit(1)
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.rmSync(outFile, { force: true })

/** zip 存在就用 zip，命令行最省事 */
function withZip() {
  execFileSync(
    "zip",
    ["-q", "-r", "-X", outFile, ...files, ...files.length ? ["-x", "*.DS_Store"] : []],
    { cwd: root, stdio: "inherit" }
  )
}

/** 退回 python3：标准库 zipfile，逐条写入，压缩级别沿用默认 */
function withPython() {
  const script = `
import sys, zipfile
out, root = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        z.write(f"{root}/{f}", f)
`
  execFileSync("python3", ["-c", script, outFile, root, ...files], { stdio: "inherit" })
}

function has(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

if (has("zip")) withZip()
else if (has("python3")) withPython()
else {
  console.error("需要系统里有 zip 或 python3 才能打包")
  process.exit(1)
}

const kb = fs.statSync(outFile).size / 1024
console.log(
  `已打包 ${files.length} 个文件 → public/${outName}（${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`}）`
)
