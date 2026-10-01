#!/usr/bin/env node
/**
 * 离线重算快照：把评价行算成 `ratings.json` + `reviews/<modId>.json` 并签名。
 *
 * 三种用法，都走 `infra/src/` 里**同一份**纯逻辑（Worker 定时任务用的也是它）：
 *
 *   1) 生成 GitHub 镜像（备门）：本地导出 D1 后重算，产物 commit 进索引仓库的 `docs/ratings/`；
 *   2) 本地端到端验证：造一份 rows 喂进来，起个静态服务，把启动器的评价源指过去；
 *   3) 灾难恢复：D1 丢了也能从最近的导出里把快照重算出来。
 *
 * 用法：
 *   node infra/scripts/build-snapshot.mjs --rows rows.json --out .parity-out/ratings \
 *        --key .keys/ratings-key.pem --key-id evejs-ratings-2026-10-01
 *
 * 取 rows 的两条路（`--rows` 只吃 JSON 文件，故意不在这儿连网）：
 *   npx wrangler d1 execute evejs-mod-ratings --remote --json \
 *     --command "SELECT ... FROM reviews ..." > rows.json
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { bytesToBase64, signDocument } from "../src/canonical.js"
import { SNAPSHOT_SCHEMA_VERSION, aggregateReviews, reviewShard, shardPath } from "../src/snapshot.js"

const args = process.argv.slice(2)
const value = (name, fallback = null) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const rowsPath = value("--rows")
const outDir = value("--out")
const keyPath = value("--key")
const keyId = value("--key-id", "")
if (!rowsPath || !outDir || !keyPath) {
  console.error("用法：node infra/scripts/build-snapshot.mjs --rows <rows.json> --out <dir> --key <pem> --key-id <id>")
  process.exit(2)
}
if (!keyId) {
  console.error("缺少 --key-id：快照里的 signature.keyId 必须与启动器内置的 RATINGS_KEY_ID 一致")
  process.exit(2)
}

/** wrangler d1 execute --json 给的是 [{results: [...]}]，裸数组也收 */
function readRows(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => (Array.isArray(item?.results) ? item.results : [item]))
  }
  if (Array.isArray(parsed?.results)) return parsed.results
  throw new Error("rows 文件既不是数组，也没有 results 字段")
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath))
const secret = bytesToBase64(privateKey.export({ type: "pkcs8", format: "der" }))
const rows = readRows(rowsPath)
const generatedAt = Number(value("--at", Date.now()))

const write = (relative, value) => {
  const target = path.join(outDir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n", "utf8")
}

const ratings = await signDocument(
  secret,
  { schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt, mods: aggregateReviews(rows) },
  keyId
)
write("ratings.json", ratings)

let shards = 0
const modIds = [...new Set(rows.filter((row) => !row?.hidden).map((row) => String(row.mod_id)))].sort()
for (const modId of modIds) {
  const relative = shardPath(modId)
  if (!relative) {
    console.warn(`跳过形状不合法的模组标识：${modId}`)
    continue
  }
  write(relative, await signDocument(secret, { schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt, ...reviewShard(modId, rows) }, keyId))
  shards += 1
}

console.log(`已写入 ${outDir}：${Object.keys(ratings.mods).length} 个模组的聚合分、${shards} 份评论分片（keyId=${keyId}）`)