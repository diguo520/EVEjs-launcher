import { Panel } from "@/components/common/panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MANUAL_META } from "@/lib/manual-data"
import { preloadManualData, type ManualKind } from "@/hooks/use-manual-data"
import type { CommandRow } from "@/lib/manual-logic"
import { CommandSections } from "@/components/commands/command-sections"
import { AnomalyPanel } from "@/components/commands/anomaly-panel"
import { ItemPanel } from "@/components/commands/item-panel"
import { NpcPanel } from "@/components/commands/npc-panel"
import { QaPanel } from "@/components/commands/qa-panel"

const TABS = [
  { value: "commands", label: "指令分类" },
  { value: "anomaly", label: "异常生成器" },
  { value: "items", label: "物品 ID 查询" },
  { value: "npcs", label: "NPC 查询" },
  { value: "qa", label: "QA 装备" },
] as const

/** 标签页对应的大表：鼠标移上去就先下载，点开时不用等 */
const TAB_TABLE: Partial<Record<string, ManualKind>> = {
  anomaly: "templates",
  items: "items",
  npcs: "npcs",
}

export function CommandReference({
  rows,
  onDeleteCustom,
}: {
  rows: CommandRow[]
  onDeleteCustom: (cmd: string) => void
}) {
  const counts: Record<string, number> = {
    commands: rows.length,
    anomaly: MANUAL_META.templates,
    items: MANUAL_META.items,
    npcs: MANUAL_META.npcs,
    qa: MANUAL_META.qa,
  }

  return (
    <Panel tag="// REFERENCE" title="指令参考" flush bodyClassName="min-h-0">
      <Tabs defaultValue="commands">
        <div className="border-b border-input px-4 py-1.5">
          <TabsList className="flex-wrap border-0">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                onPointerEnter={() => {
                  const kind = TAB_TABLE[t.value]
                  if (kind) void preloadManualData(kind)
                }}
                onFocus={() => {
                  const kind = TAB_TABLE[t.value]
                  if (kind) void preloadManualData(kind)
                }}
              >
                {t.label}
                <span className="tabular text-[10px] text-tertiary">
                  {counts[t.value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="commands" className="p-4">
          <CommandSections rows={rows} onDeleteCustom={onDeleteCustom} />
        </TabsContent>
        <TabsContent value="anomaly" className="p-4">
          <AnomalyPanel />
        </TabsContent>
        <TabsContent value="items" className="p-4">
          <ItemPanel />
        </TabsContent>
        <TabsContent value="npcs" className="p-4">
          <NpcPanel />
        </TabsContent>
        <TabsContent value="qa" className="p-4">
          <QaPanel />
        </TabsContent>
      </Tabs>
    </Panel>
  )
}
