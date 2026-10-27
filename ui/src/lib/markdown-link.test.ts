import { describe, expect, it } from "vitest"

import { repoFileUrl, repoSlugOfUrl, resolveMarkdownHref } from "@/lib/markdown-link"

/**
 * Markdown 正文链接的落点解析。
 *
 * 起因（2026-10-26 报障）：模组说明里的 `NOTICE.md` 这类相对路径被 WebView 按当前页面
 * 解析成 `react/NOTICE.md`，Tauri 找不到就整页报 `asset not found`。所以这里的断言
 * 不只是「解析对不对」，还有一条硬要求：**任何输入都不能原样交给 WebView 去导航**。
 */

const REPO = "https://github.com/xuenaimiao/evejs-mod-evejs-faction-sim"

describe("Markdown 链接落点", () => {
  it("http / https / mailto 原样交给系统", () => {
    expect(resolveMarkdownHref("https://example.com/a", REPO)).toEqual({
      kind: "external",
      url: "https://example.com/a",
    })
    expect(resolveMarkdownHref("http://example.com", null).kind).toBe("external")
    expect(resolveMarkdownHref("mailto:a@b.c", null).kind).toBe("external")
  })

  it("协议相对地址补上 https", () => {
    expect(resolveMarkdownHref("//cdn.example.com/x.png", null)).toEqual({
      kind: "external",
      url: "https://cdn.example.com/x.png",
    })
  })

  it("javascript: / data: / file: 一律不解析、不放行", () => {
    for (const href of ["javascript:alert(1)", "data:text/html;base64,AA", "file:///C:/x"]) {
      expect(resolveMarkdownHref(href, REPO).kind, href).toBe("unresolved")
    }
  })

  it("相对路径拼成作者仓库的文件页", () => {
    expect(resolveMarkdownHref("NOTICE.md", REPO)).toEqual({
      kind: "repo",
      url: "https://github.com/xuenaimiao/evejs-mod-evejs-faction-sim/blob/HEAD/NOTICE.md",
    })
    expect(resolveMarkdownHref("./docs/guide 1.md", REPO)).toEqual({
      kind: "repo",
      url: "https://github.com/xuenaimiao/evejs-mod-evejs-faction-sim/blob/HEAD/docs/guide%201.md",
    })
  })

  it("ref 用 HEAD：作者的默认分支叫 main 还是 master 都能打开", () => {
    expect(repoFileUrl(REPO, "a.md")).toContain("/blob/HEAD/a.md")
  })

  it("没有仓库地址时相对路径解析不出来（而不是交给 WebView）", () => {
    expect(resolveMarkdownHref("NOTICE.md", null)).toEqual({
      kind: "unresolved",
      href: "NOTICE.md",
    })
    expect(resolveMarkdownHref("NOTICE.md", "https://gitlab.com/a/b")).toEqual({
      kind: "unresolved",
      href: "NOTICE.md",
    })
  })

  it("跳出仓库的路径一律拒绝", () => {
    for (const href of ["../../../etc/passwd", "docs/../../x.md", "C:/windows/system32"]) {
      expect(resolveMarkdownHref(href, REPO).kind, href).toBe("unresolved")
    }
  })

  it("以 / 开头按仓库根解析：照样跑不出仓库，不该当成绝对路径丢掉", () => {
    expect(resolveMarkdownHref("/INSTALL.md", REPO)).toEqual({
      kind: "repo",
      url: "https://github.com/xuenaimiao/evejs-mod-evejs-faction-sim/blob/HEAD/INSTALL.md",
    })
  })

  it("页内锚点单独一种，不当外部地址", () => {
    expect(resolveMarkdownHref("#usage", REPO)).toEqual({ kind: "anchor", id: "usage" })
    expect(resolveMarkdownHref("#", REPO).kind).toBe("unresolved")
  })

  it("去掉 Markdown 包裹的尖括号、query 与 fragment", () => {
    expect(resolveMarkdownHref("<NOTICE.md>", REPO).kind).toBe("repo")
    const target = resolveMarkdownHref("docs/a.md?raw=1#top", REPO)
    expect(target).toEqual({
      kind: "repo",
      url: "https://github.com/xuenaimiao/evejs-mod-evejs-faction-sim/blob/HEAD/docs/a.md",
    })
  })
})

describe("仓库地址解析", () => {
  it("认得出 owner/repo，.git 和尾斜杠都无所谓", () => {
    expect(repoSlugOfUrl("https://github.com/a/b")).toBe("a/b")
    expect(repoSlugOfUrl("https://github.com/a/b.git")).toBe("a/b")
    expect(repoSlugOfUrl("https://github.com/a/b/")).toBe("a/b")
  })

  it("不是 GitHub 仓库地址就返回 null", () => {
    expect(repoSlugOfUrl("https://gitlab.com/a/b")).toBeNull()
    expect(repoSlugOfUrl("")).toBeNull()
    expect(repoSlugOfUrl(undefined)).toBeNull()
  })
})
