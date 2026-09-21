import { useState } from "react"
import { useEngine } from "@/lib/engine"
import { PresetRow } from "@/components/universe/PresetRow"
import { ConfigTabs } from "@/components/universe/ConfigTabs"
import { ImpactPanel } from "@/components/universe/ImpactPanel"
import { DiffPanel } from "@/components/universe/DiffPanel"

export function UniversePage() {
  const { config } = useEngine()
  const [activeGroup, setActiveGroup] = useState<string>("world")

  return (
    <div className="flex flex-col gap-4">
      <PresetRow config={config} />

      <div className="grid gap-4 xl:grid-cols-3">
        <ConfigTabs
          group={activeGroup}
          onGroupChange={setActiveGroup}
          className="xl:col-span-2"
        />

        <div className="flex flex-col gap-4">
          <ImpactPanel />
          <DiffPanel />
        </div>
      </div>
    </div>
  )
}
