import { Check, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { useEngine } from "@/lib/engine"
import { PRESETS, type Preset } from "@/lib/seed"
import type { UniverseConfig } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { cn } from "@/lib/utils"

type ConfigKey = keyof UniverseConfig

/** 当前 config 与预设 patch 有几项对不上。0 表示这张预设正在生效。 */
function presetDiffCount(config: UniverseConfig, patch: Partial<UniverseConfig>): number {
  return (Object.keys(patch) as ConfigKey[]).filter((key) => config[key] !== patch[key]).length
}

/** 卡片底部那行倍率摘要，让四张预设一眼能横向比较。 */
function presetHighlights(preset: Preset): string {
  const density = preset.patch.npcDensity ?? 1
  const exp = preset.patch.expRate ?? 1
  const skill = preset.patch.skillRate ?? 1
  const systems = preset.patch.systems ?? 0
  return `${systems.toLocaleString("en-US")} 星系 · 经验 ${exp.toFixed(1)}x · 技能 ${skill.toFixed(
    1,
  )}x · 密度 ${density.toFixed(1)}x`
}

function PresetCard({
  preset,
  config,
  onApply,
}: {
  preset: Preset
  config: UniverseConfig
  onApply: (preset: Preset) => void
}) {
  const diffCount = presetDiffCount(config, preset.patch)
  const active = diffCount === 0

  return (
    <button
      type="button"
      onClick={() => onApply(preset)}
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-secondary/20 hover:border-primary/40 hover:bg-secondary/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-sm font-semibold",
            active ? "text-primary" : "text-foreground",
          )}
        >
          {preset.name}
        </span>
        {active ? (
          <Badge tone="primary">
            <Check className="h-3 w-3" />
            当前生效
          </Badge>
        ) : (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {diffCount} 项差异
          </span>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{preset.desc}</p>

      <p className="mt-auto font-mono text-[10px] tabular-nums text-muted-foreground/50">
        {presetHighlights(preset)}
      </p>
    </button>
  )
}

export function PresetRow({ config }: { config: UniverseConfig }) {
  const { applyPreset, resetConfig } = useEngine()

  const handleApply = (preset: Preset) => {
    applyPreset(preset.id)
    toast.success(`已套用「${preset.name}」预设`, { description: preset.desc })
  }

  return (
    <Panel>
      <PanelHeader
        eyebrow="presets"
        title="预设方案"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetConfig()
              toast.success("宇宙参数已恢复默认值")
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </Button>
        }
      />
      <PanelBody className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PRESETS.map((preset) => (
          <PresetCard key={preset.id} preset={preset} config={config} onApply={handleApply} />
        ))}
      </PanelBody>
    </Panel>
  )
}
