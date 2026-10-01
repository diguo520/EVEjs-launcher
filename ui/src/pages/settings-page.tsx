import { SectionHeading } from "@/components/common/panel"
import { GeneralSettings } from "@/components/settings/general-settings"
import { DangerZone } from "@/components/settings/danger-zone"
import { AboutPanel } from "@/components/settings/about-panel"
import { LegacyPanel } from "@/components/settings/legacy-panel"
import { SponsorFlow } from "@/components/settings/sponsor-flow"

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col gap-4">
      {/* 上面这些是固定高度的内容；整页一屏装不下时才轮到它溢出 */}
      <div className="flex shrink-0 flex-col gap-4">
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

      {/* 最底下一块：赞助人「补给线」。它吃掉剩余高度，所以整页正好一屏、不用往下滚 */}
      <SponsorFlow />
    </div>
  )
}
