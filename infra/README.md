# EveJS 模组市场 · 评价与评分服务

启动器里那个「玩家评价 · N 条」和详情弹窗里的评论，数据源就是这个服务。
域名：`https://ping.5318.cm`。

## 为什么不放在 Pages 上

Cloudflare Pages 是**纯静态**的，没有地方放 POST 进来的评价，也没有定时任务。
所以这里落成的是 **Workers + Static Assets + D1 + KV + Cron Trigger**：

| 组件 | 干什么 |
| --- | --- |
| Workers | 唯一入口。读接口 + （M2 起）写接口 |
| Static Assets | 只有一个给人看的状态页，浏览器直接打开 `ping.5318.cm` 就能看健康检查 |
| D1 | 权威数据：评价 / 回复 / 版本白名单 / 举报 / 限流 |
| KV | 定时任务算出来的**只读快照**，启动器读的就是它 |
| Cron | 每 10 分钟重算快照；每小时同步「哪些包允许被评价」的白名单 |

选这个形态而不是「Pages + 单独的 cron Worker」，是因为我们**没有存量静态站**要保，
拆成两个 deploy 只会多一份要维护的东西。哪天真的要做前台页面，再把 `public/` 独立成 Pages
也不迟 —— 读接口的地址不会变。

### 启动器读到的三份东西

```
GET /v1/ratings.json            所有模组的聚合分（平均分 / 人数 / 直方图）
GET /v1/reviews/<modId>.json    单个模组的评论正文，打开详情弹窗时才按需拉
GET /v1/sponsors.json           赞助人「补给线」名单（与评价无关，同一次 cron 一起发）
GET /v1/health                  给你排查用的，启动器不读
```

三份都要**验签**：启动器内置 `RATINGS_PUBKEY`，验不过就整份丢掉（评分不显示，市场照常能用）。
读路径是静态快照而不是现查 D1，图的是能被边缘缓存、能被镜像、能离线重算。

补给线名单同样不进 D1：**本体的家在 KV**（`source:sponsors`），由管理接口维护
（网页在 `/admin.html`），没写过时用 `infra/src/sponsors.js` 里那份种子。
赞助人是维护者手写的一小串名字，让它进库、进后台、进审核流是杀鸡用牛刀；
可锁在代码里也不划算 —— 那等于「加一个人就要跑一次部署」。定时任务会把名单签名写进 KV，
启动器照旧走「多镜像 + 本地缓存 + 验签」读，**改名单不用发版、也不用提交**。
条目形状（币种是三位字母码，国外赞助人用 `USD` / `EUR` 这种）：

```json
{ "id": "sponsor-15", "name": "Cmdr. Nova", "amount": 50, "currency": "USD" }
```

### 启动器写进来的东西（M2）

全部是 `POST` + JSON，**每一条都必须带本机身份的 Ed25519 签名**：

```
POST /v1/reviews            打分 / 改分（一人一票，服务端按 (mod_id, public_key) 覆盖）
POST /v1/reviews/retract    撤回自己那条评价
POST /v1/replies            作者回复 / 改回复
POST /v1/replies/retract    撤回作者回复
POST /v1/reports            举报一条评价（只入库，人工处置）
```

**`/v1/reviews` 是兼容网关**：路径优先，但发到这个地址的请求会**按 body 里的 `action` 分派**
（`review.upsert` / `review.retract` / `reply.upsert` / `reply.retract` / `report.create`）。
起因是 0.3.0 的启动器只有一个写地址（Rust 侧 `DEFAULT_REVIEW_WRITE_URLS`），五个动作**全**发到
`/v1/reviews`，于是「作者回复」撞进 `validateReview`，回一句「version 不合法」（2026-10-02 报障）。
照 `action` 分派不算「信客户端自称」—— `action` 本来就在签名负载里（`canonicalJson` 覆盖全部
顶层键），每个 handler 照样先验签、再拿 `payload` 跟请求体核对，签名不对一律 403。
0.3.1 起启动器改成按动作选路径（`src-tauri/src/mods/review.rs` 的 `action_url`），
这条网关留给已经装出去的 0.3.0。

