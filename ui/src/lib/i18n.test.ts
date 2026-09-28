import { describe, expect, it } from "vitest"

import {
  FALLBACK_LOCALE,
  LOCALES,
  catalogSize,
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
})
