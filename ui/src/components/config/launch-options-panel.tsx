import { Panel } from "@/components/common/panel"
import { Switch } from "@/components/ui/switch"

export interface LaunchOptionsValue {
  /** 一键启动时是否同时拉起市场服务（后端 settings.startMarket） */
  market: boolean
  /** 客户端以窗口模式启动（EvEJSConfig.bat 的 EVEJS_CLIENT_SAFE_WINDOWED） */
  safeWindow: boolean
}

/**
 * 一键启动选项。
 *
 * 两个开关都真写后端（settings:set / config:setClient）；原型里的「启动后自动登录」
 * 后端没有对应开关，留在原位但按不可用画 —— 不接一个点了不生效的开关。
 */
export function LaunchOptionsPanel({
  value,
  onChange,
  disabled,
}: {
  value: LaunchOptionsValue
  onChange: (key: keyof LaunchOptionsValue, next: boolean) => void
  disabled?: boolean
}) {
  return (
    <Panel tag="// LAUNCH" title="一键启动选项">
      <div className="divide-y divide-input">
        <Row
          title="随启动拉起市场服务"
          note="一键启动时同时启动订单撮合（后端设置 startMarket）"
          checked={value.market}
          onCheckedChange={(next) => onChange("market", next)}
          disabled={disabled}
        />
        <Row
          title="启动后自动登录"
          note="后端暂无对应开关，暂未接入"
          checked={false}
          disabled
        />
        <Row
          title="强制安全窗口模式"
          note="客户端以窗口模式启动，避免全屏黑屏"
          checked={value.safeWindow}
          onCheckedChange={(next) => onChange("safeWindow", next)}
          disabled={disabled}
        />
      </div>
    </Panel>
  )
}

function Row({
  title,
  note,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string
  note: string
  checked: boolean
  onCheckedChange?: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className={disabled ? "text-[13px] text-tertiary" : "text-[13px] text-foreground"}>
          {title}
        </div>
        <div className="mt-0.5 text-[11px] text-tertiary">{note}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  )
}