签名负载就是请求体本身去掉 `signature` 之后的那份 JSON（规范化规则见 `src/canonical.js`，
与启动器的 Rust 侧逐字节一致，parity 固定向量在两边的单测里都钉着）。
服务端**不替客户端改写任何值再验签** —— 一改写就等于改了签名负载，客户端只会收到
「签名不匹配」这种跟真实原因无关的报错；形状不对就直接带着原因拒掉。

| 约束 | 值 | 为什么 |
| --- | --- | --- |
| 一人一票 | `UNIQUE(mod_id, public_key)` | 改分是覆盖，不是追加 |
| 「装过才能评」 | `pkg_sha256` 必须命中 `mod_versions`（每小时从索引同步） | 本地目录算不出包指纹，只能来自市场索引 |
| 每人每天 | 评价 20 条 / 举报 10 条 | 防刷 |
| 每 IP 每小时 | 写请求 60 次 | IP 在这一刻就变成 `HMAC(密钥, IP)` 的前 8 字节，**不落原始 IP** |
| 正文长度 | 评价 2000 字 / 回复 1000 字 / 举报理由 500 字 | 进别人的界面，宁可拒长 |
| 作者回复 | 签名者的 keyId 必须命中该模组的作者 | 不是作者就发不出回复 |

**地区码**：请求体里没有这个字段，服务端从 Cloudflare 白送的 `request.cf.country` 取两字母码
（`XX` / `T1` / `A1` / `A2` / `O1` 这类未知与匿名网络一律落空串）。拿不到 `request.cf` 对象的入口
（本地 `wrangler dev`、某些中转）退回同一个边缘一定会加上的 `CF-IPCountry` 头；两边都没有才算
「未知地区」。评论列表里显示的是「来自 <地区> 的玩家」+ 一面 SVG 旗子，**不显示用户名**，
所以评价服务也就不需要账号系统。原始 IP 只用来限流，且当场就散列掉。

排查「为什么显示未知地区」：`GET /v1/health` 的 `edge` 回的是**调用方自己**这一侧的读数 ——
`hasCf`（有没有 cf 对象）、`colo`（落到哪个边缘）、`country`（服务端算出来的码）、
`headerCountry`（`CF-IPCountry` 头的原值）。在出问题的那台机器上打开一次 `/v1/health`，
就知道是边缘没给，还是给了一个被过滤掉的码。`https://ping.5318.cm/cdn-cgi/trace` 的 `loc=`
是 Cloudflare 那侧的原始读数，可以拿来对照。

写成功之后 Worker 会顺手 `ctx.waitUntil(rebuildSnapshots(env))` 重算一次快照 ——
否则作者自己都要等下一个 cron 才看得到刚写的那条。启动器那边因此是「提交成功后等 1.5 秒再拉一次」。

## 一次性部署

### 0. 前置

- `5318.cm` 已经托管在 Cloudflare（NS 是 `yolanda.ns.cloudflare.com` / `hank.ns.cloudflare.com`）。
- 本机装了 `npx wrangler`（`cd infra && npm install` 即可，`wrangler ^4`）。

### 1. 建库和 KV

```bash
cd infra
npx wrangler login                 # 或者 export CLOUDFLARE_API_TOKEN=...
npx wrangler d1 create evejs-mod-ratings      # 记下 database_id
npx wrangler kv namespace create SNAPSHOTS    # 记下 id
```

把两个 id 填进 `infra/wrangler.toml` 的 `REPLACE_WITH_D1_DATABASE_ID` / `REPLACE_WITH_KV_NAMESPACE_ID`。

