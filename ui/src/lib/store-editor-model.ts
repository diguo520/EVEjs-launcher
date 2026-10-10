/**
 * 伊甸币商城的纯逻辑：把服务端的两份记录**看成一件商品**来读写。
 *
 * 服务端里一件「游戏内商品」其实是两份记录，靠 `storeOfferID` 挂钩：
 *
 *   · **货架** `stores[<storeID>].offers[]`
 *     游戏内 FEATURED 网格读的就是它 —— `storeManagerService` 的
 *     `Handle_get_offers` / `get_categories` / `get_products` 全部走 `getLegacyCatalog(4)`。
 *     价格在 `offerPricings[].price`，**单位是 PLEX**。
 *
 *   · **收银台** `publicOffers[<storeOfferID>]`
 *     真正扣 PLEX 的那一份 —— `storeFulfillment.buildReceiptPayload` 读 `plexPriceInCents`，
 *     **单位是「分」**（1 PLEX = config.centsPerPlex 分）。
 *
 * 两份的同名字段（name / description / tags / imageUrl / preview / fulfillment /
 * canPurchase / label）在现有数据里是完全一致的 —— 也就是说它们本来就要手工保持同步。
 * 界面因此按「一件商品」呈现，编辑时**同时写两边**、价格换算成各自单位，
 * 绝不让「显示价」与「实扣价」分叉。
 *
 * 只有收银台记录、没有货架记录的商品（当前 31 条）游戏内不显示，那是公开收银台 /
 * 快速结账用的；反过来只有货架记录的商品游戏内**显示但点了买不了**
 * （结算时 `findPublicOffer` 查不到）。后一种是「以后加商品」必须避免的形态 ——
 * 新增一件游戏内商品要**两边一起写**。
 */

/** offer 里界面会改的字段就这几个，其余一律原样往返 */
export interface StoreOfferEdit {
  name: string
  description: string
  /** 已按逗号 / 中文逗号 / 空格切好的标签数组 */
  tags: string[]
  /** 以 PLEX 为单位的定价（货架直接存这个数，收银台按 centsPerPlex 换算成分） */
  plexPrice: number
  canPurchase: boolean
}

/** 收银台记录（`publicOffers`） */
export interface StorePublicOffer {
  storeOfferID?: string
  name?: string
  description?: string
  tags?: string[]
  imageUrl?: string
  /** 单位：分。实际扣 PLEX 就是它 ÷ centsPerPlex */
  plexPriceInCents?: number
  currencyCode?: string | null
  currencyAmountInCents?: number | null
  fulfillment?: Record<string, unknown>
  preview?: Record<string, unknown>
  source?: Record<string, unknown>
  canPurchase?: boolean
  label?: string | null
  [key: string]: unknown
}

/** 货架记录（`stores[<storeID>].offers[]`），游戏内网格的数据源 */
export interface StoreLegacyOffer {
  id?: number
  storeOfferID?: string
  name?: string
  description?: string
  tags?: string[]
  imageUrl?: string
  href?: string
  /** 单位：PLEX */
  offerPricings?: { currency?: string; price?: number; basePrice?: number }[]
  products?: unknown[]
  categories?: { id?: number }[]
  fulfillment?: Record<string, unknown>
  preview?: Record<string, unknown>
  canPurchase?: boolean
  singlePurchase?: boolean
  label?: string | null
  thirdpartyinfo?: unknown
  [key: string]: unknown
}

export interface StoreCatalog {
  storeID?: number
  name?: string
  categories?: unknown[]
  products?: unknown[]
  offers?: StoreLegacyOffer[]
  [key: string]: unknown
}

export interface StoreAuthority {
  meta: Record<string, unknown>
  config?: Record<string, unknown>
  stores: Record<string, StoreCatalog>
  publicOffers: Record<string, StorePublicOffer>
  fastCheckout?: Record<string, unknown>
  [key: string]: unknown
}

export interface StoreSummary {
  stores: number
  publicOffers: number
  legacyOffers: number
  /** 游戏内可见（有货架记录）的件数 */
  ingameOffers: number
  /** 游戏内可见但缺收银台记录：点了买不了 */
  unpurchasable: number
  fastCheckoutOffers: number
  quickPayTokens: number
  completedPurchases: number
  purchaseLogEntries: number
  runtimeAccounts: number
}

export interface StoreConfig {
  enabled?: boolean
  centsPerPlex?: number
  purchaseLogLimit?: number
  [key: string]: unknown
}

