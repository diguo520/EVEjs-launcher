/**
 * 离线包的元信息与取址。隔离预览把应用挂在带会话前缀的 /content 路径下，
 * 静态资源写死站点根路径会 404 —— 跟外部数据 helper 一样，按当前页
 * pathname 里的 /content 前缀拼。
 */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, "")
  if (typeof window === "undefined") return clean
  const prefix = window.location.pathname.match(/^(.*\/content)(?:\/|$)/i)?.[1]
  return prefix ? `${prefix}/${clean}` : clean
}

export interface OfflineBundleEntry {
  name: string
  desc: string
}

export const OFFLINE_BUNDLE = {
  /** 打包产物放在 public/downloads 下，由预览原样吐出来。 */
  path: "downloads/eve-console.zip",
  fileName: "eve-console.zip",
  entries: [
    { name: "新伊甸指挥台.html", desc: "离线单文件版，双击就能打开" },
    { name: "源码", desc: "完整工程，想接着改就用它" },
    { name: "说明.txt", desc: "打开方式与数据说明" },
  ] satisfies OfflineBundleEntry[],
}
