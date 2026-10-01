/**
 * 赞助人名单的**调用格式**与解析器。
 *
 * 名单是**用户数据**：界面上不翻译（面板挂 `data-i18n-skip`），金额也不参与排版。
 * 三种格式任选一种，喂给下面任意一个解析器即可 —— 解析结果都是同一份 `SponsorEntry[]`，
 * 调用点只有 `sponsors.ts` 一处，动画层不用动。
 *
 * ── 格式 A：TXT（推荐：一行一条，手工维护和从众筹页复制都不费劲）──────────
 *
 *     # 井号开头是注释，空行忽略
 *     名字,金额
 *     星海孤舟,666
 *     星轨拾荒者,500.5
 *     Cmdr. Nova,50,USD
 *
 *   规则：
 *     - 按每行**最后一个逗号**切 —— 名字里万一带了逗号也不会被切错；
 *     - 末列是**三位字母**（USD / EUR…）时当币种，金额再往前切一次；不写币种就是人民币；
 *     - 右边 `Number()` 不是有限数就丢掉这一条（不编造 0，也不显示「NaN」）；
 *     - 同名只保留**第一条**：不累加，免得把「改过的金额」算成两笔。
 *
 * ── 格式 B：HTML（想直接从众筹页/网页里粘一段出来时用）──────────────────
 *
 *     <ul id="sponsors">
 *       <li data-amount="666">星海孤舟</li>
 *       <li data-amount="500.5">星轨拾荒者</li>
 *       <li data-amount="50" data-currency="USD">Cmdr. Nova</li>
 *     </ul>
 *
 *   规则：取带 `data-amount` 的元素，`textContent` 当名字，`data-amount` 当金额，
 *        币种取可选的 `data-currency`（缺省 CNY），
 *        校验与 TXT 完全同一套（同一个 `toSponsorEntry`）。
 *        ⚠️ 只在**离线 / 构建期**解析，传进来的是一棵已经建好的 DOM（启动器里不做
 *        网络抓取、也不为它引一个 DOM 实现进包）；HTML 实体交给浏览器自己解，
 *        不自己写正则。
 *
 * ── 格式 C：JSON（名单由脚本生成时用）──────────────────────────────
 *
 *     { "sponsors": [{ "id": "s1", "name": "星海孤舟", "amount": 666, "currency": "CNY" }] }
 *
 *   就是 `SponsorEntry[]` 本身（也接受裸数组）：`id` 给动画层做 key 与去重，
 *   缺了就用行号补一个；`currency` 可选，缺省 CNY。
 *
 *   **远端那份快照的条目就是这个形状**（`GET /v1/sponsors.json`，见
 *   `src-tauri/src/sponsors.rs`）：启动器优先读远端，拿不到才退回随包的
 *   `sponsors.txt`。两边共用下面这个 `toSponsorEntry`，校验口径只有一份。
 *
 * ── 币种 ─────────────────────────────────────────────────────────────
 *
 *   赞助人不全是人民币：`currency` 存三位字母码，符号表在 `sponsors.ts`。
 *   认不出来的码**原样显示**成「XYZ 20」—— 宁可让人一眼看见「这个码没人认识」，
 *   也别悄悄按人民币显示。
 *
 * 被丢掉的条目一律记在 `skipped` 里返回，不静默吞掉 —— 名字打错、金额写成「一」时，
 * 维护的人得看得见。
 */

/** 默认币种：名单里不写 `currency` 就是它（随包那份 txt 全是人民币） */
export const DEFAULT_CURRENCY = "CNY"

export interface SponsorEntry {
  /** 稳定 id：动画层拿它做 key 与去重 */
  id: string
  name: string
  /** 金额。只用于标签上的数字，不参与排版 —— 单位看 `currency` */
  amount: number
  /** 三位字母币种码（CNY / USD / EUR…）。认不出的码不翻译、原样显示 */
  currency: string
}

export interface SponsorParseResult {
  entries: SponsorEntry[]
  /** 解析不了的原始行（TXT）或元素（HTML）/条目（JSON）：给维护者看 */
  skipped: string[]
}

