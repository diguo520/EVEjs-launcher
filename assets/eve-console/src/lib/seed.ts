import type {
  Account,
  Backup,
  BootStage,
  Faction,
  LogLevel,
  LogModule,
  MarketMod,
  ModEntry,
  UniverseConfig,
} from "./types"

/* ------------------------------------------------------------------ *
 * 冷启动分段：启动器按权重推进进度条，每段带一条真实感的日志。
 * ------------------------------------------------------------------ */
export const BOOT_STAGES: BootStage[] = [
  {
    id: "verify",
    label: "校验存档完整性",
    detail: "比对世界数据库校验和，确认上一份快照未损坏",
    weight: 1,
  },
  {
    id: "starmap",
    label: "加载星图",
    detail: "载入星系、星门、空间站与小行星带拓扑",
    weight: 2,
  },
  {
    id: "generate",
    label: "生成星域",
    detail: "按安全等级分布播种 NPC 势力与资源点",
    weight: 2.5,
  },
  {
    id: "market",
    label: "初始化市场",
    detail: "重建订单簿，回放最近成交序列",
    weight: 2,
  },
  {
    id: "ai",
    label: "启动势力 AI",
    detail: "载入行为树、巡逻航线与赏金规则",
    weight: 2,
  },
  {
    id: "restore",
    label: "恢复玩家状态",
    detail: "结算离线技能训练与资产位置",
    weight: 1.5,
  },
  {
    id: "listen",
    label: "监听端口",
    detail: "绑定网关端口，等待客户端握手",
    weight: 1,
  },
  {
    id: "ready",
    label: "世界就绪",
    detail: "心跳已建立，可以登船了",
    weight: 0.5,
  },
]

/** 每段启动过程里播报的日志。 */
export const BOOT_LOGS: Record<string, { level: LogLevel; module: LogModule; message: string }[]> = {
  verify: [
    { level: "INFO", module: "存档", message: "正在校验 world.db 校验和 …" },
    { level: "INFO", module: "存档", message: "校验通过，快照版本 v14.22 完整" },
  ],
  starmap: [
    { level: "INFO", module: "星图", message: "载入星系 5,231 个 / 星门 7,894 条" },
    { level: "DEBUG", module: "星图", message: "空间站索引构建完成，耗时 412ms" },
  ],
  generate: [
    { level: "INFO", module: "星图", message: "按安全等级播种势力领地 …" },
    { level: "INFO", module: "星图", message: "小行星带 18,204 处 / 资源点 6,733 处" },
    { level: "WARN", module: "星图", message: "0.0 区域星域密度偏高，NPC 巡逻已自动加派" },
  ],
  market: [
    { level: "INFO", module: "市场", message: "重建订单簿，回放成交 1,284,905 笔" },
    { level: "INFO", module: "市场", message: "NPC 买卖盘挂单完成，价差按配置生效" },
  ],
  ai: [
    { level: "INFO", module: "AI", message: "载入行为树 148 棵，巡逻航线 2,910 条" },
    { level: "DEBUG", module: "AI", message: "赏金结算规则编译完成" },
  ],
  restore: [
    { level: "INFO", module: "账号", message: "恢复角色 47 个，结算离线技能训练" },
    { level: "WARN", module: "账号", message: "1 个账号处于封禁状态，已跳过登录队列" },
  ],
  listen: [
    { level: "INFO", module: "网络", message: "网关绑定 0.0.0.0:26000，等待握手" },
    { level: "INFO", module: "内核", message: "tick 调度器已启动" },
  ],
  ready: [
    { level: "INFO", module: "内核", message: "世界心跳建立，单机宇宙已上线" },
  ],
}

/** 运行时随机播报的日志池，按模块分组。 */
export const RUNNING_LOG_POOL: { level: LogLevel; module: LogModule; message: string }[] = [
  { level: "DEBUG", module: "星图", message: "星门跳跃请求已受理：尤拉 → 佩林" },
  { level: "INFO", module: "市场", message: "尤拉 IV 站成交 三钛合金 x 240,000" },
  { level: "INFO", module: "市场", message: "订单簿刷新完成，挂单 38,412 条" },
  { level: "INFO", module: "战斗", message: "赏金结算：古斯塔斯 巡洋舰 击毁，+1,240,000 ISK" },
  { level: "WARN", module: "战斗", message: "玩家舱体受损，结构完整度 42%" },
  { level: "INFO", module: "AI", message: "血袭者 巡逻队已进入 塔玛 星系" },
  { level: "DEBUG", module: "AI", message: "行为树重规划：目标丢失，转入巡航" },
  { level: "INFO", module: "账号", message: "角色登录：灰隼凯恩 于 尤拉 IV 站" },
  { level: "INFO", module: "网络", message: "客户端握手完成，RTT 18ms" },
  { level: "DEBUG", module: "网络", message: "丢包重传 1 次，链路质量良好" },
  { level: "INFO", module: "存档", message: "自动存档写入完成，耗时 1.2s" },
  { level: "DEBUG", module: "内核", message: "tick 耗时 41ms，负载正常" },
  { level: "WARN", module: "内核", message: "tick 耗时 78ms，超过告警阈值" },
  { level: "INFO", module: "市场", message: "NPC 买单补货：米玛塔尔 舰船装备" },
  { level: "INFO", module: "星图", message: "小行星带刷新：新增矿石 4,820 单位" },
  { level: "ERROR", module: "网络", message: "客户端 0x1F 心跳超时，已断开连接" },
  { level: "INFO", module: "战斗", message: "安全等级变更：-0.4 → -0.7" },
  { level: "DEBUG", module: "账号", message: "技能队列推进：高级武器升级 IV" },
]

