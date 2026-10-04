/**
 * 静态数据表的「人话」名字与分类。
 *
 * 服务端把表名写成了英文 ID（`solarSystems` / `stargates`），启动器里只丢 ID 出来
 * 用户分不清哪个是星系、哪个是星门，所以这里补一层中文名 + 分类。
 *
 * 名字走 `t()` 翻（键就是这里的中文，7 种外文目录里都有条目）；
 * 表 ID 本身照旧原样显示 —— 它就是 `_local/gameStore/data/<ID>/data.json` 的目录名。
 */

/** 表分类：只影响界面分组与标签，不代表任何服务端行为 */
export type StaticTableCategory =
  | "geography"
  | "ships"
  | "skills"
  | "industry"
  | "npc"
  | "content"
  | "character"
  | "market"

/** 分类标签（中文即 `t()` 的键） */
export const CATEGORY_LABEL: Record<StaticTableCategory, string> = {
  geography: "星系地理",
  ships: "舰船与装备",
  skills: "技能",
  industry: "工业与行星",
  npc: "NPC 与战斗",
  content: "任务与玩法",
  character: "角色创建",
  market: "市场与资产",
}

interface TableMeta {
  zh: string
  category: StaticTableCategory
}

const TABLES: Record<string, TableMeta> = {
  celestials: { zh: "天体", category: "geography" },
  solarSystems: { zh: "星系", category: "geography" },
  stargates: { zh: "星门", category: "geography" },
  stargateTypes: { zh: "星门类型", category: "geography" },
  stations: { zh: "空间站", category: "geography" },
  stationTypes: { zh: "空间站类型", category: "geography" },
  stationDockingPlacements: { zh: "空间站停靠位", category: "geography" },
  stationGraphicLocators: { zh: "空间站炮位", category: "geography" },
  stationStandingsRestrictions: { zh: "空间站声望限制", category: "geography" },
  asteroidBelts: { zh: "小行星带", category: "geography" },
  asteroidFieldStyles: { zh: "小行星带外观", category: "geography" },
  asteroidTypesBySolarSystemID: { zh: "星系矿石分布", category: "geography" },
  moonMiningPoints: { zh: "月球采矿点", category: "geography" },
  stargateVisualOverrides: { zh: "星门外观覆盖", category: "geography" },
  mapTagsAuthority: { zh: "星图标签", category: "geography" },

  itemTypes: { zh: "物品类型", category: "ships" },
  typeDogma: { zh: "物品属性 dogma", category: "ships" },
  dynamicItemAttributes: { zh: "动态物品属性", category: "ships" },
  shipTypes: { zh: "舰船型号", category: "ships" },
  shipDogmaAttributes: { zh: "舰船属性", category: "ships" },
  shipCosmeticsCatalog: { zh: "舰船涂装目录", category: "ships" },
  shipInsurancePrices: { zh: "舰船保险费", category: "ships" },
  movementAttributes: { zh: "移动属性", category: "ships" },
  itemIcons: { zh: "物品图标", category: "ships" },
  clientTypeLists: { zh: "客户端分类列表", category: "ships" },
  dbuffCollections: { zh: "减益集合", category: "ships" },
  fighterAbilities: { zh: "铁骑舰载机技能", category: "ships" },
  structureTypes: { zh: "建筑类型", category: "ships" },
  structureGraphicLocators: { zh: "建筑炮位", category: "ships" },

  skillTypes: { zh: "技能表", category: "skills" },
  skillTrainingAlphaCaps: { zh: "阿尔法技能训练上限", category: "skills" },
  expertSystems: { zh: "专家系统", category: "skills" },

  industryBlueprints: { zh: "工业蓝图", category: "industry" },
  industryFacilities: { zh: "工业设施", category: "industry" },
  reprocessingStatic: { zh: "精炼静态数据", category: "industry" },
  reprocessingClientRandomizedMaterials: { zh: "客户端精炼产出", category: "industry" },
  planetSchematics: { zh: "行星交互蓝图", category: "industry" },

  npcProfiles: { zh: "NPC 档案", category: "npc" },
  npcBehaviorProfiles: { zh: "NPC 行为档案", category: "npc" },
  npcLoadouts: { zh: "NPC 装配", category: "npc" },
  npcSpawnPools: { zh: "NPC 生成池", category: "npc" },
  npcSpawnGroups: { zh: "NPC 生成组", category: "npc" },
  npcLootTables: { zh: "NPC 掉落表", category: "npc" },
  npcStartupRules: { zh: "NPC 初始规则", category: "npc" },
  npcHostileUtilities: { zh: "NPC 敌对工具", category: "npc" },
  npcStandingsAuthority: { zh: "NPC 声望权威数据", category: "npc" },
  capitalNpcAuthority: { zh: "旗舰 NPC 权威数据", category: "npc" },
  trigDrifterSpawnAuthority: { zh: "三神裔生成规则", category: "npc" },

  agentAuthority: { zh: "代理人权威数据", category: "content" },
  missionAuthority: { zh: "任务权威数据", category: "content" },
  dungeonAuthority: { zh: "副本规则", category: "content" },
  dungeonClientContent: { zh: "副本客户端内容", category: "content" },
  explorationAuthority: { zh: "探索权威数据", category: "content" },
  explorationWormholeStatic: { zh: "虫洞静态数据", category: "content" },
  sovereigntyStatic: { zh: "主权静态数据", category: "content" },
  researchFieldAuthority: { zh: "研究领域权威数据", category: "content" },
  clientEntityStandings: { zh: "客户端声望表", category: "content" },
  factions: { zh: "势力", category: "content" },

  characterCreationRaces: { zh: "创建角色·种族", category: "character" },
  characterCreationBloodlines: { zh: "创建角色·血脉", category: "character" },
  characterCreationSchools: { zh: "创建角色·学院", category: "character" },
  starterShipFittings: { zh: "新手船装配", category: "character" },

  evermarksCatalog: { zh: "永恒印记目录", category: "market" },
  elysianItems: { zh: "极乐物品", category: "market" },
}

/**
 * 一张表的中文名。认出 ID 就给名字，认不出（服务端换了版本、加了新表）就返回 null，
 * 界面退回显示原始 ID —— 宁可不翻译，也不编一个名字。
 */
export function tableNameZh(id: string): string | null {
  return TABLES[id]?.zh ?? null
}

export function tableCategory(id: string): StaticTableCategory | null {
  return TABLES[id]?.category ?? null
}

/** 分类的顺序就是界面里的排列顺序 */
export const CATEGORY_ORDER: StaticTableCategory[] = [
  "geography",
  "ships",
  "skills",
  "industry",
  "npc",
  "content",
  "character",
  "market",
]