/** HTML 侧只需要一个 `querySelectorAll`：真跑时是 `Document`，单测里给个假的即可 */
export interface HtmlSponsorRoot {
  querySelectorAll(selector: string): ArrayLike<HtmlSponsorNode>
}

export interface HtmlSponsorNode {
  getAttribute(name: string): string | null
  textContent: string | null
}

/** 币种归一化：三位字母转大写照收（认不认识是显示层的事），其余一律当作人民币 */
export function normalizeCurrency(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY
}

/** 认领一个「名字 + 金额 + 币种」：名字空、金额不是有限数（或为负）就判为无效 */
export function toSponsorEntry(
  id: string,
  name: string,
  amount: unknown,
  currency?: unknown
): SponsorEntry | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  let value: number
  if (typeof amount === "number") {
    value = amount
  } else {
    // 空串会被 Number() 变成 0，所以先把「没写金额」挡掉
    const raw = String(amount ?? "").trim()
    if (!raw) return null
    value = Number(raw)
  }
  if (!Number.isFinite(value) || value < 0) return null
  return { id, name: trimmed, amount: value, currency: normalizeCurrency(currency) }
}

/** 按名字去重（保留先出现的那条）：同一个人改过金额时，不会算成两笔 */
function dedupe(entries: SponsorEntry[]): SponsorEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false
    seen.add(entry.name)
    return true
  })
}

/** 末列是不是币种码：三位字母（大小写都认，存的时候统一大写） */
function isCurrencyCode(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value)
}

/** 格式 A：TXT。见文件头部的格式说明 */
export function parseSponsorsTxt(text: string): SponsorParseResult {
  const entries: SponsorEntry[] = []
  const skipped: string[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const cut = line.lastIndexOf(",")
    if (cut < 0) {
      skipped.push(line)
      continue
    }
    // 末列写成三位字母就当币种（金额得再往前切一次）；不是就还是老写法：末列即金额。
    // 老写法里「名字带逗号」的那条规则因此不会被改坏。
    const tail = line.slice(cut + 1).trim()
    const currency = isCurrencyCode(tail) ? tail : undefined
    const amountCut = currency ? line.lastIndexOf(",", cut - 1) : cut
    if (amountCut < 0) {
      skipped.push(line)
      continue
    }
    const entry = toSponsorEntry(
      `sponsor-${entries.length + 1}`,
      line.slice(0, amountCut),
      line.slice(amountCut + 1, currency ? cut : undefined),
      currency
    )
    if (entry) entries.push(entry)
    else skipped.push(line)
  }

  return { entries: dedupe(entries), skipped }
}

/** 格式 B：HTML。`root` 传 `new DOMParser().parseFromString(html, "text/html")` */
export function parseSponsorsHtml(root: HtmlSponsorRoot): SponsorParseResult {
  const entries: SponsorEntry[] = []
  const skipped: string[] = []

  const nodes = root.querySelectorAll("[data-amount]")
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const name = node.textContent ?? ""
    const entry = toSponsorEntry(
      `sponsor-${entries.length + 1}`,
      name,
      node.getAttribute("data-amount"),
      node.getAttribute("data-currency")
    )
    if (entry) entries.push(entry)
    else skipped.push(name.trim() || "<空元素>")
  }

  return { entries: dedupe(entries), skipped }
}

/** 格式 C：JSON。接受 `SponsorEntry[]`、`{ sponsors: [...] }` 两种外形 */
export function parseSponsorsJson(text: string): SponsorParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], skipped: [`JSON 解析失败：${(error as Error).message}`] }
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { sponsors?: unknown })?.sponsors)
      ? ((parsed as { sponsors: unknown[] }).sponsors)
      : null
  if (!rows) return { entries: [], skipped: ["JSON 里没有 sponsors 数组"] }

  const entries: SponsorEntry[] = []
  const skipped: string[] = []
  rows.forEach((row, index) => {
    const item = row as Partial<SponsorEntry> | null
    const entry = item
      ? toSponsorEntry(
          String(item.id || `sponsor-${index + 1}`),
          String(item.name ?? ""),
          item.amount,
          item.currency
        )
      : null
    if (entry) entries.push(entry)
    else skipped.push(JSON.stringify(row))
  })

  return { entries: dedupe(entries), skipped }
}
