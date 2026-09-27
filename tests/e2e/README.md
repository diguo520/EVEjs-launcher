# tests/e2e —— L3 端到端的沙箱（快照 → 跑 → 还原）

L2（`tests/parity`）证明的是「同一个逻辑在两种外壳下回包一致」，用的通道全是**只读**的。
L3 要往下走一层：**真调写通道**（建模组、启停、排序、卸载…），这就有副作用了。
本目录解决的就是「怎么在不碰用户真实数据的前提下，把写通道端到端跑一遍，并且能证明跑完收得干净」。

## 1. 目录

| 文件 | 作用 |
| --- | --- |
| `sandbox.mjs` | 沙箱本体：建替身仓库 + 替身 userdata、快照（路径 → 大小 + sha256）、还原、清单 diff |
| `run.mjs` | 编排：前置卫生检查 → 预热 → 快照 → 跑场景 → 断言 → 还原 → 复跑比对 → 收尾卫生检查 |
| `scenarios/repo-mods.json` | 场景一：模组全链（建 → 列出 → 启用 → 排序 → 注入计划 → 卸载 → 列出） |
| `scenarios/config-settings.json` | 场景二：`config:*` + `settings:*`（改客户端路径与安全窗口 → 读回 → repoRoot 指回沙箱 → 写一条设置 → 读回；含「非法 repoRoot 被拒」） |
| `scenarios/author-token.json` | 场景三：作者身份 + GitHub 令牌（`author:get` / `author:setName` → `mods:githubTokenStatus` / `Save`）；断言令牌**不是明文落盘**；不出网 |

产物（都在已 gitignore 的 `.parity-out/` 下）：`e2e.json`（机器可读）、`e2e.md`（表）、
`e2e-out/run*.json`（每轮的原样回包）、`e2e-sandbox/`（现场）、`e2e-sandbox.snapshot/`（基线副本）。

## 2. 怎么跑

```powershell
pwsh -File scripts/build.ps1      # 先有产物（或 --debug 用 debug 产物）
npm run e2e                        # 默认场景 repo-mods，跑 2 轮
node tests/e2e/run.mjs --debug --repeats 1
node tests/e2e/run.mjs --scenario repo-mods --keep   # 跑完不还原，留给人工看现场
node tests/e2e/run.mjs --scenario author-token         # 作者身份 + 令牌落盘
node tests/e2e/run.mjs --scenario config-settings      # config:* + settings:*
```

## 3. 沙箱口径

启动器眼里的两个「外部世界」都被换成替身，且都能逐字节回滚：

| 真实位置 | 沙箱替身 | 怎么换的 |
| --- | --- | --- |
| 服务端仓库根 | `.parity-out/e2e-sandbox/repo` | cwd 里的 `launcher.config.json` 指过去（复用 L2 的 `make-repo-fixture.mjs`） |
| `_launcher` 运行时目录 | `.parity-out/e2e-sandbox/userdata` | `EVEJS_USER_DATA_DIR` |

三道保障，缺一条 L3 就只是「跑过了」而不是「可回滚」：

1. **快照**：先记下整棵沙箱的「相对路径 → 大小 + sha256」清单，并留一份副本；
2. **跑**：场景按顺序真打通道，注入脚本只负责带回原样回包，判定交给编排脚本；
3. **还原 + 复跑**：整棵删掉再从副本敷回去，digest 必须与基线一致；**默认跑 2 轮**，
   第 2 轮完全建立在还原后的树上，两轮的文件改动指纹必须一致 —— 这条同时证明了「还原是逐字节的」
   和「沙箱能反复用」。

### 密闭性（为什么沙箱要预置市场索引缓存）

渲染层在**每次启动**都会 `void loadMarket(false, true)`（`ui/web/launcher-bridge.js` 末尾：为了页签上的
「N 可更新」徽章），也就是后台静默出网拉一次真实索引（两条镜像，总预算 12s）。本机实测：**连不带任何
场景的只读自检**都会因此生成 `userdata/cache/mod-index.json` —— 索引抢在进程被杀之前拉到/没拉到，会让
沙箱里多/少一个文件，两轮指纹永远对不上。

