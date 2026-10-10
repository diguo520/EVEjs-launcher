import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, PackagePlus, RefreshCw, Save, Search, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"

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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { StoreAddOfferDialog } from "@/components/store/store-add-offer-dialog"
import { useStoreEditor } from "@/hooks/use-store-editor"
import { t } from "@/lib/i18n"
import {
  currencyTextOf,
  formatPlex,
  fulfillmentKindOf,
  isUnpurchasable,
  matchesQuery,
  rowsOf,
  splitTags,
  type StoreOfferEdit,
  type StoreRow,
  type StoreRowKind,
} from "@/lib/store-editor-model"
import { cn } from "@/lib/utils"

type RowFilter = "all" | StoreRowKind

/**
 * 伊甸币商城编辑器：**一件商品 = 货架 + 收银台两条记录**，界面合成一行来改。
 *
 * 为什么必须两边一起写：游戏内 FEATURED 网格读的是货架（`stores[4].offers[]`，
 * 走 storeManagerService 的 get_offers），而真正扣 PLEX 读的是收银台
 * （`publicOffers[].plexPriceInCents`，走 storeFulfillment）。这两份是独立存储 ——
 * 只改一份就会出现「显示一个价、扣另一个价」，或者干脆改了没反应。
 *
 * 为什么自己画而不用服务端自带的 tools/NewEdenStoreEditor：那个 Web 版（editor.js）
 * 没有启动脚本、`app.listen` 不绑 host（实测监听全网卡）且没有任何鉴权 ——
 * 局域网里谁都能 POST 改写商城目录；桌面版又要用户装 Python 3。
 *
 * 保存要求服务端先停下来：服务端进程自己持有商城缓存并对同一张表写入
 * （购买结算会追加流水），两边同时写必然互相覆盖。后端会拒绝并在原因里说明。
 */
