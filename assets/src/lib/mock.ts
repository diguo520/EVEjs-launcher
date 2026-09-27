/* ============================================================
   EveJS 启动器原型 —— 模拟数据层
   全部为演示用静态数据，不连接任何真实服务。
   ============================================================ */

/* ---------------- 服务 ---------------- */

export type ServiceState = "running" | "ready" | "stopped" | "error"

export interface Service {
  id: string
  name: string
  en: string
  desc: string
  port: number
  state: ServiceState
  pid: number | null
  uptime: string
  cpu: number
  memMB: number
  logs: number
}

export const SERVICES: Service[] = [
  {
    id: "node",
    name: "主服务器",
    en: "NODE",
    desc: "世界模拟 / 星图 / 战斗结算",
    port: 26000,
    state: "running",
    pid: 14872,
    uptime: "02:14:38",
    cpu: 12.4,
    memMB: 1842,
    logs: 4821,
  },
  {
    id: "market",
    name: "市场服务",
    en: "MARKET",
    desc: "订单撮合 / 价格索引",
    port: 26001,
    state: "running",
    pid: 14903,
    uptime: "02:14:31",
    cpu: 3.1,
    memMB: 412,
    logs: 1204,
  },
  {
    id: "images",
    name: "图片服务",
    en: "IMAGES",
    desc: "舰船 / 头像 / 物品图标",
    port: 3001,
    state: "ready",
    pid: 14930,
    uptime: "02:14:29",
    cpu: 0.8,
    memMB: 186,
    logs: 318,
  },
  {
    id: "gateway",
    name: "网关代理",
    en: "GATEWAY",
    desc: "TLS 终结 / 客户端接入",
    port: 8080,
    state: "ready",
    pid: 14944,
    uptime: "02:14:26",
    cpu: 1.6,
    memMB: 94,
    logs: 642,
  },
]

export const SERVICE_STATE_LABEL: Record<ServiceState, string> = {
  running: "RUNNING",
  ready: "READY",
  stopped: "STOPPED",
  error: "FAULT",
}

/* ---------------- 日志 ---------------- */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

export interface LogLine {
  id: number
  t: string
  level: LogLevel
  src: string
  msg: string
}

export const LOG_SOURCES = [
  { id: "sys", label: "系统" },
  { id: "node", label: "主服务器" },
  { id: "market", label: "市场服务" },
  { id: "client", label: "客户端" },
] as const

export const LOGS: LogLine[] = [
  { id: 1, t: "14:02:11", level: "INFO", src: "sys", msg: "启动序列完成 · 4 个核心服务已就绪" },
  { id: 2, t: "14:02:09", level: "INFO", src: "gateway", msg: "TLS 握手完成 · 证书 CN=localhost 有效期 365 天" },
  { id: 3, t: "14:02:07", level: "INFO", src: "images", msg: "图片缓存目录就绪 · 命中率 94.2%" },
  { id: 4, t: "14:02:04", level: "INFO", src: "market", msg: "载入 18,442 条历史订单 · 索引重建耗时 412ms" },
  { id: 5, t: "14:02:01", level: "INFO", src: "node", msg: "星图载入完成 · 7,804 个星系 / 2,614 条星门" },
  { id: 6, t: "14:01:58", level: "WARN", src: "node", msg: "静态数据版本落后 1 个小版本 (v0.12.8.1 → v0.12.9.0)" },
  { id: 7, t: "14:01:55", level: "INFO", src: "node", msg: "世界存档挂载 · gameStore.sqlite (128.4 MB)" },
  { id: 8, t: "14:01:52", level: "DEBUG", src: "sys", msg: "检测到 16 逻辑线程 · 堆上限 4096 MB" },
  { id: 9, t: "14:01:49", level: "WARN", src: "sys", msg: "环境自检 5/6 通过 · 客户端证书 CA 未检测到" },
  { id: 10, t: "13:58:20", level: "ERROR", src: "client", msg: "客户端连接超时 (10s) · 已自动重试 1/3" },
  { id: 11, t: "13:58:22", level: "INFO", src: "client", msg: "重试成功 · 会话令牌已刷新" },
  { id: 12, t: "13:47:03", level: "WARN", src: "market", msg: "订单簿深度不足 · Jita IV-4 买单仅 12 档" },
  { id: 13, t: "13:40:16", level: "INFO", src: "node", msg: "「Kaede Tanaka」进入 New Caldari (0.9)" },
  { id: 14, t: "13:38:44", level: "INFO", src: "node", msg: "异常空间生成 · Blood Raiders Hideaway × 3" },
  { id: 15, t: "13:31:02", level: "ERROR", src: "node", msg: "NPC 路径寻路失败 (星系 30000142) · 已回退直线航向" },
  { id: 16, t: "13:29:51", level: "INFO", src: "node", msg: "击杀记录写入 · 累计 28,471 条" },
  { id: 17, t: "13:22:10", level: "DEBUG", src: "sys", msg: "垃圾回收 · 释放 218 MB (耗时 14ms)" },
  { id: 18, t: "13:15:38", level: "INFO", src: "market", msg: "价格索引已同步 · 涉及 1,204 种物品" },
  { id: 19, t: "13:02:07", level: "WARN", src: "sys", msg: "磁盘剩余 421 GB · 低于建议阈值 500 GB" },
  { id: 20, t: "12:55:44", level: "INFO", src: "node", msg: "自动备份完成 · 归档 2026-09-26_1255.sqlite" },
]

/* ---------------- 数据库 ---------------- */

export interface DbColumn {
  name: string
  type: string
  pk: boolean
  notNull: boolean
  def: string
}

export interface DbTable {
  name: string
  rows: number
  columns: DbColumn[]
  data: Record<string, string | number | null>[]
}

