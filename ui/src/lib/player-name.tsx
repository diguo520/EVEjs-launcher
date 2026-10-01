import { Globe } from "lucide-react"

import { countryFlagUrl } from "@/lib/flags.generated"
import { countryName, translate, type LocaleCode } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/**
 * 评论者署名 —— **不显示昵称**，只显示「来自 <国家> 的玩家」加一面小旗子。
 *
 * 为什么不显示用户名：评价服务不做账号系统（方案 B），没人注册就没法保证昵称唯一，
 * 显示别人的昵称还会招来重名与冒充，索性统一成「来自哪个国家/地区的玩家」。
 * 国家码来自 Cloudflare 边缘白送的 `request.cf.country`，只存这两位码、**不存 IP**（GDPR）；
 * 老快照没有这个字段、或地区不在旗子清单里，就退化成地球图标，不是错误。
 */

/**
 * 小旗子。用 SVG 资源而不是 emoji：Windows 的 Segoe UI 不画区域指示符，
 * `🇩🇪` 会原样掉成两个字母「DE」，那种「旗子」不如不画。
 *
 * `alt=""` + `aria-hidden` 是有意的：旁边的文字已经说了是哪个地区，读屏不必再念一遍，
 * 翻译桥也不会去改写它（它只翻 title / placeholder / aria-label / alt 这几个属性）。
 */
export function PlayerFlag({ country, className }: { country?: string | null; className?: string }) {
  const url = countryFlagUrl(String(country ?? ""))
  if (!url) {
    return <Globe aria-hidden="true" className={cn("size-3.5 shrink-0 text-tertiary", className)} />
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={cn("h-2.5 w-[13px] shrink-0 rounded-[1px] object-cover", className)}
    />
  )
}

/** 「来自 <国家> 的玩家」；没有国家码时说「来自未知地区」。译文进 locales 目录，缺条目回退中文 */
export function fromCountryLabel(country: string | null | undefined, locale: LocaleCode): string {
  const name = countryName(String(country ?? ""), locale)
  return name
    ? translate(locale, "来自 {country} 的玩家", { country: name })
    : translate(locale, "来自未知地区的玩家")
}