import { CheckCircle2, Undo2 } from "lucide-react"
import type { ModSubmission } from "@/lib/types"
import { formatRelative } from "@/lib/format"
import { reviewStageLabel } from "@/lib/market"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Panel, PanelHeader } from "@/components/ui/panel"

export interface ModSubmissionsPanelProps {
  submissions: ModSubmission[]
  now: number
  onWithdraw: (submission: ModSubmission) => void
}

/** 我的提交：审核流水线的可见部分，通过后条目本身留在列表里当记录。 */
export function ModSubmissionsPanel({ submissions, now, onWithdraw }: ModSubmissionsPanelProps) {
  if (submissions.length === 0) return null

  const publishedCount = submissions.filter((item) => item.status === "published").length

  return (
    <Panel className="border-primary/40">
      <PanelHeader
        eyebrow="my submissions"
        title="我的提交"
        actions={
          <>
            <Badge tone="primary">{submissions.length} 条</Badge>
            {publishedCount > 0 ? <Badge tone="success">{publishedCount} 已上架</Badge> : null}
          </>
        }
      />
      <div className="flex flex-col gap-2 p-3">
        {submissions.map((item) => {
          const published = item.status === "published"
          return (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm border border-border bg-background/40 px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                {item.name}
              </span>
              <Badge tone="outline" className="shrink-0 px-1 py-0 text-[10px]">
                {item.version}
              </Badge>
              <Badge tone="neutral" className="shrink-0 px-1 py-0 text-[10px]">
                {item.category}
              </Badge>

              {published ? (
                <Badge tone="success" className="shrink-0">
                  <CheckCircle2 className="h-3 w-3" />
                  已上架
                </Badge>
              ) : (
                <>
                  <Badge tone="primary" className="shrink-0">
                    {reviewStageLabel(item.progress)}
                  </Badge>
                  <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-200 ease-linear"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-primary">
                    {Math.round(item.progress)}%
                  </span>
                </>
              )}

              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                {formatRelative(item.submittedAt, now)}
              </span>

              {!published ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onWithdraw(item)}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  撤回
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
