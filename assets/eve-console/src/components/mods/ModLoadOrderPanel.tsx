import type { ModEntry } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"

export interface ModLoadOrderPanelProps {
  /** 已启用且按 order 升序的模组。 */
  mods: ModEntry[]
}

/** 加载顺序预览：服务端实际按这个序列挂载模组，后者覆盖前者。 */
export function ModLoadOrderPanel({ mods }: ModLoadOrderPanelProps) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="boot sequence"
        title="加载顺序预览"
        actions={<Badge tone="primary">{mods.length} 个已启用</Badge>}
      />
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          数字小的先加载，后面的模组可以覆盖前面的行为。用行内上移 / 下移调整生效顺序。
        </p>

        {mods.length === 0 ? (
          <EmptyState title="当前没有启用任何模组" hint="启用后这里会列出真实挂载序列" />
        ) : (
          <ol className="flex flex-col gap-1.5">
            {mods.map((mod, index) => (
              <li
                key={mod.id}
                className="flex items-center gap-2.5 rounded-sm border border-border bg-background/40 px-2 py-1.5"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-primary/40 bg-primary/15 font-mono text-[10px] tabular-nums text-primary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{mod.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {mod.version}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  )
}