export const DEFAULT_CONFIG: UniverseConfig = {
  serverName: "新伊甸·单机宇宙",
  port: 26000,
  maxPlayers: 64,
  adminPassword: "eve-local",
  systems: 5231,
  securitySpread: 55,
  npcDensity: 1,
  expRate: 1,
  skillRate: 1,
  iskRate: 1,
  lootRate: 1,
  marketTax: 3,
  orderRefresh: 300,
  npcSpread: 8,
  tickRate: 20,
  autoSaveMinutes: 15,
  pvpEnabled: true,
  friendlyFire: false,
  persistentWorld: true,
}

export interface Preset {
  id: string
  name: string
  desc: string
  patch: Partial<UniverseConfig>
}

export const PRESETS: Preset[] = [
  {
    id: "vanilla",
    name: "原味",
    desc: "官方手感，倍率全 1，适合慢慢玩",
    patch: {
      systems: 5231,
      securitySpread: 55,
      npcDensity: 1,
      expRate: 1,
      skillRate: 1,
      iskRate: 1,
      lootRate: 1,
      marketTax: 3,
      npcSpread: 8,
      friendlyFire: false,
    },
  },
  {
    id: "relaxed",
    name: "轻松",
    desc: "成长加速、税低、NPC 温和，下班两小时也能推进",
    patch: {
      systems: 5231,
      securitySpread: 65,
      npcDensity: 0.6,
      expRate: 5,
      skillRate: 8,
      iskRate: 3,
      lootRate: 3,
      marketTax: 1,
      npcSpread: 5,
      friendlyFire: false,
    },
  },
  {
    id: "hardcore",
    name: "硬核",
    desc: "成长减半、NPC 凶猛、误伤开启，舰船真的会没",
    patch: {
      systems: 5231,
      securitySpread: 35,
      npcDensity: 1.8,
      expRate: 0.5,
      skillRate: 0.5,
      iskRate: 0.6,
      lootRate: 0.4,
      marketTax: 6,
      npcSpread: 12,
      friendlyFire: true,
    },
  },
  {
    id: "sandbox",
    name: "沙盒",
    desc: "小星域、超高倍率，适合测试配船和试玩法",
    patch: {
      systems: 1200,
      securitySpread: 80,
      npcDensity: 0.3,
      expRate: 20,
      skillRate: 20,
      iskRate: 10,
      lootRate: 8,
      marketTax: 0.5,
      npcSpread: 4,
      friendlyFire: true,
    },
  },
]

/* ------------------------------------------------------------------ *
 * 确定性伪随机：种子数据每次刷新都一致，截图/对比不会跳。
 * ------------------------------------------------------------------ */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const CHARACTERS = [
  "北辰凛", "灰隼凯恩", "铁砧七号", "赤鸦之影", "长夜不眠", "潮汐重工", "陨铁遗民",
  "幽蓝航迹", "苍狼塞恩", "熔火之芯", "星屑拾荒者", "断刃无名", "静默信标", "曙光先驱",
  "深渊回响", "极光漫游者", "荒原游隼", "银翼奥丁", "暗流商队", "雷霆之拳", "寒鸦低语",
  "拂晓守望", "虚空织者", "磐石之誓", "孤星旅人", "白鲸号舰长", "残阳拾荒", "双螺旋",
  "逆熵者", "蜂巢思维", "冷月无声", "千帆过尽", "磁暴前夕", "青铜齿轮", "雪线之上",
  "拓荒者K", "星门守卫", "提灯人", "焦土行者", "灰烬纪元", "镜面之海", "双刃协议",
  "长弓远射", "黑市掮客", "轨道清扫者", "深空信使", "折跃领航", "静电场",
]

const CORPS = [
  "星际商业委员会", "天蛇集团", "血袭者同盟", "古斯塔斯海盗团", "萨沙国度",
  "天使企业联合体", "无国界矿业", "深空打捞局", "自由领航员协会", "铁壁重工",
  "织星者商会", "暗礁物流",
]

const SYSTEMS = [
  "尤拉", "阿姆尔", "多德谢", "雷尼", "赫克", "佩林", "尼耶伦", "苏巴",
  "奥贝尔", "图尔巴斯", "米亚尔", "塔玛", "阿姆达", "索巴塞克", "哈克农",
]