export const DB_TABLES: DbTable[] = [
  {
    name: "accounts",
    rows: 3,
    columns: [
      { name: "id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "username", type: "TEXT", pk: false, notNull: true, def: "—" },
      { name: "role", type: "TEXT", pk: false, notNull: true, def: "'PLAYER'" },
      { name: "banned", type: "INTEGER", pk: false, notNull: true, def: "0" },
      { name: "created_at", type: "TEXT", pk: false, notNull: true, def: "CURRENT_TIMESTAMP" },
      { name: "last_login", type: "TEXT", pk: false, notNull: false, def: "NULL" },
    ],
    data: [
      { id: 1001, username: "capsuleer", role: "ADMIN", banned: 0, created_at: "2026-03-04 09:12:44", last_login: "2026-09-26 13:40:02" },
      { id: 1002, username: "industrialist", role: "GM", banned: 0, created_at: "2026-05-19 21:03:17", last_login: "2026-09-25 22:07:51" },
      { id: 1003, username: "tester", role: "PLAYER", banned: 0, created_at: "2026-09-26 11:58:20", last_login: null },
    ],
  },
  {
    name: "characters",
    rows: 6,
    columns: [
      { name: "id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "account_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "name", type: "TEXT", pk: false, notNull: true, def: "—" },
      { name: "ship_type_id", type: "INTEGER", pk: false, notNull: false, def: "587" },
      { name: "skill_points", type: "INTEGER", pk: false, notNull: true, def: "0" },
      { name: "solar_system_id", type: "INTEGER", pk: false, notNull: true, def: "30000142" },
    ],
    data: [
      { id: 1, account_id: 1001, name: "Kaede Tanaka", ship_type_id: 17738, skill_points: 12847331, solar_system_id: 30000145 },
      { id: 2, account_id: 1001, name: "Rei Ayanami", ship_type_id: 29990, skill_points: 8412006, solar_system_id: 30000142 },
      { id: 3, account_id: 1001, name: "Sora Hoshino", ship_type_id: 17478, skill_points: 3198470, solar_system_id: 30000144 },
      { id: 4, account_id: 1002, name: "Mika Sorrel", ship_type_id: 12005, skill_points: 9633102, solar_system_id: 30002659 },
      { id: 5, account_id: 1002, name: "Nell Ferrow", ship_type_id: 16240, skill_points: 2210884, solar_system_id: 30002510 },
      { id: 6, account_id: 1003, name: "Probe Unit 07", ship_type_id: 587, skill_points: 42300, solar_system_id: 30002053 },
    ],
  },
  {
    name: "market_orders",
    rows: 18442,
    columns: [
      { name: "order_id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "type_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "is_buy", type: "INTEGER", pk: false, notNull: true, def: "0" },
      { name: "price", type: "REAL", pk: false, notNull: true, def: "—" },
      { name: "volume_remain", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "station_id", type: "INTEGER", pk: false, notNull: true, def: "60003760" },
    ],
    data: [
      { order_id: 881201, type_id: 34, is_buy: 1, price: 5.18, volume_remain: 12400000, station_id: 60003760 },
      { order_id: 881202, type_id: 34, is_buy: 0, price: 5.34, volume_remain: 8420000, station_id: 60003760 },
      { order_id: 881203, type_id: 35, is_buy: 1, price: 8.42, volume_remain: 4210000, station_id: 60003760 },
      { order_id: 881204, type_id: 35, is_buy: 0, price: 8.71, volume_remain: 2180000, station_id: 60003760 },
      { order_id: 881205, type_id: 36, is_buy: 1, price: 41.9, volume_remain: 884000, station_id: 60003760 },
      { order_id: 881206, type_id: 37, is_buy: 1, price: 96.4, volume_remain: 402000, station_id: 60003760 },
      { order_id: 881207, type_id: 38, is_buy: 1, price: 682.0, volume_remain: 61800, station_id: 60003760 },
      { order_id: 881208, type_id: 39, is_buy: 0, price: 1842.5, volume_remain: 12400, station_id: 60003760 },
      { order_id: 881209, type_id: 40, is_buy: 0, price: 3120.0, volume_remain: 4820, station_id: 60003760 },
      { order_id: 881210, type_id: 11399, is_buy: 0, price: 14820.0, volume_remain: 620, station_id: 60003760 },
    ],
  },
  {
    name: "killmails",
    rows: 28471,
    columns: [
      { name: "kill_id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "victim_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "ship_type_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "solar_system_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "isk_value", type: "REAL", pk: false, notNull: false, def: "0" },
      { name: "killed_at", type: "TEXT", pk: false, notNull: true, def: "CURRENT_TIMESTAMP" },
    ],
    data: [
      { kill_id: 204118, victim_id: 24194, ship_type_id: 587, solar_system_id: 30000142, isk_value: 428000, killed_at: "2026-09-26 13:29:51" },
      { kill_id: 204117, victim_id: 24206, ship_type_id: 638, solar_system_id: 30000142, isk_value: 184200000, killed_at: "2026-09-26 13:21:04" },
      { kill_id: 204116, victim_id: 24198, ship_type_id: 587, solar_system_id: 30000145, isk_value: 512000, killed_at: "2026-09-26 12:58:33" },
      { kill_id: 204115, victim_id: 24401, ship_type_id: 641, solar_system_id: 30002053, isk_value: 962400000, killed_at: "2026-09-26 12:41:19" },
      { kill_id: 204114, victim_id: 24212, ship_type_id: 16242, solar_system_id: 30000144, isk_value: 24180000, killed_at: "2026-09-26 12:12:47" },
      { kill_id: 204113, victim_id: 24199, ship_type_id: 603, solar_system_id: 30002510, isk_value: 386000, killed_at: "2026-09-26 11:47:02" },
    ],
  },
  {
    name: "standings",
    rows: 1284,
    columns: [
      { name: "character_id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "faction_id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "standing", type: "REAL", pk: false, notNull: true, def: "0" },
    ],
    data: [
      { character_id: 1, faction_id: 500001, standing: 8.5 },
      { character_id: 1, faction_id: 500002, standing: -3.2 },
      { character_id: 2, faction_id: 500001, standing: 4.1 },
      { character_id: 4, faction_id: 500004, standing: 6.8 },
    ],
  },
  {
    name: "assets",
    rows: 8412,
    columns: [
      { name: "item_id", type: "INTEGER", pk: true, notNull: true, def: "—" },
      { name: "character_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "type_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
      { name: "quantity", type: "INTEGER", pk: false, notNull: true, def: "1" },
      { name: "location_id", type: "INTEGER", pk: false, notNull: true, def: "—" },
    ],
    data: [
      { item_id: 55101, character_id: 1, type_id: 34, quantity: 4200000, location_id: 60003760 },
      { item_id: 55102, character_id: 1, type_id: 17738, quantity: 1, location_id: 60003760 },
      { item_id: 55103, character_id: 2, type_id: 29990, quantity: 1, location_id: 60003760 },
      { item_id: 55104, character_id: 3, type_id: 17478, quantity: 2, location_id: 60003760 },
    ],
  },
]

export const DB_META = {
  file: "gameStore.sqlite",
  sizeMB: 128.4,
  tableCount: 34,
  rowTotal: 84612,
  journal: "WAL",
  path: "/opt/evejs/data/gameStore.sqlite",
}

/* ---------------- 模组 ---------------- */

/** 市场审核状态（仅本地作者创建的模组有意义） */
export type ModReviewState = "draft" | "reviewing" | "approved" | "rejected"

export const MOD_REVIEW_LABEL: Record<ModReviewState, string> = {
  draft: "草稿",
  reviewing: "审核中",
  approved: "已上架",
  rejected: "已驳回",
}

/** 人工审核的官方时长口径（分钟） */
export const REVIEW_WINDOW_MINUTES = 30

/** 模组可申请的权限：id 与平台清单一致，label 给不熟清单的人看 */
export interface ModPermSpec {
  id: string
  label: string
  /** 会主动对外连接，详情与表单都要单独提示 */
  network?: boolean
}

/** 权限白名单：模组清单里声明的 id 以这份为准 */
export const MOD_PERMS: ModPermSpec[] = [
  { id: "map.read", label: "读取星图与坐标" },
  { id: "sov.read", label: "读取主权与建筑状态" },
  { id: "fleet.read", label: "读取舰队成员与编队" },
  { id: "fleet.broadcast", label: "向舰队频道广播" },
  { id: "market.read", label: "读取市场行情与订单" },
  { id: "market.hook", label: "挂接市场成交钩子" },
  { id: "industry.blueprint", label: "读取工业蓝图与材料" },
  { id: "cargo.read", label: "读取货舱与库存" },
  { id: "loot.table", label: "读取掉落表" },
  { id: "killmail.read", label: "读取击杀邮件" },
  { id: "npc.behavior", label: "改写 NPC 行为逻辑" },
  { id: "combat.targeting", label: "改写战斗目标选择" },
  { id: "graphics.material", label: "替换材质与贴图" },
  { id: "ui.overlay", label: "在界面上叠加面板" },
  { id: "notify.push", label: "发送本地通知" },
  { id: "net.outbound", label: "主动发起对外连接", network: true },
]

/** 需要联网的权限 id */
export const NETWORK_PERMS: string[] = MOD_PERMS.filter(
  (perm) => perm.network
).map((perm) => perm.id)

/** 权限 id 对应的中文说明，白名单外的原样返回 */
export function permLabel(id: string): string {
  return MOD_PERMS.find((perm) => perm.id === id)?.label ?? id
}

/** 模组可声明的兼容服务端版本，新的在前 */
export const GAME_VERSIONS: string[] = [
  "0.12.8+",
  "0.12.6+",
  "0.12.4+",
  "0.12.2+",
]

/** 本地作者身份 */
export const MOD_AUTHOR = {
  id: "kaede-0421",
  name: "Kaede",
  corp: "月海工业",
  fingerprint: "A3F1 9C24 7B0E D852 41AF 6E30 92C7 B15D",
  /** 身份创建时间精确到秒：作者身份页那一栏要显示到秒 */
  joinedAt: "2026-04-18 21:07:33",
}

export interface ModChangelog {
  version: string
  date: string
  items: string[]
}

/** 市场评论：一条来自已安装玩家的评分与评论 */
export interface ModReview {
  id: string
  author: string
  /** 评论者所属军团 */
  corp: string
  /** 1-5 星 */
  stars: number
  date: string
  /** 写下这条评论时使用的模组版本 */
  version: string
  body: string
  /** 本地玩家自己写的评论 */
  mine?: boolean
  /** 本人改过星级或内容，列表里标一句「已编辑」 */
  edited?: boolean
  /** 作者回复，只有被作者回复过的评论才有 */
  reply?: { date: string; body: string; edited?: boolean }
}

export interface ModEntry {
  id: string
  name: string
  version: string
  author: string
  cat: string
  desc: string
  tags: string[]
  installed: boolean
  enabled: boolean
  needsRestart: boolean
  /** 市场评论，最新的在前；未上架模组为空 */
  reviews: ModReview[]
  downloads: number
  /** 综合评分（1-5）：由全部打分的玩家算出，不只是写了评论的那部分 */
  ratingAvg: number
  /** 评分人数，含只打分不写评论的玩家 */
  ratingCount: number
  /** 安装包体积（MB） */
  sizeMB: number
  /** 最近一次上架或更新时间 */
  updatedAt: string
  /** 声明的兼容服务端版本 */
  gameVersion: string
  /** 申请的运行时权限 */
  perms: string[]
  /**
   * 详情页正文段落。功能要点那段按约定写：先一行「功能要点」，再每条一行、以「· 」开头，
   * 详情页据此把它拆成一列能扫的要点，其余段落当正文；格式与表单写入时是同一套。
   */
  readme: string[]
  /** 版本历史，最新的在前 */
  changelog: ModChangelog[]
  /** 市场最新版本，与 version 不同即表示可更新 */
  latest?: string
  /** 与之存在加载冲突的模组 id（互为对方的 id） */
  conflicts?: string[]
  /** 冲突原因，按对方 id 索引 */
  conflictReason?: Record<string, string>
  /** 本地作者创建的模组 */
  mine?: boolean
  /** 审核状态，仅 mine 模组有 */
  review?: ModReviewState
  /** 提交审核的时间 */
  submittedAt?: string
  /** 被驳回的原因 */
  reviewNote?: string
}

export const MODS: ModEntry[] = [
  {
    id: "mod-market-insight",
    name: "市场洞察",
    version: "2.0.1",
    latest: "2.1.0",
    author: "Ferrow Works",
    cat: "经济",
    desc: "为每个物品生成 30 天价格走势与成交量分布，识别被扫货的挂单并提示套利空间。",
    tags: ["市场", "行情", "分析"],
    installed: true,
    enabled: true,
    needsRestart: true,
    reviews: [
      { id: "mod-market-insight-r1", author: "Vex Amarr", corp: "月海工业", stars: 5, date: "2026-09-25", version: "2.0.1", body: "Jita 的价差终于能一眼看出来了，扫货侦测上周提醒我两次，避开了两笔亏本单。" },
      { id: "mod-market-insight-r2", author: "Sable Oram", corp: "深空贸易", stars: 5, date: "2026-09-22", version: "2.0.1", body: "走势图导出 CSV 之后直接进军团表格，省了每天手动记账的半小时。" },
      { id: "mod-market-insight-r3", author: "Kestrel Vane", corp: "自由佣兵", stars: 4, date: "2026-09-14", version: "2.0.1", body: "很好用，就是 30 天均价在低成交量物品上波动偏大，希望能加个成交量过滤。" , reply: { date: "2026-09-15", body: "成交量过滤开关已经做进 2.1.0，可以按 24 小时成交量隐藏噪声大的物品。" } },
      { id: "mod-market-insight-r4", author: "Ilya Prine", corp: "凛冬联合", stars: 5, date: "2026-09-06", version: "2.0.0", body: "改成增量快照之后挂一整天也不卡了，2.0.0 之前久了会掉帧。" },
      { id: "mod-market-insight-r5", author: "Bram Hallow", corp: "北境矿联", stars: 4, date: "2026-08-31", version: "2.0.1", body: "和战利品账本同时启用会丢掉落记录，作者在说明里标了，注意别一起开。" , reply: { date: "2026-09-01", body: "钩子冲突已同步给平台侧，短期方案是先停用其中一个，两边都在推进合并。" } },
    ],
    downloads: 9310,
  ratingAvg: 4.600,
  ratingCount: 177,
    sizeMB: 18.4,
    updatedAt: "2026-09-24",
    gameVersion: "0.12.8+",
    perms: ["market.read", "market.hook", "loot.table"],
    conflicts: ["mod-loot-log"],
    conflictReason: {
      "mod-loot-log": "两者都接管掉落事件表 loot.table，同时启用会导致掉落记录丢失。",
    },
readme: [
      "为市场里每个物品计算 30 天移动均价、成交量分布与买卖价差，并在物品详情页右侧插入一张走势卡片。",
      "功能要点",
      "· 30 天移动均价、成交量分布与买卖价差",
      "· 扫货侦测：挂单撤销率超阈值时在挂单簿顶部标红",
      "· 走势图支持导出 CSV",
      "· 行情全部取自本机服务端，不上传角色名与资产信息",
    ],
    changelog: [
      { version: "2.1.0", date: "2026-09-24", items: ["新增扫货侦测", "走势图支持导出 CSV"] },
      { version: "2.0.1", date: "2026-08-30", items: ["修复 Jita 与 Amarr 价差计算偏差"] },
      { version: "2.0.0", date: "2026-07-11", items: ["重写行情采集，改为增量快照"] },
    ],
  },
  {
    id: "mod-npc-brain",
    name: "NPC 战术大脑",
    version: "0.9.7",
    latest: "0.10.0",
    author: "Rogue Dev",
    cat: "AI",
    desc: "让 NPC 舰队按吨位编组、集火高威胁目标并在护盾告急时撤离，替代默认的直线航向。",
    tags: ["NPC", "战斗", "AI"],
    installed: true,
    enabled: false,
    needsRestart: true,
    reviews: [
      { id: "mod-npc-brain-r1", author: "Rook Salvo", corp: "夜枭舰队", stars: 5, date: "2026-09-23", version: "0.9.7", body: "NPC 终于会撤了，以前打异常空间它们排着队送，现在得认真打。" },
      { id: "mod-npc-brain-r2", author: "Dana Vex", corp: "夜枭舰队", stars: 5, date: "2026-09-20", version: "0.9.7", body: "按吨位分组之后战场可读性高很多，火力组会自己去找电子战目标。" },
      { id: "mod-npc-brain-r3", author: "Oren Tallow", corp: "铁壁安保", stars: 5, date: "2026-09-21", version: "0.10.0", body: "撤退逻辑很值，护卫级偶尔退得太早，整体依然强烈推荐。" },
      { id: "mod-npc-brain-r4", author: "Mira Sandoval", corp: "深空学院", stars: 5, date: "2026-09-12", version: "0.9.7", body: "行为树能直接在 config 里覆写，这点比同类模组强太多。" },
      { id: "mod-npc-brain-r5", author: "Cale Brandt", corp: "北境矿联", stars: 4, date: "2026-09-01", version: "0.9.7", body: "和掉落重构一起装会互相覆盖，装之前记得看一眼说明。" , reply: { date: "2026-09-02", body: "两个模组都要重写行为树根节点，需要合并后才能共存，暂时只能二选一。" } },
    ],
    downloads: 18770,
  ratingAvg: 4.800,
  ratingCount: 394,
    sizeMB: 32.1,
    updatedAt: "2026-09-21",
    gameVersion: "0.12.6+",
    perms: ["npc.behavior", "combat.targeting"],
    conflicts: ["mod-npc-loot"],
    conflictReason: {
      "mod-npc-loot": "两者都会重写 NPC 行为树根节点，同时启用时后加载的一方会被静默忽略。",
    },
readme: [
      "替换默认的直线追击逻辑，NPC 会按吨位分成前排与火力组，优先集火被标记的电子战目标。",
      "功能要点",
      "· 按吨位编组，火力组自动转向电子战目标",
      "· 护盾低于 25% 且无后勤支援时主动脱离撤退",
      "· 行为树节点可在 config 目录下覆写，无需改动模组本体",
    ],
    changelog: [
      { version: "0.10.0", date: "2026-09-21", items: ["新增撤退逻辑", "支持按吨位编组"] },
      { version: "0.9.7", date: "2026-08-14", items: ["修复集火目标在跃迁后丢失"] },
    ],
  },
  {
    id: "mod-fleet-tools",
    name: "舰队工具集",
    version: "1.7.3",
    author: "Tranquility Labs",
    cat: "工具",
    desc: "舰队编成模板、成员装备审计、跃迁同步倒计时，团长视角一键广播指令。",
    tags: ["舰队", "工具", "协同"],
    installed: true,
    enabled: true,
    needsRestart: false,
    reviews: [
      { id: "mod-fleet-tools-r1", author: "Oren Tallow", corp: "铁壁安保", stars: 5, date: "2026-09-18", version: "1.7.3", body: "编成模板一键套用，组队时间少了一半。" },
      { id: "mod-fleet-tools-r2", author: "Hana Rios", corp: "月海工业", stars: 5, date: "2026-09-10", version: "1.7.3", body: "装备审计帮我们抓出过三次缺装的，广播前一目了然。" },
      { id: "mod-fleet-tools-r3", author: "Tobias Kerr", corp: "凛冬联合", stars: 4, date: "2026-08-30", version: "1.7.0", body: "跃迁同步倒计时很实用，希望窄屏下也能并排显示。" },
      { id: "mod-fleet-tools-r4", author: "Nadia Ferr", corp: "自由佣兵", stars: 5, date: "2026-08-14", version: "1.7.0", body: "团长视角的广播指令做得很干净，没有多余的东西。" },
    ],
    downloads: 15230,
  ratingAvg: 4.750,
  ratingCount: 274,
    sizeMB: 12.8,
    updatedAt: "2026-09-12",
    gameVersion: "0.12.4+",
    perms: ["fleet.read", "fleet.broadcast"],
readme: [
      "团长视角的编成与广播工具：把当前编成存成模板，下次组队时一键套用。",
      "功能要点",
      "· 编成模板按舰船级别自动分配小队",
      "· 装备审计列出成员缺装的槽位，广播前给出统一装配清单",
      "· 跃迁同步倒计时只走本地时钟，不向服务端写入状态",
    ],
    changelog: [
      { version: "1.7.3", date: "2026-09-12", items: ["审计结果支持导出", "修复模板覆盖同名项"] },
      { version: "1.7.0", date: "2026-07-28", items: ["新增跃迁同步倒计时"] },
    ],
  },
  {
    id: "mod-loot-log",
    name: "战利品账本",
    version: "1.0.4",
    author: "Nell Ferrow",
    cat: "工具",
    desc: "按异常空间自动归集掉落，折算 ISK 估值并导出 CSV，方便军团内部分账。",
    tags: ["掉落", "账本", "导出"],
    installed: true,
    enabled: true,
    needsRestart: false,
    reviews: [
      { id: "mod-loot-log-r1", author: "Bram Hallow", corp: "北境矿联", stars: 4, date: "2026-09-15", version: "1.0.4", body: "按异常空间自动归集，打完直接导出丢进军团表格，省事。" , reply: { date: "2026-09-16", body: "按舰队成员拆分导出的功能排在下个版本，感谢反馈。" } },
      { id: "mod-loot-log-r2", author: "Sable Oram", corp: "深空贸易", stars: 5, date: "2026-09-03", version: "1.0.4", body: "估值和实际成交有点差，但能手动改汇率就够了。" },
      { id: "mod-loot-log-r3", author: "Ilya Prine", corp: "凛冬联合", stars: 4, date: "2026-08-27", version: "1.0.4", body: "按天分文件很贴心，挂机一周也不会撑爆单个文件。" },
      { id: "mod-loot-log-r4", author: "Vex Amarr", corp: "月海工业", stars: 4, date: "2026-08-20", version: "1.0.4", body: "和市场洞察同时开会丢记录，两个都想要的建议先停一个。" },
    ],
    downloads: 4880,
  ratingAvg: 4.250,
  ratingCount: 107,
    sizeMB: 6.2,
    updatedAt: "2026-08-19",
    gameVersion: "0.12.2+",
    perms: ["loot.table", "market.read"],
    conflicts: ["mod-market-insight"],
    conflictReason: {
      "mod-market-insight": "两者都接管掉落事件表 loot.table，同时启用会导致掉落记录丢失。",
    },
readme: [
      "每打完一处异常空间就自动把掉落按类型归集，附上击杀时间与所在星系。",
      "功能要点",
      "· 按异常空间归集掉落，折算 ISK 估值",
      "· 汇率可手动改写，导出 CSV 后可直接丢进军团表格",
      "· 账本默认按天分文件，长时间挂机也不会撑出巨型文件",
    ],
    changelog: [
      { version: "1.0.4", date: "2026-08-19", items: ["修复同一星系多次进场重复计数"] },
      { version: "1.0.0", date: "2026-06-30", items: ["首个公开版本"] },
    ],
  },
  {
    id: "mod-wormhole-map",
    name: "虫洞测绘",
    version: "2.3.0",
    author: "Signal Cartel",
    cat: "玩法",
    desc: "记录虫洞出口稳定性与质量上限，绘制可共享的链路图，支持批量标记已塌陷。",
    tags: ["虫洞", "测绘", "地图"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-wormhole-map-r1", author: "Juno Pell", corp: "星图测绘局", stars: 5, date: "2026-09-24", version: "2.3.0", body: "链路图能导出图片直接贴聊天频道，队友导入后是同一张图，太好用了。" },
      { id: "mod-wormhole-map-r2", author: "Ravi Okonkwo", corp: "深空学院", stars: 5, date: "2026-09-19", version: "2.3.0", body: "质量上限估算救过我们一次，差点把整条链路压塌。" },
      { id: "mod-wormhole-map-r3", author: "Elsa Nord", corp: "凛冬联合", stars: 5, date: "2026-09-11", version: "2.3.0", body: "批量标记塌陷会把下游一并灰掉，这个细节做得很到位。" },
      { id: "mod-wormhole-map-r4", author: "Piotr Lang", corp: "自由佣兵", stars: 5, date: "2026-09-02", version: "2.2.0", body: "稳定性记录很准，跳之前看一眼心里有底。" },
      { id: "mod-wormhole-map-r5", author: "Mira Sandoval", corp: "深空学院", stars: 4, date: "2026-08-22", version: "2.2.0", body: "功能没得挑，就是链路长了之后地图有点卡，希望能分页。" , reply: { date: "2026-08-23", body: "链路超过 30 跳会自动折叠成一段，分页在 2.4.0 里。" } },
    ],
    downloads: 22140,
  ratingAvg: 4.800,
  ratingCount: 443,
    sizeMB: 22.6,
    updatedAt: "2026-09-16",
    gameVersion: "0.12.8+",
    perms: ["map.read", "net.outbound"],
readme: [
      "扫描到虫洞后自动记录等级、剩余质量与稳定性，并按时间轴串成一条链路。",
      "功能要点",
      "· 记录等级、剩余质量与稳定性上限",
      "· 链路图可导出图片，或粘贴进聊天频道让队友导入同一张图",
      "· 批量标记塌陷会把整条下游链路一并灰掉，避免误跳",
    ],
    changelog: [
      { version: "2.3.0", date: "2026-09-16", items: ["链路图支持导入导出", "新增质量上限估算"] },
      { version: "2.2.0", date: "2026-08-02", items: ["支持批量标记塌陷"] },
    ],
  },
  {
    id: "mod-industry-calc",
    name: "工业成本核算",
    version: "1.2.6",
    author: "Ferrow Works",
    cat: "经济",
    desc: "按当前矿物市价与蓝图材料表实时核算制造成本，自动扣除 ME/TE 影响并给出利润率。",
    tags: ["工业", "成本", "蓝图"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-industry-calc-r1", author: "Hana Rios", corp: "月海工业", stars: 5, date: "2026-09-13", version: "1.2.6", body: "接代工单之前先看利润率，已经帮我推掉两笔亏本单了。" },
      { id: "mod-industry-calc-r2", author: "Nadia Ferr", corp: "自由佣兵", stars: 4, date: "2026-09-01", version: "1.2.6", body: "多星系采购对比很好用，就是矿物市价刷新间隔有点长。" , reply: { date: "2026-09-02", body: "市价刷新间隔改成可配置了，默认 5 分钟，也可以在设置里手动刷新。" } },
      { id: "mod-industry-calc-r3", author: "Piotr Lang", corp: "自由佣兵", stars: 4, date: "2026-08-25", version: "1.2.0", body: "ME/TE 折算准，和手工算的结果一致。" },
    ],
    downloads: 8420,
  ratingAvg: 4.333,
  ratingCount: 185,
    sizeMB: 9.1,
    updatedAt: "2026-09-08",
    gameVersion: "0.12.6+",
    perms: ["market.read", "industry.blueprint"],
readme: [
      "打开蓝图时直接显示按当前矿物市价算出的单件成本，ME/TE 已经折算进去。",
      "功能要点",
      "· 按当前矿物市价与蓝图材料表实时核算单件成本",
      "· 对比多个星系的市场价，找出材料采购最划算的落点",
      "· 利润率为负时整行标红，避免接亏本代工单",
    ],
    changelog: [
      { version: "1.2.6", date: "2026-09-08", items: ["修复 T2 蓝图材料表缺失"] },
      { version: "1.2.0", date: "2026-07-20", items: ["新增多星系采购对比"] },
    ],
  },
  {
    id: "mod-npc-loot",
    name: "NPC 掉落重构",
    version: "1.0.2",
    author: "Rogue Dev",
    cat: "AI",
    desc: "把 NPC 掉落从固定概率改成按威胁等级加权，精英怪会额外掉落打捞件与蓝图。",
    tags: ["NPC", "掉落", "平衡"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-npc-loot-r1", author: "Cale Brandt", corp: "北境矿联", stars: 4, date: "2026-09-08", version: "1.0.2", body: "掉落权重全部写在 JSON 里，想怎么改就怎么改，这点很好。" },
      { id: "mod-npc-loot-r2", author: "Rook Salvo", corp: "夜枭舰队", stars: 4, date: "2026-08-29", version: "1.0.2", body: "精英怪掉打捞件之后收益明显上来，护卫级不再出旗舰件也合理。" },
      { id: "mod-npc-loot-r3", author: "Dana Vex", corp: "夜枭舰队", stars: 5, date: "2026-08-16", version: "1.0.0", body: "和 NPC 战术大脑一起装会互相覆盖，只能二选一，比较可惜。" },
    ],
    downloads: 5360,
  ratingAvg: 4.333,
  ratingCount: 113,
    sizeMB: 15.3,
    updatedAt: "2026-09-02",
    gameVersion: "0.12.6+",
    perms: ["npc.behavior", "loot.table"],
    conflicts: ["mod-npc-brain"],
    conflictReason: {
      "mod-npc-brain": "两者都会重写 NPC 行为树根节点，同时启用时后加载的一方会被静默忽略。",
    },
readme: [
      "掉落表改成按威胁等级加权，护卫级 NPC 不再产出旗舰级打捞件。",
      "功能要点",
      "· 掉落按威胁等级加权，权重全部写在可编辑的 JSON 里",
      "· 精英怪额外掉落打捞件与蓝图",
      "· 护卫级 NPC 不再产出旗舰级打捞件",
    ],
    changelog: [
      { version: "1.0.2", date: "2026-09-02", items: ["下调护卫级掉落权重"] },
      { version: "1.0.0", date: "2026-07-05", items: ["首个公开版本"] },
    ],
  },
  {
    id: "mod-route-planner",
    name: "跳线规划器",
    version: "3.1.4",
    author: "Signal Cartel",
    cat: "工具",
    desc: "按安全等级与星系危险度规划跳线，支持避开低安堵门点并估算全程耗时。",
    tags: ["导航", "跳线", "安全"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-route-planner-r1", author: "Juno Pell", corp: "星图测绘局", stars: 5, date: "2026-09-21", version: "3.1.4", body: "导入堵门记录之后会自己绕开高危星系，跑低安安心多了。" },
      { id: "mod-route-planner-r2", author: "Tobias Kerr", corp: "凛冬联合", stars: 5, date: "2026-09-15", version: "3.1.4", body: "三条候选跳线对比很清楚，能看出多花几分钟换多少安全。" },
      { id: "mod-route-planner-r3", author: "Elsa Nord", corp: "凛冬联合", stars: 4, date: "2026-09-04", version: "3.1.0", body: "耗时估算挺准，换船之后立刻重算这点好评。" },
      { id: "mod-route-planner-r4", author: "Kestrel Vane", corp: "自由佣兵", stars: 5, date: "2026-08-18", version: "3.1.0", body: "从 2.x 用到现在没出过问题。" },
    ],
    downloads: 13620,
  ratingAvg: 4.750,
  ratingCount: 259,
    sizeMB: 28.7,
    updatedAt: "2026-09-19",
    gameVersion: "0.12.8+",
    perms: ["map.read"],
readme: [
      "输入起点与终点，按安全等级权重给出三条候选跳线，并标出沿途的低安星系。",
      "功能要点",
      "· 按安全等级与星系危险度给出三条候选跳线",
      "· 可导入近期堵门记录，规划时自动绕开高危星系",
      "· 按当前舰船最大跃迁速度估算全程耗时，换船后立即重算",
    ],
    changelog: [
      { version: "3.1.4", date: "2026-09-19", items: ["支持导入堵门记录"] },
      { version: "3.1.0", date: "2026-08-06", items: ["新增三条候选跳线对比"] },
    ],
  },
  {
    id: "mod-kill-feed",
    name: "击杀播报",
    version: "1.3.0",
    author: "Nell Ferrow",
    cat: "玩法",
    desc: "把本地击杀邮件整理成实时播报条，按 ISK 损失排序并高亮军团成员。",
    tags: ["击杀", "播报", "战报"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-kill-feed-r1", author: "Ravi Okonkwo", corp: "深空学院", stars: 4, date: "2026-09-05", version: "1.3.0", body: "播报条固定在右侧之后打架时不用来回切窗口了。" },
      { id: "mod-kill-feed-r2", author: "Sable Oram", corp: "深空贸易", stars: 4, date: "2026-08-28", version: "1.3.0", body: "ISK 阈值过滤很实用，小打小闹不会刷屏。" },
      { id: "mod-kill-feed-r3", author: "Dana Vex", corp: "夜枭舰队", stars: 3, date: "2026-08-20", version: "1.2.0", body: "高亮军团成员偶尔会漏，可能是名字匹配的问题，整体还行。" , reply: { date: "2026-08-21", body: "定位到是名字里的特殊字符没匹配上，下个补丁修掉。" } },
    ],
    downloads: 3910,
  ratingAvg: 3.667,
  ratingCount: 82,
    sizeMB: 4.8,
    updatedAt: "2026-08-25",
    gameVersion: "0.12.2+",
    perms: ["killmail.read"],
readme: [
      "本地击杀邮件会被整理成一条滚动播报，按 ISK 损失从高到低排序。",
      "功能要点",
      "· 按 ISK 损失从高到低排序",
      "· 军团成员出现在播报里时高亮，并附上击杀方与损失方舰船",
      "· 播报条可固定在屏幕任意一边，也可只保留超过阈值的击杀",
    ],
    changelog: [
      { version: "1.3.0", date: "2026-08-25", items: ["新增 ISK 阈值过滤", "播报条可固定位置"] },
      { version: "1.2.0", date: "2026-06-18", items: ["支持高亮军团成员"] },
    ],
  },
  {
    id: "mod-sov-timer",
    name: "主权计时器",
    version: "1.4.2",
    latest: "1.5.0",
    author: "Kaede",
    cat: "玩法",
    desc: "把主权结构加固窗口、退增强倒计时同步到客户端通知栏，支持多军团共享视图。",
    tags: ["主权", "计时", "通知"],
    installed: true,
    enabled: true,
    needsRestart: false,
    reviews: [
      { id: "mod-sov-timer-r1", author: "Hana Rios", corp: "月海工业", stars: 5, date: "2026-09-26", version: "1.5.0", body: "退增强倒计时推到通知栏之后，再也没错过加固窗口。" },
      { id: "mod-sov-timer-r2", author: "Oren Tallow", corp: "铁壁安保", stars: 5, date: "2026-09-25", version: "1.5.0", body: "多军团共享视图很好用，盟友的计时用不同颜色叠在一条轴上。" },
      { id: "mod-sov-timer-r3", author: "Elsa Nord", corp: "凛冬联合", stars: 5, date: "2026-09-24", version: "1.5.0", body: "静默时段终于能关，凌晨的提醒不会再吵醒人。" },
      { id: "mod-sov-timer-r4", author: "Tobias Kerr", corp: "凛冬联合", stars: 5, date: "2026-09-10", version: "1.4.2", body: "跨日倒计时显示为负的问题修得很及时。" },
      { id: "mod-sov-timer-r5", author: "Piotr Lang", corp: "自由佣兵", stars: 4, date: "2026-09-02", version: "1.4.2", body: "希望以后能导出成日历订阅，现在只能自己记。" },
    ],
    downloads: 12840,
  ratingAvg: 4.800,
  ratingCount: 334,
    sizeMB: 24.6,
    updatedAt: "2026-09-26",
    gameVersion: "0.12.8+",
    perms: ["sov.read", "notify.push"],
    mine: true,
    review: "approved",
readme: [
      "自动读取主权结构的加固窗口与退增强时间，倒计时直接推到客户端通知栏。",
      "功能要点",
      "· 加固窗口与退增强倒计时同步到客户端通知栏",
      "· 多军团共享视图，盟友的计时以不同颜色叠在同一张时间轴上",
      "· 到点前 15 分钟与 5 分钟各提醒一次，可单独关闭",
    ],
    changelog: [
      { version: "1.5.0", date: "2026-09-26", items: ["新增多军团共享视图", "通知支持静默时段"] },
      { version: "1.4.2", date: "2026-09-05", items: ["修复跨日倒计时显示为负"] },
      { version: "1.4.0", date: "2026-08-11", items: ["新增提前 5 分钟提醒"] },
    ],
  },
  {
    id: "mod-nebula-hd",
    name: "高清星云材质",
    version: "1.1.0",
    author: "Kaede",
    cat: "画面",
    desc: "替换 42 张星云与星系背景贴图到 4K，附带亮度均衡配置，避免星门附近过曝。",
    tags: ["画面", "贴图", "4K"],
    installed: true,
    enabled: true,
    needsRestart: false,
    reviews: [
      { id: "mod-nebula-hd-r1", author: "Juno Pell", corp: "星图测绘局", stars: 5, date: "2026-09-09", version: "1.1.0", body: "星云换成 4K 之后跳跃时的观感提升非常明显。" },
      { id: "mod-nebula-hd-r2", author: "Kestrel Vane", corp: "自由佣兵", stars: 4, date: "2026-08-30", version: "1.1.0", body: "亮度均衡配置很实用，星门附近不再一片死白。" },
      { id: "mod-nebula-hd-r3", author: "Ravi Okonkwo", corp: "深空学院", stars: 4, date: "2026-08-24", version: "1.1.0", body: "显存占用确实高，8 GB 的卡建议关掉 4K 选项。" , reply: { date: "2026-08-25", body: "4K 选项可以单独关掉，关闭后显存占用和原版基本一致。" } },
      { id: "mod-nebula-hd-r4", author: "Nadia Ferr", corp: "自由佣兵", stars: 4, date: "2026-08-18", version: "1.0.0", body: "和舰船涂装合集同时开贴图会互相覆盖，注意二选一。" },
    ],
    downloads: 6420,
  ratingAvg: 4.250,
  ratingCount: 154,
    sizeMB: 186.4,
    updatedAt: "2026-08-28",
    gameVersion: "0.12.4+",
    perms: ["graphics.material"],
    mine: true,
    review: "approved",
    conflicts: ["mod-skin-pack"],
    conflictReason: {
      "mod-skin-pack": "两者都替换材质管线，同时启用会导致星云与涂装贴图互相覆盖。",
    },
readme: [
      "替换 42 张星云与星系背景贴图到 4K，附带一份亮度均衡配置。",
      "功能要点",
      "· 42 张星云与星系背景贴图重制到 4K",
      "· 亮度均衡配置压低星门附近的过曝，长时间跳跃不易视觉疲劳",
      "· 显存占用比原版高约 900 MB，8 GB 以下显卡建议关闭 4K 选项",
    ],
    changelog: [
      { version: "1.1.0", date: "2026-08-28", items: ["新增亮度均衡配置", "补齐 6 张星系背景"] },
      { version: "1.0.0", date: "2026-06-21", items: ["首个公开版本"] },
    ],
  },
  {
    id: "mod-skin-pack",
    name: "舰船涂装合集",
    version: "3.0.0",
    author: "Kaede",
    cat: "画面",
    desc: "新增 86 套舰船涂装方案，含 4 套阵营限定配色，不影响舰船属性。",
    tags: ["涂装", "外观"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [
      { id: "mod-skin-pack-r1", author: "Mira Sandoval", corp: "深空学院", stars: 4, date: "2026-09-12", version: "3.0.0", body: "86 套涂装挑花眼，旗舰那几套做得很细。" },
      { id: "mod-skin-pack-r2", author: "Cale Brandt", corp: "北境矿联", stars: 4, date: "2026-09-06", version: "3.0.0", body: "阵营限定配色要声望 5.0 才解锁，慢慢刷吧。" , reply: { date: "2026-09-07", body: "阵营限定是上架条款要求的，暂时不能放开解锁条件。" } },
      { id: "mod-skin-pack-r3", author: "Bram Hallow", corp: "北境矿联", stars: 4, date: "2026-08-28", version: "3.0.0", body: "延迟加载之后进游戏快了不少，比 2.x 好。" },
    ],
    downloads: 11760,
  ratingAvg: 4.000,
  ratingCount: 176,
    sizeMB: 94.2,
    updatedAt: "2026-09-10",
    gameVersion: "0.12.6+",
    perms: ["graphics.material"],
    mine: true,
    review: "approved",
    conflicts: ["mod-nebula-hd"],
    conflictReason: {
      "mod-nebula-hd": "两者都替换材质管线，同时启用会导致星云与涂装贴图互相覆盖。",
    },
readme: [
      "新增 86 套舰船涂装方案，覆盖四大阵营的主力舰船，纯外观不改任何属性。",
      "功能要点",
      "· 86 套涂装方案，覆盖四大阵营主力舰船",
      "· 4 套阵营限定配色，需对应阵营声望达到 5.0 才会解锁",
      "· 纯外观，不占用舰船属性字段",
    ],
    changelog: [
      { version: "3.0.0", date: "2026-09-10", items: ["新增 12 套旗舰涂装", "材质管线改为延迟加载"] },
      { version: "2.4.0", date: "2026-07-15", items: ["补齐战列巡洋舰涂装"] },
    ],
  },
  {
    id: "mod-jump-bridge",
    name: "跃迁桥接助手",
    version: "0.9.0",
    author: "Kaede",
    cat: "玩法",
    desc: "为跳跃桥接计算燃料消耗与冷却时间，并在桥接范围内自动标出可用落点。",
    tags: ["桥接", "燃料", "导航"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [],
    downloads: 0,
  ratingAvg: 0.000,
  ratingCount: 0,
    sizeMB: 11.2,
    updatedAt: "2026-09-26",
    gameVersion: "0.12.8+",
    perms: ["map.read", "sov.read"],
    mine: true,
    review: "reviewing",
    submittedAt: "13:41",
readme: [
      "为跳跃桥接计算每次跳跃的燃料消耗，并把冷却时间叠在桥接建筑的状态条上。",
      "功能要点",
      "· 按舰船与桥接距离计算单次跳跃的燃料消耗",
      "· 冷却时间叠在桥接建筑的状态条上",
      "· 桥接范围内自动标出可用落点，落点被占用时提示改选",
      "· 只读取本地地图与主权数据，不涉及任何写操作",
    ],
    changelog: [
      { version: "0.9.0", date: "2026-09-26", items: ["首个提交审核的版本"] },
    ],
  },
  {
    id: "mod-drone-ui",
    name: "无人机控制面板重制",
    version: "0.4.0",
    author: "Kaede",
    cat: "画面",
    desc: "重做无人机控制面板，按编队分组显示护盾与电量，支持一键回收全部无人机。",
    tags: ["无人机", "界面", "编队"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [],
    downloads: 0,
  ratingAvg: 0.000,
  ratingCount: 0,
    sizeMB: 7.6,
    updatedAt: "2026-09-25",
    gameVersion: "0.12.8+",
    perms: ["ui.overlay"],
    mine: true,
    review: "draft",
readme: [
      "把无人机控制面板按编队重新分组，每组单独显示护盾、电量与当前目标。",
      "功能要点",
      "· 按编队分组显示护盾、电量与当前目标",
      "· 一键回收全部无人机，按剩余电量排序，先回电量低的",
      "· 面板宽度可调，适配 1440p 以上的宽屏",
    ],
    changelog: [
      { version: "0.4.0", date: "2026-09-25", items: ["新增一键回收", "面板宽度可调"] },
    ],
  },
  {
    id: "mod-cargo-alert",
    name: "货舱超载预警",
    version: "1.0.0",
    author: "Kaede",
    cat: "工具",
    desc: "按剩余货舱容量与矿石体积预警，装满前自动提醒并高亮当前采矿激光。",
    tags: ["采矿", "货舱", "预警"],
    installed: false,
    enabled: false,
    needsRestart: false,
    reviews: [],
    downloads: 0,
  ratingAvg: 0.000,
  ratingCount: 0,
    sizeMB: 3.4,
    updatedAt: "2026-09-23",
    gameVersion: "0.12.8+",
    perms: ["ui.overlay", "cargo.read"],
    mine: true,
    review: "rejected",
    reviewNote: "预警弹窗在 4K 分辨率下会遮挡总览面板，请调整锚点后重新提交。",
readme: [
      "按剩余货舱容量与当前矿石体积计算还能装几轮，装满前 10 秒给出预警。",
      "功能要点",
      "· 按剩余容量与矿石体积算还能装几轮",
      "· 装满前 10 秒预警，并高亮正在工作的采矿激光",
      "· 阈值可在设置里调整，默认按 90% 容量触发",
    ],
    changelog: [
      { version: "1.0.0", date: "2026-09-23", items: ["首个提交审核的版本"] },
    ],
  },
]

/* ---------------- 环境自检 ---------------- */

/**
 * 检测结果里最要紧的一档是「未检测到」：不是坏了，是本机压根没有这个东西，
 * 得作者自己动手装。所以它单独成一档，并且必须带一条能照着做的修复指引。
 */
export interface CheckFix {
  /** 为什么会缺、该做什么，一句话讲清 */
  hint: string
  /** 手工补的话敲什么；没有就只给说明 */
  cmd?: string
  /** 启动器自己能补的，给个按钮文案；没有就表示只能手工装 */
  action?: string
  /**
   * 有些项没什么文件可补，问题是外部的：root = 配置里的服务端根目录指错了，
   * bin = 本地二进制落后于启动器构建。修复动作由自检那边接住，不在这一项里做。
   */
  repair?: "root" | "bin"
  /** 补好之后这一项该显示什么 */
  okDetail: string
  /** 补好之后的提示语 */
  done: string
}

export interface CheckItem {
  id: string
  name: string
  detail: string
  ok: boolean
  level: "ok" | "warn" | "error" | "missing"
  /**
   * 缺了它还能不能把服务器拉起来。工具链只影响本地编译模组，
   * 缺了照样能启动；依赖、二进制、证书缺了则启动必然失败。
   */
  blocking?: boolean
  fix?: CheckFix
}

/**
 * 服务端根目录下长着的两样东西：主服务器依赖与市场服务二进制。
 * 目录写错、或者整个目录被挪走，它们就是真的找不到——不是文案上的差别，
 * 跟客户端证书一样挡住一键启动，模组目录也相对同一个根定位。
 */
const ROOT_BOUND: Record<
  string,
  { missingDetail: (root: string) => string; hint: string }
> = {
  serverDeps: {
    missingDetail: (root) => `${root}\\node_modules 不存在 · 服务端拉不起来`,
    hint: "服务端主程序目录对不上，依赖自然找不到。把「服务端根目录」改回主程序所在的位置即可。",
  },
  marketBin: {
    missingDetail: (root) => `${root}\\market\\market-service.exe 不存在`,
    hint: "市场服务二进制在服务端根目录的 market 子目录下，随启动拉起市场服务时要用到它。",
  },
}

/** 主服务器依赖找到之后长这样，跟目录无关 */
const SERVER_DEPS_OK = "412 个包已就绪 · node_modules 完整"

/** 这两项没什么可补的，动的是配置里的根目录 */
const ROOT_FIX_ACTION = "改回默认目录"

/** 市场服务二进制：跟着启动器构建走，启动器一更新它就落后了 */
export const MARKET_BIN = {
  file: "market-service.exe",
  size: "12.4 MB",
  /** 本地这一份的版本，装好之后就一直躺在服务端目录里 */
  version: "v0.12.8",
}

/** 二进制这一行的读数：文件名 · 版本 · 体积 */
export function binDetail(version: string): string {
  return `${MARKET_BIN.file} · ${version} · ${MARKET_BIN.size}`
}

/** 二进制该跟到哪个版本：启动器的构建号取前三段（v0.12.9.0 → v0.12.9） */
export function binTargetVersion(launcherVersion: string): string {
  return launcherVersion.split(".").slice(0, 3).join(".")
}

/** 配置里的服务端根目录，还指不指向主程序所在的位置 */
export function isServerRootValid(root: string): boolean {
  return root.trim().toLowerCase() === SERVER_CONFIG.root.toLowerCase()
}

export interface CheckInputs {
  /** 配置里的服务端根目录 */
  root: string
  /** 本地那份市场服务二进制的版本 */
  binVersion: string
  /** 启动器当前构建 */
  launcherVersion: string
}

/**
 * 依赖与二进制这两项不吃死数据，跟着外部状态走：
 * 根目录换了它们就找不到、改回来又都在；启动器更新之后二进制就落后一个版本。
 * 这是自检里唯一会自己变的两项，其余几项原样返回——重算不会把作者补好的证书打回未检测到。
 *
 * 根目录不对时先算「找不到」：版本落后的事等目录对了再说，一次只讲一件。
 */
export function applyDerivedChecks(
  items: CheckItem[],
  input: CheckInputs
): CheckItem[] {
  const root = input.root.trim()
  const rootOk = isServerRootValid(root)
  const target = binTargetVersion(input.launcherVersion)

  return items.map((item) => {
    const bound = ROOT_BOUND[item.id]
    if (!bound) return item

    if (!rootOk) {
      return {
        ...item,
        ok: false,
        level: "missing" as const,
        detail: bound.missingDetail(root || "（根目录为空）"),
        fix: {
          hint: bound.hint,
          action: ROOT_FIX_ACTION,
          repair: "root" as const,
          okDetail:
            item.id === "marketBin" ? binDetail(input.binVersion) : SERVER_DEPS_OK,
          done: "服务端根目录已改回主程序所在的位置，依赖与二进制都回来了。",
        },
      }
    }

    if (item.id === "serverDeps") {
      return {
        ...item,
        ok: true,
        level: "ok" as const,
        detail: SERVER_DEPS_OK,
        fix: undefined,
      }
    }

    // 二进制还在，只是版本落后：不该挡住启动，但得提醒，并且真能同步
    if (input.binVersion === target) {
      return {
        ...item,
        ok: true,
        level: "ok" as const,
        detail: binDetail(input.binVersion),
        fix: undefined,
      }
    }
    return {
      ...item,
      ok: false,
      level: "warn" as const,
      detail: binDetail(input.binVersion),
      fix: {
        hint: `启动器已经更新到 ${input.launcherVersion}，这份二进制还停在 ${input.binVersion}，市场服务与启动器会对不上版本。`,
        action: `同步到 ${target}`,
        repair: "bin" as const,
        okDetail: binDetail(target),
        done: `市场服务二进制已同步到 ${target}，与启动器构建一致。`,
      },
    }
  })
}

/**
 * 启动前的依赖门禁：先看工具链，再看依赖与二进制，最后是客户端证书。
 * 内存 / 磁盘这类运行期读数在资源监控里看，不在这里重复。
 *
 * 这里留了一项「未检测到」——自检的价值全在没通过的时候，全绿的界面看不出门禁到底管不管用。
 * 挑客户端证书是因为它确实会缺（换机器、清过 bin 目录都会），
 * 而且启动器能自己补，作者不会卡死在这一步。
 * 依赖与二进制那两项跟着外部状态走（配置里的服务端根目录、启动器当前构建），
 * 见 applyDerivedChecks。
 */
export const CHECK_ITEMS: CheckItem[] = [
  { id: "node", name: "Node.js", detail: "v26.5.0 · 16 逻辑线程", ok: true, level: "ok" },
  { id: "rust", name: "Rust / Cargo", detail: "rustc 1.83.0 · cargo 1.83.0", ok: true, level: "ok", blocking: false },
  { id: "msvc", name: "VS C++", detail: "MSVC v143 · Windows SDK 10.0.26100", ok: true, level: "ok", blocking: false },
  { id: "serverDeps", name: "主服务器依赖", detail: SERVER_DEPS_OK, ok: true, level: "ok" },
  { id: "marketBin", name: "市场服务二进制", detail: binDetail(MARKET_BIN.version), ok: true, level: "ok" },
  {
    id: "cert",
    name: "客户端证书 CA",
    detail: "未检测到 · bin\\ca.crt 不存在，bin\\ca.key 也不在",
    ok: false,
    level: "missing",
    fix: {
      hint: "换过机器、或手动清过 bin 目录之后证书就没了。重新签一份即可，已有的存档不受影响。",
      cmd: 'openssl req -x509 -newkey rsa:4096 -nodes -keyout bin\\ca.key -out bin\\ca.crt -days 365 -subj "/CN=EveJS Local CA"',
      action: "重新签发证书",
      okDetail: "bin\\ca.crt · 有效期至 2027-09-26",
      done: "证书已重新签发，本机客户端可以连上来了。",
    },
  },
]

/** 世界存档文件，危险操作区引用（不再走环境自检） */
export const WORLD_STORE = "gameStore.sqlite · 128.4 MB · 可写"

export const ENV_META = {
  runtime: "Node v26.5.0",
  ram: "32 GB",
  threads: 16,
  checkedAt: "14:01:49",
}

/* ---------------- 资源监控 ---------------- */

export interface Metric {
  key: string
  label: string
  value: number
  display: string
  unit: string
  tone: "primary" | "telemetry" | "success" | "warning" | "destructive"
  /** 最近一段采样，用来画走势曲线；最后一位与 value 对齐 */
  series: number[]
}

export const METRICS: Metric[] = [
  { key: "cpu", label: "处理器 CPU", value: 47.2, display: "47.2", unit: "%", tone: "primary", series: [38.1, 41.6, 39.8, 44.2, 52.7, 49.3, 45.1, 43.6, 48.9, 55.2, 51.4, 46.8, 44.3, 47.2] },
  { key: "gpu", label: "显卡 GPU", value: 38.5, display: "38.5", unit: "%", tone: "telemetry", series: [30.2, 33.8, 36.1, 41.5, 45.9, 43.2, 39.6, 37.4, 40.8, 44.1, 42.6, 39.1, 37.2, 38.5] },
  { key: "gpuDed", label: "专用 GPU 内存", value: 44.1, display: "3.5", unit: "GB / 8GB", tone: "telemetry", series: [40.5, 41.2, 42.8, 45.6, 47.3, 46.1, 44.9, 43.7, 45.2, 46.8, 45.5, 44.3, 43.8, 44.1] },
  { key: "gpuMem", label: "GPU 共享内存", value: 21.7, display: "1.7", unit: "GB / 8GB", tone: "primary", series: [18.2, 19.1, 20.4, 22.6, 24.8, 23.5, 22.1, 21.4, 22.8, 24.2, 23.1, 22.3, 21.5, 21.7] },
  { key: "mem", label: "内存 MEMORY", value: 38.8, display: "12.4", unit: "GB / 32GB", tone: "primary", series: [34.2, 34.8, 35.1, 35.9, 36.4, 36.2, 37.1, 37.6, 37.4, 38.1, 38.5, 38.3, 38.6, 38.8] },
  { key: "vmem", label: "虚拟内存", value: 18.2, display: "5.8", unit: "GB / 32GB", tone: "telemetry", series: [16.4, 16.9, 17.3, 17.8, 18.6, 18.2, 17.9, 17.6, 18.1, 18.8, 18.5, 18.0, 17.8, 18.2] },
  { key: "disk", label: "磁盘卷 C:", value: 42.1, display: "421", unit: "GB / 1TB", tone: "warning", series: [40.6, 40.7, 40.7, 40.8, 40.8, 40.9, 40.9, 41.0, 41.0, 41.0, 41.1, 41.1, 41.1, 42.1] },
  { key: "net", label: "网络 I/O", value: 38.0, display: "842", unit: "MB/s", tone: "primary", series: [22.4, 31.7, 44.9, 58.2, 36.5, 28.1, 41.3, 62.8, 47.6, 33.2, 25.9, 45.4, 52.1, 38.0] },
]

/** 磁盘占用曲线用百分比采样，跟上面的指标同一套画法 */
export const DISK_VOLUMES = [
  { name: "C:", used: 421, total: 1024, series: [40.6, 40.7, 40.7, 40.8, 40.9, 40.9, 41.0, 41.0, 41.0, 41.1, 41.1, 41.1, 41.1, 41.1] },
  { name: "D:", used: 812, total: 2048, series: [39.2, 39.3, 39.3, 39.4, 39.4, 39.5, 39.5, 39.5, 39.6, 39.6, 39.6, 39.6, 39.6, 39.6] },
  { name: "E:", used: 264, total: 2048, series: [12.6, 12.6, 12.7, 12.7, 12.8, 12.8, 12.8, 12.9, 12.9, 12.9, 12.9, 12.9, 12.9, 12.9] },
]

/* ---------------- 配置 ---------------- */

export const SERVER_CONFIG = {
  gamePort: 26000,
  imagesPort: 3001,
  gatewayPort: 8080,
  sourcePath: "/opt/evejs/config/server.json",
  root: "E:\\Games\\EveJS-v0.12.8",
}

export const CLIENT_CONFIG = {
  path: "E:\\Games\\EVE\\",
  exe: "Exefile.exe",
  caPem: "E:\\Games\\EVE\\bin\\ca.crt",
  proxy: "127.0.0.1:8080",
  scriptPath: "E:\\Games\\EVE\\EvEJSConfig.bat",
}

/* ---------------- 状态栏 / 顶栏 ---------------- */

export const LAUNCHER_META = {
  version: "v0.12.8.1",
  latestVersion: "v0.12.9.0",
  channel: "stable",
  releaseDate: "2026-09-18",
  size: "18.4 MB",
  rootPath: "/opt/evejs",
  sponsor: "B站的波坤太叔",
  author: "波坤太叔",
  /** 右上角赞助入口的标题：这里写赞助项目名，个人昵称留给 author / sponsor */
  sponsorTitle: "托肯赞助",
}

/* ---------------- 启动器更新说明 ---------------- */

/** 更新说明按分组列：新增 / 优化 / 修复 */
export interface ReleaseNoteGroup {
  group: string
  items: string[]
}

export interface LauncherRelease {
  version: string
  channel: string
  date: string
  size: string
  notes: ReleaseNoteGroup[]
}

/** 更新通道上这一版改了什么，自更新弹窗里逐条列给用户看 */
export const LAUNCHER_RELEASE: LauncherRelease = {
  version: LAUNCHER_META.latestVersion,
  channel: LAUNCHER_META.channel,
  date: LAUNCHER_META.releaseDate,
  size: LAUNCHER_META.size,
  notes: [
    {
      group: "新增",
      items: [
        "账号管理：空槽位可直接拉起客户端，角色在游戏内建好后自动回到列表",
        "自更新：更新前先看这一版改了什么，再决定装不装",
        "环境自检：提醒项支持一键修复，不用逐项点",
      ],
    },
    {
      group: "优化",
      items: [
        "环境自检：主服务器依赖与市场服务二进制跟着服务端根目录实时判定",
        "模组：服务端根目录不对时，构建骨架前先提醒并可直接去改",
        "配置中心：服务端根目录改成不存在的路径会当场给出结论",
      ],
    },
    {
      group: "修复",
      items: [
        "修复启动器更新后市场服务二进制版本不跟着走的问题",
        "修复重新检测把提醒项误判为通过、结果报全部通过的问题",
        "修复模组骨架建到错误目录下却不报错的问题",
      ],
    },
  ],
}

/* ---------------- 源码包 ---------------- */

/**
 * 整个工程的打包产物，放在 public/ 下，由 scripts/pack-source.mjs 生成。
 * 界面上只负责把链接给出去，不参与打包本身。
 */
export const SOURCE_ARCHIVE = {
  file: "evejs-command-src.zip",
  size: "1.1 MB",
  note: "含全部界面代码与开发说明，改完自己也能重新打包",
}

export const SESSION = {
  pilots: 3,
  ping: 12,
  alerts: 2,
  uptime: "02:14:38",
}

/* ---------------- 格式化 ---------------- */

export function formatCount(n: number): string {
  return n.toLocaleString("en-US")
}

/** 安装包体积：小于 1 GB 显示 MB，否则显示 GB */
export function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

