import { useEffect, useMemo, useState } from "react"
import { Loader2, PackagePlus, Plus, Search, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { t } from "@/lib/i18n"
import {
  categoriesOf,
  collectTypeIDs,
  emptyNewOfferDraft,
  isAsciiOnly,
  splitTags,
  validateNewOffer,
  withKind,
  type StoreAuthority,
  type StoreFulfillmentKind,
  type StoreItemInfo,
  type StoreNewOfferDraft,
} from "@/lib/store-editor-model"
import { cn } from "@/lib/utils"

/** `ui/src/data/items.json` 的一行：[typeID, 中文名, 英文名, 分组, 分类] */
type RawItem = [number, string, string, string, string]

/**
 * 26,896 条的物品表跟着标签页同源走、按需拉取（`?raw` 动态导入，独立 chunk）。
 * 解析结果缓存在模块级：反复开关向导不再重解析 2.65 MB。
 */
let itemCache: RawItem[] | null = null
let itemPending: Promise<RawItem[]> | null = null
function loadItems(): Promise<RawItem[]> {
  if (itemCache) return Promise.resolve(itemCache)
  if (!itemPending) {
    itemPending = import("@/data/items.json?raw").then((mod) => {
      const rows = JSON.parse(mod.default as string) as RawItem[]
      itemCache = rows
      return rows
    })
  }
  return itemPending
}

const KINDS: { id: StoreFulfillmentKind; label: string }[] = [
  { id: "item", label: "单件物品" },
  { id: "bundle", label: "组合包" },
  { id: "omega", label: "Omega 时长" },
  { id: "mct", label: "多角色训练槽" },
  { id: "grant_plex", label: "发放 PLEX" },
]

/**
 * 上架新商品向导。
 *
 * 上架一件游戏内商品要**同时写 4 处**（货架 offer、商品目录 products、offer 内嵌的
 * products[]、收银台的 publicOffers）—— 少写任何一处，游戏里要么不显示、要么点了买不了。
 * 这些全在模型的 `addOffer` 里做，向导只负责收集参数与事前校验。
 *
 * 两条硬规则：
 *   · **名称 / 描述 / 标签只收可打印 ASCII**。客户端按 Latin-1 解这些字段，中文一定会
 *     显示成乱码（实测「旭日级」变成 `ÇœŽÈ±¹Çº§`），所以模型层直接拦。
 *   · **图片必填**。物品的图标由服务端物品库决定（itemIcons 表）；大部分矿石 / 舰船在
 *     客户端里根本没有图标，这时不能给个猜的路径 —— 界面改成让用户从「现有商品用过、
 *     已证明能显示」的图片里挑，或者自己填。
 */
export function StoreAddOfferDialog({
  authority,
  knownImages,
  placeholderImageUrl,
  lookupItems,
  onAdd,
  onClose,
}: {
  authority: StoreAuthority | null
  knownImages: string[]
  placeholderImageUrl: string
  lookupItems: (typeIDs: number[]) => Promise<StoreItemInfo[]>
  onAdd: (draft: StoreNewOfferDraft) => void
  onClose: () => void
}) {
  const categories = useMemo(() => categoriesOf(authority ?? undefined), [authority])
  const [draft, setDraft] = useState<StoreNewOfferDraft>(() =>
    emptyNewOfferDraft(categories[0]?.id ?? 0),
  )
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<RawItem[] | null>(null)
  const [known, setKnown] = useState<StoreItemInfo[]>([])
  const [probing, setProbing] = useState(false)

  useEffect(() => {
    let alive = true
    void loadItems().then((rows) => {
      if (alive) setItems(rows)
    })
    return () => {
      alive = false
    }
  }, [])

  const typeIDs = useMemo(() => collectTypeIDs(draft), [draft])
  const typeKey = typeIDs.join(",")

  // 发货方式或选中的物品一变，就去服务端核一遍（顺带拿图标）
  useEffect(() => {
    let alive = true
    const ids = typeKey === "" ? [] : typeKey.split(",").map((value) => Number(value))
    if (ids.length === 0) {
      setKnown([])
      return
    }
    setProbing(true)
    void lookupItems(ids).then((list) => {
      if (!alive) return
      setKnown(list)
      setProbing(false)
      // 物品自带图标且用户还没填图，就直接用它的
      const first = list.find((item) => item.known && item.imageUrl !== "")
      if (first) {
        setDraft((prev) => (prev.imageUrl.trim() === "" ? { ...prev, imageUrl: first.imageUrl } : prev))
      }
    })
    return () => {
      alive = false
    }
  }, [typeKey, lookupItems])

  const results = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    if (q === "") return items.slice(0, 30)
    return items
      .filter(
        (row) =>
          String(row[0]).includes(q) ||
          String(row[1] ?? "").toLowerCase().includes(q) ||
          String(row[2] ?? "").toLowerCase().includes(q),
      )
      .slice(0, 30)
  }, [items, query])

  const { errors, warnings } = useMemo(
    () => validateNewOffer(authority ?? undefined, draft, known),
    [authority, draft, known],
  )
  const canSubmit = errors.length === 0

  const nameOf = (typeID: number) =>
    known.find((item) => item.typeID === typeID)?.name ??
    items?.find((row) => Number(row[0]) === typeID)?.[1] ??
    String(typeID)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("上架新商品")}</DialogTitle>
          <DialogDescription>
            {t("上架后会写进游戏货架与商品目录，点「保存商城」才真正落盘")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("发货方式")}</Label>
            <div className="flex flex-wrap gap-1">
              {KINDS.map((item) => (
                <Button
                  key={item.id}
                  variant={draft.kind === item.id ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setDraft((prev) => withKind(prev, item.id))}
                >
                  {t(item.label)}
                </Button>
              ))}
            </div>
          </div>

          {draft.kind === "item" || draft.kind === "bundle" ? (
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("选择物品")}</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("搜索物品名或 ID")}
                  className="h-8 pl-8 text-[12px]"
                />
              </div>
              <ScrollArea className="h-36 rounded-lg border border-border/60">
                {items === null ? (
                  <p className="p-3 text-[12px] text-muted-foreground">{t("正在载入物品表…")}</p>
                ) : results.length === 0 ? (
                  <p className="p-3 text-[12px] text-muted-foreground">{t("没有匹配的物品")}</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {results.map((row) => (
                      <li key={row[0]}>
                        <button
                          type="button"
                          onClick={() => {
                            const typeID = Number(row[0])
                            setDraft((prev) =>
                              prev.kind === "item"
                                ? { ...prev, typeID, name: prev.name.trim() === "" ? (row[2] || row[1]) : prev.name }
                                : {
                                    ...prev,
                                    grants: [...prev.grants, { kind: "item", typeID, quantity: 1 }],
                                  },
                            )
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50",
                            draft.kind === "item" && draft.typeID === Number(row[0]) && "bg-primary/10",
                          )}
                        >
                          <span className="font-mono text-[10px] text-tertiary">{row[0]}</span>
                          <span className="text-[12px]">{row[2] || row[1]}</span>
                          <span className="truncate text-[10px] text-tertiary">{row[1]}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-tertiary">{row[3]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>

              {draft.kind === "bundle" ? (
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">{t("组合包内容")}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          grants: [...prev.grants, { kind: "skill_points", points: 100000 }],
                        }))
                      }
                    >
                      <Plus />
                      {t("添加技能点")}
                    </Button>
                  </div>
                  {draft.grants.length === 0 ? (
                    <p className="text-[11px] text-tertiary">{t("组合包至少要有一项发放内容")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {draft.grants.map((grant, index) => (
                        <li key={index} className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-[11px] text-muted-foreground">
                            {grant.kind === "skill_points" ? t("技能点") : t("物品")}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px]">
                            {grant.kind === "skill_points" ? `${grant.points}` : nameOf(grant.typeID)}
                          </span>
                          <Input
                            type="number"
                            min={1}
                            value={grant.kind === "skill_points" ? grant.points : grant.quantity}
                            onChange={(event) => {
                              const value = Number(event.target.value || 0)
                              setDraft((prev) => ({
                                ...prev,
                                grants: prev.grants.map((item, at) =>
                                  at !== index
                                    ? item
                                    : item.kind === "skill_points"
                                      ? { kind: "skill_points", points: value }
                                      : { kind: "item", typeID: item.typeID, quantity: value },
                                ),
                              }))
                            }}
                            className="h-7 w-24 tabular text-[12px]"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDraft((prev) => ({
                                ...prev,
                                grants: prev.grants.filter((_, at) => at !== index),
                              }))
                            }
                          >
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed">
                  {probing ? (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      {t("正在核对服务端物品库…")}
                    </span>
                  ) : draft.typeID > 0 ? (
                    <span className="text-muted-foreground">
                      {t("已选物品")}：<span className="text-foreground">{nameOf(draft.typeID)}</span>
                      <span className="ml-2 font-mono text-[10px] text-tertiary">{draft.typeID}</span>
                    </span>
                  ) : (
                    <span className="text-tertiary">{t("请先选择要上架的物品")}</span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed text-tertiary">
              {t("这类商品的图片由发货方式决定，不用挑")}
            </p>
          )}

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("图片")}</Label>
            <div className="flex items-center gap-2">
              <Input
                value={draft.imageUrl}
                onChange={(event) => setDraft((prev) => ({ ...prev, imageUrl: event.target.value }))}
                placeholder="res:/UI/Texture/..."
                className={cn(
                  "h-8 font-mono text-[11px]",
                  draft.imageUrl.trim() === "" && "border-destructive/60",
                )}
              />
              {knownImages.length > 0 ? (
                <Select
                  value=""
                  onValueChange={(value) => setDraft((prev) => ({ ...prev, imageUrl: value }))}
                >
                  <SelectTrigger className="h-8 w-[180px] shrink-0 text-[11px]">
                    <SelectValue placeholder={t("从现有商品用过的图片里挑")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-[260px]">
                    {knownImages.map((url) => (
                      <SelectItem key={url} value={url} className="font-mono text-[10px]">
                        {url.replace("res:/", "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <p className="text-[10px] leading-relaxed text-tertiary">
              {draft.imageUrl.trim() === ""
                ? t("图片必填：留空游戏里只会显示灰色占位图")
                : placeholderImageUrl !== "" && draft.imageUrl.trim() === placeholderImageUrl
                  ? t("这是客户端的占位图路径，游戏里会显示斜叉，请换一个")
                  : draft.imageUrl}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("商品名")}</Label>
              <Input
                value={draft.name}
                onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                className={cn("h-8 text-[12px]", !isAsciiOnly(draft.name) && "border-destructive/60")}
              />
              <p className="text-[10px] text-tertiary">{t("只能用英文，中文在游戏里会变成乱码")}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("分类")}</Label>
              <Select
                value={draft.categoryID > 0 ? String(draft.categoryID) : ""}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, categoryID: Number(value) }))}
              >
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue placeholder={t("请选择一个分类")} />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)} className="text-[12px]">
                      {item.name}（{item.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("描述")}</Label>
            <Textarea
              value={draft.description}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              rows={2}
              className={cn(
                "min-h-[52px] text-[12px]",
                draft.description.trim() !== "" && !isAsciiOnly(draft.description) && "border-destructive/60",
              )}
            />
            <p className="text-[10px] text-tertiary">{t("只能用英文，中文在游戏里会变成乱码")}</p>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("PLEX 价格")}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={draft.plexPrice}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, plexPrice: Number(event.target.value || 0) }))
                }
                className="h-8 tabular text-[12px]"
              />
            </div>
            {draft.kind === "item" ? (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{t("数量")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.quantity}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, quantity: Number(event.target.value || 0) }))
                  }
                  className="h-8 tabular text-[12px]"
                />
              </div>
            ) : null}
            {draft.kind === "omega" || draft.kind === "mct" ? (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{t("天数")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.durationDays}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, durationDays: Number(event.target.value || 0) }))
                  }
                  className="h-8 tabular text-[12px]"
                />
              </div>
            ) : null}
            {draft.kind === "mct" ? (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{t("槽位数")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.slotCount}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, slotCount: Number(event.target.value || 0) }))
                  }
                  className="h-8 tabular text-[12px]"
                />
              </div>
            ) : null}
            {draft.kind === "grant_plex" ? (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{t("发放数量")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.plexAmount}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, plexAmount: Number(event.target.value || 0) }))
                  }
                  className="h-8 tabular text-[12px]"
                />
              </div>
            ) : null}
            <div className="col-span-2 space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("标签")}</Label>
              <Input
                value={draft.tags.join(", ")}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, tags: splitTags(event.target.value) }))
                }
                placeholder={t("按逗号、中文逗号或空格分隔")}
                className={cn(
                  "h-8 text-[12px]",
                  draft.tags.some((tag) => !isAsciiOnly(tag)) && "border-destructive/60",
                )}
              />
              <p className="text-[10px] text-tertiary">{t("只能用英文，中文在游戏里会变成乱码")}</p>
            </div>
          </div>

          {errors.length > 0 ? (
            <ul className="space-y-0.5">
              {errors.map((item) => (
                <li key={item} className="text-[11px] text-destructive">
                  {t(item)}
                </li>
              ))}
            </ul>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="space-y-0.5">
              {warnings.map((item) => (
                <li key={item} className="text-[11px] text-warning">
                  {t(item)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => {
              onAdd(draft)
              onClose()
            }}
          >
            <PackagePlus />
            {t("上架")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}