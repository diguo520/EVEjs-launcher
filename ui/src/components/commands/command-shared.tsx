import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, Copy, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

import { cn, copyText } from "@/lib/utils"
import { t } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/* ---------------- 复制 ---------------- */

export function CopyButton({
  text,
  iconOnly = false,
  label = "复制",
  message = "指令已复制",
  className,
}: {
  text: string
  iconOnly?: boolean
  label?: string
  message?: string
  className?: string
}) {
  async function handleCopy() {
    const ok = await copyText(text)
    if (ok) toast.success(message)
    else toast.error("复制失败，请手动选择文本")
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      title={label}
      onClick={handleCopy}
      className={cn("h-7 text-[11px]", iconOnly ? "w-7 px-0" : "px-2", className)}
    >
      <Copy />
      {iconOnly ? null : label}
    </Button>
  )
}

/* ---------------- 输入件 ---------------- */

export function SearchInput({
  value,
  onChange,
  placeholder,
  id,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  id?: string
  className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="h-9 pl-8"
      />
    </div>
  )
}

/** 数量输入 + ▲▼ 步进 */
export function NumberStepper({
  value,
  onChange,
  min = 1,
  id,
  className,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  id?: string
  className?: string
}) {
  function commit(next: number) {
    if (!Number.isFinite(next)) {
      onChange(min)
      return
    }
    onChange(Math.max(min, Math.floor(next)))
  }

  return (
    <div className={cn("flex items-stretch gap-1.5", className)}>
      <Input
        id={id}
        type="number"
        min={min}
        value={value}
        onChange={(e) => commit(Number(e.target.value))}
        className="tabular h-9"
      />
      <div className="flex shrink-0 flex-col justify-between gap-1">
        <Button
          type="button"
          variant="secondary"
          aria-label="增加数量"
          onClick={() => commit(value + 1)}
          className="h-4 w-8 rounded-sm px-0 [&_svg]:size-3"
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-label="减少数量"
          onClick={() => commit(value - 1)}
          className="h-4 w-8 rounded-sm px-0 [&_svg]:size-3"
        >
          <ChevronDown />
        </Button>
      </div>
    </div>
  )
}

/* ---------------- 预览行 ---------------- */

export function PreviewBar({
  value,
  onCopy,
  empty = "选择模板后生成指令",
  label = "PREVIEW",
  className,
}: {
  value: string
  onCopy: () => void
  empty?: string
  label?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-input bg-background/60 px-3 py-2",
        className
      )}
    >
      <span className="panel-label shrink-0">{label}</span>
      <code
        className={cn(
          "tabular min-w-0 flex-1 truncate text-[13px]",
          value ? "text-telemetry" : "text-tertiary"
        )}
      >
        {value || empty}
      </code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={!value}
        onClick={onCopy}
        className="h-7 shrink-0 px-2 text-[11px]"
      >
        <Copy />
        复制
      </Button>
    </div>
  )
}

/* ---------------- 分类 chips ---------------- */

export interface ChipOption {
  key: string
  label: string
  count?: number
}

