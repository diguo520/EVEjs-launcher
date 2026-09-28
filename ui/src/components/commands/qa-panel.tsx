import { useMemo, useState } from "react"

import { QA_ROWS } from "@/lib/manual-data"
import { buildItemCommand, displayName, filterQa } from "@/lib/manual-logic"
import { t } from "@/lib/i18n"
import {
  CopyButton,
  EmptyHint,
  NumberStepper,
  Pagination,
  RefCard,
  RefCardFoot,
  ResultCount,
  SearchInput,
  usePagedList,
} from "@/components/commands/command-shared"

const PAGE_SIZE = 24

/** QA 装备：手册内联的 89 件测试装备，一键生成发放指令 */
export function QaPanel() {
  const [query, setQuery] = useState("")
  const [qty, setQty] = useState(1)

  const filtered = useMemo(() => filterQa(QA_ROWS, query), [query])
  const { page, pageCount, rows: pageRows, setPage } = usePagedList(
    filtered,
    PAGE_SIZE,
    query
  )

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-warning">
        QA 装备仅供测试，属性远高于常规装备；请勿在正式存档中批量发放。
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_140px] lg:items-end">
        <div className="space-y-1.5">
          <span className="panel-label">搜索</span>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="中文名 / 英文名 / typeID"
          />
        </div>
        <div className="space-y-1.5">
          <span className="panel-label">数量</span>
          <NumberStepper id="qa-qty" value={qty} onChange={setQty} />
        </div>
      </div>

      <div className="flex items-center justify-end">
        <ResultCount shown={filtered.length} total={QA_ROWS.length} unit="件装备" />
      </div>

      {pageRows.length === 0 ? (
        <EmptyHint text="没有匹配的 QA 装备" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pageRows.map((it) => (
            <RefCard key={it.typeID}>
              <div className="truncate text-[13px] font-semibold text-foreground">
                {displayName(it.nameCn, it.nameEn)}
              </div>
              <div className="tabular mt-0.5 truncate text-[11px] text-muted-foreground">
                {it.nameEn}
              </div>
              <div className="tabular mt-1.5 text-[11px] text-telemetry">{it.typeID}</div>
              <RefCardFoot>
                <CopyButton
                  text={buildItemCommand(it.nameEn, qty)}
                  label="发放"
                  message={t("已复制 · {name} × {qty}", { name: it.nameEn, qty })}
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
        unit="件装备"
      />
    </div>
  )
}