export function StoreEditorDialog({ onClose }: { onClose: () => void }) {
  const store = useStoreEditor()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<RowFilter>("all")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const authority = store.authority ?? undefined
  const rows = useMemo(() => rowsOf(authority), [authority])
  const ingameCount = useMemo(() => rows.filter((row) => row.kind === "ingame").length, [rows])
  const visible = useMemo(
    () =>
      rows.filter(
        (row) => (filter === "all" || row.kind === filter) && matchesQuery(row, query),
      ),
    [rows, filter, query],
  )
  const buyable = useMemo(
    () => rows.filter((row) => store.drafts[row.id]?.canPurchase !== false).length,
    [rows, store.drafts],
  )

  const pending = store.pendingIDs.length
  const blocked = store.firstError !== null

  async function submit() {
    const reply = await store.save()
    if (!reply.ok) {
      toast.error(t("商城没有保存"), { description: t(reply.reason ?? "") })
      return
    }
    toast.success(t("商城保存成功"))
  }

  const filters: { id: RowFilter; label: string }[] = [
    { id: "all", label: t("全部") },
    { id: "ingame", label: t("游戏内") },
    { id: "checkout", label: t("仅收银台") },
  ]

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("伊甸币商城")}</DialogTitle>
          <DialogDescription>
            {t("改商品目录、PLEX 定价与上下架")}
            <span className="tabular ml-2 text-tertiary">
              {t("游戏内 {ingame} 件 · 仅收银台 {checkout} 件", {
                ingame: ingameCount,
                checkout: rows.length - ingameCount,
              })}
              {` · ${t("{count} 件在售", { count: buyable })}`}
              {pending > 0 ? ` · ${t("{count} 项未保存", { count: pending })}` : ""}
            </span>
          </DialogDescription>
        </DialogHeader>

        {store.error ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t("读不到商城目录")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-tertiary">{store.error}</p>
            <div className="mt-2">
              <Button variant="secondary" size="sm" onClick={store.reload} disabled={store.loading}>
                {store.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("重新读取商城")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("搜索商品名、ID 或标签")}
                  className="h-8 pl-8 text-[12px]"
                />
              </div>
              <div className="flex items-center gap-1">
                {filters.map((item) => (
                  <Button
                    key={item.id}
                    variant={filter === item.id ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
                <PackagePlus />
                {t("上架新商品")}
              </Button>
              <Button variant="secondary" size="sm" onClick={store.reload} disabled={store.loading}>
                {store.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("重新读取商城")}
              </Button>
            </div>

            <ScrollArea className="h-[52vh] rounded-lg border border-border/60">
              {store.loading && rows.length === 0 ? (
                <p className="p-4 text-[12px] text-muted-foreground">{t("商城读取中…")}</p>
              ) : visible.length === 0 ? (
                <p className="p-4 text-[12px] text-muted-foreground">{t("没有匹配的商品")}</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {visible.map((row) => (
                    <OfferRow
                      key={row.id}
                      row={row}
                      draft={store.drafts[row.id]}
                      centsPerPlex={store.centsPerPlex}
                      changed={store.pendingIDs.includes(row.id)}
                      expanded={expanded === row.id}
                      onToggle={() => setExpanded((prev) => (prev === row.id ? null : row.id))}
                      onChange={(patch) => store.editOffer(row.id, patch)}
                      onRemove={() => store.removeOffer(row.id)}
                    />
                  ))}
                </ul>
              )}
            </ScrollArea>
          </>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span
            className={cn(
              "tabular text-[11px]",
              blocked ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {blocked
              ? t(store.firstError ?? "")
              : pending > 0
                ? t("{count} 项未保存", { count: pending })
                : t("还没有改动")}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={store.discard} disabled={pending === 0}>
              <Undo2 />
              {t("放弃改动")}
            </Button>
            <Button size="sm" onClick={submit} disabled={store.saving || pending === 0 || blocked}>
              {store.saving ? <Loader2 className="animate-spin" /> : <Save />}
              {t("保存商城")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
      </Dialog>
      {addOpen ? (
        <StoreAddOfferDialog
          authority={store.authority}
          knownImages={store.knownImages}
          placeholderImageUrl={store.placeholderImageUrl}
          lookupItems={store.lookupItems}
          onAdd={(draft) => {
            const added = store.addOffer(draft)
            if (added) {
              toast.success(t("已加入上架清单"), { description: added })
            } else {
              toast.error(t("上架失败"), { description: t("读不到游戏内商店目录，无法上架") })
            }
          }}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
    </>
  )
}

/** 一行 = 一件商品：商品名 / PLEX 价 / 上下架直接改，描述与标签展开后改 */
function OfferRow({
  row,
  draft,
  centsPerPlex,
  changed,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  row: StoreRow
  draft: StoreOfferEdit | undefined
  centsPerPlex: number
  changed: boolean
  expanded: boolean
  onToggle: () => void
  onChange: (patch: Partial<StoreOfferEdit>) => void
  onRemove: () => void
}) {
  // 删除是不可逆的（保存后四处记录一起没了），所以点一次变确认、再点才真删
  const [confirming, setConfirming] = useState(false)
  const cash = row.publicOffer ? currencyTextOf(row.publicOffer) : ""
  const kind = fulfillmentKindOf(row)
  const onSale = draft?.canPurchase ?? true
  const ingame = row.kind === "ingame"

  return (
    <li className={cn("px-3 py-2", changed && "bg-primary/5")}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex size-5 shrink-0 items-center justify-center rounded text-tertiary hover:text-foreground"
          aria-label={t("展开")}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <Input
            value={draft?.name ?? ""}
            onChange={(event) => onChange({ name: event.target.value })}
            className="h-7 border-transparent bg-transparent px-1 text-[12px] hover:border-border/60"
          />
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
            <span
              className={cn(
                "rounded px-1 text-[10px]",
                ingame ? "bg-primary/15 text-primary" : "text-tertiary",
              )}
            >
              {ingame ? t("游戏内") : t("仅收银台")}
            </span>
            <span className="font-mono text-[10px] text-tertiary">{row.id}</span>
            {kind ? <span className="text-[10px] text-tertiary">{kind}</span> : null}
            {cash ? <span className="tabular text-[10px] text-tertiary">{cash}</span> : null}
            {isUnpurchasable(row) ? (
              <span className="text-[10px] text-warning">
                {t("缺收银台记录，游戏里点了买不了")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex w-32 shrink-0 items-center gap-1.5">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={draft ? formatPlex(draft.plexPrice) : "0"}
            onChange={(event) =>
              onChange({ plexPrice: event.target.value === "" ? 0 : Number(event.target.value) })
            }
            className="h-7 text-right tabular text-[12px]"
            aria-label={t("PLEX 价格")}
          />
          <span className="text-[10px] text-tertiary">PLEX</span>
        </div>

        <div className="flex w-24 shrink-0 items-center justify-end gap-2">
          <span className={cn("text-[11px]", onSale ? "text-emerald-500" : "text-tertiary")}>
            {onSale ? t("在售") : t("已下架")}
          </span>
          <Switch
            checked={onSale}
            onCheckedChange={(checked) => onChange({ canPurchase: checked })}
            aria-label={t("在售")}
          />
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="destructive" size="sm" onClick={onRemove}>
              {t("确认删除")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("取消")}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-tertiary hover:text-destructive"
            onClick={() => setConfirming(true)}
            aria-label={t("删除这件商品")}
          >
            <Trash2 />
          </Button>
        )}
      </div>

      {expanded ? (
        <div className="mt-2 space-y-2 pl-8 pr-1">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("描述")}</Label>
            <Textarea
              value={draft?.description ?? ""}
              onChange={(event) => onChange({ description: event.target.value })}
              rows={2}
              className="min-h-[52px] text-[12px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("标签")}</Label>
            <Input
              value={(draft?.tags ?? []).join(", ")}
              onChange={(event) => onChange({ tags: splitTags(event.target.value) })}
              className="h-7 text-[12px]"
              placeholder={t("按逗号、中文逗号或空格分隔")}
            />
          </div>
          <p className="tabular text-[10px] text-tertiary">
            {t("服务端存的分值：{cents} 分（1 PLEX = {rate} 分）", {
              cents: Math.round((draft?.plexPrice ?? 0) * centsPerPlex),
              rate: centsPerPlex,
            })}
          </p>
          {ingame ? (
            <p className="text-[10px] leading-relaxed text-tertiary">
              {t("价格会同时写进游戏货架与实际扣费两处")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