> 走 GitHub Actions 自动化的话**不要**把填好的提交上去：CI 会读仓库 variables
> （`D1_DATABASE_ID` / `KV_NAMESPACE_ID`）在 runner 上现场替换占位符。
> 本机手工部署时填一次就行，记得别把 id 一起 commit。

### 2. 建表

```bash
npx wrangler d1 migrations apply evejs-mod-ratings --remote
```

（本地试跑用 `--local`，`npm run migrate:local`。）

### 3. 签名密钥（**必须，缺了不发布快照**）

```bash
node scripts/gen-ratings-key.mjs                    # 生成 .keys/ratings-key.pem（已 gitignore）
node scripts/gen-ratings-key.mjs --from .keys/ratings-key.pem            # 打印要填进 ratings.rs 的两行常量
node scripts/gen-ratings-key.mjs --from .keys/ratings-key.pem --secret-raw   # 只吐那一行 base64（自动化用）
node scripts/gen-ratings-key.mjs --from .keys/ratings-key.pem --secret       # 带标签行，给人看的
```

三件事都要做，缺一不可：

1. 打印出来的两行常量替换进 `src-tauri/src/mods/ratings.rs`（`RATINGS_KEY_ID` / `RATINGS_PUBKEY`）；
   之后可以 `--check` 复核两边是不是一对。
2. `npx wrangler secret put RATINGS_SIGNING_KEY` —— 粘 **`--secret-raw` 那一行**（base64 PKCS8 DER，**不要带换行**）。
   别用 `--secret` 去管道取「第一行」：那行是中文标签，塞进去会让定时任务每次都在 importKey 上炸掉，
   而快照永远不生成 —— 现在 `--secret-raw` 就是为这个加的。
3. `npx wrangler secret put RATINGS_KEY_ID` —— 粘 keyId。

**为什么必须和自更新用两把钥匙**：自更新那把私钥能签出「让启动器替换自己」的清单，泄露就是能推恶意代码。
评价这把私钥要放在 Cloudflare 的 secret 里（签名是定时任务在隔离环境做的），
泄露的后果必须止步于「评分能被伪造」。`gen-ratings-key.mjs` 里刻意不复用 `.keys/update-key.pem`。

### 4. 部署

```bash
npm run deploy      # npx wrangler deploy
```

`wrangler.toml` 里的 `[[routes]] pattern = "ping.5318.cm"` + `custom_domain = true`，
部署时 Cloudflare 自己在同一个账号里建 CNAME 并签发证书，不用手工加 DNS 记录。

### 5. 让快照生成一次

快照由 cron 生成，部署完最多等 10 分钟。想立刻验证：

```bash
npx wrangler dev            # 本地起一个
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"
curl "http://127.0.0.1:8787/v1/health"
```

线上确认：

```bash
curl -s https://ping.5318.cm/v1/health
```

`ok: true` 且 `signing: "ok"` 才算通 —— 健康检查会**真的试签一次**，不是只看 secret 在不在。
`signing: "missing"` 是没配；`signing: "broken"` 是配了但用不了（`signingReason` 有原因）。
另外可以拿内置常量直接验线上快照，一条命令把「钥匙 / keyId 对不对」判掉：

```bash
node scripts/gen-ratings-key.mjs --from .keys/ratings-key.pem --check-live https://ping.5318.cm/v1/ratings.json
```

## 日常自动化（这套东西不需要人守）

| 谁 | 什么时候 | 干什么 |
| --- | --- | --- |
| Cron `*/10 * * * *` | 每 10 分钟 | 从 D1 重算 `ratings.json` + 所有 `reviews/*.json`，签名后写 KV |
| Cron `0 * * * *` | 每小时 | 拉市场索引，同步 `mod_versions` 白名单（决定哪个包的 sha256 允许被评价） |
| `.github/workflows/infra.yml` | push / PR 改到 `infra/**` | PR 上单测 + `wrangler deploy --dry-run`；main 上迁移 + 部署 |
| `infra/scripts/build-snapshot.mjs` | 手动 / 定时 | 把 D1 导出的行重算成快照文件，用来做 GitHub 备门镜像或灾难恢复 |

