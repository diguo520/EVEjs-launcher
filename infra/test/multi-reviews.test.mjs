/**
 * 「一人一条评价」放开后的行为测试（2026-10-29）。
 *
 * 与其他 infra 测试不同，这里**跑真 SQLite**（Node 自带的 `node:sqlite`）：
 * 冲突语义（`ON CONFLICT (id)` + 作者守卫）与迁移删索引都只能靠真库证明 ——
 * `worker.test.mjs` 那个 D1 桩只记录 SQL 文本、不执行。
 *
 * 建库方式与生产一致：按 `migrations/` 依次 apply（不是读 `schema.sql`——
 * 那份是初始 schema，`country` 等列由后续迁移补）。
 */
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"

import { DatabaseSync } from "node:sqlite"

import { __internals } from "../src/index.js"

const { REVIEW_UPSERT_SQL } = __internals
const KEY_A = "pubkey-aaaa"
const KEY_B = "pubkey-bbbb"

/** 把 `migrations/` 里编号 ≤ upto 的迁移依次执行（生产就是这么建的库） */
async function applyMigrations(db, upto = 999) {
  const dir = new URL("../migrations/", import.meta.url)
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()
  for (const file of files) {
    if (Number(file.slice(0, 4)) > upto) continue
    db.exec(await readFile(new URL(file, dir), "utf8"))
  }
}

/** 建一个空库并 apply 迁移（upto < 4 可复现「迁移前」的旧状态） */
async function freshDb({ upto = 999 } = {}) {
  const db = new DatabaseSync(":memory:")
  await applyMigrations(db, upto)
  return db
}

/** 用 worker 的**真 SQL** 写一条（参数顺序与 upsertReview 的 bind 一致） */
function writeReview(db, { id, modId = "evejs-autolockfire", publicKey, body, at = 1 }) {
  db.prepare(REVIEW_UPSERT_SQL).run(
    id,
    modId,
    "1.0.10",
    "a".repeat(64),
    5,
    body,
    "CN",
    "au-1",
    "kid-1",
    publicKey,
    "sig",
    at,
    at
  )
}

test("同一身份可以写第二条：不同 id 各自成行，不覆盖第一条", async () => {
  const db = await freshDb()
  writeReview(db, { id: "rv-1000-1", publicKey: KEY_A, body: "第一条" })
  writeReview(db, { id: "rv-1000-2", publicKey: KEY_A, body: "第二条" })
  const rows = db.prepare("SELECT id, body FROM reviews ORDER BY id").all()
  assert.equal(rows.length, 2, JSON.stringify(rows))
  assert.equal(rows[0].body, "第一条")
  assert.equal(rows[1].body, "第二条")
})

test("编辑同一条：按 id 原地覆盖，不新增行，并标 edited（created_at 不动）", async () => {
  const db = await freshDb()
  writeReview(db, { id: "rv-2000-1", publicKey: KEY_A, body: "原文" })
  writeReview(db, { id: "rv-2000-1", publicKey: KEY_A, body: "改过", at: 9 })
  const rows = db.prepare("SELECT id, body, edited, created_at FROM reviews").all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].body, "改过")
  assert.equal(rows[0].edited, 1)
  assert.equal(rows[0].created_at, 1, "created_at 不该被编辑改掉")
})

test("作者守卫：拿别人的 id 改不动那一行", async () => {
  const db = await freshDb()
  writeReview(db, { id: "rv-3000-1", publicKey: KEY_A, body: "作者原话" })
  writeReview(db, { id: "rv-3000-1", publicKey: KEY_B, body: "我想改别人的" })
  const row = db.prepare("SELECT public_key, body FROM reviews WHERE id = ?").get("rv-3000-1")
  assert.equal(row.public_key, KEY_A, "归属不能被顶掉")
  assert.equal(row.body, "作者原话")
})

test("迁移 0004：删掉旧唯一索引之后，同一身份才能写第二条", async () => {
  const db = await freshDb({ upto: 3 })
  writeReview(db, { id: "rv-4000-1", publicKey: KEY_A, body: "第一条" })
  assert.throws(
    () => writeReview(db, { id: "rv-4000-2", publicKey: KEY_A, body: "第二条" }),
    /UNIQUE/i,
    "旧 schema 上第二条必须被唯一索引挡住（否则这条测试就失去意义了）"
  )
  // 只补跑 0004：迁移链不是幂等的（0002 的 ALTER 再跑一次会报重复列），这也是生产用
  // wrangler 的记录表来跳过的原因
  db.exec(await readFile(new URL("../migrations/0004_multi_reviews.sql", import.meta.url), "utf8"))
  writeReview(db, { id: "rv-4000-2", publicKey: KEY_A, body: "第二条" })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reviews").get().n, 2)
})

test("schema.sql 不再建那个唯一索引（防回退）", async () => {
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8")
  const withoutComments = schema.replace(/--[^\n]*/g, "")
  assert.equal(
    /CREATE UNIQUE INDEX[^;]*idx_reviews_voter/.test(withoutComments),
    false,
    "一人一条的约束已经放开，schema 里不该再建它"
  )
})

test("撤回按 id 只删那一条（另一条留着）", async () => {
  const db = await freshDb()
  writeReview(db, { id: "rv-5000-1", publicKey: KEY_A, body: "留着的" })
  writeReview(db, { id: "rv-5000-2", publicKey: KEY_A, body: "要撤的" })
  db.prepare("DELETE FROM reviews WHERE id IN (?)").run("rv-5000-2")
  const rows = db.prepare("SELECT id FROM reviews").all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, "rv-5000-1")
})