export function CategoryChips({
  options,
  value,
  onChange,
  allLabel = "全部",
  allCount,
  className,
}: {
  options: ChipOption[]
  value: string
  onChange: (v: string) => void
  allLabel?: string
  allCount?: number
  className?: string
}) {
  const items: ChipOption[] = [
    { key: "all", label: allLabel, count: allCount },
    ...options,
  ]

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={cn(
            "flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[12px] transition-colors",
            value === it.key
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:bg-secondary"
          )}
        >
          <span className="truncate">{it.label}</span>
          {it.count === undefined ? null : (
            <span className="tabular text-[10px] text-tertiary">{it.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 参考卡片 ---------------- */

export function RefCard({
  children,
  selected = false,
  onClick,
  className,
}: {
  children: ReactNode
  selected?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-md border border-border bg-card p-3 transition-colors",
        onClick ? "cursor-pointer hover:border-primary/40" : null,
        selected ? "border-primary bg-primary/5" : null,
        className
      )}
    >
      {children}
    </div>
  )
}

/** 卡片右下角操作区 */
export function RefCardFoot({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex items-end justify-between gap-2">
      <div className="min-w-0" />
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  )
}

/* ---------------- 分页 ---------------- */

/**
 * 分页：筛选条件（resetKey）或结果条数一变就回到第一页。
 * 大表有上千页，所以页码只显示当前页前后各 3 页，两端各留首页 / 末页。
 */
export function usePagedList<T>(items: T[], pageSize = 24, resetKey = "") {
  const [page, setPage] = useState(0)
  const signature = `${resetKey}|${items.length}`
  const [lastSignature, setLastSignature] = useState(signature)

  if (lastSignature !== signature) {
    setLastSignature(signature)
    if (page !== 0) setPage(0)
  }

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(page, pageCount - 1)

  const rows = useMemo(
    () => items.slice(current * pageSize, current * pageSize + pageSize),
    [items, current, pageSize]
  )

  return { page: current, pageCount, rows, setPage }
}

/** 页码窗口：0 … p-3..p+3 … 末页，`gap` 表示省略号 */
export function pageWindow(page: number, pageCount: number, span = 3): (number | "gap")[] {
  const out: (number | "gap")[] = []
  const from = Math.max(0, page - span)
  const to = Math.min(pageCount - 1, page + span)

  if (from > 0) {
    out.push(0)
    if (from > 1) out.push("gap")
  }
  for (let i = from; i <= to; i++) out.push(i)
  if (to < pageCount - 1) {
    if (to < pageCount - 2) out.push("gap")
    out.push(pageCount - 1)
  }
  return out
}

export function Pagination({
  page,
  pageCount,
  total,
  onPage,
  unit = "条",
}: {
  page: number
  pageCount: number
  total: number
  onPage: (p: number) => void
  unit?: string
}) {
  const marks = pageWindow(page, pageCount)

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <span className="tabular text-[11px] text-muted-foreground">
        共 {total} {unit} · 第 {page + 1} / {pageCount} 页
      </span>

      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="tabular h-7 px-2 text-[11px]"
          disabled={page <= 0}
          onClick={() => onPage(0)}
        >
          首页
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="tabular h-7 px-2 text-[11px]"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </Button>

        {marks.map((m, i) =>
          m === "gap" ? (
            <span key={`gap-${i}`} className="tabular px-1 text-[11px] text-tertiary">
              …
            </span>
          ) : (
            <Button
              key={m}
              size="sm"
              variant={m === page ? "default" : "outline"}
              className="tabular h-7 min-w-7 px-2 text-[11px]"
              onClick={() => onPage(m)}
            >
              {m + 1}
            </Button>
          )
        )}

        <Button
          size="sm"
          variant="outline"
          className="tabular h-7 px-2 text-[11px]"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="tabular h-7 px-2 text-[11px]"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(pageCount - 1)}
        >
          末页
        </Button>
      </div>
    </div>
  )
}

/* ---------------- 状态提示 ---------------- */

/** 空结果提示 */
export function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-input bg-background/40 px-4 py-6 text-center text-[12px] text-tertiary">
      {text}
    </div>
  )
}

/** 大表加载中 / 加载失败 */
export function LoadingHint({ failed = false, label }: { failed?: boolean; label: string }) {
  const localizedLabel = t(label)
  if (failed) {
    return (
      <EmptyHint
        text={t("{label}加载失败，切到别的标签页再回来可重试", {
          label: localizedLabel,
        })}
      />
    )
  }
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-input bg-background/40 px-4 py-10 text-[12px] text-tertiary">
      <Loader2 className="size-3.5 animate-spin" />
      正在载入{localizedLabel}…
    </div>
  )
}

/** 结果条数提示 */
export function ResultCount({ shown, total, unit = "条" }: { shown: number; total: number; unit?: string }) {
  return (
    <span className="tabular shrink-0 text-[11px] text-muted-foreground">
      筛选 {shown} / {total} {unit}
    </span>
  )
}
