-- 星标（GitHub 式点赞）：二元、可取消、一人一颗。
--
-- 与 `reviews`（评论）解耦：只点星不写评论、只写评论不点星都成立，
-- 因此另起一张表，而不是继续用 `reviews.stars` 那个 1..5 的分值列。
--
-- 历史迁移：老的 1..5 分评价按「评过 = 点过星」折算成一颗星，分值本身丢弃
-- （星标模型的语义是「推荐 / 不推荐」，五档均分没有对应物）。
CREATE TABLE IF NOT EXISTS stars (
  mod_id      TEXT    NOT NULL,
  public_key  TEXT    NOT NULL,
  key_id      TEXT    NOT NULL,
  identity_id TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (mod_id, public_key)
);
CREATE INDEX IF NOT EXISTS idx_stars_mod ON stars (mod_id, created_at DESC);

-- 幂等：migration 只会跑一次，但重复执行也不该把星标翻倍。
INSERT OR IGNORE INTO stars (mod_id, public_key, key_id, identity_id, created_at)
SELECT mod_id, public_key, key_id, identity_id, updated_at
  FROM reviews
 WHERE hidden = 0;
