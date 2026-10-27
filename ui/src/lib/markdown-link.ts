/**
 * Markdown 正文里的链接：**一律由启动器自己接管**，不让 WebView 去导航。
 *
 * 为什么必须接管：模组说明是作者写的 Markdown，里面常见 `NOTICE.md`、`docs/x.md`
 * 这类**相对路径**。WebView 会按当前页面地址解析它们 —— 渲染层挂在 `react/` 下，
 * 点一下就去加载 `react/NOTICE.md` 这个「资产」，Tauri 找不到就把整页变成
 * `asset not found: react/NOTICE.md`（2026-10-26 报障）。
 *
 * 相对路径按**作者仓库**解析成 GitHub 上的文件页；仓库地址未知就给「打不开」，
 * 总之不跳转。
 */

/**
 * 解析相对路径时用的 ref。
 *
 * `HEAD` 是 git 的真 ref，GitHub 的 `/blob/<ref>/` 认它并落到**仓库的默认分支**上 ——
 * 作者的默认分支叫 main 还是 master 都能打开。写死 `main` 会让 master 仓库的链接 404。
 */
export const REPO_FILE_REF = "HEAD"

/** 链接的落点；点击时按 kind 决定干什么 */
export type MarkdownLinkTarget =
  /** 绝对地址（http/https/mailto）：交给系统浏览器 */
  | { kind: "external"; url: string }
  /** 作者仓库里的文件（相对路径）：同样是外部地址，只是由仓库地址拼出来 */
  | { kind: "repo"; url: string }
  /** 页内锚点：不跳转，滚动到对应元素 */
  | { kind: "anchor"; id: string }
  /** 解析不出来：提示一下，绝不放行 */
  | { kind: "unresolved"; href: string }

/** `https://github.com/owner/repo(.git)?` → `owner/repo`；别的地址（含 GitLab 等）返回 null */
export function repoSlugOfUrl(repo: string | null | undefined): string | null {
  const text = String(repo ?? "").trim()
  if (text === "") return null
  const match = text.match(/^https?:\/\/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * 相对路径 → 作者仓库里的文件页。
 *
 * 只认「仓库内的相对路径」：以 `/` 开头按**仓库根**算（作者写 `/INSTALL.md` 想表达的就是
 * 这个，前面那个斜杠不该把它变成打不开的链接）；含 `..`、带盘符（`C:/…`）的一律拒绝 ——
 * 它们会跑出仓库，拼出来也没有意义。
 */
export function repoFileUrl(repo: string | null | undefined, path: string): string | null {
  const slug = repoSlugOfUrl(repo)
  if (slug === null) return null
  const raw = String(path ?? "")
    .trim()
    .replace(/^<|>$/g, "")
    .split(/[?#]/)[0]
  // 协议相对地址（`//host/x`）不从仓库里解析
  if (raw.startsWith("//")) return null
  // 只去掉一个「本目录」前缀或一个仓库根斜杠。**不能**写成 `^[./]+`：那样会把
  // `../../../etc/passwd` 的前导 `..` 一起吃掉，于是它摇身变成合法的仓库内路径
  // （测试里就是这么抓到的）—— `..` 要留着，交给下面的检查拒绝。
  const cleaned = raw.replace(/^\.\//, "").replace(/^\//, "")
  if (cleaned === "") return null
  const segments = cleaned.split("/").filter((part) => part !== "" && part !== ".")
  if (segments.length === 0 || segments.includes("..")) return null
  const encoded = segments.map((part) => encodeURIComponent(part)).join("/")
  return `https://github.com/${slug}/blob/${REPO_FILE_REF}/${encoded}`
}

/** 带 scheme 的地址（`javascript:`、`data:` 这些也在内）—— 用来把它们挡在相对路径之外 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** 允许交给系统的 scheme；其余（javascript: / data: / file: / vbscript: …）一律不放行 */
const ALLOWED_SCHEME = /^(https?|mailto):/i

/**
 * Markdown 里的 `href` → 落点。
 *
 * 顺序即优先级：页内锚点 → 绝对地址 → 协议相对地址 → **其余带 scheme 的一律拒** →
 * 相对路径（拼作者仓库）→ 都不成就 `unresolved`。
 */
export function resolveMarkdownHref(
  href: string | null | undefined,
  repo?: string | null
): MarkdownLinkTarget {
  const raw = String(href ?? "").trim()
  if (raw === "") return { kind: "unresolved", href: raw }
  if (raw.startsWith("#")) {
    const id = raw.slice(1).trim()
    return id === "" ? { kind: "unresolved", href: raw } : { kind: "anchor", id }
  }
  if (ALLOWED_SCHEME.test(raw)) {
    // 去掉尾随的空白与换行，避免 href 里混进 Markdown 换行符
    return { kind: "external", url: raw.replace(/\s+$/, "") }
  }
  // 协议相对（`//example.com/x`）：补上 https 再交给系统
  if (raw.startsWith("//")) return { kind: "external", url: `https:${raw}` }
  // 其余带 scheme 的（javascript: / data: / file:）不进仓库解析，也不放行
  if (HAS_SCHEME.test(raw)) return { kind: "unresolved", href: raw }

  const url = repoFileUrl(repo, raw)
  return url === null ? { kind: "unresolved", href: raw } : { kind: "repo", url }
}
