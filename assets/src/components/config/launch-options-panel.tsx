import { Panel } from "@/components/common/panel"
import { Switch } from "@/components/ui/switch"

export interface LaunchOptions {
  market: boolean
  autoLogin: boolean
  safeWindow: boolean
}

export const LAUNCH_OPTIONS_DEFAULT: LaunchOptions = {
  market: true,
  autoLogin: false,
  safeWindow: false,
}

const LAUNCH_ITEMS: { key: keyof LaunchOptions; title: string; note: string }[] = [
  {
    key: "market",
    title: "随启动拉起市场服务",
    note: "一键启动时同时启动订单撮合",
  },
  {
    key: "autoLogin",
    title: "启动后自动登录",
    note: "拉起客户端后自动填入上次账号",
  },
  {
    key: "safeWindow",
    title: "强制安全窗口模式",
    note: "客户端以窗口模式启动，避免全屏黑屏",
  },
]

export function LaunchOptionsPanel({
  value,
  onChange,
}: {
  value: LaunchOptions
  onChange: (key: keyof LaunchOptions, next: boolean) => void
}) {
  return (
    <Panel tag="// LAUNCH" title="一键启动选项">
      <div className="divide-y divide-input">
        {LAUNCH_ITEMS.map((item) => (
          <div
            key={item.key}
            className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-foreground">{item.title}</div>
              <div className="mt-0.5 text-[11px] text-tertiary">
                {item.note}
              </div>
            </div>
            <Switch
              checked={value[item.key]}
              onCheckedChange={(next) => onChange(item.key, next)}
            />
          </div>
        ))}
      </div>
    </Panel>
  )
}
