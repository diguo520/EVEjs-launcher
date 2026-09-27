import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { useManualData } from "@/hooks/use-manual-data"
import { MANUAL_META } from "@/lib/manual-data"
import { copyText } from "@/lib/utils"
import {
  buildSpawnCommand,
  countBy,
  filterTemplates,
  groupLabel,
  keysByCount,
  sourceLabel,
  templateFactionLabel,
  templateSubtitle,
  templateTitle,
  tierLabel,
  variantLabel,
} from "@/lib/manual-logic"
import {
  CategoryChips,
  EmptyHint,
  LoadingHint,
  Pagination,
  PreviewBar,
  RefCard,
  ResultCount,
  SearchInput,
  usePagedList,
} from "@/components/commands/command-shared"

const PAGE_SIZE = 24

/** 异常 / 签名站点生成：5944 条模板，按分类、势力与关键词筛选 */
export function AnomalyPanel() {
  const { rows, loading, failed } = useManualData("templates")
  const [group, setGroup] = useState("all")
  const [faction, setFaction] = useState("all")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const groupCounts = useMemo(() => countBy(rows, (t) => t.group), [rows])
  const factionCounts = useMemo(() => countBy(rows, (t) => t.faction), [rows])

  const groupOptions = useMemo(
    () =>
      keysByCount(groupCounts).map((key) => ({
        key,
        label: groupLabel(key),
        count: groupCounts[key],
      })),
    [groupCounts]
  )

  const factionOptions = useMemo(
    () =>
      keysByCount(factionCounts).map((key) => ({
        key,
        label: templateFactionLabel(key),
        count: factionCounts[key],
      })),
    [factionCounts]
  )

  const filtered = useMemo(
    () => filterTemplates(rows, group, faction, query),
    [rows, group, faction, query]
  )

  const { page, pageCount, rows: pageRows, setPage } = usePagedList(
    filtered,
    PAGE_SIZE,
    `${group}|${faction}|${query}`
  )

  const selected = useMemo(
    () => rows.find((t) => t.id === selectedId) ?? null,
    [rows, selectedId]
  )
  const preview = selected ? buildSpawnCommand(selected.id) : ""

  async function copyPreview() {
    if (!preview) return
    const ok = await copyText(preview)
    if (ok) toast.success("指令已复制")
    else toast.error("复制失败，请手动选择文本")
  }

  if (loading || failed) {
    return <LoadingHint failed={failed} label="异常模板" />
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="panel-label">搜索</span>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="模板 ID / 中英文名 / 等级"
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="panel-label shrink-0">分类</span>
          <CategoryChips
            options={groupOptions}
            value={group}
            onChange={setGroup}
            allLabel="全部分类"
            allCount={MANUAL_META.templates}
            className="min-w-0 flex-1"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="panel-label shrink-0">势力</span>
          <CategoryChips
            options={factionOptions}
            value={faction}
            onChange={setFaction}
            allLabel="全部势力"
            className="min-w-0 flex-1"
          />
          <ResultCount shown={filtered.length} total={MANUAL_META.templates} unit="个模板" />
        </div>
      </div>

      <PreviewBar value={preview} onCopy={copyPreview} empty="点击下方模板卡片生成指令" />

      {selected ? (
        <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="text-foreground">{templateTitle(selected)}</span>
          <span>势力 {templateFactionLabel(selected.faction)}</span>
          <span>等级 {tierLabel(selected.tier)}</span>
          <span>变体 {variantLabel(selected.variant)}</span>
          <span>分类 {groupLabel(selected.group)}</span>
          <span>来源 {sourceLabel(selected.source)}</span>
          <span className="text-warning">需身在太空中</span>
        </div>
      ) : null}

      {pageRows.length === 0 ? (
        <EmptyHint text="没有匹配的模板" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pageRows.map((t) => (
            <RefCard
              key={t.id}
              selected={selectedId === t.id}
              onClick={() => setSelectedId(t.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {templateTitle(t)}
                </span>
                <Badge variant="secondary">{tierLabel(t.tier)}</Badge>
              </div>
              <div className="tabular mt-0.5 truncate text-[11px] text-muted-foreground">
                {templateSubtitle(t) || "—"}
              </div>
              <div className="tabular mt-1.5 truncate text-[10px] tracking-[0.06em] text-tertiary">
                {t.id}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{groupLabel(t.group)}</Badge>
                <span className="text-[10px] text-tertiary">
                  {templateFactionLabel(t.faction)} · {variantLabel(t.variant)}
                </span>
              </div>
            </RefCard>
          ))}
        </div>
      )}

      <Pagination
        page={page}
        pageCount={pageCount}
        total={filtered.length}
        onPage={setPage}
        unit="个模板"
      />
    </div>
  )
}