/** `storeEditor:read` / `storeEditor:save` 的回包 */
export interface StoreEditorSnapshot {
  ok: boolean
  supported?: boolean
  reason?: string
  generatedAt?: string
  summary?: StoreSummary
  config?: StoreConfig
  /** 整棵权威数据；写回时原样带回 */
  authority?: StoreAuthority
}

/** `ingame` = 游戏内可见（有货架记录）；`checkout` = 仅收银台 */
export type StoreRowKind = "ingame" | "checkout"

/** 界面里的一行 = 一件商品（货架 + 收银台两条记录合起来看） */
export interface StoreRow {
  /** storeOfferID，天然主键 */
  id: string
  kind: StoreRowKind
  /** 在 `stores[<storeID>].offers` 里的下标；没有货架记录时为 -1 */
  legacyIndex: number
  legacy: StoreLegacyOffer | null
  publicOffer: StorePublicOffer | null
}

/** 服务端没给 centsPerPlex 时的兜底：实测值是 100（1 PLEX = 100 分） */
export const DEFAULT_CENTS_PER_PLEX = 100

/** 游戏内商店固定用这个 storeID（服务端的 STORE_ID_INGAME） */
export const INGAME_STORE_ID = 4

export function centsPerPlexOf(config: StoreConfig | undefined): number {
  const value = Number(config?.centsPerPlex)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CENTS_PER_PLEX
}

/** 服务端存的分 → 界面显示的 PLEX。非有限数或负数一律当 0，不显示 NaN。 */
export function centsToPlex(cents: unknown, centsPerPlex: number): number {
  const value = Number(cents)
  if (!Number.isFinite(value) || value < 0) return 0
  return roundTo(value / centsPerPlex, 2)
}