const SHIPS = [
  "乌鸦级", "万王宝座级", "多米尼克斯级", "龙卷风级", "狂暴级", "恶狼级",
  "猎犬级", "短剑级", "冥府级", "使徒级", "弥米尔级", "巨像级", "地狱天使级",
  "弯刀级", "纳迦法级",
]

const FACTIONS: Faction[] = ["加达里", "米玛塔尔", "艾玛", "盖伦特"]

const ROLES: Account["role"][] = ["管理员", "军团指挥", "玩家", "玩家", "玩家", "观察者"]

const NOTES = [
  "",
  "内测老账号",
  "长期挂机采矿",
  "军团仓库管理员",
  "误伤队友，观察中",
  "试用账号，月底到期",
]

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]
}

function buildAccounts(): Account[] {
  const rnd = lcg(20260919)
  const now = Date.now()
  const accounts: Account[] = []

  for (let i = 0; i < 47; i += 1) {
    const character = CHARACTERS[i % CHARACTERS.length]
    const online = i < 12
    const banned = i === 41 || i === 45
    const security = Number((rnd() * 11 - 5.5).toFixed(1))

    accounts.push({
      id: `acc-${String(i + 1).padStart(3, "0")}`,
      username: `pilot${String(i + 1).padStart(3, "0")}`,
      character,
      corp: pick(rnd, CORPS),
      faction: FACTIONS[i % FACTIONS.length],
      role: i === 0 ? "管理员" : pick(rnd, ROLES),
      isk: Math.floor(rnd() * 4.8e10) + 2e6,
      skillPoints: Math.floor(rnd() * 1.1e8) + 8e5,
      securityStatus: security,
      status: banned ? "banned" : online ? "online" : "offline",
      shipName: pick(rnd, SHIPS),
      solarSystem: pick(rnd, SYSTEMS),
      playtimeHours: Math.floor(rnd() * 2400) + 3,
      lastSeen: banned
        ? now - (12 + Math.floor(rnd() * 40)) * 86400000
        : online
          ? now - Math.floor(rnd() * 90) * 1000
          : now - Math.floor(rnd() * 30) * 3600000,
      createdAt: now - (30 + Math.floor(rnd() * 700)) * 86400000,
      note: pick(rnd, NOTES),
    })
  }

  return accounts
}

function buildBackups(): Backup[] {
  const rnd = lcg(77003)
  const now = Date.now()
  const kinds: Backup["kind"][] = ["自动", "自动", "手动", "启动前"]
  const labels = [
    "开服前基线", "大规模会战前", "经济调整前", "模组更新前", "周常自动存档",
    "补丁回滚点", "玩家反馈异常时", "版本升级前",
  ]

  return Array.from({ length: 9 }, (_, i) => ({
    id: `bk-${String(9 - i).padStart(3, "0")}`,
    label: labels[i % labels.length],
    createdAt: now - i * (7 + Math.floor(rnd() * 20)) * 3600000,
    sizeMb: Math.floor(rnd() * 900) + 320,
    kind: i === 0 ? "手动" : kinds[i % kinds.length],
    version: `v14.${22 - Math.floor(i / 3)}`,
    note: i === 0 ? "回滚点，确认经济参数稳定后可删除" : "",
    playersAt: Math.floor(rnd() * 34),
  }))
}

function buildMods(): ModEntry[] {
  const now = 0
  void now
  return [
    {
      id: "mod-gate",
      name: "星门加速",
      author: "DeepSpaceWorks",
      version: "2.4.1",
      category: "玩法",
      enabled: true,
      order: 10,
      sizeMb: 18,
      desc: "星门跳跃动画缩短 60%，跨星系移动不再等到打瞌睡。",
      conflicts: [],
    },
    {
      id: "mod-market",
      name: "市场深度扩展",
      author: "JitaTrader",
      version: "1.9.0",
      category: "经济",
      enabled: true,
      order: 20,
      sizeMb: 42,
      desc: "为每个空间站补充历史成交曲线与深度图，NPC 挂单更拟真。",
      conflicts: ["mod-market-lite"],
    },
    {
      id: "mod-market-lite",
      name: "市场精简版",
      author: "JitaTrader",
      version: "1.2.3",
      category: "经济",
      enabled: false,
      order: 21,
      sizeMb: 12,
      desc: "只保留基础订单簿，低配机器友好。与市场深度扩展互斥。",
      conflicts: ["mod-market"],
    },
    {
      id: "mod-npc-ai",
      name: "势力 AI 强化",
      author: "BloodRaiderLab",
      version: "3.0.2",
      category: "AI",
      enabled: true,
      order: 30,
      sizeMb: 96,
      desc: "NPC 舰队会编队、包夹与撤退，海盗不再排队送人头。",
      conflicts: [],
    },
    {
      id: "mod-graphics",
      name: "舰船模型高清包",
      author: "NovaAssets",
      version: "5.1.0",
      category: "画面",
      enabled: false,
      order: 40,
      sizeMb: 1840,
      desc: "重制 42 艘主力舰的贴图与法线，纯客户端资源，服务端无感。",
      conflicts: [],
    },
    {
      id: "mod-logger",
      name: "战斗日志分析",
      author: "KillmailCN",
      version: "0.9.7",
      category: "工具",
      enabled: true,
      order: 50,
      sizeMb: 8,
      desc: "把每次击毁记录成结构化日志，方便回看谁打爆了谁。",
      conflicts: [],
    },
    {
      id: "mod-hardcore",
      name: "永久损失规则",
      author: "IronAnvil",
      version: "1.0.4",
      category: "玩法",
      enabled: false,
      order: 60,
      sizeMb: 24,
      desc: "舱体被击毁后角色资产清零，硬核玩家专属。",
      conflicts: [],
    },
  ]
}

