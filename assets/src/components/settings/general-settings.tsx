import { useState } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/common/panel"
import { Switch } from "@/components/ui/switch"

type SettingKey =
  | "autoConnect"
  | "autoRestart"
  | "autoBackup"
  | "experimental"
  | "telemetry"

interface SettingDef {
  key: SettingKey
  label: string
  hint: string
  def: boolean
}

const SETTINGS: SettingDef[] = [
  {
    key: "autoConnect",
    label: "启动时自动连接集群",
    hint: "启动器打开后自动握手",
    def: true,
  },
  {
    key: "autoRestart",
    label: "崩溃后自动重启服务",
    hint: "单服务异常退出时自动拉起",
    def: true,
  },
  {
    key: "autoBackup",
    label: "每日自动备份",
    hint: "每天 03:00 EVE 时间归档世界存档",
    def: true,
  },
  {
    key: "experimental",
    label: "实验性功能",
    hint: "提前体验未稳定特性",
    def: false,
  },
  {
    key: "telemetry",
    label: "遥测数据上报",
    hint: "上报崩溃日志帮助改进",
    def: false,
  },
]

const DEFAULTS = SETTINGS.reduce(
  (acc, s) => ({ ...acc, [s.key]: s.def }),
  {} as Record<SettingKey, boolean>
)

/** 通用设置：逐项开关，切换即时反馈 */
export function GeneralSettings() {
  const [values, setValues] = useState<Record<SettingKey, boolean>>(DEFAULTS)

  function toggle(item: SettingDef, next: boolean) {
    setValues((prev) => ({ ...prev, [item.key]: next }))
    toast.success(`已${next ? "开启" : "关闭"}：${item.label}`, {
      description: next ? item.hint : "该项设置已停用，可随时重新开启。",
    })
  }

  return (
    <Panel
      tag="// GENERAL"
      title="通用"
      meta="更改立即生效"
      bodyClassName="divide-y divide-input"
    >
      {SETTINGS.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-foreground">{item.label}</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
              {item.hint}
            </p>
          </div>
          <Switch
            checked={values[item.key]}
            onCheckedChange={(v) => toggle(item, v)}
            aria-label={item.label}
          />
        </div>
      ))}
    </Panel>
  )
}
