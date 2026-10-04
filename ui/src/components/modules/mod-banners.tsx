import { Clock, TriangleAlert } from "lucide-react"

import { StatusDot } from "@/components/common/status-dot"
import { useLocale } from "@/components/shell/locale-provider"
import { Button } from "@/components/ui/button"
import { reviewPrStateLabel, type ConflictPair } from "@/lib/mod-logic"
import { type ModEntry } from "@/lib/mock"

export type { ConflictPair }

/**
 * 页面级冲突告警：只在双方都已启用时出现，提供逐项停用与忽略。
 */
export function ConflictBanner({
  pairs,
  onDisable,
  onDisableAll,
  onDismiss,
}: {
  pairs: ConflictPair[]
  onDisable: (mod: ModEntry) => void
  onDisableAll: () => void
  onDismiss: () => void
}) {
  const { t } = useLocale()

  if (pairs.length === 0) return null

  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-destructive/45 bg-destructive/10">
          <TriangleAlert className="size-4 text-destructive" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-destructive">
            检测到 {pairs.length} 组模组冲突
          </div>
          <div className="text-[11px] text-muted-foreground">
            冲突的模组同时启用时会互相覆盖钩子，可能导致功能失效或数据丢失。
          </div>
        </div>
        <div className="min-w-2 flex-1" />
        <Button variant="outline" size="sm" onClick={onDismiss}>
          暂时忽略
        </Button>
        <Button variant="destructive" size="sm" onClick={onDisableAll}>
          全部停用冲突项
        </Button>
      </div>

      <ul className="mt-3 space-y-2.5">
        {pairs.map((pair) => (
          <li
            key={`${pair.a.id}|${pair.b.id}`}
            className="rounded-md border border-destructive/30 bg-background/40 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <StatusDot tone="destructive" pulse />
              <span className="tabular text-[12px] font-semibold text-foreground">
                {pair.a.name}
              </span>
              <span className="text-[12px] text-destructive">↔</span>
              <span className="tabular text-[12px] font-semibold text-foreground">
                {pair.b.name}
              </span>
              <div className="min-w-2 flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onDisable(pair.a)}
              >
                {t("停用「{name}」", { name: pair.a.name })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onDisable(pair.b)}
              >
                {t("停用「{name}」", { name: pair.b.name })}
              </Button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {pair.reason}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 「我创建的」页签顶部的审核状态汇总，把审核状态摆在最显眼的位置。
 * 只陈述状态，不推算进度 —— 审核由索引仓库的 PR 托管。
 */
export function ReviewBanner({ mods }: { mods: ModEntry[] }) {
  if (mods.length === 0) return null

  return (
    <div className="rounded-lg border border-warning/45 bg-warning/10 p-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-warning/45 bg-warning/10">
          <Clock className="size-4 text-warning" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning">
            <StatusDot tone="warning" pulse />
            {mods.length} 个模组正在上架审核中
          </div>
          <div className="text-[11px] text-muted-foreground">
            模组代码审查中，审查时间与模组大小有关，通过后自动上架到模组市场；
            审核结论以索引仓库那条版本审核 PR 的状态为准。
          </div>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {mods.map((mod) => (
          <li
            key={mod.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/25 bg-background/40 px-3 py-2"
          >
            <StatusDot tone="warning" pulse />
            <span className="text-[12px] font-semibold text-foreground">{mod.name}</span>
            <span className="tabular text-[11px] text-tertiary">{mod.version}</span>
            <div className="min-w-2 flex-1" />
            {mod.submittedAt ? (
              <span className="tabular text-[11px] text-tertiary">
                提交于 {mod.submittedAt}
              </span>
            ) : null}
            <span className="text-[11px] font-semibold text-warning">
              {reviewPrStateLabel(mod.reviewPrState)}
              {mod.reviewPrNumber ? ` #${mod.reviewPrNumber}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
