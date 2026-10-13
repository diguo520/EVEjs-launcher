/** 快照生成的纯逻辑：聚合口径、分片筛选与排序、路径白名单 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  SNAPSHOT_SCHEMA_VERSION,
  aggregateReviews,
  reviewShard,
  shardPath,
  toDateString,
} from "../src/snapshot.js"

const row = (over = {}) => ({
  id: "r1",
  mod_id: "evejs-a",
  version: "1.0.0",
  stars: 5,
  body: "",
  author_name: "指挥官",
  corp: "",
  key_id: "abc",
  created_at: Date.UTC(2026, 9, 1),
  updated_at: Date.UTC(2026, 9, 1),
  edited: 0,
  hidden: 0,
  ...over,
})

/** 星标行：只要 mod_id / key_id / created_at（服务端不取 public_key） */
const starRow = (over = {}) => ({
  mod_id: "evejs-a",
  key_id: "key-1",
  created_at: Date.UTC(2026, 9, 1),
  ...over,
})

test("聚合：星标数是唯一评分口径，遗留均分只有 0 与 5", () => {
  const mods = aggregateReviews(
    [],
    [starRow({ key_id: "k1" }), starRow({ key_id: "k2" }), starRow({ key_id: "k3" })]
  )
  assert.deepEqual(mods["evejs-a"], {
    stars: 3,
    comments: 0,
    // 下面三个是给老客户端看的遗留口径：点星按 5 分折算
    average: 5,
    count: 3,
    withText: 0,
    histogram: [0, 0, 0, 0, 3],
  })
})

test("聚合：星标与评论分开算，只评论不点星也算一条评论", () => {
  const mods = aggregateReviews(
    [row({ id: "a", body: "好用" }), row({ id: "b", body: "" }), row({ id: "c", body: "   " })],
    [starRow({ key_id: "k1" })]
  )
  assert.equal(mods["evejs-a"].stars, 1)
  assert.equal(mods["evejs-a"].comments, 3)
  assert.equal(mods["evejs-a"].withText, 1)
})

test("聚合：隐藏的评论不进统计，没有 mod_id 的行一律跳过", () => {
  const mods = aggregateReviews(
    [row({ id: "a" }), row({ id: "b", hidden: 1 }), row({ id: "c", mod_id: "" })],
    [starRow({ key_id: "k1" }), starRow({ key_id: "k2", mod_id: "" })]
  )
  assert.deepEqual(Object.keys(mods), ["evejs-a"])
  assert.equal(mods["evejs-a"].comments, 1)
  assert.equal(mods["evejs-a"].stars, 1)
})

test("聚合：一个模组都没有时返回空表，不是报错", () => {
  assert.deepEqual(aggregateReviews([]), {})
  assert.deepEqual(aggregateReviews(undefined), {})
  assert.deepEqual(aggregateReviews(undefined, undefined), {})
})

test("分片：只装本模组的、未隐藏的评价，最新的在前", () => {
  const shard = reviewShard("evejs-a", [
    row({ id: "old", mod_id: "evejs-a", updated_at: Date.UTC(2026, 0, 1) }),
    row({ id: "new", mod_id: "evejs-a", updated_at: Date.UTC(2026, 8, 1) }),
    row({ id: "other", mod_id: "evejs-b" }),
    row({ id: "hidden", mod_id: "evejs-a", hidden: 1, updated_at: Date.UTC(2026, 9, 9) }),
  ])
  assert.equal(shard.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
  assert.equal(shard.modId, "evejs-a")
  assert.deepEqual(
    shard.reviews.map((item) => item.id),
    ["new", "old"]
  )
  // 没有星标行时分片里也必须有 stars 块（形状固定），否则客户端读不到「我点过没有」
  assert.deepEqual(shard.stars, { count: 0, keys: [] })
})

test("分片：星标名单只装本模组的，按时间升序（同名时间再按 keyId 稳定排序）", () => {
  const shard = reviewShard("evejs-a", [], [
    starRow({ key_id: "late", created_at: Date.UTC(2026, 9, 3) }),
    starRow({ key_id: "early", created_at: Date.UTC(2026, 9, 1) }),
    starRow({ key_id: "tie-b", created_at: Date.UTC(2026, 9, 2) }),
    starRow({ key_id: "tie-a", created_at: Date.UTC(2026, 9, 2) }),
    starRow({ key_id: "other", mod_id: "evejs-b" }),
  ])
  assert.deepEqual(shard.stars, {
    count: 4,
    keys: ["early", "tie-a", "tie-b", "late"],
  })
})

test("分片：有回复才带 reply，没有就不带这个键", () => {
  const shard = reviewShard("evejs-a", [
    row({ id: "with", reply_body: "谢谢", reply_at: Date.UTC(2026, 8, 2), reply_edited: 1 }),
    row({ id: "without" }),
  ])
  const withReply = shard.reviews.find((item) => item.id === "with")
  const without = shard.reviews.find((item) => item.id === "without")
  assert.deepEqual(withReply.reply, { date: "2026-09-02", body: "谢谢", edited: true })
  assert.equal("reply" in without, false)
})

test("分片：日期落成 UTC 的 YYYY-MM-DD（界面按 `${date}T00:00:00Z` 算几天前）", () => {
  assert.equal(toDateString(Date.UTC(2026, 9, 1, 23, 59)), "2026-10-01")
  assert.equal(toDateString(0), "")
  assert.equal(toDateString(Number.NaN), "")
})

test("分片路径：只放行小写字母/数字/短横，挡住 .. 与斜杠", () => {
  assert.equal(shardPath("evejs-automining"), "reviews/evejs-automining.json")
  // 大写先归一成小写再判（与 Rust 的 reviews_for 同序：先 lowercase 再白名单）
  assert.equal(shardPath("EVEJS-X"), "reviews/evejs-x.json")
  assert.equal(shardPath("../../etc/passwd"), "")
  assert.equal(shardPath(""), "")
  assert.equal(shardPath("-lead"), "")
  assert.equal(shardPath("a".repeat(65)), "")
})