所以 `buildSandbox()` 会预置一份 `fetchedAt = 现在` 的空索引缓存：命中 30 分钟 TTL，走 `source=cache`
分支，全程不出网。编排脚本还会断言这份缓存**没有被重写**（重写 = 本轮出网了 = 失败）。

## 4. 一轮里都断言了什么

- 产物存在、场景合法（每个通道都在 `contract/ipc-channels.json` 里、步骤 id 不重复）；
- 跑之前：没有残留启动器进程、四个服务端口（26000/26001/26002/40110）空闲；
- 每一步都有回包（不是 undefined、不是 error），并按场景里的 `expect` 校验回包字段；
- 落地文件符合 `fsAfter` 预期（例如启用之后 `loader.js` 在、`loader.js.disabled` 不在）；
  `fsAfter` 支持 `exists` / `contains` / `notContains` —— `notContains` 专用来证明「机密没有明文落盘」（令牌文件里不该出现明文）；
- 沙箱**确实被改过**（写通道真落盘了 —— 否则「还原」这条断言毫无意义）；
- 本轮没有出网刷新市场索引；
- 还原后 digest 与基线逐字节一致；多轮之间的改动指纹一致；
- 跑完：没有残留启动器进程、端口全部释放。

## 5. 已知限制

- 只在 Windows 上有意义：收尾检查用 `tasklist` / `Get-NetTCPConnection`（都走系统自带的绝对路径，
  不依赖 PATH 上的 pwsh）。
- `mods:uninstall` 走**系统回收站**（对齐现役版的「用户能自己还原」）。沙箱能还原仓库，但回收站里那份
  副本不会自动清 —— 跑多次会在回收站里留同名残留，属已知副作用。
- 多轮指纹比对里：`repo/` 内的文件比**内容哈希**（要求逐字节确定），`userdata/` 只比路径集合
  （窗口几何、身份密钥这类运行时状态不构成场景确定性）。
- `--keep` 会跳过每一轮的还原，因此后续轮次与指纹比对都不再成立，只用于人工查现场。

## 6. 这道沙箱已经抓到的东西

| # | 发现 | 性质 |
| --- | --- | --- |
| 1 | 启动器**每次启动都静默出网**拉市场索引（`launcher-bridge.js` 末尾），离线时走满 12s 预算 | 继承自现役版的行为，不是移植缺陷；但它是 E2E 不确定性的根源，沙箱已预置缓存规避 |
| 2 | `launcher.config.json` 内容非法（例如尾部多一个字符）时，`env::read_launcher_config_repo_root` **静默返回 None**，仓库根一路回退到 **exe 所在目录** —— 启动器不会报错，而是换一个目录去建 `mods/` | 失败模式问题（写坏配置 → 静默换仓库根）。本轮先记录，是否对齐现役版待 L3 后续场景确认 |
| 3 | 首轮就抓到的一个「看起来像缺陷、其实是 harness 自己错」的例子：配置文件末尾带字面 `\n` 会让 JSON 解析失败，于是整轮写操作都落到 exe 目录 | 已修（`tests/e2e/*.mjs` 的转义），保留在此提醒：**沙箱一旦没生效，写通道是会真写盘的** |
| 4 | 加了 `author-token` 场景后暴露：预热跑的是**空场景**，靠渲染层加载时顺手建作者身份 —— 换成 React 渲染层后身份只在进入「作者身份」页时才建，空场景不建，于是每轮都现建一把**新随机密钥**，`mod-keys/<keyId>.key` 文件名跟着变，多轮指纹永远对不上 | 已修：预热改为显式打一次 `author:get`，把身份固化进基线（这也正是预热注释里原本的意图） |
