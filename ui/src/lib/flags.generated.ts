/* 本文件由 scripts/gen-country-flags.mjs 生成，不要手改。
 *
 * 国旗图形来自 flag-icons（MIT）：https://github.com/lipis/flag-icons
 * 这里只登记「有哪些码」，真正的 SVG 在 ui/public/flags/ 下按需加载 ——
 * 内联进 bundle 会让每次冷启动都多解析几百 KB，而这些旗子大多数会话里根本不会显示。
 * 清单外的国家码界面退化成地球图标，不是错误。
 */

export const COUNTRY_FLAG_CODES: readonly string[] = [
  "CN",
  "TW",
  "HK",
  "JP",
  "KR",
  "SG",
  "MY",
  "TH",
  "VN",
  "ID",
  "PH",
  "IN",
  "GB",
  "IE",
  "FR",
  "DE",
  "NL",
  "BE",
  "LU",
  "AT",
  "CH",
  "IT",
  "ES",
  "PT",
  "SE",
  "NO",
  "DK",
  "FI",
  "IS",
  "PL",
  "CZ",
  "SK",
  "HU",
  "RO",
  "BG",
  "GR",
  "HR",
  "SI",
  "RS",
  "UA",
  "RU",
  "TR",
  "IL",
  "SA",
  "AE",
  "ZA",
  "EG",
  "BR",
  "AR",
  "CL",
  "CO",
  "PE",
  "MX",
  "US",
  "CA",
  "AU",
  "NZ",
]

/** 国家码 → 资源路径；清单里没有就返回空串（调用方据此退化） */
export function countryFlagUrl(code: string): string {
  const upper = String(code || "").toUpperCase()
  return COUNTRY_FLAG_CODES.includes(upper) ? `./flags/${upper.toLowerCase()}.svg` : ""
}
