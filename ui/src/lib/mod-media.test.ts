import { describe, expect, it } from "vitest"

import {
  DEFAULT_SHOTS_REF,
  MAX_SHOTS,
  modBannerUrl,
  modShotUrls,
  repoSlugOf,
  shotUrlOf,
  shotsRefOf,
} from "@/lib/mod-media"

describe("精选横幅（shots/Banner/）", () => {
  it("banner 是文件名时拼到 shots/Banner/ 下", () => {
    expect(modBannerUrl(raw({ banner: "banner.jpg" }))).toBe(
      "https://cdn.jsdelivr.net/gh/rzwm/evejs-mod-evejs-beijing-time@main/shots/Banner/banner.jpg"
    )
  })

  it("banner 已经带 shots/Banner/ 前缀时不再重复拼", () => {
    expect(modBannerUrl(raw({ banner: "shots/Banner/banner.jpg" }))).toBe(
      "https://cdn.jsdelivr.net/gh/rzwm/evejs-mod-evejs-beijing-time@main/shots/Banner/banner.jpg"
    )
  })

  it("banners 数组按顺序取第一张能用的", () => {
    expect(modBannerUrl(raw({ banners: ["nope.txt", "banner-1920x600.png"] }))).toBe(
      "https://cdn.jsdelivr.net/gh/rzwm/evejs-mod-evejs-beijing-time@main/shots/Banner/banner-1920x600.png"
    )
  })

  it("banner 优先于 banners", () => {
    expect(
      modBannerUrl(raw({ banner: "a.png", banners: ["b.png"] }))
    ).toContain("/shots/Banner/a.png")
  })

  it("没有 banner 字段返回 null（精选位退回本地横幅）", () => {
    expect(modBannerUrl(raw())).toBeNull()
    expect(modBannerUrl(null)).toBeNull()
  })

  it("拒绝非图片、绝对路径与 .. 穿越", () => {
    expect(modBannerUrl(raw({ banner: "evil.exe" }))).toBeNull()
    expect(modBannerUrl(raw({ banner: "/etc/passwd.png" }))).toBeNull()
    expect(modBannerUrl(raw({ banner: "../../secret.png" }))).toBeNull()
  })

  it("只放行白名单图床的完整地址", () => {
    expect(modBannerUrl(raw({ banner: "https://cdn.jsdelivr.net/gh/a/b@main/x.png" }))).toBe(
      "https://cdn.jsdelivr.net/gh/a/b@main/x.png"
    )
    expect(modBannerUrl(raw({ banner: "https://evil.example/x.png" }))).toBeNull()
  })

  it("shotsRef 生效（钉版本时）", () => {
    expect(modBannerUrl(raw({ banner: "b.png", shotsRef: "v1.2.3" }))).toContain("@v1.2.3/")
  })
})

const raw = (over: Record<string, unknown> = {}) => ({
  source: "rzwm/evejs-mod-evejs-beijing-time",
  downloadUrls: [
    {
      url: "https://github.com/rzwm/evejs-mod-evejs-beijing-time/releases/download/v1.1.0/evejs-beijing-time-1.1.0.zip",
      mirror: "github",
      priority: 1,
    },
  ],
  shots: ["01.webp", "02.webp"],
  ...over,
})

describe("仓库与 ref", () => {
  it("优先用索引里的 source", () => {
    expect(repoSlugOf(raw())).toBe("rzwm/evejs-mod-evejs-beijing-time")
  })

  it("没有 source 就从 repo 解析", () => {
    expect(repoSlugOf({ repo: "https://github.com/a/b" })).toBe("a/b")
    expect(repoSlugOf({ repo: "git@github.com:a/b.git" })).toBe("a/b")
    expect(repoSlugOf({})).toBeNull()
  })

  /**
   * **默认走 main，不取 release tag** —— 实测：作者常常是发版之后才补截图，
   * 那时 tag 指向的提交里根本没有 `shots/`，按 tag 拼地址一律 404。
   */
  it("默认 ref 是 main，不是下载地址里的 tag", () => {
    expect(shotsRefOf(raw())).toBe("main")
    expect(shotsRefOf({ source: "a/b", shots: ["1.webp"] })).toBe(DEFAULT_SHOTS_REF)
  })

  it("索引里显式给了 shotsRef 就用它（想钉版本时）", () => {
    expect(shotsRefOf(raw({ shotsRef: "abc123" }))).toBe("abc123")
    expect(shotsRefOf(raw({ shotsRef: "v1.1.0" }))).toBe("v1.1.0")
  })
})

describe("拼地址", () => {
  it("裸文件名补上 shots/ 前缀；带上 ref 段", () => {
    expect(shotUrlOf("a/b", "main", "01.webp")).toBe(
      "https://cdn.jsdelivr.net/gh/a/b@main/shots/01.webp",
    )
  })

  it("带目录的路径原样使用，中文/空格会编码", () => {
    expect(shotUrlOf("a/b", "main", "shots/封面 1.png")).toBe(
      "https://cdn.jsdelivr.net/gh/a/b@main/shots/%E5%B0%81%E9%9D%A2%201.png",
    )
  })

  it("拒绝绝对路径、上跳路径、非图片后缀", () => {
    expect(shotUrlOf("a/b", "v1", "/etc/passwd")).toBeNull()
    expect(shotUrlOf("a/b", "v1", "../../secret.webp")).toBeNull()
    expect(shotUrlOf("a/b", "v1", "shots/readme.md")).toBeNull()
    expect(shotUrlOf(null, "v1", "01.webp")).toBeNull()
    expect(shotUrlOf("a/b", "v1", "   ")).toBeNull()
  })

  it("绝对地址只放行允许域里的图片", () => {
    expect(shotUrlOf(null, "v1", "https://cdn.jsdelivr.net/gh/a/b@main/shots/1.webp")).toBe(
      "https://cdn.jsdelivr.net/gh/a/b@main/shots/1.webp",
    )
    // 别的域名：放行也会被 CSP 拦，直接丢掉
    expect(shotUrlOf(null, "v1", "https://evil.example/x.webp")).toBeNull()
    expect(shotUrlOf(null, "v1", "http://raw.githubusercontent.com/a/b/main/1.webp")).toBeNull()
    expect(shotUrlOf(null, "v1", "https://raw.githubusercontent.com/a/b/main/1.exe")).toBeNull()
  })
})

describe("整条列表", () => {
  it("按索引顺序去重后给出地址", () => {
    const urls = modShotUrls(raw({ shots: ["01.webp", "01.webp", "shots/02.webp"] }))
    expect(urls).toEqual([
      "https://cdn.jsdelivr.net/gh/rzwm/evejs-mod-evejs-beijing-time@main/shots/01.webp",
      "https://cdn.jsdelivr.net/gh/rzwm/evejs-mod-evejs-beijing-time@main/shots/02.webp",
    ])
  })

  it("没有 shots 就是空数组，界面据此不画截图条", () => {
    expect(modShotUrls(raw({ shots: [] }))).toEqual([])
    expect(modShotUrls(raw({ shots: undefined }))).toEqual([])
    expect(modShotUrls(null)).toEqual([])
  })

  it("最多 MAX_SHOTS 张", () => {
    const many = Array.from({ length: MAX_SHOTS + 4 }, (_, i) => `0${i}.webp`)
    expect(modShotUrls(raw({ shots: many })).length).toBe(MAX_SHOTS)
  })
})
