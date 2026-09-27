import { ArrowUpCircle, ShieldAlert, TriangleAlert } from "lucide-react"

import { StatusDot } from "@/components/common/status-dot"
import { Button } from "@/components/ui/button"
import { hasUpdate } from "@/lib/mod-logic"
import { REVIEW_WINDOW_MINUTES, type ModEntry } from "@/lib/mock"
import { cn } from "@/lib/utils"

/**
 * 上架审核中的状态条：只说明状态与时长口径，不做进度推算。
 * 卡片与详情弹窗共用，compact 版本去掉说明行。
 */
export function ReviewStrip({
  mod,
  compact = false,
  className,
}: {
  mod: ModEntry
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone="warning" pulse />
        <span className="text-[12px] font-semibold text-warning">上架审核中</span>
        <div className="min-w-2 flex-1" />
        {mod.submittedAt ? (
          <span className="tabular text-[11px] text-tertiary">
            提交于 {mod.submittedAt}
          </span>
        ) : null}
      </div>

      {compact ? null : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-tertiary">
          人工审核通常需要 {REVIEW_WINDOW_MINUTES} 分钟，通过后自动上架到模组市场。
        </p>
      )}
    </div>
  )
}

/**
 * 冲突提示条。active = 双方都已启用（红），否则为安装前的预警（琥珀）。
 */
export function ConflictStrip({
  mod,
  others,
  reasonOf,
  onDisable,
  className,
}: {
  mod: ModEntry
  others: ModEntry[]
  reasonOf: (other: ModEntry) => string
  /** 传入即渲染「停用对方」按钮；安装前的预警不传 */
  onDisable?: (other: ModEntry) => void
  className?: string
}) {
  if (others.length === 0) return null
  const active = onDisable !== undefined

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        active
          ? "border-destructive/45 bg-destructive/10"
          : "border-warning/35 bg-warning/5",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {active ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0 text-warning" />
        )}
        <span
          className={cn(
            "text-[12px] font-semibold",
            active ? "text-destructive" : "text-warning"
          )}
        >
          {active ? "加载冲突" : "安装后可能冲突"}
        </span>
        <div className="min-w-2 flex-1" />
        <span className="tabular text-[10px] text-tertiary">
          {others.length} 项
        </span>
      </div>

      <ul className="mt-2 space-y-2">
        {others.map((other) => (
          <li
            key={other.id}
            className="border-t border-input pt-2 first:border-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "text-[11px] font-semibold",
                  active ? "text-destructive" : "text-warning"
                )}
              >
                {mod.name} ↔ {other.name}
              </span>
              <div className="min-w-2 flex-1" />
              {onDisable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDisable(other)}
                >
                  停用「{other.name}」
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {reasonOf(other)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 可更新提示条：当前版本 → 市场最新版本 + 更新入口 */
export function UpdateStrip({
  mod,
  onUpdate,
  disabled = false,
  className,
}: {
  mod: ModEntry
  onUpdate: () => void
  disabled?: boolean
  className?: string
}) {
  if (!hasUpdate(mod)) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2",
        className
      )}
    >
      <ArrowUpCircle className="size-3.5 shrink-0 text-primary" />
      <span className="text-[12px] font-semibold text-primary">有新版本</span>
      <span className="tabular text-[11px] text-muted-foreground">
        {mod.version} → <span className="font-semibold text-primary">{mod.latest}</span>
      </span>
      <div className="min-w-2 flex-1" />
      <Button size="sm" onClick={onUpdate} disabled={disabled}>
        更新
      </Button>
    </div>
  )
}
