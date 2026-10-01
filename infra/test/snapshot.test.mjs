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

test("聚合：平均分与直方图按 1-5 星分桶", () => {
  const mods = aggregateReviews([
    row({ id: "a", stars: 5 }),
    row({ id: "b", stars: 4 }),
    row({ id: "c", stars: 3 }),
    row({ id: "d", stars: 5 }),
  ])
  assert.deepEqual(mods["evejs-a"], {
    average: 4.25,
    count: 4,
    withText: 0,
    histogram: [0, 0, 1, 1, 2],
  })
})

test("聚合：count 是打过分的人，withText 才是写了字的人（两个口径刻意分开）", () => {
  const mods = aggregateReviews([
    row({ id: "a", stars: 5, body: "好用" }),
    row({ id: "b", stars: 4, body: "" }),
    row({ id: "c", stars: 5, body: "   " }),
  ])
  assert.equal(mods["evejs-a"].count, 3)
  assert.equal(mods["evejs-a"].withText, 1)
})

test("聚合：隐藏的与非法星级都不进统计", () => {
  const mods = aggregateReviews([
    row({ id: "a", stars: 5 }),
    row({ id: "b", stars: 5, hidden: 1 }),
    row({ id: "c", stars: 0 }),
    row({ id: "d", stars: 6 }),
    row({ id: "e", stars: 3.5 }),
    row({ id: "f", stars: 4, mod_id: "" }),
  ])
  assert.deepEqual(Object.keys(mods), ["evejs-a"])
  assert.equal(mods["evejs-a"].count, 1)
})

test("聚合：一个模组都没有时返回空表，不是报错", () => {
  assert.deepEqual(aggregateReviews([]), {})
  assert.deepEqual(aggregateReviews(undefined), {})
})

test("聚合：平均分只保留两位小数，签名负载里不出现长尾浮点", () => {
  const mods = aggregateReviews([row({ stars: 4 }), row({ id: "b", stars: 4 }), row({ id: "c", stars: 5 })])
  assert.equal(mods["evejs-a"].average, 4.33)
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