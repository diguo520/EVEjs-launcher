import { describe, expect, it } from "vitest"

import de from "@/locales/de.json"
import en from "@/locales/en.json"
import fr from "@/locales/fr.json"
import ja from "@/locales/ja.json"
import ko from "@/locales/ko.json"
import nl from "@/locales/nl.json"
import ru from "@/locales/ru.json"
import { COUNTRY_FLAG_CODES, countryFlagUrl } from "@/lib/flags.generated"
import {
  FALLBACK_LOCALE,
  LOCALES,
  catalogSize,
  countryName,
  detectLocale,
  hasEntry,
  localeName,
  matchLocale,
  resolveLocale,
  translate,
  translateInline,
} from "@/lib/i18n"

/**
 * 多语言口径与老 Electron 启动器一致（语言集合、系统语言兜底英文、共用存储键），
 * 这几条是那次对齐里最容易回归的部分。
 */
describe("i18n", () => {
  it("语言集合与老启动器一致：中文 + 7 种外文", () => {
    expect(LOCALES.map((item) => item.code)).toEqual([
      "zh",
      "en",
      "ja",
      "ko",
      "fr",
      "de",
      "nl",
      "ru",
    ])
  })

  it("语言标签只按主语言匹配，带地区码也算同一种", () => {
    expect(matchLocale("zh-CN")).toBe("zh")
    expect(matchLocale("zh-Hans-CN")).toBe("zh")
    expect(matchLocale("en-GB")).toBe("en")
    expect(matchLocale("ja-JP")).toBe("ja")
    expect(matchLocale("pt-BR")).toBeNull()
    expect(matchLocale("")).toBeNull()
    expect(matchLocale(null)).toBeNull()
  })

  it("系统语言按优先级挑，都不认识就用英文（老版兜底）", () => {
    expect(detectLocale(["pt-BR", "ko-KR", "en"])).toBe("ko")
    expect(detectLocale(["pt-BR"])).toBe(FALLBACK_LOCALE)
    expect(detectLocale([])).toBe("en")
  })

  it("存过的选择优先于系统语言；存的值不认识才回落到系统", () => {
    expect(resolveLocale("ja", ["en-US"])).toBe("ja")
    expect(resolveLocale(null, ["fr-FR"])).toBe("fr")
    expect(resolveLocale("klingon", ["de-DE"])).toBe("de")
    expect(resolveLocale("klingon", ["pt-BR"])).toBe("en")
  })

  it("翻译：命中目录用译文，没命中留原文，占位符按传入替换", () => {
    expect(translate("zh", "搜索")).toBe("搜索")
    expect(translate("en", "搜索")).toBe("Search")
    expect(translate("en", "还没有翻译过的句子")).toBe("还没有翻译过的句子")
    // 带 {n} 的动态文案还没落目录：先钉住「没命中也要把占位符填上」——
    // 调用方切到没翻译的语言时，看到的是填好值的原文，而不是带 {0} 的半成品。
    expect(translate("en", "已是最新的 {0}，上面这些改动已经生效。", { "0": "0.2.1" })).toBe(
      "已是最新的 0.2.1，上面这些改动已经生效。"
    )
  })

  it("翻译桥的单元：命中就换、没命中返回 null，首尾空白原样保留", () => {
    // 命中：只换掉去空白后的那一段，缩进/换行/空格全部照旧 —— JSX 的间距全靠它
    expect(translateInline("搜索", "en")).toBe("Search")
    expect(translateInline("  搜索  ", "en")).toBe("  Search  ")
    expect(translateInline("\n            账号管理\n          ", "en")).toBe(
      "\n            Accounts\n          "
    )
    // 键按折叠空白匹配：跨行/多空格的原文也能命中同一条目录
    expect(translateInline("身份  key 与 GitHub 令牌都不用重置", "en")).toBe(
      "Neither the identity key nor the GitHub token needs to be reset"
    )
    // 没命中 / 空串 / 原文语言 → 不返回字符串，调用方据此保持 DOM 原样
    expect(translateInline("还没有翻译过的句子", "en")).toBeNull()
    expect(translateInline("   ", "en")).toBeNull()
    expect(translateInline("搜索", "zh")).toBeNull()
  })

  it("语言名按各自母语显示，永不翻译", () => {
    expect(localeName("ja")).toBe("日本語")
    expect(localeName("nl")).toBe("Nederlands")
    expect(localeName("zh")).toBe("中文")
  })

  it("七种外文目录都已落地；外壳必备文案每种语言都必须翻到", () => {
    for (const code of ["en", "ja", "ko", "fr", "de", "nl", "ru"] as const) {
      expect(catalogSize(code), code).toBeGreaterThan(0)
    }
    // 导航 / 顶栏 / 更新弹窗 / 常用动作：切到任何一种语言都得有译文，缺一条就算回归
    const chrome = [
      "主控台",
      "服务器日志",
      "账号管理",
      "指令手册",
      "数据库",
      "模组市场",
      "配置中心",
      "设置",
      "界面语言",
      "启动器更新",
      "立即更新",
      "检查更新",
      "保存",
      "取消",
      "删除",
      "关闭",
      "搜索",
      "详情",
    ]
    for (const code of ["en", "ja", "ko", "fr", "de", "nl", "ru"] as const) {
      for (const key of chrome) {
        // 判「条目在不在」而不是「译文与原文不同」：日语「保存」这类同形汉字译文本来就一样
        expect(hasEntry(code, key), code + " · " + key).toBe(true)
      }
    }
  })

  it("英语目录已落地（中文是源语言，不建目录）", () => {
    expect(catalogSize("zh")).toBe(0)
    expect(catalogSize("en")).toBeGreaterThan(500)
  })

  /**
   * 目录**逐条对齐**：七种外文的键集合必须完全一致。
   * 少一条就回退中文，用户看到的就是「切了语言还有中文」——2026-09-29 那次报障
   * （日志区 / 环境自检 / 角色种族 / 指令手册 / 右下角提示）就是这类缺口攒出来的。
   * 这里只比集合，不比译文：日语「保存」这类同形汉字译文与原文相同是正常的。
   */
  it("七种外文目录的键集合完全一致", () => {
    const catalogs: Record<string, Record<string, string>> = { en, ja, ko, fr, de, nl, ru }
    const reference = Object.keys(en).sort()
    expect(reference.length).toBeGreaterThan(1000)
    for (const [code, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), code).toEqual(reference)
    }
  })

  /**
   * 2026-09-29 补齐的那批文案：静态文案走翻译桥、带插值的走 `t()`，
   * 两条路都要求目录里有条目。这里挑每个报障点各留一条，回归了当场就红。
   */
  it("这批报障文案在七种语言里都有条目", () => {
    const keys = [
      // 图1 日志区（启动横幅与已加载模组一行）
      "[启动器] EvEJS Launcher {version} · EVEJS {evejs} · {platform}",
      "[启动器] 已加载模组: 共 {total} 个 · 启用 {enabled} · 禁用 {disabled}{conflicts}",
      // 图2/图3/图5 状态行
      "{count} 张表已挂载{extra}",
      " · 本表载入 {loaded} / {rows} 行",
      "{count} 个文件 · 约 {size}",
      "{count} 行 · 自动滚动",
      // 图4 服务卡片
      "{name} · 端口 {port}",
      // 环境自检（Rust 侧重测读数 + 面板读数）
      "server/node_modules 已就绪",
      "release 二进制已构建",
      "CA 证书就绪",
      "{pass}/{total} 通过{extra}",
      // 角色种族 / 血统
      "加达里",
      "德泰斯",
      // 右下角提示
      "已停用 {name}",
      "账号名「{name}」已存在",
      "删除账号 {name}",
      // 模组详情：正文 / 版本历史为空时的兜底文案
      "暂无版本历史",
      "还没有填写功能说明。",
      // 2026-09-29 「作者身份」改名「令牌配置」＋系统页签里剩下的中文
      "令牌配置",
      "署名会印在模组的作者栏上，先在「令牌配置」里填上你自己的署名。",
      "，打开「令牌配置」就能看到。",
      "[启动器] GitHub 令牌: 未配置 · MOD制作者需要配置令牌，可在模组市场里设置",
      "[启动器] {service} · {action}",
      "一键启动序列开始 · 环境自检门禁通过",
      "启动序列完成",
    ]
    for (const code of ["en", "ja", "ko", "fr", "de", "nl", "ru"] as const) {
      for (const key of keys) expect(hasEntry(code, key), code + " · " + key).toBe(true)
    }
  })
})

