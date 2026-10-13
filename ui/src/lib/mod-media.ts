/**
 * 模组截图：图放在**作者自己的仓库**里（约定的 `shots/` 目录），市场索引只透传文件名。
 * 启动器按索引里的 `source`（`owner/repo`）拼出 raw 地址 —— 不做上传、不做代理，
 * 渲染层直接 `<img>`。
 *
 * 为什么文件名必须由索引给出：`raw.githubusercontent.com` **不能列目录**，
 * 启动器没法自己发现作者仓库里有哪些图。所以索引里的 `shots: ["01.webp", …]` 是唯一来源。
 *
 * ⚠️ **主用 jsDelivr 而不是 raw.githubusercontent.com**：2026-10-14 实测，本机到
 * `raw.githubusercontent.com`（以及 `github.com/.../raw/...`）**直接超时**，而
 * `cdn.jsdelivr.net` 与 `diguo520.github.io` 都通。jsDelivr 会镜像**任意** GitHub 仓库，
 * 所以「图放作者自己的仓库」这个前提在 jsDelivr 下依然成立，只是取图主机的选择变了。
 *
 * 与 `tauri.conf.json` 的 `img-src` 是配套的：只认这三个域，别的域名一律丢掉
 * （放行也没用，CSP 会拦），**改一处要改两处**。
 */
export interface ModShotsSource {
  /** `owner/repo`，索引里既有这条 */
  source?: string
  /** 完整仓库地址；`source` 缺失时从这里解析 */
  repo?: string
  /** 显式指定的 git ref（tag / commit）；缺省时从下载地址里推 tag */
  shotsRef?: string
  /** 作者仓库里 `shots/` 下的文件名，或完整 https 地址 */
  shots?: string[]
  downloadUrls?: { url?: string; mirror?: string; priority?: number }[]
}

export const MOD_SHOTS_DIR = "shots"
export const RAW_HOST = "raw.githubusercontent.com"
export const CDN_HOST = "cdn.jsdelivr.net"
/** 市场索引自己就挂在这个 Pages 域名下；作者若把图放进市场仓库，也走它 */
export const PAGES_HOST = "diguo520.github.io"
/** 兜底 ref：作者仓库的默认分支 */
export const DEFAULT_SHOTS_REF = "main"
/** 一次最多显示几张 */
export const MAX_SHOTS = 9

/** 允许的图片域 —— 与 tauri.conf.json 的 img-src 一一对应 */
export const ALLOWED_IMAGE_HOSTS = [CDN_HOST, PAGES_HOST, RAW_HOST]
const IMAGE_EXT = /\.(webp|png|jpe?g|gif)$/i

/** `owner/repo`；索引里 `source` 是现成的，没有就从 `repo` 解析 */
export function repoSlugOf(raw: ModShotsSource | null | undefined): string | null {
  const source = String(raw?.source ?? "").trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return source
  const repo = String(raw?.repo ?? "").trim()
  const match = repo.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?$/)
  return match ? match[1] : null
}

/**
 * 用哪个 ref 取图。
 *
 * **默认 `main`，不取 release tag** —— 这是 2026-10-14 实测踩出来的：作者往往是
 * **发版之后**才补截图，而那时 tag 已经指向没有图的旧提交，按 tag 拼地址一律 404
 * （`@v1.0.14` 取不到、`@main` 才拿得到）。代价是作者能事后换图，先接受。
 *
 * 想钉版本就在索引里显式写 `shotsRef`（tag / commit），那时以它为准。
 */
export function shotsRefOf(raw: ModShotsSource | null | undefined): string {
  const explicit = String(raw?.shotsRef ?? "").trim()
  if (explicit !== "") return explicit
  return DEFAULT_SHOTS_REF
}

function isAllowedAbsolute(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      ALLOWED_IMAGE_HOSTS.includes(parsed.hostname.toLowerCase()) &&
      IMAGE_EXT.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

/** 单张图 → 可用地址；不可用返回 null（宁可不显示，也不要留一个破图） */
export function shotUrlOf(
  slug: string | null,
  ref: string,
  entry: unknown,
): string | null {
  const text = String(entry ?? "").trim()
  if (text === "") return null
  if (text.startsWith("http://") || text.startsWith("https://")) {
    return isAllowedAbsolute(text) ? text : null
  }
  if (slug === null || slug === "") return null
  // 相对路径只允许往下走：拒绝绝对路径与 `..`
  const path = text.replace(/^\.\//, "")
  if (path.startsWith("/") || path.split("/").includes("..")) return null
  const relative = path.includes("/") ? path : MOD_SHOTS_DIR + "/" + path
  if (!IMAGE_EXT.test(relative)) return null
  const encoded = relative
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/")
  // jsDelivr 的 GitHub 镜像格式：/gh/<owner>/<repo>@<ref>/<path>
  return `https://${CDN_HOST}/gh/${slug}@${encodeURIComponent(ref)}/${encoded}`
}

/** 索引条目 → 可渲染的截图地址列表（去重、限量、顺序照索引） */
export function modShotUrls(raw: ModShotsSource | null | undefined): string[] {
  const entries = Array.isArray(raw?.shots) ? raw.shots : []
  if (entries.length === 0) return []
  const slug = repoSlugOf(raw)
  const ref = shotsRefOf(raw)
  const out: string[] = []
  for (const entry of entries) {
    const url = shotUrlOf(slug, ref, entry)
    if (url !== null && !out.includes(url)) out.push(url)
    if (out.length >= MAX_SHOTS) break
  }
  return out
}
