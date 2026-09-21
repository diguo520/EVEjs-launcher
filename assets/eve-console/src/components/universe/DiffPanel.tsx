import { useMemo } from "react"
import { Undo2 } from "lucide-react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import { DEFAULT_CONFIG } from "@/lib/seed"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState, Panel, PanelHeader } from "@/components/ui/panel"
import { changedFields, formatFieldValue } from "./configMeta"

export function DiffPanel() {
  const { config, resetConfig } = useEngine()

  const changed = useMemo(() => changedFields(config), [config])

  return (
    <Panel>
      <PanelHeader
        eyebrow="unsaved changes"
        title="未保存改动"
        actions={
          changed.length > 0 ? (
            <Badge tone="warn">{changed.length} 项</Badge>
          ) : (
            <Badge tone="outline">默认</Badge>
          )
        }
      />

      {changed.length === 0 ? (
        <EmptyState title="参数均为默认值" hint="当前世界按出厂配置运行" />
      ) : (
        <>
          <div className="max-h-[260px] divide-y divide-border overflow-y-auto hud-scroll">
            {changed.map((field) => (
              <div
                key={String(field.key)}
                className="flex items-center justify-between gap-3 px-4 py-2"
              >
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={field.desc}>
                  {field.label}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-muted-foreground/60">
                    {formatFieldValue(field, DEFAULT_CONFIG[field.key])}
                  </span>
                  <span className="mx-1.5 text-muted-foreground/40">→</span>
                  <span className="text-primary">{formatFieldValue(field, config[field.key])}</span>
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground/70">改动在下次启动世界时生效</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetConfig()
                toast.success("已撤销全部改动", { description: "宇宙参数回到出厂配置" })
              }}
            >
              <Undo2 className="h-3.5 w-3.5" />
              撤销全部改动
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}