/**
 * 评论署名与顶部语言切换器：地区名走 Intl、旗子走 ui/public/flags/ 下按需加载的 SVG。
 * 这两条一起决定「来自 <地区> 的玩家」那一行长什么样，缺一都会退化成地球图标。
 */
describe("国家 / 地区码", () => {
  it("地区名按当前语言取（跟系统 ICU 走，不维护对照表）", () => {
    expect(countryName("DE", "zh")).toBe("德国")
    expect(countryName("de", "en")).toBe("Germany")
    expect(countryName("DE", "ja")).toBe("ドイツ")
    expect(countryName("US", "ru")).toBe("Соединенные Штаты")
    // 香港的 ICU 译名太长（「中国香港特别行政区」），按玩家习惯压成两个字
    expect(countryName("HK", "zh")).toBe("香港")
  })

  it("不是两字母地区码的一律给空串（调用方据此说「未知地区」）", () => {
    expect(countryName("", "en")).toBe("")
    expect(countryName("CHN", "en")).toBe("")
    expect(countryName("T1", "en")).toBe("")
  })

  it("八种语言的旗子都在生成清单里，路径也对得上", () => {
    for (const item of LOCALES) {
      expect(COUNTRY_FLAG_CODES, item.code).toContain(item.flagCode)
      expect(countryFlagUrl(item.flagCode), item.code).toBe(
        "./flags/" + item.flagCode.toLowerCase() + ".svg"
      )
    }
  })

  it("清单外的地区码不给路径（界面退化成地球图标，不是错误）", () => {
    expect(countryFlagUrl("ZZ")).toBe("")
  })

  it("「来自 {country} 的玩家」按语言拼，占位符不残留", () => {
    expect(translate("en", "来自 {country} 的玩家", { country: "Germany" })).toBe(
      "Player from Germany"
    )
    expect(translate("ja", "来自 {country} 的玩家", { country: "ドイツ" })).toBe(
      "ドイツのプレイヤー"
    )
    // 法语和俄语里「来自 + 国名」要变格 / 变冠词（du Japon、из Японии），
    // 而 Intl.DisplayNames 只给主格形式。硬拼会写出 "Joueur de Japon"、"Игрок из Япония"
    // 这种病句，所以这两门语言换成不带介词的说法。改回去之前先想清楚这一点。
    expect(translate("fr", "来自 {country} 的玩家", { country: "Japon" })).toBe("Joueur (Japon)")
    expect(translate("ru", "来自 {country} 的玩家", { country: "Япония" })).toBe("Игрок (Япония)")
    expect(translate("zh", "来自未知地区的玩家")).toBe("来自未知地区的玩家")
  })

  it("评论区新文案七种语言都有条目", () => {
    const keys = [
      "来自 {country} 的玩家",
      "来自未知地区的玩家",
      "评价已提交",
      "评价已撤回",
      "评价没能提交",
      "撤回评价失败",
      "回复已发布",
      "回复已撤回",
      "回复没能发布",
      "撤回回复失败",
    ]
    for (const code of ["en", "ja", "ko", "fr", "de", "nl", "ru"] as const) {
      for (const key of keys) expect(hasEntry(code, key), code + " · " + key).toBe(true)
    }
  })
})