/* ------------------------------------------------------------------ *
 * 模组市场：本地索引，隔离环境里不联网。安装后才会写进模组清单。
 * 已收录的条目里，有 7 条与本地已装模组同 id，用来演示「已安装 / 可更新」。
 * ------------------------------------------------------------------ */
function buildMarket(): MarketMod[] {
  const now = Date.now()
  const day = 86400000
  const ago = (days: number) => now - days * day

  return [
    {
      id: "mod-wh-space",
      name: "虫洞空间扩展",
      author: "SigilWorks",
      version: "3.2.0",
      category: "玩法",
      sizeMb: 260,
      desc: "补全 2600 个虫洞星系，含随机极性、质量衰减与塌缩预警。",
      readme: [
        "原版世界只有零星几个虫洞入口，跑久了很快就会摸清全部出口。这个模组按真实虫洞机制重建了整张虫洞网络：每个入口都有独立的极性、剩余质量与寿命，跳跃会消耗质量，质量见底时洞口会剧烈闪烁并塌缩。",
        "星系内的异常点也一并补齐，包括冬眠者遗迹、气云站与打捞残骸，掉落表按虫洞等级分档。所有随机数都走服务端种子，重启后世界形态保持一致，不会出现「刷新一次换个洞」的情况。",
      ],
      highlights: [
        "2600 个虫洞星系，随机极性 + 质量衰减",
        "塌缩前 5 分钟在本地频道广播预警",
        "冬眠者遗迹与气云站按等级分档掉落",
        "随机种子持久化，重启不换洞",
      ],
      conflicts: [],
      tags: ["PVE", "探索", "高安外"],
      downloads: 184320,
      rating: 4.7,
      ratingCount: 2140,
      reviews: [
        {
          author: "深渊常客",
          stars: 5,
          text: "塌缩预警救了我至少三条船。以前进洞全靠掐表，现在本地频道直接喊，安全感完全不一样。",
          at: ago(3),
        },
        {
          author: "Sigil 老用户",
          stars: 4,
          text: "3.0 之后洞口极性真的随机了，跑了一周没碰到重复的洞。扣一分是因为高等级洞的遗迹刷新还是偏少。",
          at: ago(38),
        },
        {
          author: "独狼矿工",
          stars: 5,
          text: "气云站的产出很稳，一个人也能在里面待很久。随机种子持久化这点太关键了，重启不换洞才是正经世界。",
          at: ago(70),
        },
      ],
      updatedAt: ago(4),
      featured: true,
      requiresRestart: true,
      history: [
        {
          version: "3.0.0",
          changelog: "重写虫洞生成算法，洞口极性不再固定，质量衰减按星系等级分档。",
          at: ago(96),
        },
        {
          version: "3.1.2",
          changelog: "修了塌缩预警偶尔不广播的问题；冬眠者遗迹掉落表补齐到 12 档。",
          at: ago(41),
        },
        {
          version: "3.2.0",
          changelog: "新增 340 个高等级虫洞，气云站按等级刷新；随机种子改为持久化，重启不换洞。",
          at: ago(4),
        },
      ],
    },
    {
      id: "mod-industry-overhaul",
      name: "工业重制",
      author: "ForgeMaster",
      version: "4.0.1",
      category: "经济",
      sizeMb: 148,
      desc: "重做蓝图材料树与制造槽位，加入并行产线与发明成功率曲线。",
      readme: [
        "把原版那套「一张蓝图对应一组材料」的线性结构整个换掉，改成带中间产物的多层材料树。造一艘战列舰不再是一步到位，而是要先把装甲板、反应堆、推进器分别造出来再总装。",
        "制造槽位支持并行排产，每个槽位独立计时。发明成功率改成一条随技能等级平滑上升的曲线，不再是非成即败的硬判定。",
      ],
      highlights: [
        "多层材料树，含中间产物与副产物",
        "并行产线，槽位独立计时",
        "发明成功率改为连续曲线",
        "与「行星开发重制」互斥，两者都会改写工业管线",
      ],
      conflicts: ["mod-pi-overhaul"],
      tags: ["工业", "制造", "经济"],
      downloads: 96750,
      rating: 4.5,
      ratingCount: 1180,
      updatedAt: ago(9),
      featured: true,
      requiresRestart: true,
      history: [
        {
          version: "3.2.0",
          changelog: "材料树铺到三级中间产物，副产物不再直接销毁。",
          at: ago(150),
        },
        {
          version: "3.5.4",
          changelog: "并行产线槽位独立计时；发明成功率改成随技能平滑上升的曲线。",
          at: ago(72),
        },
        {
          version: "4.0.1",
          changelog: "总装流程重做，战列舰要先造装甲板、反应堆与推进器；与「行星开发重制」明确互斥。",
          at: ago(9),
        },
      ],
    },
    {
      id: "mod-market",
      name: "市场深度扩展",
      author: "JitaTrader",
      version: "2.0.0",
      category: "经济",
      sizeMb: 44,
      desc: "为每个空间站补充历史成交曲线与深度图，NPC 挂单更拟真。",
      readme: [
        "原版市场的 NPC 挂单是固定档位，价格几乎不动。这个模组给每个空间站维护一份独立的订单簿，NPC 会依据库存、区域供需与运输成本动态调整买卖价，跨星域搬运货物第一次真的有利可图。",
        "同时补上历史成交曲线，本地市场面板可以直接看到 7 日与 30 日走势。2.0 起订单簿改为增量快照，冷启动时不再全量重建，启动时间缩短约 40%。",
      ],
      highlights: [
        "每站独立订单簿，价格随供需浮动",
        "7 日 / 30 日历史成交曲线",
        "2.0 起增量快照，冷启动更快",
        "与「市场精简版」互斥",
      ],
      conflicts: ["mod-market-lite"],
      tags: ["市场", "交易", "经济"],
      downloads: 231480,
      rating: 4.8,
      ratingCount: 3620,
      reviews: [
        {
          author: "搬运工小陈",
          stars: 5,
          text: "跨星域倒货终于有得算了。7 日曲线一开，什么时候进货、什么时候抛一目了然。",
          at: ago(2),
        },
        {
          author: "Jita 常客",
          stars: 4,
          text: "价格浮动真实多了，就是刚上 1.7 那会儿订单簿刷新会顿一下，2.0 增量快照之后基本感觉不到了。",
          at: ago(21),
        },
        {
          author: "独狼矿工",
          stars: 5,
          text: "以前 NPC 挂单是死的，现在靠信息差真能赚到钱。经济玩法总算立起来了。",
          at: ago(55),
        },
      ],
      updatedAt: ago(2),
      featured: true,
      requiresRestart: true,
      history: [
        {
          version: "1.7.0",
          changelog: "每站独立订单簿上线，NPC 挂单开始随库存与区域供需浮动。",
          at: ago(180),
        },
        {
          version: "1.9.0",
          changelog: "补上 7 日 / 30 日历史成交曲线，本地市场面板可直接查看。",
          at: ago(60),
        },
        {
          version: "2.0.0",
          changelog: "订单簿改为增量快照，冷启动不再全量重建，启动时间缩短约 40%。",
          at: ago(2),
        },
      ],
    },
    {
      id: "mod-npc-ai",
      name: "势力 AI 强化",
      author: "BloodRaiderLab",
      version: "3.1.0",
      category: "AI",
      sizeMb: 102,
      desc: "NPC 舰队会编队、包夹与撤退，海盗不再排队送人头。",
      readme: [
        "给 NPC 舰队加了一层战术决策：接战前会评估双方吨位与后勤，劣势时分散撤退而不是硬顶；优势时会分兵包夹，优先打掉落单目标。",
        "3.1 新增对电子战与后勤舰的识别，NPC 会优先点掉你的摇修船。难度整体上调，建议配合「永久损失规则」以外的配置使用。",
      ],
      highlights: [
        "编队、包夹、劣势撤退",
        "识别后勤与电子战目标并优先处理",
        "难度随星域安等平滑上升",
        "与「AI 守序者」互斥",
      ],
      conflicts: ["mod-ai-warden"],
      tags: ["PVE", "AI", "难度"],
      downloads: 143200,
      rating: 4.6,
      ratingCount: 2410,
      reviews: [
        {
          author: "高安刷子",
          stars: 4,
          text: "终于不用挨个点死人了。劣势会散开跑这点做得很好，但有时候散得太干脆，追都追不上。",
          at: ago(5),
        },
        {
          author: "后勤船长",
          stars: 5,
          text: "3.1 之后 NPC 会优先点摇修船，我们队被迫开始学走位了。这才是像样的对手。",
          at: ago(44),
        },
      ],
      updatedAt: ago(6),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-abyssal",
      name: "深渊副本",
      author: "TriglavianFan",
      version: "3.5.1",
      category: "玩法",
      sizeMb: 320,
      desc: "三界深渊裂隙与限时生存玩法，含深渊专属掉落与词条。",
      readme: [
        "把深渊裂隙做成可以反复刷的副本：三层难度、随机环境词条（电磁风暴、质量过载、黑暗），每层限时三分钟，超时即判定失败并踢出。",
        "深渊掉落独立成表，出产的突变质体可以在本地市场自由定价，是后期主要的收入来源之一。",
      ],
      highlights: [
        "三层难度 + 随机环境词条",
        "限时生存，超时判定失败",
        "深渊专属掉落与突变质体",
        "词条组合每日轮换",
      ],
      conflicts: [],
      tags: ["PVE", "副本", "高难"],
      downloads: 78410,
      rating: 4.3,
      ratingCount: 890,
      updatedAt: ago(14),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-sov-warfare",
      name: "主权战争",
      author: "NullSecUnion",
      version: "1.6.2",
      category: "玩法",
      sizeMb: 210,
      desc: "完整的主权宣称、基础设施与联盟领土战流程。",
      readme: [
        "补齐 0.0 地区的主权玩法：宣称节点、争夺窗口、基础设施中心升级与主权等级加成，全部按正式流程实现。",
        "联盟之间的争夺有独立的战况面板，可以在指挥台看到当前所有进行中的主权战与剩余窗口时间。",
      ],
      highlights: [
        "主权宣称与争夺窗口",
        "基础设施中心分级升级",
        "主权等级带来采矿与制造加成",
        "战况面板汇总进行中的争夺",
      ],
      conflicts: [],
      tags: ["PVP", "0.0", "联盟"],
      downloads: 54200,
      rating: 4.2,
      ratingCount: 610,
      updatedAt: ago(21),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-fleet-doctrine",
      name: "舰队编成助手",
      author: "FC_Toolsmith",
      version: "2.1.5",
      category: "工具",
      sizeMb: 34,
      desc: "按吨位与角色一键组队，自动校验技能与装备缺口。",
      readme: [
        "把常用的舰队编成存成模板，组队时一键拉人：助手会检查每个成员是否有对应舰船、技能是否达标、装备是否齐全，缺什么直接列出来。",
        "支持按角色（指挥 / 后勤 / 电子战 / 输出）自动分配位置，编成不满时给出替补建议。",
      ],
      highlights: [
        "编成模板一键组队",
        "技能与装备缺口校验",
        "按角色自动分配位置",
        "缺人时给出替补建议",
      ],
      conflicts: [],
      tags: ["工具", "舰队", "协作"],
      downloads: 41800,
      rating: 4.4,
      ratingCount: 470,
      updatedAt: ago(11),
      featured: false,
      requiresRestart: false,
    },
    {
      id: "mod-graphics",
      name: "舰船模型高清包",
      author: "NovaAssets",
      version: "5.1.0",
      category: "画面",
      sizeMb: 1840,
      desc: "重制 42 艘主力舰的贴图与法线，纯客户端资源，服务端无感。",
      readme: [
        "重制了 42 艘主力舰的外壳贴图与法线，统一了各势力舰船的材质风格，并补上了长期缺失的细节贴花。",
        "纯客户端资源，服务端不加载任何内容，因此不占服务端内存，也不影响 tick 耗时。装完只需重启客户端。",
      ],
      highlights: [
        "42 艘主力舰贴图重制",
        "统一势力材质风格",
        "纯客户端资源，服务端零开销",
        "与「星云天空盒」互斥",
      ],
      conflicts: ["mod-nebula-sky"],
      tags: ["画面", "客户端", "贴图"],
      downloads: 312400,
      rating: 4.9,
      ratingCount: 5120,
      reviews: [
        {
          author: "截图党",
          stars: 5,
          text: "开进去第一眼就愣住了，船身上的焊点都能看清。装完帧数掉得不多，优化比想象中好。",
          at: ago(12),
        },
        {
          author: "老显卡",
          stars: 4,
          text: "效果没得说，就是显存吃紧，4G 卡开高配得悠着点。",
          at: ago(33),
        },
      ],
      updatedAt: ago(30),
      featured: true,
      requiresRestart: false,
    },
    {
      id: "mod-nebula-sky",
      name: "星云天空盒",
      author: "NovaAssets",
      version: "2.2.0",
      category: "画面",
      sizeMb: 760,
      desc: "重绘 120 个星系的背景星云，含体积光与动态尘埃。",
      readme: [
        "为 120 个主要星系重新绘制了背景星云，加入体积光散射与缓慢流动的尘埃层，跃迁出站时的观感提升明显。",
        "会覆盖舰船高清包使用的部分天空盒资源，两者同时启用会出现资源争用。",
      ],
      highlights: [
        "120 个星系背景重绘",
        "体积光 + 动态尘埃",
        "支持按安等切换色调",
        "与「舰船模型高清包」互斥",
      ],
      conflicts: ["mod-graphics"],
      tags: ["画面", "客户端", "天空盒"],
      downloads: 87400,
      rating: 4.6,
      ratingCount: 1120,
      updatedAt: ago(17),
      featured: false,
      requiresRestart: false,
    },
    {
      id: "mod-logger",
      name: "战斗日志分析",
      author: "KillmailCN",
      version: "1.0.0",
      category: "工具",
      sizeMb: 9,
      desc: "把每次击毁记录成结构化日志，方便回看谁打爆了谁。",
      readme: [
        "监听战斗结算事件，把每次击毁写成本地结构化日志：时间、星系、双方舰船与装备、伤害构成、参与人数一应俱全。",
        "1.0 起支持按角色与军团聚合，月度战报可以直接导出 CSV 交给军团管理层。",
      ],
      highlights: [
        "击毁记录结构化落盘",
        "伤害构成与参与人数统计",
        "按角色 / 军团聚合",
        "战报导出 CSV",
      ],
      conflicts: [],
      tags: ["工具", "日志", "统计"],
      downloads: 62900,
      rating: 4.5,
      ratingCount: 730,
      updatedAt: ago(1),
      featured: false,
      requiresRestart: false,
    },
    {
      id: "mod-gate",
      name: "星门加速",
      author: "DeepSpaceWorks",
      version: "2.5.0",
      category: "玩法",
      sizeMb: 19,
      desc: "星门跳跃动画缩短 60%，跨星系移动不再等到打瞌睡。",
      readme: [
        "把星门跳跃的过场时间从 12 秒压到 5 秒以内，跨星域长途移动的体感提升非常直接。",
        "2.5 起跳跃冷却与动画时长解耦，缩短动画不会再顺带削掉冷却保护时间，被蹲门时依然有反应窗口。",
      ],
      highlights: [
        "跳跃动画缩短 60%",
        "动画时长与冷却解耦",
        "支持按星域单独配置",
        "对服务端负载无影响",
      ],
      conflicts: [],
      tags: ["体验", "移动"],
      downloads: 268900,
      rating: 4.8,
      ratingCount: 4310,
      updatedAt: ago(5),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-market-lite",
      name: "市场精简版",
      author: "JitaTrader",
      version: "1.2.3",
      category: "经济",
      sizeMb: 12,
      desc: "只保留基础订单簿，低配机器友好。与市场深度扩展互斥。",
      readme: [
        "如果机器内存吃紧，又不想放弃动态定价，这个版本是折中方案：保留订单簿与基础浮动，去掉历史曲线与深度图。",
        "内存占用约为完整版的四分之一，tick 耗时增加可以忽略。",
      ],
      highlights: [
        "保留订单簿与基础价格浮动",
        "去掉历史曲线与深度图",
        "内存占用约为完整版 1/4",
        "与「市场深度扩展」互斥",
      ],
      conflicts: ["mod-market"],
      tags: ["市场", "轻量", "低配"],
      downloads: 45200,
      rating: 4.1,
      ratingCount: 380,
      updatedAt: ago(45),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-ai-warden",
      name: "AI 守序者",
      author: "ConcordLabs",
      version: "1.3.0",
      category: "AI",
      sizeMb: 54,
      desc: "服务端内置的秩序守卫，自动识别并处理违规行为。",
      readme: [
        "常驻在服务端的秩序守卫：识别异常收益曲线、异常移动速度与重复刷单行为，达到阈值时自动记录并推送告警。",
        "默认只告警不处罚，可以在配置里把处置动作改成临时禁言或直接封禁。所有判定都会写进日志中心，可随时申诉复核。",
      ],
      highlights: [
        "异常收益 / 移速 / 刷单识别",
        "默认只告警，处置动作可配置",
        "判定全程留痕，支持复核",
        "与「势力 AI 强化」互斥",
      ],
      conflicts: ["mod-npc-ai"],
      tags: ["AI", "风控", "管理"],
      downloads: 29800,
      rating: 4.0,
      ratingCount: 240,
      updatedAt: ago(8),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-loot-balance",
      name: "掉落平衡",
      author: "EconNerds",
      version: "2.0.3",
      category: "经济",
      sizeMb: 16,
      desc: "按安等与舰船吨位重排掉落表，抑制高安刷钱收益。",
      readme: [
        "重排了全星域的掉落表：高安异常点的 ISK 收益下调，低安与 0.0 上调，让冒险去危险星域重新变得划算。",
        "掉落改为按舰船吨位加权，打大船出好货的概率显著提高，刷小船刷不出暴富。",
      ],
      highlights: [
        "高安收益下调，0.0 上调",
        "掉落按吨位加权",
        "全星系经济数据可在指挥台观察",
        "改数值不改机制，随时可关",
      ],
      conflicts: [],
      tags: ["经济", "平衡", "掉落"],
      downloads: 51600,
      rating: 4.2,
      ratingCount: 520,
      updatedAt: ago(12),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-pi-overhaul",
      name: "行星开发重制",
      author: "ForgeMaster",
      version: "1.4.0",
      category: "经济",
      sizeMb: 88,
      desc: "重做行星开采链路，加入殖民地物流与产量衰减模型。",
      readme: [
        "把行星开发从「点几下收菜」改成一条完整链路：采集 → 加工 → 转运 → 总装，每个环节都有独立的产能与仓储上限。",
        "殖民地会随开采时长出现产量衰减，需要轮换开采点，长期挂机收益不再是线性的。",
      ],
      highlights: [
        "采集 / 加工 / 转运全链路",
        "殖民地仓储与产能上限",
        "产量随开采时长衰减",
        "与「工业重制」互斥",
      ],
      conflicts: ["mod-industry-overhaul"],
      tags: ["工业", "行星", "经济"],
      downloads: 38700,
      rating: 4.1,
      ratingCount: 330,
      updatedAt: ago(19),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-hardcore",
      name: "永久损失规则",
      author: "IronAnvil",
      version: "1.0.4",
      category: "玩法",
      sizeMb: 24,
      desc: "舱体被击毁后角色资产清零，硬核玩家专属。",
      readme: [
        "把原版的「爆船只掉船」改成「爆舱清空资产」：逃生舱被击毁后，角色的 ISK、物资与植入体全部归零，只保留技能点。",
        "建议只在自己的私人服上开启，或者配合一份高频自动快照使用。",
      ],
      highlights: [
        "爆舱清空 ISK 与物资",
        "技能点保留，不会回到起点",
        "开启前会二次确认",
        "建议配合高频自动快照",
      ],
      conflicts: [],
      tags: ["硬核", "PVP", "风险"],
      downloads: 22400,
      rating: 3.9,
      ratingCount: 410,
      updatedAt: ago(60),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-observatory",
      name: "观测站面板",
      author: "StarGazer",
      version: "1.1.0",
      category: "工具",
      sizeMb: 12,
      desc: "给指挥台加一块全星域实时观测面板，异常点一目了然。",
      readme: [
        "在指挥台右侧挂一块观测面板，实时汇总全星域的异常点、入侵与资源点，按安等与距离排序。",
        "可以按星域订阅，只关心自己活动范围内的动静，避免被全局信息淹没。",
      ],
      highlights: [
        "全星域异常点实时汇总",
        "按安等 / 距离排序",
        "支持按星域订阅",
        "面板可折叠，不占主视野",
      ],
      conflicts: [],
      tags: ["工具", "监控", "面板"],
      downloads: 34200,
      rating: 4.3,
      ratingCount: 290,
      updatedAt: ago(7),
      featured: false,
      requiresRestart: false,
    },
    {
      id: "mod-newbro",
      name: "新手保护期",
      author: "KindWolves",
      version: "1.0.2",
      category: "玩法",
      sizeMb: 9,
      desc: "新角色前 30 天免疫玩家攻击，并附带引导任务链。",
      readme: [
        "给新角色 30 天的保护期，期间无法被其他玩家锁定，但也不能主动攻击别人，避免用小号当盾。",
        "附带一条引导任务链，从第一次出站到第一次会战逐级发放奖励，帮助新人渡过最容易流失的阶段。",
      ],
      highlights: [
        "前 30 天免遭玩家攻击",
        "保护期内不可主动攻击",
        "分级引导任务链",
        "保护期时长可配置",
      ],
      conflicts: [],
      tags: ["新手", "保护", "引导"],
      downloads: 27600,
      rating: 4.4,
      ratingCount: 350,
      updatedAt: ago(23),
      featured: false,
      requiresRestart: true,
    },
    {
      id: "mod-voice-chat",
      name: "舰队语音",
      author: "CommsGuru",
      version: "0.8.4",
      category: "工具",
      sizeMb: 62,
      desc: "舰队内置语音频道，按编队自动分房，无需外部工具。",
      readme: [
        "在舰队里直接开语音，按编队自动分房：指挥官频道、后勤频道、小队频道互不干扰，进出舰队自动同步。",
        "仍是 0.x 版本，音质与回声消除还在打磨，人多的时候偶有杂音，介意的话建议先观望。",
      ],
      highlights: [
        "按编队自动分房",
        "进出舰队自动同步",
        "纯客户端，服务端不转发音频",
        "0.x 版本，音质仍在打磨",
      ],
      conflicts: [],
      tags: ["工具", "语音", "协作"],
      downloads: 19800,
      rating: 3.6,
      ratingCount: 210,
      updatedAt: ago(3),
      featured: false,
      requiresRestart: false,
    },
  ]
}

export const SEED_ACCOUNTS: Account[] = buildAccounts()
export const SEED_BACKUPS: Backup[] = buildBackups()
export const SEED_MODS: ModEntry[] = buildMods()
export const SEED_MARKET: MarketMod[] = buildMarket()

/** 新建账号时用到的候选池，导出给对话框做下拉。 */
export const CHARACTER_POOL = CHARACTERS
export const CORP_POOL = CORPS
export const SYSTEM_POOL = SYSTEMS
export const SHIP_POOL = SHIPS
