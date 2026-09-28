import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { useManualData } from "@/hooks/use-manual-data"
import { MANUAL_META } from "@/lib/manual-data"
import { t } from "@/lib/i18n"
import {
  buildNpcCommand,
  countBy,
  displayName,
  filterNpcs,
  formatBounty,
  keysByCount,
  npcFactionLabel,
} from "@/lib/manual-logic"
import {
  CategoryChips,
  CopyButton,
  EmptyHint,
  LoadingHint,
  NumberStepper,
  Pagination,
  RefCard,
  RefCardFoot,
  ResultCount,
  SearchInput,
  usePagedList,
} from "@/components/commands/command-shared"

const PAGE_SIZE = 24

/** NPC 查询：5620 条 NPC 档案，按势力筛选后生成刷怪指令 */
export function NpcPanel() {
  const { rows, loading, failed } = useManualData("npcs")
  const [faction, setFaction] = useState("all")
  const [query, setQuery] = useState("")
  const [qty, setQty] = useState(1)

  const factionCounts = useMemo(() => countBy(rows, (n) => n.factionName), [rows])
  const factionOptions = useMemo(
    () =>
      keysByCount(factionCounts).map((key) => ({
        key,
        label: npcFactionLabel(key),
        count: factionCounts[key],
      })),
    [factionCounts]
  )

  const filtered = useMemo(() => filterNpcs(rows, faction, query), [rows, faction, query])

  const { page, pageCount, rows: pageRows, setPage } = usePagedList(
    filtered,
    PAGE_SIZE,
    `${faction}|${query}`
  )

  if (loading || failed) {
    return <LoadingHint failed={failed} label="NPC 档案" />
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_140px] lg:items-end">
        <div className="space-y-1.5">
          <span className="panel-label">搜索</span>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="档案键 / 中英文名 / typeID / 势力"
          />
        </div>
        <div className="space-y-1.5">
          <span className="panel-label">数量</span>
          <NumberStepper id="npc-qty" value={qty} onChange={setQty} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="panel-label shrink-0">势力</span>
        <CategoryChips
          options={factionOptions}
          value={faction}
          onChange={setFaction}
          allLabel="全部势力"
          allCount={MANUAL_META.npcs}
          className="min-w-0 flex-1"
        />
        <ResultCount shown={filtered.length} total={MANUAL_META.npcs} unit="个 NPC" />
      </div>

      {pageRows.length === 0 ? (
        <EmptyHint text="没有匹配的 NPC" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pageRows.map((n) => (
            <RefCard key={`${n.key}-${n.typeID}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {displayName(n.nameCn, n.nameEn)}
                </span>
                {n.tag === "concord" ? (
                  <Badge variant="warning">统合部</Badge>
                ) : (
                  <Badge variant="secondary">{npcFactionLabel(n.factionName)}</Badge>
                )}
              </div>
              <div className="tabular mt-0.5 truncate text-[11px] text-muted-foreground">
                {n.nameEn || "—"}
              </div>
              <div className="tabular mt-1.5 flex items-center gap-2 text-[11px]">
                <span className="text-telemetry">{n.typeID}</span>
                <span className="truncate text-[10px] tracking-[0.06em] text-tertiary">
                  {n.key}
                </span>
              </div>
              <RefCardFoot>
                <span className="tabular truncate text-[11px] text-muted-foreground">
                  {formatBounty(n.bounty)}
                </span>
                <CopyButton
                  text={buildNpcCommand(n.key, qty)}
                  label="刷怪"
                  message={t("已复制 · {name} × {qty}", { name: n.nameEn, qty })}
                  className="h-6 px-1.5 text-[11px]"
                />
              </RefCardFoot>
            </RefCard>
          ))}
        </div>
      )}

      <Pagination
        page={page}
        pageCount={pageCount}
        total={filtered.length}
        onPage={setPage}
        unit="个 NPC"
      />
    </div>
  )
}
