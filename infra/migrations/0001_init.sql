-- 模组市场 · 评价与评分服务（D1）
--
-- 权威数据只有这一份。启动器读的是定时任务从这些表算出来的快照
-- （`ratings.json` / `reviews/<modId>.json`），GitHub 上那份只是机器生成的只读镜像。
--
-- 表结构一次建齐（写入路径在 M2 接上），M1 只读。

-- 评价：一个人对一个模组只有一条，改分改字都是 UPSERT，不是追加
CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT    PRIMARY KEY,           -- 客户端生成的 reviewId，重试的幂等键
  mod_id      TEXT    NOT NULL,
  version     TEXT    NOT NULL,              -- 写这条评价时装的版本
  pkg_sha256  TEXT    NOT NULL,              -- 装的那个包的 sha256：必须命中 mod_versions 才收
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body        TEXT    NOT NULL DEFAULT '',
  author_name TEXT    NOT NULL DEFAULT '',   -- 落库时的署名，作者改名不追改历史
  corp        TEXT    NOT NULL DEFAULT '',   -- 可选，留空界面不显示
  identity_id TEXT    NOT NULL,              -- au-xxx
  key_id      TEXT    NOT NULL,              -- Ed25519 公钥指纹
  public_key  TEXT    NOT NULL,              -- base64 raw 32 字节
  sig         TEXT    NOT NULL,              -- 上面这些字段的签名
  created_at  INTEGER NOT NULL,              -- epoch 毫秒
  updated_at  INTEGER NOT NULL,
  edited      INTEGER NOT NULL DEFAULT 0,    -- 改过（不是第一次写的那条）
  hidden      INTEGER NOT NULL DEFAULT 0,    -- 自动规则 / 举报命中后隐藏，聚合与分片都跳过
  hide_reason TEXT    NOT NULL DEFAULT ''
);

-- 一人一票：同一个公钥对同一个模组只留一条，改分是覆盖
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_voter ON reviews (mod_id, public_key);
CREATE INDEX IF NOT EXISTS idx_reviews_mod ON reviews (mod_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_key ON reviews (public_key, updated_at DESC);

-- 作者回复：作者用它自己那把身份密钥签，服务端要核对确实是该模组的作者
CREATE TABLE IF NOT EXISTS replies (
  review_id  TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  key_id     TEXT    NOT NULL,
  public_key TEXT    NOT NULL,
  sig        TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  edited     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (review_id, key_id)
);

-- 版本白名单：每小时从 mod-index.json 同步。pkg_sha256 必须命中这里才能评价
-- —— 这条是「装过才能评」的唯一凭据，光靠客户端自称不算数。
CREATE TABLE IF NOT EXISTS mod_versions (
  mod_id    TEXT    NOT NULL,
  version   TEXT    NOT NULL,
  sha256    TEXT    NOT NULL,
  author_key_id TEXT NOT NULL DEFAULT '',   -- 该模组作者的 keyId，回复鉴权用
  active    INTEGER NOT NULL DEFAULT 1,     -- 下架 / 版本过期后置 0
  PRIMARY KEY (mod_id, version)
);
CREATE INDEX IF NOT EXISTS idx_mod_versions_sha ON mod_versions (mod_id, sha256);

-- 举报
CREATE TABLE IF NOT EXISTS reports (
  id         TEXT    PRIMARY KEY,
  review_id  TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  reporter   TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reports_review ON reports (review_id);

-- 按天限流：bucket = `<public_key>:<YYYY-MM-DD>`
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT    PRIMARY KEY,
  used   INTEGER NOT NULL DEFAULT 0
);

-- 运维台账：定时任务每次跑完写一行，健康检查与「多久没同步」看它
CREATE TABLE IF NOT EXISTS job_runs (
  job        TEXT    PRIMARY KEY,
  ran_at     INTEGER NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT    NOT NULL DEFAULT ''
);