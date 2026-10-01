/**
 * 补给线（赞助人）名单。
 *
 * **优先读远端，随包那份只是回落**：名单本体在服务端（`infra/src/sponsors.js`），
 * 由那个 Cloudflare 服务定时签成 `sponsors.json` 下发；启动器走 `sponsorsSnapshot`
 * 通道取（多镜像 + 本地缓存 + 验签，实现见 `src-tauri/src/sponsors.rs`）。
 * 所以**改名单不用重新发版**，启动器也不用跟着动。
 *
 * 旁边的 `sponsors.txt` 是**随包回落**：没网、服务还没上、验签没过时，这块面板照样有
 * 东西看，不会开天窗。格式说明与三种格式（TXT / HTML / JSON）的解析器都在
 * `sponsor-source.ts`；换格式时只改这个文件里的那一行 import，动画层不用动。
 *
 * ⚠️ 那份回落名单还是**演示数据**：前十条取自原型截图，后四条是占位凑数。
 *
 * 名字与金额都是**用户数据**：界面上一律不翻译（面板挂 `data-i18n-skip`），也不进多语言目录。
 * 币种不是用户数据 —— `currency` 决定金额前面挂什么符号。
 */
import source from "./sponsors.txt?raw"

import {
  normalizeCurrency,
  parseSponsorsTxt,
  toSponsorEntry,
  type SponsorEntry,
} from "./sponsor-source"

export type { SponsorEntry }

export const SPONSORS: SponsorEntry[] = parseSponsorsTxt(source).entries

/** 金额显示：去掉多余的零（9.90 → 9.9，666.00 → 666），但不动整数位 */
export function formatAmount(amount: number): string {
  return Number(amount.toFixed(2)).toString()
}

/**
 * 币种 → 符号。赞助人不全是人民币，国外那批得按自己的币种显示。
 *
 * 表里没有的码**不猜**：原样给出「XYZ 20」。宁可让人一眼看见「这个码没人认识」，
 * 也别去猜该换算成什么 —— 换算与合并是名单的事，不是启动器的事。
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  KRW: "₩",
  RUB: "₽",
}

/** 币种符号；表里没有就返回 null（调用方退回原码） */
export function currencySymbol(currency: string): string | null {
  return CURRENCY_SYMBOLS[normalizeCurrency(currency)] ?? null
}

/** 远端快照里的一行（`sponsors:snapshot` 回包 `sponsors` 数组的元素） */
export interface SponsorRow {
  id?: string
  name?: string
  amount?: unknown
  currency?: string
}

/**
 * 远端快照过成 `SponsorEntry[]`：`ok` 不是 true、或 `sponsors` 不是数组，就是空名单。
 * 单条走的是与写名单的人同一套校验（`toSponsorEntry`），错的丢掉、不静默造一条。
 *
 * 这个函数刻意不碰名单顺序、也不去重：顺序是名单的事，而服务端算快照时已经按名字去过重了。
 */
export function sponsorEntriesFrom(
  raw: { ok?: boolean; sponsors?: SponsorRow[] } | null
): SponsorEntry[] {
  if (!raw?.ok || !Array.isArray(raw.sponsors)) return []
  const entries: SponsorEntry[] = []
  raw.sponsors.forEach((row, index) => {
    const entry = toSponsorEntry(
      String(row?.id || `sponsor-${index + 1}`),
      String(row?.name ?? ""),
      row?.amount,
      row?.currency
    )
    if (entry) entries.push(entry)
  })
  return entries
}

/** 金额 + 币种的显示文本：`¥666` / `$50` / 认不出的码 `XYZ 20` */
export function formatMoney(entry: Pick<SponsorEntry, "amount" | "currency">): string {
  const symbol = currencySymbol(entry.currency)
  if (symbol !== null) return symbol + formatAmount(entry.amount)
  return `${normalizeCurrency(entry.currency)} ${formatAmount(entry.amount)}`
}
