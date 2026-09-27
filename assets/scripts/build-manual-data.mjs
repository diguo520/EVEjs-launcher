/**
 * 从「EVE.js 全指令手册」单文件 HTML 里抽出结构化数据，写进 src/data/。
 *
 *   node scripts/build-manual-data.mjs <手册 HTML 路径>
 *
 * 手册把数据以 `var __XXX_DATA__ = [...]` 的形式内联在 <script> 里，
 * 本脚本按括号配平把字面量切出来（字符串里的括号要跳过），再落成 JSON。
 * 三个大表（模板 / 物品 / NPC）在页面里是懒加载的，别改成同步 import。
 */
import fs from "node:fs"
import path from "node:path"

const src = process.argv[2]
if (!src) {
  console.error("用法: node scripts/build-manual-data.mjs <手册 HTML 路径>")
  process.exit(1)
}

const outDir = path.resolve(import.meta.dirname, "../src/data")
const html = fs.readFileSync(src, "utf8")

/** 从 `var NAME = ` 处切出字面量：取 [ 与 { 里先出现的那个，再按括号配平 */
function sliceLiteral(text, from) {
  const a = text.indexOf("[", from)
  const b = text.indexOf("{", from)
  const start = a === -1 ? b : b === -1 ? a : Math.min(a, b)
  const open = text[start]
  const close = open === "[" ? "]" : "}"
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(`括号不配平: ${open}`)
}

const literalAt = (keyword, name) => {
  const at = html.indexOf(`${keyword} ${name} = `)
  if (at < 0) throw new Error(`手册里找不到 ${name}`)
  return sliceLiteral(html, at)
}
/** 数据表都是纯 JSON */
const readJson = (keyword, name) => JSON.parse(literalAt(keyword, name))
/** 两个名称映射表的键里有 [xxx] 这类非 JSON 键，只能当 JS 求值 */
const readMap = (name) => new Function(`return ${literalAt("const", name)}`)()

const rawCommands = readJson("var", "__COMMANDS_DATA__")
const rawTemplates = readJson("var", "__TEMPLATES_DATA__")
const rawItems = readJson("var", "__ITEMS_DATA__")
const rawNpcs = readJson("var", "__NPC_DATA__")
const tplNameZh = readMap("TPL_NAME_ZH")
const itemNameEn = readMap("ITEM_NAME_EN")

/* ---------------- 指令：25 个分类，条目保留原字段 ---------------- */
const commands = rawCommands.map((group) => ({
  category: group.category,
  commands: group.commands.map((c) => ({
    cmd: c.cmd,
    alias: c.alias || "",
    desc: c.desc || "",
    params: c.params || "",
    example: c.example || "",
    requires: c.requires || "无",
    typeID: c.typeID || "",
    note: c.note || "",
  })),
}))

/* ---------------- 异常模板：[id, 英文名, 中文名, 分类, 势力, 等级, 变体, 来源] ----------------
   有 4 条模板的 name 是对象（客户端没给文案），统一压成空串。 */
const templates = rawTemplates.map((t) => {
  const name = typeof t.name === "string" ? t.name : ""
  return [
    String(t.id),
    name,
    name ? tplNameZh[name] || name : "",
    t.group || "",
    t.faction || "",
    t.tier || "",
    t.variant || "",
    t.source || "",
  ]
})

/* ---------------- 物品：[typeID, 中文名, 英文名, 分组, 分类] ---------------- */
const items = rawItems.map((r) => [
  r[0],
  String(r[1]),
  itemNameEn[r[0]] || "",
  String(r[2]),
  String(r[4]),
])

/* ---------------- NPC：[键, 英文名, typeID, 中文名, 势力ID, 势力, 赏金, 类型] ---------------- */
const npcs = rawNpcs.map((r) => [
  String(r[0]),
  String(r[1]),
  r[2],
  String(r[3]),
  String(r[4]),
  String(r[5]),
  r[6] || 0,
  String(r[7] || "npc"),
])

/* ---------------- QA 装备：手册里是单引号的内联数组，当 JS 求值 ---------------- */
const qaBlock = html.slice(html.indexOf("var qaData = ["))
const qa = new Function(`return ${sliceLiteral(qaBlock, 0)}`)().map((r) => [
  r[0],
  String(r[1]),
  String(r[2]),
])

/* ---------------- 概览数字：列表页要立刻显示总数，不能等大表加载 ---------------- */
const flat = commands.flatMap((g) => g.commands)
const requires = {}
for (const c of flat) requires[c.requires] = (requires[c.requires] || 0) + 1

const meta = {
  source: path.basename(src),
  categories: commands.length,
  commands: flat.length,
  templates: templates.length,
  items: items.length,
  npcs: npcs.length,
  qa: qa.length,
  requires,
}

fs.mkdirSync(outDir, { recursive: true })
const write = (name, data) => {
  const file = path.join(outDir, name)
  fs.writeFileSync(file, JSON.stringify(data))
  const kb = (fs.statSync(file).size / 1024).toFixed(0)
  const rows = Array.isArray(data) ? `${data.length} 条 · ` : ""
  console.log(`${name.padEnd(16)} ${rows}${kb} KB`)
}
write("manual-meta.json", meta)
write("commands.json", commands)
write("qa.json", qa)
write("templates.json", templates)
write("items.json", items)
write("npcs.json", npcs)
console.log("指令条件分布:", JSON.stringify(requires))
