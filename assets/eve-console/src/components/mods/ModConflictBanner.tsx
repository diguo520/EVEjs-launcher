import { AlertTriangle } from "lucide-react"
import type { ModEntry } from "@/lib/types"
import { Panel } from "@/components/ui/panel"

export interface ModConflictPair {
  a: ModEntry
  b: ModEntry
}

export interface ModConflictBannerProps {
  pairs: ModConflictPair[]
}

/** 顶部冲突汇总：只要存在启用中的互斥模组就常驻，直到用户停用其中之一。 */
export function ModConflictBanner({ pairs }: ModConflictBannerProps) {
  if (pairs.length === 0) return null

  return (
    <Panel className="border-destructive/50 bg-destructive/10">
      <div className="flex items-start gap-3 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-300">
            检测到 {pairs.length} 组模组冲突，请停用其中之一
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pairs.map((pair) => (
              <span
                key={`${pair.a.id}-${pair.b.id}`}
                className="rounded-sm border border-destructive/40 bg-background/40 px-1.5 py-0.5 font-mono text-[10px] text-red-200"
              >
                {pair.a.name} × {pair.b.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  )
}
