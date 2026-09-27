import { SectionHeading } from "@/components/common/panel"
import { GeneralSettings } from "@/components/settings/general-settings"
import { DangerZone } from "@/components/settings/danger-zone"
import { AboutPanel } from "@/components/settings/about-panel"
import { LegacyPanel } from "@/components/settings/legacy-panel"

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <SectionHeading
        title="设置"
        sub="// LAUNCHER PREFERENCES"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            配置仅保存在本机
          </span>
        }
      />

      {/* 两列排：常规设置 | 关于；危险操作单独整行，避免误触 */}
      <div className="grid items-start gap-4 md:grid-cols-[1.35fr_1fr]">
        <GeneralSettings />
        <AboutPanel />
      </div>

      {/* 老用户最关心的一块：身份 key 与 GitHub 令牌有没有接过来 */}
      <LegacyPanel />

      <DangerZone />
    </div>
  )
}
