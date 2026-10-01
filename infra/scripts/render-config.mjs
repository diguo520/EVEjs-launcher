#!/usr/bin/env node
/**
 * CI 专用：把 wrangler.toml 里的资源占位符换成 GitHub Actions 注入的真实 id。
 *
 * 为什么不在仓库里直接填 id：
 *   database_id / KV namespace id 是账号内的资源标识，填进去就等于把维护者的账号结构
 *   写进了公开仓库；而且换账号时还得改提交。占位符 + runner 上现场替换，
 *   仓库里那份永远是模板，本机部署的人才在本地填。
 *
 * 用法（工作目录 infra/）：
 *   D1_DATABASE_ID=xxx KV_NAMESPACE_ID=yyy node scripts/render-config.mjs
 *
 * 只动 <infra>/wrangler.toml；runner 是一次性的，不需要还原。
 */
import fs from "node:fs"
import path from "node:path"

const D1_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID"
const KV_PLACEHOLDER = "REPLACE_WITH_KV_NAMESPACE_ID"

const d1 = String(process.env.D1_DATABASE_ID ?? "").trim()
const kv = String(process.env.KV_NAMESPACE_ID ?? "").trim()

const missing = []
if (!d1) missing.push("D1_DATABASE_ID")
if (!kv) missing.push("KV_NAMESPACE_ID")
if (missing.length > 0) {
  console.error(`缺少环境变量：${missing.join(" / ")}`)
  console.error("它们应来自仓库 Variables（Settings → Secrets and variables → Actions → Variables）。")
  process.exit(2)
}

const file = path.join(import.meta.dirname, "..", "wrangler.toml")
const source = fs.readFileSync(file, "utf8")

if (!source.includes(D1_PLACEHOLDER) || !source.includes(KV_PLACEHOLDER)) {
  console.error("wrangler.toml 里找不到占位符 —— 可能已经在本机填过真实 id，请先还原成占位符再提交。")
  process.exit(2)
}

const rendered = source.split(D1_PLACEHOLDER).join(d1).split(KV_PLACEHOLDER).join(kv)
fs.writeFileSync(file, rendered, "utf8")
console.log(`已注入 D1 / KV id：${path.relative(process.cwd(), file)}`)