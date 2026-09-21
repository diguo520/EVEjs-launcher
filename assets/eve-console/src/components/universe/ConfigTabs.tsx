import { useEngine } from "@/lib/engine"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { CONFIG_GROUPS, changedFields, fieldsOfGroup } from "./configMeta"
import { ConfigRow } from "./ParamRow"

export function ConfigTabs({
  group,
  onGroupChange,
  className,
}: {
  group: string
  onGroupChange: (next: string) => void
  className?: string
}) {
  const { config } = useEngine()
  const changedCount = changedFields(config).length

  return (
    <Panel className={cn("overflow-hidden", className)}>
      <PanelHeader
        eyebrow="universe params"
        title="宇宙参数"
        actions={
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {changedCount > 0 ? `${changedCount} 项已改` : "全部默认"}
          </span>
        }
      />

      <Tabs value={group} onValueChange={onGroupChange} className="flex flex-col">
        <div className="border-b border-border px-4 py-2.5">
          <TabsList>
            {CONFIG_GROUPS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {CONFIG_GROUPS.map((item) => (
          <TabsContent key={item.id} value={item.id}>
            <p className="border-b border-border bg-background/30 px-4 py-2 text-xs text-muted-foreground/70">
              {item.hint}
            </p>
            <div className="divide-y divide-border">
              {fieldsOfGroup(item.id).map((field) => (
                <ConfigRow key={String(field.key)} field={field} />
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </Panel>
  )
}