两条 cron 的时间与 `src/index.js` 的 `scheduled()` 分派是**写死的对应关系**，改一处必须改另一处。

### GitHub 备门镜像（已自动化）

`ping.5318.cm` 挂了的时候启动器还能从 GitHub 读 —— 启动器内置的第二个地址就是
`https://diguo520.github.io/EVEjs-mods/ratings/ratings.json`。两条源的目录结构不同，
启动器是按「最后一个 `/` 之前」拼分片地址的，所以这边摆成：

```
docs/ratings/ratings.json
docs/ratings/reviews/<modId>.json
docs/ratings/sponsors.json
```

这份镜像**不用手工搬运**：索引仓库自己那条流水线在维护 —— `EVEjs-mods/scripts/mirror-ratings.mjs`
配 `.github/workflows/mirror-ratings.yml`，每小时（也能在 Actions 页面手动跑一次）从主门抓
`/v1/ratings.json`、`/v1/sponsors.json` 和每个模组的 `/v1/reviews/<modId>.json`，**先验签再落盘**：
签名对不上、keyId 不是启动器内置那把，或者主门整段不可达，就整体失败并原样保留旧文件
（坏镜像比没有镜像更糟）；线上已经撤回干净的模组，它的旧分片会被删掉。

名单能进镜像是因为同一个脚本顺带抄了 `/v1/sponsors.json` —— 名单本体在 KV（见下一节），
镜像里这份就是线上那份的副本，所以哪怕评价库是空的，备门也不会少文件。

下面这条手工路只在「主门彻底不可用、要离线重算」时才用得上（灾难恢复）：

```bash
# 导出 D1 的评价行
npx wrangler d1 execute evejs-mod-ratings --remote --json \
  --command "SELECT r.*, p.body AS reply_body, p.updated_at AS reply_at, p.edited AS reply_edited \
             FROM reviews r LEFT JOIN replies p ON p.review_id = r.id" > rows.json

# 用同一份纯函数重算（产物形状与 Worker 定时任务完全一致）
node infra/scripts/build-snapshot.mjs --rows rows.json --out .parity-out/ratings \
  --key .keys/ratings-key.pem --key-id <keyId> [--sponsors sponsors.json]
```

产物按上面的结构 commit 进索引仓库的 `docs/ratings/` 即可。
### 维护补给线名单（不用改代码、不用部署）

名单本体存在 KV 的 `source:sponsors`，没写过就用代码里那份种子。加人 / 改金额 / 删人都在
一个页面上做：**`https://ping.5318.cm/admin.html`**（本地跑起来就是
`http://127.0.0.1:8787/admin.html`）。保存后**立刻**重签快照，启动器按自己那 10 分钟缓存跟进。

