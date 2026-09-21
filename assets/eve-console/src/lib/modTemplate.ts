/**
 * 新建模组时可选的骨架模板。模板决定预置的分类、体积、重启要求，
 * 以及「将生成」清单里列出的文件。
 */
export interface ModTemplate {
  id: string
  name: string
  desc: string
  category: string
  sizeMb: number
  requiresRestart: boolean
  /** 骨架文件，只作展示，让用户知道建出来长什么样。 */
  files: string[]
  /** 预填的功能要点，帮用户先把说明写起来。 */
  highlights: string[]
  /** 预填到详细介绍里的一段说明。 */
  readme: string
}

export const MOD_TEMPLATES: ModTemplate[] = [
  {
    id: "blank",
    name: "空白模组",
    desc: "只有清单和一个入口文件，适合从零写起",
    category: "玩法",
    sizeMb: 2,
    requiresRestart: true,
    files: ["manifest.json", "README.md", "src/main.lua", "src/config.lua"],
    highlights: [],
    readme: "空白模组骨架，所有逻辑都写在 src/main.lua 的 onLoad 里。",
  },
  {
    id: "gameplay",
    name: "玩法调整",
    desc: "预置规则钩子，改数值、加机制都从这里下手",
    category: "玩法",
    sizeMb: 6,
    requiresRestart: true,
    files: ["manifest.json", "README.md", "src/rules.lua", "src/hooks.lua", "config/balance.toml"],
    highlights: [
      "预置伤害、掉落与声望三组钩子",
      "数值集中在 config/balance.toml，改完不用碰逻辑",
      "与市场深度扩展共存时建议调整加载顺序",
    ],
    readme:
      "玩法调整模板预置了伤害、掉落与声望三组钩子，改数值不用动逻辑代码。\n\n钩子按加载顺序依次生效，排在后面的会覆盖前面的结果。",
  },
  {
    id: "panel",
    name: "界面面板",
    desc: "自带可停靠的侧边面板，适合做统计与监控工具",
    category: "工具",
    sizeMb: 4,
    requiresRestart: false,
    files: [
      "manifest.json",
      "README.md",
      "ui/panel.html",
      "ui/panel.css",
      "ui/panel.js",
      "src/api.lua",
    ],
    highlights: ["自带可停靠的侧边面板", "前后端通过 src/api.lua 通信", "纯客户端资源，免重启"],
    readme:
      "界面面板模板自带一个可停靠的侧边面板，适合做统计、监控一类的工具。\n\n面板通过 src/api.lua 暴露的接口读取服务端数据，不需要改内核。",
  },
  {
    id: "visual",
    name: "画面资源",
    desc: "替换贴图、天空盒与着色器，只动客户端",
    category: "画面",
    sizeMb: 180,
    requiresRestart: false,
    files: ["manifest.json", "README.md", "assets/textures/", "assets/shaders/", "assets/skybox/"],
    highlights: ["按目录覆盖原版资源", "不影响服务端逻辑", "纯客户端资源，免重启"],
    readme:
      "画面资源模板按目录覆盖原版贴图与着色器，不会影响服务端逻辑。\n\n同名文件直接覆盖，删掉模组即可还原。",
  },
]

/**
 * 从模组名推一个稳定的 id。中文名推不出拉丁字符时返回空串，
 * 由引擎补时间戳兜底；表单里则显示占位，让用户知道会拿到什么。
 */
export function slugifyModId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
}
