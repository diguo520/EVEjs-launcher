import { useState } from "react"

import {
  ArrowRight,
  Bookmark,
  FolderOpen,
  Layers3,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Upload,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import marketBanner from "@/images/market-banner.svg"
import {
  ALL_CATEGORY,
  MARKET_FILTER_LABEL,
  MARKET_FILTER_ORDER,
  MOD_CATEGORIES,
  MOD_SORT_LABEL,
  MOD_SORT_ORDER,
  formatCount,
  type MarketFilter,
  type ModSort,
} from "@/lib/mod-logic"
import type { ModEntry } from "@/lib/mock"
import { t } from "@/lib/i18n"
import { cn } from "@/lib/utils"

export interface MarketTagCount {
  tag: string
  count: number
}

function SidebarRow({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors",
        active
          ? "bg-primary/10 font-semibold text-primary"
          : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="tabular text-[10px] text-tertiary">{count}</span>
      )}
    </button>
  )
}

export function MarketSidebar({
  query,
  onQueryChange,
  marketFilter,
  onMarketFilterChange,
  marketCounts,
  category,
  onCategoryChange,
  categoryCounts,
  sort,
  onSortChange,
  tag,
  onTagChange,
  tagCounts,
}: {
  query: string
  onQueryChange: (value: string) => void
  marketFilter: MarketFilter
  onMarketFilterChange: (value: MarketFilter) => void
  marketCounts: Record<MarketFilter, number>
  category: string
  onCategoryChange: (value: string) => void
  categoryCounts: Record<string, number>
  sort: ModSort
  onSortChange: (value: ModSort) => void
  tag: string | null
  onTagChange: (value: string | null) => void
  tagCounts: MarketTagCount[]
}) {
  return (
    <aside className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-card/70 p-3 xl:sticky xl:top-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索模组名 / ID / 作者 / 标签"
          className="h-8 pl-8 text-[12px]"
        />
      </div>

      <section>
        <div className="panel-label mb-1">状态</div>
        <div className="space-y-0.5">
          {MARKET_FILTER_ORDER.map((item) => (
            <SidebarRow
              key={item}
              active={marketFilter === item}
              label={t(MARKET_FILTER_LABEL[item])}
              count={marketCounts[item]}
              onClick={() => onMarketFilterChange(item)}
            />
          ))}
        </div>
      </section>

      <section className="min-h-0">
        <div className="panel-label mb-1">分类</div>
        <div className="max-h-52 space-y-0.5 overflow-y-auto pr-0.5">
          <SidebarRow
            active={category === ALL_CATEGORY}
            label="全部"
            count={categoryCounts[ALL_CATEGORY] ?? 0}
            onClick={() => onCategoryChange(ALL_CATEGORY)}
          />
          {MOD_CATEGORIES.map((item) => (
            <SidebarRow
              key={item}
              active={category === item}
              label={item}
              count={categoryCounts[item] ?? 0}
              onClick={() => onCategoryChange(item)}
            />
          ))}
        </div>
      </section>

      {tagCounts.length ? (
        <section>
          <div className="panel-label mb-1">标签</div>
          <div className="flex flex-wrap gap-1">
            {tagCounts.map((item) => (
              <button
                key={item.tag}
                type="button"
                onClick={() => onTagChange(tag === item.tag ? null : item.tag)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  tag === item.tag
                    ? "border-primary/55 bg-primary/10 text-primary"
                    : "border-input text-tertiary hover:border-primary/45 hover:text-primary"
                )}
              >
                {item.tag}
                <span className="tabular ml-1 opacity-70">{item.count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="panel-label mb-1">排序</div>
        <div className="flex flex-wrap gap-1">
          {MOD_SORT_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={sort === item}
              onClick={() => onSortChange(item)}
              className={cn(
                "rounded-full border px-2 py-1 text-[10px] transition-colors",
                sort === item
                  ? "border-primary/55 bg-primary/10 font-semibold text-primary"
                  : "border-input text-tertiary hover:border-primary/45 hover:text-primary"
              )}
            >
              {t(MOD_SORT_LABEL[item])}
            </button>
          ))}
        </div>
      </section>

    </aside>
  )
}

function ratingLine(mod: ModEntry) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-tertiary">
      <Star className="size-3 text-warning" fill="currentColor" />
      <span className="tabular text-foreground">{formatCount(mod.ratingCount)}</span>
      <span className="tabular">{t("星标")}</span>
    </span>
  )
}

/** 简介按字符截断：精选区只保留设计图那么高的摘要，不再被长描述撑开 */
function clipText(text: string, max: number): string {
  const chars = Array.from(text.trim())
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("")
}

export function MarketSpotlight({
  featured,
  secondary,
  favoriteOf,
  onDetail,
  onToggleFavorite,
}: {
  featured: ModEntry | null
  secondary: ModEntry[]
  favoriteOf: (id: string) => boolean
  onDetail: (id: string) => void
  onToggleFavorite: (mod: ModEntry) => void
}) {
  // 作者仓库里有 shots/Banner/ 就用它当背景，没有/加载失败退回本地横幅。
  // 用 state 而不是直接用 mod.banner：作者换图或删图时 URL 会 404，不能留一块破图。
  const [failed, setFailed] = useState<Record<string, true>>({})
  const setFeaturedBannerFailed = (bad: boolean) => {
    if (bad && featured?.banner) setFailed((prev) => ({ ...prev, [featured.banner as string]: true }))
  }
  const featuredBanner =
    featured?.banner && !failed[featured.banner] ? featured.banner : marketBanner
  const bannerOf = (mod: ModEntry) => (mod.banner && !failed[mod.banner] ? mod.banner : null)

  return (
    <div className="grid items-stretch gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(260px,0.85fr)]">
      <section className="relative h-[204px] overflow-hidden rounded-lg border border-primary/30 bg-card">
        {/* 横幅优先用作者仓库 shots/Banner/ 的横版图；没有或加载失败才退回本地资源。
            本地图右侧有行星弧线、矿船与牵引光束，作者图则靠 scrim 压暗保证文案可读。 */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <img
            src={featuredBanner}
            alt=""
            onError={() => setFeaturedBannerFailed(true)}
            className="market-banner-art absolute inset-0 h-full w-full object-cover"
          />
          <div className="market-banner-scrim absolute inset-0" />
          <div className="market-banner-sweep absolute inset-y-0 w-1/2" />
        </div>
        <div className="relative flex h-full min-h-0 flex-col p-5 pb-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-primary">
            <Sparkles className="size-3.5" />
            Editor&apos;s pick
          </div>
          {featured ? (
            <>
              <h3 className="mt-2 truncate text-[22px] font-semibold leading-tight text-foreground">
                {featured.name}
              </h3>
              <p className="mt-1 line-clamp-2 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
                {clipText(featured.desc, 44)}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {ratingLine(featured)}
                <Badge variant="secondary">{featured.cat}</Badge>
                <span className="text-[11px] text-tertiary">{featured.author}</span>
              </div>
              {/* 独立底栏：mt-auto 把按钮推到底部，pb-4 保证按钮与卡片底边留出呼吸位 */}
              <div className="mt-auto flex shrink-0 items-center gap-2 pt-3">
                <Button size="sm" onClick={() => onDetail(featured.id)}>
                  {t("查看详情")}
                  <ArrowRight />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={favoriteOf(featured.id)}
                  onClick={() => onToggleFavorite(featured)}
                  className={cn(
                    favoriteOf(featured.id) &&
                      "border-primary/55 bg-primary/10 text-primary hover:bg-primary/15"
                  )}
                >
                  <Bookmark fill={favoriteOf(featured.id) ? "currentColor" : "none"} />
                  {favoriteOf(featured.id) ? t("已收藏") : t("收藏")}
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-6 text-[13px] text-tertiary">
              {t("市场里还没有可推荐的模组。")}
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 xl:grid-rows-2">
        {secondary.length ? (
          secondary.slice(0, 2).map((mod) => (
            <button
              key={mod.id}
              type="button"
              onClick={() => onDetail(mod.id)}
              className="group relative flex h-[96px] min-h-0 items-start gap-3 overflow-hidden rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/45 xl:h-full"
            >
              {/* 次精选位同样吃作者 Banner；没有就保持纯卡片，不留空图。
                  图与压暗层都锁在 z-0 的独立层里，正文一律 z-10 —— 文字和图标必须保持实色，
                  不能跟着背景一起变淡（用户 2026-10-21 明确要求）。 */}
              {bannerOf(mod) ? (
                <span
                  className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
                  aria-hidden="true"
                >
                  <img
                    src={bannerOf(mod) as string}
                    alt=""
                    onError={() => {
                      const url = mod.banner
                      if (url) setFailed((prev) => ({ ...prev, [url]: true }))
                    }}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  {/* 压暗只作用于背景图：足够的对比度让白字可读，但不把正文一起调暗 */}
                  <span className="absolute inset-0 bg-gradient-to-r from-card via-card/80 to-card/35" />
                </span>
              ) : null}
              {/* z-10：Banner 与它的压暗层都在 z-0，文字与图标必须抬到上面，
                  否则整块内容会跟着遮罩一起变淡（2026-10-21 实测） */}
              <span className="relative z-10 grid size-8 shrink-0 place-items-center rounded-md border border-primary/40 bg-card text-primary">
                {mod.installed ? <Layers3 className="size-4" /> : <Package className="size-4" />}
              </span>
              <span className="relative z-10 min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {mod.name}
                  </span>
                  <ArrowRight className="ml-auto size-3 shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                  {clipText(mod.desc, 28)}
                </span>
                <span className="mt-1 flex items-center gap-1 text-[10px] text-tertiary">
                  <Star className="size-2.5 text-warning" fill="currentColor" />
                  <span className="tabular">{formatCount(mod.ratingCount)}</span>
                  <span>{t("星标")}</span>
                </span>
              </span>
            </button>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 text-[12px] text-tertiary">
            {t("暂无更多精选模组")}
          </div>
        )}
      </div>
    </div>
  )
}

export function MarketGridHeader({
  count,
  onOpenModsDir,
  onImportZip,
  importing,
  onRefresh,
}: {
  count: number
  onOpenModsDir: () => void
  onImportZip: () => void
  importing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[13px] font-semibold text-foreground">
        {count} {t("个模组")}
      </span>
      <span className="text-[11px] text-tertiary">{t("精选榜单 · 目录浏览")}</span>
      <div className="min-w-2 flex-1" />
      <Button variant="outline" size="sm" onClick={onOpenModsDir}>
        <FolderOpen />
        打开 mods 目录
      </Button>
      <Button variant="outline" size="sm" disabled={importing} onClick={onImportZip}>
        {importing ? <Loader2 className="animate-spin" /> : <Upload />}
        {importing ? "正在导入…" : "导入 ZIP"}
      </Button>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        <RefreshCw />
        刷新列表
      </Button>
    </div>
  )
}
