import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/common/panel"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { startMarketOf } from "@/lib/config-map"
import { t } from "@/lib/i18n"
import { callOr, hasIpc } from "@/lib/ipc"
import type { RawAck, RawSettings } from "@/lib/ipc"

type SettingKey =
  | "startMarket"
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
  /** 后端是否有这个设置项；没有的按「未接」灰掉，不能让开关假装生效 */
  wired: boolean
}

const SETTINGS: SettingDef[] = [
  {
    key: "startMarket",
    label: "一键启动时同时启动市场服务",
    hint: "对应后端设置 startMarket：关掉后「一键启动」只拉起主服务器",
    def: true,
    wired: true,
  },
  {
    key: "autoConnect",
    label: "启动时自动连接集群",
    hint: "启动器打开后自动握手",
    def: true,
    wired: false,
  },
  {
    key: "autoRestart",
    label: "崩溃后自动重启服务",
    hint: "单服务异常退出时自动拉起",
    def: true,
    wired: false,
  },
  {
    key: "autoBackup",
    label: "每日自动备份",
    hint: "每天 03:00 EVE 时间归档世界存档",
    def: true,
    wired: false,
  },
  {
    key: "experimental",
    label: "实验性功能",
    hint: "提前体验未稳定特性",
    def: false,
    wired: false,
  },
  {
    key: "telemetry",
    label: "遥测数据上报",
    hint: "上报崩溃日志帮助改进",
    def: false,
    wired: false,
  },
]

const DEFAULTS = SETTINGS.reduce(
  (acc, s) => ({ ...acc, [s.key]: s.def }),
  {} as Record<SettingKey, boolean>
)

/**
 * 通用设置：逐项开关，改动写进后端设置文件（`settings:set`）。
 *
 * 只有 `startMarket` 是后端真有的设置项；原型里其余几项对应的一键行为、
 * 自动备份、遥测在现役后端里还没有实现，这里**灰掉并标「未接」**，不做假开关。
 */
export function GeneralSettings() {
  const ipc = hasIpc()
  const [values, setValues] = useState<Record<SettingKey, boolean>>(DEFAULTS)

  useEffect(() => {
    if (!ipc) return
    void callOr<RawSettings>("settingsGet", null).then((settings) => {
      if (!settings) return
      setValues((prev) => ({ ...prev, startMarket: startMarketOf(settings) }))
    })
  }, [ipc])

  async function toggle(item: SettingDef, next: boolean) {
    if (!item.wired) return
    setValues((prev) => ({ ...prev, [item.key]: next }))
    const reply = await callOr<RawAck>("settingsSet", null, { [item.key]: next })
    if (!reply?.ok) {
      setValues((prev) => ({ ...prev, [item.key]: !next }))
      toast.error("设置没能写入", { description: reply?.reason ?? "后端没说明原因" })
      return
    }
    toast.success(next ? t("已开启：{label}", { label: item.label }) : t("已关闭：{label}", { label: item.label }), {
      description: next ? item.hint : "该项设置已停用，可随时重新开启。",
    })
  }

  return (
    <Panel
      tag="// GENERAL"
      title="通用"
      meta="更改立即生效"
      bodyClassName="grid gap-x-6 gap-y-3 sm:grid-cols-2"
    >
      {SETTINGS.map((item) => (
        <div key={item.key} className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] text-foreground">
              {item.label}
              {item.wired ? null : <Badge variant="secondary">未接</Badge>}
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
              {item.wired
                ? item.hint
                : t("{hint} · 现役后端还没有这个设置项", { hint: item.hint })}
            </p>
          </div>
          <Switch
            checked={values[item.key]}
            disabled={!item.wired}
            onCheckedChange={(v) => void toggle(item, v)}
            aria-label={item.label}
          />
        </div>
      ))}
    </Panel>
  )
}