/** 界面输入的 PLEX → 服务端的分。四舍五入到整分，负数归 0。 */
export function plexToCents(plex: unknown, centsPerPlex: number): number {
  const value = Number(plex)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(value * centsPerPlex)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function formatPlex(plex: number): string {
  return String(plex)
}

/**
 * 标签切分：逗号、中文逗号、空格都算分隔符，去空、去重、保序。
 * 与模组表单的「关联模组 id」保持一致 —— 同一个启动器里不该有两套切法。
 */
export function splitTags(text: string): string[] {
  const out: string[] = []
  for (const part of String(text ?? "").split(/[,，\s]+/)) {
    const tag = part.trim()
    if (tag !== "" && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** 货架记录上的 PLEX 价（`offerPricings` 里那一条 PLX） */
export function legacyPlexPriceOf(offer: StoreLegacyOffer | null | undefined): number {
  const list = Array.isArray(offer?.offerPricings) ? offer.offerPricings : []
  const plx = list.find((item) => String(item?.currency ?? "").toUpperCase() === "PLX") ?? list[0]
  const value = Number(plx?.price)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** 找到游戏内那个 store（默认 storeID=4），拿不到就退回第一个 */
export function catalogOf(
  authority: StoreAuthority | undefined,
): { key: string; store: StoreCatalog } | null {
  const stores = authority?.stores ?? {}
  const keys = Object.keys(stores)
  if (keys.length === 0) return null
  const key = keys.find((item) => Number(stores[item]?.storeID) === INGAME_STORE_ID) ?? keys[0]
  return { key, store: stores[key] }
}

export function legacyOffersOf(authority: StoreAuthority | undefined): StoreLegacyOffer[] {
  const offers = catalogOf(authority)?.store?.offers
  return Array.isArray(offers) ? offers : []
}

/**
 * 把两份记录合成界面用的行：**游戏内可见的排前面**，各自按 storeOfferID 排序
 * （排序稳定，滚动时位置不会跳）。
 */
export function rowsOf(authority: StoreAuthority | undefined): StoreRow[] {
  const rows = new Map<string, StoreRow>()
  legacyOffersOf(authority).forEach((offer, index) => {
    const id = String(offer?.storeOfferID ?? "").trim()
    if (id === "") return
    rows.set(id, { id, kind: "ingame", legacyIndex: index, legacy: offer, publicOffer: null })
  })
  for (const [id, offer] of Object.entries(authority?.publicOffers ?? {})) {
    const existing = rows.get(id)
    if (existing) existing.publicOffer = offer
    else rows.set(id, { id, kind: "checkout", legacyIndex: -1, legacy: null, publicOffer: offer })
  }
  return [...rows.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "ingame" ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/** 游戏内可见但查不到收银台记录 —— 点了会买不了，界面必须提示 */
export function isUnpurchasable(row: StoreRow): boolean {
  return row.kind === "ingame" && !row.publicOffer
}

/** 界面草稿：有货架记录就以货架为准（那才是游戏里看到的），否则看收银台 */
export function draftOfRow(row: StoreRow, centsPerPlex: number): StoreOfferEdit {
  if (row.legacy) {
    return {
      name: String(row.legacy.name ?? ""),
      description: String(row.legacy.description ?? ""),
      tags: Array.isArray(row.legacy.tags) ? [...row.legacy.tags] : [],
      plexPrice: legacyPlexPriceOf(row.legacy),
      canPurchase: row.legacy.canPurchase !== false,
    }
  }
  const offer = row.publicOffer ?? {}
  return {
    name: String(offer.name ?? ""),
    description: String(offer.description ?? ""),
    tags: Array.isArray(offer.tags) ? [...offer.tags] : [],
    plexPrice: centsToPlex(offer.plexPriceInCents, centsPerPlex),
    canPurchase: offer.canPurchase !== false,
  }
}

/** 搜索：商品名、storeOfferID 或标签，大小写不敏感 */
export function matchesQuery(row: StoreRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  if (row.id.toLowerCase().includes(q)) return true
  const draft = draftOfRow(row, DEFAULT_CENTS_PER_PLEX)
  if (draft.name.toLowerCase().includes(q)) return true
  return draft.tags.some((tag) => String(tag).toLowerCase().includes(q))
}

/** 编辑器与上架向导共用的文本字段（校验只用到这几个） */
export interface StoreTextFields {
  name: string
  description: string
  tags: string[]
  plexPrice: number
}

/**
 * 商品文本只接受可打印 ASCII。
 *
 * 原因不是洁癖：游戏客户端按 **Latin-1** 解这些字段，中文进去一定变乱码 ——
 * 实测「旭日级」在商城卡片上显示成 `ÇœŽÈ±¹Çº§`。所以名称 / 描述 / 标签一律拦掉非 ASCII。
 * （`\x09`/`\x0A`/`\x0D` 放行，描述里可以有换行。）
 */
export function isAsciiOnly(text: string): boolean {
  return /^[\x09\x0A\x0D\x20-\x7E]*$/.test(String(text ?? ""))
}

/**
 * 草稿校验。返回中文提示（界面用 t() 包一层显示）。
 * 只在草稿非法时出现，保存会被拦住。
 */
export function draftErrorsOf(draft: StoreTextFields): string[] {
  const errors: string[] = []
  if (draft.name.trim() === "") {
    errors.push("商品名不能为空")
  } else if (!isAsciiOnly(draft.name)) {
    errors.push("商品名只能用英文：客户端显示不了中文，会变成乱码")
  }
  if (!Number.isFinite(draft.plexPrice) || draft.plexPrice < 0) {
    errors.push("PLEX 价格必须是不小于 0 的数字")
  }
  if (draft.description.trim() !== "" && !isAsciiOnly(draft.description)) {
    errors.push("描述只能用英文：客户端显示不了中文，会变成乱码")
  }
  if (draft.tags.some((tag) => !isAsciiOnly(tag))) {
    errors.push("标签只能用英文：客户端显示不了中文，会变成乱码")
  }
  return errors
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}

export function isRowChanged(row: StoreRow, draft: StoreOfferEdit, centsPerPlex: number): boolean {
  const base = draftOfRow(row, centsPerPlex)
  return (
    base.name !== draft.name ||
    base.description !== draft.description ||
    base.plexPrice !== draft.plexPrice ||
    base.canPurchase !== draft.canPurchase ||
    !sameTags(base.tags, draft.tags)
  )
}

/** 动过的行 id（有序，便于界面显示条数） */
export function changedRowIDs(
  authority: StoreAuthority | undefined,
  drafts: Record<string, StoreOfferEdit>,
  centsPerPlex: number,
): string[] {
  return rowsOf(authority)
    .filter((row) => drafts[row.id] && isRowChanged(row, drafts[row.id], centsPerPlex))
    .map((row) => row.id)
    .sort((a, b) => a.localeCompare(b))
}

/** 货架记录的写回：只覆盖界面管得着的字段，其余原样带回 */
function mergeLegacyOffer(offer: StoreLegacyOffer, draft: StoreOfferEdit): StoreLegacyOffer {
  const pricings = Array.isArray(offer.offerPricings)
    ? offer.offerPricings.map((item) => ({ ...item }))
    : []
  const plx = pricings.find((item) => String(item?.currency ?? "").toUpperCase() === "PLX")
  if (plx) {
    plx.price = draft.plexPrice
    plx.basePrice = draft.plexPrice
  } else {
    pricings.push({ currency: "PLX", price: draft.plexPrice, basePrice: draft.plexPrice })
  }
  return {
    ...offer,
    name: draft.name,
    description: draft.description,
    tags: [...draft.tags],
    canPurchase: draft.canPurchase,
    offerPricings: pricings,
  }
}

/**
 * 整棵写回：动过的行**两边一起写** ——
 * 货架写 `offerPricings[PLX].price`（PLEX），收银台写 `plexPriceInCents`（分）。
 * 返回新对象，不改入参；没改动时原样返回入参（React 靠引用变化重渲染）。
 */
export function applyEdits(
  authority: StoreAuthority | undefined,
  drafts: Record<string, StoreOfferEdit>,
  centsPerPlex: number,
): StoreAuthority | null {
  if (!authority) return null
  const rows = rowsOf(authority)
  const changed = rows.filter(
    (row) => drafts[row.id] && isRowChanged(row, drafts[row.id], centsPerPlex),
  )
  if (changed.length === 0) return authority

  const catalog = catalogOf(authority)
  const offers = catalog && Array.isArray(catalog.store.offers) ? [...catalog.store.offers] : null
  const publicOffers = { ...authority.publicOffers }

  for (const row of changed) {
    const draft = drafts[row.id]
    if (offers && row.legacyIndex >= 0) {
      offers[row.legacyIndex] = mergeLegacyOffer(offers[row.legacyIndex], draft)
    }
    if (row.publicOffer) {
      const offer = row.publicOffer
      const merged: StorePublicOffer = {
        ...offer,
        name: draft.name,
        description: draft.description,
        tags: [...draft.tags],
      }
      // `null` / 缺省是有语义的：这份商品不走 PLEX 定价（例如只收 USD 的礼包）。
      // 只在用户**确实动过价**的时候才写回数字，否则保持原样 —— 一把 null 归成 0
      // 就等于把「不卖 PLEX」改成「0 PLEX」，那是界面没让用户做的改动。
      const basePlex = centsToPlex(offer.plexPriceInCents, centsPerPlex)
      const hadPlex = offer.plexPriceInCents !== null && offer.plexPriceInCents !== undefined
      if (hadPlex || draft.plexPrice !== basePlex) {
        merged.plexPriceInCents = plexToCents(draft.plexPrice, centsPerPlex)
      }
      // 同理：缺省 canPurchase 就是「可买」，用户没动过就别凭空补一个键上去
      if (offer.canPurchase !== undefined || draft.canPurchase === false) {
        merged.canPurchase = draft.canPurchase
      }
      publicOffers[row.id] = merged
    }
  }

  const stores =
    catalog && offers
      ? { ...authority.stores, [catalog.key]: { ...catalog.store, offers } }
      : authority.stores
  return { ...authority, stores, publicOffers }
}

/** 侧车返回的摘要缺失时，就地按权威数据算一份，界面不显示空白 */
export function summaryOfAuthority(authority: StoreAuthority | undefined): StoreSummary {
  const stores = authority?.stores ?? {}
  const legacyOffers = legacyOffersOf(authority)
  const fastCheckout = authority?.fastCheckout ?? {}
  const legacyIDs = new Set(
    legacyOffers.map((offer) => String(offer?.storeOfferID ?? "").trim()).filter((id) => id !== ""),
  )
  return {
    stores: Object.keys(stores).length,
    publicOffers: Object.keys(authority?.publicOffers ?? {}).length,
    legacyOffers: legacyOffers.length,
    ingameOffers: legacyIDs.size,
    unpurchasable: [...legacyIDs].filter((id) => !authority?.publicOffers?.[id]).length,
    fastCheckoutOffers: Array.isArray((fastCheckout as { offers?: unknown[] }).offers)
      ? (fastCheckout as { offers: unknown[] }).offers.length
      : 0,
    quickPayTokens: Object.keys((fastCheckout as { tokensByID?: object }).tokensByID ?? {}).length,
    completedPurchases: 0,
    purchaseLogEntries: 0,
    runtimeAccounts: 0,
  }
}

/** 现金定价（收银台记录上才有）；没有就空串 */
export function currencyTextOf(offer: StorePublicOffer): string {
  const code = String(offer.currencyCode ?? "").trim()
  const amount = Number(offer.currencyAmountInCents)
  if (!code || !Number.isFinite(amount)) return ""
  return `${code} ${roundTo(amount / 100, 2)}`
}

/** 发货类型：fulfillment.kind 是服务端的自由结构，界面只展示不解释 */
export function fulfillmentKindOf(row: StoreRow): string {
  const holder = (row.publicOffer?.fulfillment ?? row.legacy?.fulfillment) as
    | { kind?: unknown }
    | undefined
  const value = holder?.kind
  return typeof value === "string" && value.trim() !== "" ? value : ""
}

/* ==================================================================== *
 *                            上架新商品                                *
 * ==================================================================== */

/**
 * 向导支持的发货方式。服务端一共 5 种，`bundle`（多条目 grants 数组）先不做 ——
 * 现有 18 条 bundle 都是付费礼包，UI 要多一层"多条发放项"的编辑器。
 */
export type StoreFulfillmentKind = "item" | "omega" | "mct" | "grant_plex" | "bundle"

/** 组合包里的一项：要么发物品，要么发技能点（服务端 bundle.grants 的两种形状） */
export interface StoreBundleGrantItem {
  kind: "item"
  typeID: number
  quantity: number
}

export interface StoreBundleGrantSkillPoints {
  kind: "skill_points"
  points: number
}

export type StoreBundleGrant = StoreBundleGrantItem | StoreBundleGrantSkillPoints

/** `storeEditor:itemLookup` 回包里的一条 */
export interface StoreItemInfo {
  typeID: number
  /** 在服务端物品库里找不找得到 —— 找不到就不能上架（买了拿不到货） */
  known: boolean
  name: string
  groupName: string
  iconID: number | null
  /** 客户端图标路径；空串表示这个物品在客户端里没有图标（游戏内画问号） */
  imageUrl: string
}

/** 非物品类发货方式的固定图标 —— 实测现有数据用的就是这几个 */
export const KIND_DEFAULT_IMAGE: Record<Exclude<StoreFulfillmentKind, "item">, string> = {
  omega: "res:/UI/Texture/classes/PlexVault/UpgradeOmega.png",
  mct: "res:/UI/Texture/Icons/multiple_training.png",
  grant_plex: "res:/UI/Texture/Plex/plex_128_gradient_yellow.png",
  bundle: "res:/ui/texture/icons/99_64_9.png",
}

export type StoreFulfillmentKindWithImage = Exclude<StoreFulfillmentKind, "item">

export interface StoreNewOfferDraft {
  kind: StoreFulfillmentKind
  /** 单件物品用 */
  typeID: number
  quantity: number
  /** omega / mct 用 */
  durationDays: number
  /** mct 用 */
  slotCount: number
  /** grant_plex 用 */
  plexAmount: number
  /** bundle 用：多条发放项 */
  grants: StoreBundleGrant[]
  name: string
  description: string
  tags: string[]
  plexPrice: number
  categoryID: number
  /** 客户端图标路径；item 由查物品结果填入，其余按发货方式取固定图 */
  imageUrl: string
}

export function emptyNewOfferDraft(categoryID = 0): StoreNewOfferDraft {
  return {
    kind: "item",
    typeID: 0,
    quantity: 1,
    durationDays: 30,
    slotCount: 1,
    plexAmount: 100,
    grants: [{ kind: "item", typeID: 0, quantity: 1 }],
    name: "",
    description: "",
    tags: [],
    plexPrice: 100,
    categoryID,
    imageUrl: "",
  }
}

/** 发货方式换了就重置另一侧的参数，避免把无用字段写进 offer */
export function withKind(draft: StoreNewOfferDraft, kind: StoreFulfillmentKind): StoreNewOfferDraft {
  const next: StoreNewOfferDraft = { ...draft, kind }
  if (kind === "item") {
    next.imageUrl = ""
  } else {
    next.typeID = 0
    next.imageUrl = KIND_DEFAULT_IMAGE[kind as StoreFulfillmentKindWithImage]
  }
  return next
}

/** 选好物品后按它的图标填 imageUrl（可能是空串 = 客户端没图标） */
export function withItem(
  draft: StoreNewOfferDraft,
  item: StoreItemInfo | null,
): StoreNewOfferDraft {
  if (!item) return { ...draft, typeID: 0, imageUrl: "" }
  return {
    ...draft,
    typeID: item.typeID,
    imageUrl: item.imageUrl,
    name: draft.name.trim() === "" ? item.name : draft.name,
  }
}

export function buildFulfillment(draft: StoreNewOfferDraft): Record<string, unknown> {
  switch (draft.kind) {
    case "omega":
      return { kind: "omega", durationDays: Math.trunc(draft.durationDays) }
    case "mct":
      return {
        kind: "mct",
        durationDays: Math.trunc(draft.durationDays),
        slotCount: Math.trunc(draft.slotCount),
      }
    case "grant_plex":
      return { kind: "grant_plex", plexAmount: Math.trunc(draft.plexAmount) }
    case "bundle":
      return {
        kind: "bundle",
        grants: draft.grants.map((grant) =>
          grant.kind === "item"
            ? { kind: "item", typeID: Math.trunc(grant.typeID), quantity: Math.trunc(grant.quantity) }
            : { kind: "skill_points", points: Math.trunc(grant.points) },
        ),
      }
    case "item":
    default:
      return {
        kind: "item",
        quantity: Math.trunc(draft.quantity),
        typeID: Math.trunc(draft.typeID),
      }
  }
}

/** storeOfferID / href 用的 slug */
export function slugify(text: string): string {
  const slug = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return slug === "" ? "offer" : slug
}

export function hrefSlug(slug: string): string {
  return slug.replace(/_/g, "-")
}

/** 与已有 storeOfferID 不撞车 */
export function uniqueStoreOfferID(authority: StoreAuthority | undefined, base: string): string {
  const taken = new Set(rowsOf(authority).map((row) => row.id))
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}_${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${Date.now()}`
}

/** 货架 offer 的 id 从现有最大值 +1；没有货架记录时从 9200001 起 */
export function nextShelfOfferID(authority: StoreAuthority | undefined): number {
  const ids = legacyOffersOf(authority)
    .map((offer) => Number(offer?.id))
    .filter((value) => Number.isFinite(value) && value > 0)
  return ids.length === 0 ? 9200001 : Math.max(...ids) + 1
}

/** 商品目录的 id 同样从最大值 +1 */
export function nextProductID(authority: StoreAuthority | undefined): number {
  const products = catalogOf(authority)?.store?.products
  const ids = (Array.isArray(products) ? products : [])
    .map((item) => Number((item as { id?: unknown })?.id))
    .filter((value) => Number.isFinite(value) && value > 0)
  return ids.length === 0 ? 9100001 : Math.max(...ids) + 1
}

/** 分类下拉用：现有 9 个 */
export function categoriesOf(authority: StoreAuthority | undefined): { id: number; name: string }[] {
  const categories = catalogOf(authority)?.store?.categories
  return (Array.isArray(categories) ? categories : [])
    .map((item) => {
      const record = item as { id?: unknown; name?: unknown }
      return { id: Number(record?.id), name: String(record?.name ?? "") }
    })
    .filter((item) => Number.isFinite(item.id) && item.id > 0)
}

/** 卡片预览：服务端存的是这个结构，游戏内网格画的就是它 */
export function buildPreview(draft: StoreNewOfferDraft): Record<string, unknown> {
  const theme = PREVIEW_THEMES[draft.kind]
  return {
    accent: theme.accent,
    secondary: theme.secondary,
    foreground: theme.foreground,
    imageMode: "generated",
    badge: theme.badge,
    title: draft.name,
    subtitle: draft.description,
  }
}

const PREVIEW_THEMES: Record<StoreFulfillmentKind, { accent: string; secondary: string; foreground: string; badge: string }> = {
  item: { accent: "#81a8ff", secondary: "#1e325b", foreground: "#f2f7ff", badge: "ITEM" },
  omega: { accent: "#f0c14b", secondary: "#5d3a00", foreground: "#fff8ec", badge: "OMEGA" },
  mct: { accent: "#7dd3a0", secondary: "#1d4030", foreground: "#f2fff7", badge: "MCT" },
  grant_plex: { accent: "#f7b955", secondary: "#5a3b00", foreground: "#fff9ef", badge: "PLEX" },
  bundle: { accent: "#9ad1ff", secondary: "#17334f", foreground: "#f2f9ff", badge: "BUNDLE" },
}

/**
 * 上架前校验。errors 会挡住保存；warnings 只提示（例如物品在客户端里没有图标，
 * 游戏内会画问号 —— 这是物品本身的问题，不该阻止上架）。
 */
export function validateNewOffer(
  authority: StoreAuthority | undefined,
  draft: StoreNewOfferDraft,
  known: StoreItemInfo[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = draftErrorsOf(draft)
  const warnings: string[] = []
  const byID = new Map(known.map((entry) => [entry.typeID, entry]))

  if (draft.kind === "item") {
    // 以「选中的物品」为准：还没选（查不到）与「选了但服务端不认」是两回事，
    // 报错文案必须分开 —— 前者是还没挑，后者是挑了也不能上架。
    const item = byID.get(draft.typeID) ?? null
    if (!item || !Number.isFinite(item.typeID) || item.typeID <= 0) {
      errors.push("请先选择要上架的物品")
    } else if (!item.known) {
      errors.push("这个物品不在服务端物品库里，上架后买了拿不到货")
    } else if (item.imageUrl === "") {
      warnings.push("这个物品在客户端里没有图标，请另选一张图片")
    }
    if (!Number.isInteger(draft.quantity) || draft.quantity < 1) {
      errors.push("数量必须是不小于 1 的整数")
    }
  }

  if (draft.kind === "bundle") {
    if (draft.grants.length === 0) errors.push("组合包至少要有一项发放内容")
    for (const grant of draft.grants) {
      if (grant.kind === "skill_points") {
        if (!Number.isInteger(grant.points) || grant.points < 1) {
          errors.push("技能点必须是不小于 1 的整数")
        }
        continue
      }
      const item = byID.get(grant.typeID) ?? null
      if (!item) errors.push("组合包里有物品还没选")
      else if (!item.known) errors.push("组合包里有物品不在服务端物品库里，上架后买了拿不到货")
      if (!Number.isInteger(grant.quantity) || grant.quantity < 1) {
        errors.push("组合包里的数量必须是不小于 1 的整数")
      }
    }
  }
  if (draft.kind === "omega" || draft.kind === "mct") {
    if (!Number.isInteger(draft.durationDays) || draft.durationDays < 1) {
      errors.push("天数必须是不小于 1 的整数")
    }
  }
  if (draft.kind === "mct" && (!Number.isInteger(draft.slotCount) || draft.slotCount < 1)) {
    errors.push("槽位数必须是不小于 1 的整数")
  }
  if (draft.kind === "grant_plex" && (!Number.isInteger(draft.plexAmount) || draft.plexAmount < 1)) {
    errors.push("发放的 PLEX 数量必须是不小于 1 的整数")
  }
  if (draft.imageUrl.trim() === "") {
    errors.push("请为这件商品选一个图片，否则游戏里只会显示占位图")
  }
  if (!Number.isFinite(draft.categoryID) || draft.categoryID <= 0) {
    errors.push("请选择一个分类")
  }
  if (catalogOf(authority) === null) {
    errors.push("读不到游戏内商店目录，无法上架")
  }
  return { errors, warnings }
}

/** 这次上架需要向服务端核对的 typeID（item 一个，bundle 每个物品一项） */
export function collectTypeIDs(draft: StoreNewOfferDraft): number[] {
  if (draft.kind === "item") return draft.typeID > 0 ? [draft.typeID] : []
  if (draft.kind === "bundle") {
    return draft.grants
      .filter((grant): grant is StoreBundleGrantItem => grant.kind === "item" && grant.typeID > 0)
      .map((grant) => grant.typeID)
  }
  return []
}

/**
 * 「已经证明能显示」的图片路径：从现有 offer 里收集，去掉客户端的占位符
 * （`itemIcons.iconsByID["0"]` —— 现有 4 条游戏内画问号的商品用的就是它）。
 * 给没有图标的物品当替代图用：宁可让用户从这些里挑，也不要编一个不存在的路径。
 */
export function knownGoodImages(
  authority: StoreAuthority | undefined,
  placeholder: string,
): string[] {
  const out = new Set<string>()
  for (const row of rowsOf(authority)) {
    for (const url of [row.legacy?.imageUrl, row.publicOffer?.imageUrl]) {
      const text = String(url ?? "").trim()
      if (text === "" || text === placeholder) continue
      out.add(text)
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

/**
 * 删除商品：**四处一起删** —— 货架 offer、商品目录 products（按 offer 内嵌的 product id
 * 反查）、offer 自己的 products[]、收银台的 publicOffers。只删一半会让游戏里留下
 * 「点了买不了」或「目录里有、货架上没有」的残骸。
 */
export function removeOffers(
  authority: StoreAuthority | undefined,
  ids: string[],
): StoreAuthority | null {
  if (!authority) return null
  const doomed = new Set(ids.filter((id) => String(id ?? "").trim() !== ""))
  if (doomed.size === 0) return authority

  const catalog = catalogOf(authority)
  if (!catalog) return authority
  const allOffers = Array.isArray(catalog.store.offers) ? catalog.store.offers : []

  const removedProductIDs = new Set<number>()
  for (const offer of allOffers) {
    const id = String(offer?.storeOfferID ?? "").trim()
    if (!doomed.has(id)) continue
    for (const product of Array.isArray(offer.products) ? offer.products : []) {
      const productID = Number((product as { id?: unknown })?.id)
      if (Number.isFinite(productID)) removedProductIDs.add(productID)
    }
  }

  const offers = allOffers.filter((offer) => !doomed.has(String(offer?.storeOfferID ?? "").trim()))
  const products = (Array.isArray(catalog.store.products) ? catalog.store.products : []).filter(
    (product) => !removedProductIDs.has(Number((product as { id?: unknown })?.id)),
  )
  const publicOffers = { ...authority.publicOffers }
  for (const id of doomed) delete publicOffers[id]

  return {
    ...authority,
    stores: { ...authority.stores, [catalog.key]: { ...catalog.store, offers, products } },
    publicOffers,
  }
}

/**
 * 上架：**一次写全 4 处** —— 货架 offer、商品目录 products、货架 offer 内嵌的 products[]，
 * 以及收银台的 publicOffers。少写任何一处，游戏里要么不显示、要么点了买不了。
 * 返回新 authority，不改入参。
 */
export function addOffer(
  authority: StoreAuthority | undefined,
  draft: StoreNewOfferDraft,
  centsPerPlex: number,
): StoreAuthority | null {
  const catalog = catalogOf(authority)
  if (!authority || !catalog) return null

  const fulfillment = buildFulfillment(draft)
  const preview = buildPreview(draft)
  const slug = uniqueStoreOfferID(authority, slugify(draft.name))
  const shelfID = nextShelfOfferID(authority)
  const productID = nextProductID(authority)
  const price = draft.plexPrice

  const shelfOffer: StoreLegacyOffer = {
    id: shelfID,
    storeOfferID: slug,
    name: draft.name,
    description: draft.description,
    tags: [...draft.tags],
    imageUrl: draft.imageUrl,
    href: `/store/${INGAME_STORE_ID}/offers/${hrefSlug(slug)}`,
    offerPricings: [{ currency: "PLX", price, basePrice: price }],
    products: [
      {
        id: productID,
        typeId: draft.kind === "item" ? draft.typeID : 0,
        quantity: draft.kind === "item" ? draft.quantity : 1,
        productName: draft.name,
        imageUrl: draft.imageUrl,
      },
    ],
    categories: [{ id: draft.categoryID }],
    fulfillment,
    preview,
    canPurchase: true,
    singlePurchase: false,
    label: null,
    thirdpartyinfo: null,
  }

  const publicOffer: StorePublicOffer = {
    storeOfferID: slug,
    name: draft.name,
    description: draft.description,
    tags: [...draft.tags],
    imageUrl: draft.imageUrl,
    plexPriceInCents: plexToCents(price, centsPerPlex),
    currencyCode: null,
    currencyAmountInCents: null,
    fulfillment,
    preview,
    canPurchase: true,
    source: { kind: "launcher-added", addedAt: new Date().toISOString() },
  }

  const offers = [...(catalog.store.offers ?? []), shelfOffer]
  const products = [
    ...(Array.isArray(catalog.store.products) ? catalog.store.products : []),
    { id: productID, name: draft.name, href: `/store/${INGAME_STORE_ID}/products/${hrefSlug(slug)}` },
  ]

  return {
    ...authority,
    stores: { ...authority.stores, [catalog.key]: { ...catalog.store, offers, products } },
    publicOffers: { ...authority.publicOffers, [slug]: publicOffer },
  }
}
