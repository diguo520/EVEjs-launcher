import { ControlDeck } from "@/components/console/ControlDeck"
import { MetricStrip } from "@/components/console/MetricStrip"
import { LiveLogPanel } from "@/components/console/LiveLogPanel"
import { PresencePanel } from "@/components/console/PresencePanel"
import { ActivityFeed } from "@/components/console/ActivityFeed"

export function ConsolePage() {
  return (
    <div className="flex flex-col gap-4">
      <ControlDeck />
      <MetricStrip />
      <div className="grid gap-4 lg:grid-cols-3">
        <LiveLogPanel className="h-[380px] lg:col-span-2" />
        <PresencePanel className="h-[380px]" />
      </div>
      <ActivityFeed />
    </div>
  )
}