先配一次令牌 —— **没配这个 secret 时管理接口是关的**（fail closed），配了才开：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put SPONSOR_ADMIN_TOKEN    # 粘上一步打印的那串
```

然后打开页面，把令牌填进「管理令牌」→ 连接（只存在这台浏览器的 localStorage 里，
不进 URL、不进日志）。换电脑就在新电脑上再填一次。

接口一共三个，全部 `Authorization: Bearer <令牌>`，**不发 CORS 头**（所以别的站点读不到回包）：

```
GET  /v1/admin/sponsors           当前名单（归一化后的视图，看到的就是启动器最终显示的）
POST /v1/admin/sponsors           { name, amount, currency? }   加或改：同名只改金额，位置不动
POST /v1/admin/sponsors/remove    { name } 或 { id }
POST /v1/admin/sponsors/reset     {}                            清掉 KV 那份，回到代码里的种子
```

curl 也行：

```bash
curl -H "Authorization: Bearer $TOKEN" https://ping.5318.cm/v1/admin/sponsors
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Cmdr. Nova","amount":50,"currency":"USD"}' https://ping.5318.cm/v1/admin/sponsors
```

几条规矩：
- `amount` 是不小于 0 的数字；`currency` 要么三位字母（`CNY` / `USD` / `EUR`…）要么不写（默认人民币）。
  写错了当场 400 并告诉你原因，**不会**悄悄改成人民币 —— 快照那层才做兜底，防的是历史数据。
- 同名再存一次是「改金额」，不会变成两条，也不会跳到列表末尾。
- 改坏了不用慌：页面上的「重置回代码名单」清掉 KV 那份，立刻回到 `src/sponsors.js`。
- 想限制一下也容易：一个 IP 一小时最多 60 次（`index.js` 的 `MAX_ADMIN_PER_HOUR`）。
- **别把令牌贴到聊天记录、issue 或截图里**。怀疑泄露就 `wrangler secret put` 换一个，
  页面上的旧令牌自然失效。

### CI 需要配置的东西

| 类型 | 名字 | 说明 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 权限只要 Workers Scripts:Edit + D1:Edit + Workers KV Storage:Edit |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 账号 id |
| Variable | `D1_DATABASE_ID` | 步骤 1 拿到的 |
| Variable | `KV_NAMESPACE_ID` | 步骤 1 拿到的 |

> ⚠️ `CLOUDFLARE_API_TOKEN` 是**自己建的受限 API Token**，不是账号资料页那把 Global API Key
> （那把能改整个账号的一切，泄露等于账号被端走，别往 CI 里放）。
>
> 建法：Cloudflare 面板 → 右上头像 → My Profile → API Tokens → Create Token → Create Custom Token，
> 权限给 `Account / Workers Scripts / Edit`、`Account / D1 / Edit`、`Account / Workers KV Storage / Edit`，
> 资源范围选自己的账号（想更严可以再收窄到具体的 Worker / D1 / KV）。建完只显示一次，当场复制。
>
> `CLOUDFLARE_ACCOUNT_ID` 只是**账号 id**（32 位十六进制），面板 Workers & Pages 页右侧栏能看到，
> 或者 `npx wrangler whoami`。它不是密钥，放 Variable 也完全没问题。
>
> 别和另外两个搞混：`RATINGS_SIGNING_KEY` / `RATINGS_KEY_ID` 是 **Worker 的 secret**，
> 值是第 3 步本地生成的那把 Ed25519 私钥（`wrangler secret put` 写进 Worker 环境），跟 Cloudflare 账号凭据无关。

没配 secret 的时候 workflow 会**跳过部署并打印一行提示**，不会把红灯算到你头上。

## 故障排查

| 现象 | 看哪里 |
| --- | --- |
| 启动器卡片上没有星级 | `/v1/health` 的 `ok`；再确认 `ratings.rs` 里的公钥与 keyId 和线上是一对 |
| `健康检查 ok:false`、`signing: missing` | 步骤 3 的两个 secret 没设全 |
| `健康检查 ok:false`、`signing: broken` | secret 设了但用不了（多半是值不对，见 `signingReason`）；用 `--check-live` 进一步定位 |
| `signing: ok` 但 `ratings.json` 一直 503 | 不是配置问题，是定时任务还没跑过（见上一条手动触发） |
| `reason` 说快照还没生成 | 一行评价都没有，或者 cron 还没跑过；用上面的 `scheduled` 手动触发一次 |
| 有评价但启动器读不到 | 启动器是「多镜像 + 5 分钟缓存」；settings 里 `modRatingUrls` 可以临时指到本地调试源 |
| 分片 404 | 该模组一条可见评价都没有（`hidden` 的不算），不是错误 |
| 写评价报「安装包对不上市场记录」 | 报上来的 `pkg_sha256` 不在白名单里：本地装的那一版和索引里的不是同一个包，或者白名单还没同步（每小时整点跑一次 `sync-versions`） |
| 写评价报「keyId 与公钥对不上」 | 客户端把 keyId 和公钥配错了 —— keyId 必须是那把公钥的 sha256 前 12 位（`keyIdFromRaw`） |
| 所有请求都 500「ctx is not defined」 | Worker 入口 `fetch(request, env, ctx)` 少了第三个参数。`infra/test/worker.test.mjs` 钉着这一条 |
| 管理页报「管理接口未启用」 | 没配 `SPONSOR_ADMIN_TOKEN`（或短于 16 个字符）。这不是故障，是接口默认关着 |
| 管理页报「管理令牌不对」 | 令牌粘错了（前后空格也算）。换一个浏览器再填一次，或者重新 `secret put` |
| 改了名单但启动器还没变 | 启动器缓存 10 分钟；先看 `/v1/health` 的 `counts.sponsors` 与 `sponsorsSource` 对不对 |

回滚：`npx wrangler deployments list` 找上一个版本 `npx wrangler rollback`。
想彻底停掉发布（让所有人读不到评分）就删掉 `RATINGS_SIGNING_KEY` secret —— 定时任务会 fail closed，
不再写快照，启动器那边退化成「没有评分」，不会崩。

## 代码地图

```
infra/src/canonical.js      canonical JSON + Ed25519（纯 WebCrypto，零依赖，Worker 与 Node 共用）
infra/src/snapshot.js       纯函数：聚合 / 分片 / 文件名白名单 / 补给线名单
infra/src/sponsors.js       补给线名单的**种子**（线上的那份在 KV 里，见 admin.js）
infra/src/admin.js          补给线名单的管理接口：令牌 + 校验 + KV 名单本体 + 归一化视图
infra/src/write.js          纯函数：写接口的校验 + 待签名负载（服务端不改写客户端的值）
infra/src/index.js          Worker 入口：读接口 + 五个写接口 + 名单管理 + 静态资源兜底 + scheduled()
infra/public/admin.html     维护者改名单的页面（令牌鉴权，同源 fetch）
infra/schema.sql            建表（人读用）
infra/migrations/0001_init.sql   D1 迁移（真正执行的）
infra/scripts/build-snapshot.mjs 离线重算
infra/scripts/render-config.mjs  CI 专用：占位符 → 真实 id
infra/test/                 单测（node --test；worker.test.mjs 会发真请求，钉住入口 ctx 那类低级错误）
```

启动器侧配套：`src-tauri/src/mods/ratings.rs`（读 + 验签 + 缓存）、
`src-tauri/src/mods/review.rs`（写 + 签名 + 多写地址回落）、
`src-tauri/src/mods/registry.rs`（把评分并进市场列表）、
IPC `mods:reviews` 与 `mods:reviewSubmit` / `reviewRetract` / `replySubmit` / `replyRetract` / `reportReview`。

## 分期

- **M1（已完成）**：只读。聚合分 + 评论正文 + 验签 + 缓存 + 界面渲染。
- **M2（已完成）**：写路径。五个 POST 接口 + 验签 + 限流 + 落库 + 写完触发快照重算；
  界面上的打分 / 写评论 / 改 / 删 / 作者回复 / 撤回全部接真通道。评价署名改成
  「来自 <地区> 的玩家」+ SVG 旗子（不做账号系统，也就不存在重名）。
- **M3**：举报处置（现在只入库，规则没定之前不自动处置）。
- **M4**：运维收口（告警、备份演练、备门镜像自动化）。

「只有装过这个模组的人才能评价」的凭据是 `pkg_sha256` 命中 `mod_versions` 白名单。
白名单每小时从市场索引同步；`syncModVersions` **故意不验索引签名** —— 这一步只决定
「哪个 sha256 允许评价」，被中间人塞假 sha256 最多让人给自己没装的包打分，
而包能不能装由启动器验索引签名 + 验包签名管着，赌注不对等，没必要在这儿再引一把公钥。