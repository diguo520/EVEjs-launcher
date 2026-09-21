import type { ModEntry } from "@/lib/types"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"
import { ModRow } from "./ModRow"

export interface ModListProps {
  /** 已过滤 + 已按 order 升序的展示列表。 */
  mods: ModEntry[]
  /** 未经筛选的模组总数，用于首尾判断与计数。 */
  totalCount: number
  /** 模组 id → 与之冲突的模组名。 */
  conflictMap: Map<string, string[]>
  /** 模组 id → 在完整排序列表中的下标。 */
  indexById: Map<string, number>
  onToggle: (mod: ModEntry) => void
  onMove: (mod: ModEntry, dir: -1 | 1) => void
}

/** 模组清单：按加载顺序排列，行内可切换启用状态与调整顺序。 */
export function ModList({
  mods,
  totalCount,
  conflictMap,
  indexById,
  onToggle,
  onMove,
}: ModListProps) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="mod registry"
        title="模组清单"
        actions={
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {mods.length} / {totalCount}
          </span>
        }
      />
      <div className="flex flex-col gap-2 p-3">
        {mods.length === 0 ? (
          <EmptyState title="没有符合条件的模组" hint="换个关键词，或把分类切回全部" />
        ) : (
          mods.map((mod) => {
            const globalIndex = indexById.get(mod.id) ?? 0
            return (
              <ModRow
                key={mod.id}
                mod={mod}
                conflictingNames={conflictMap.get(mod.id) ?? []}
                canMoveUp={globalIndex > 0}
                canMoveDown={globalIndex < totalCount - 1}
                onToggle={() => onToggle(mod)}
                onMove={(dir) => onMove(mod, dir)}
              />
            )
          })
        )}
      </div>
    </Panel>
  )
}
