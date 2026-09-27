import { Loader2, MonitorCog, RotateCcw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { ConfigState } from "@/hooks/use-config"
import { flagOf } from "@/lib/config-map"

/**
 * 显示与窗口。
 *
 * 两个按钮都真做事：「修复游戏窗口」调 config:repairClientDisplay（后端跑服务端自带的
 * PrepareClientSettings.ps1 -Mode Display）；「重置为默认显示设置」先把客户端配置写回
 * 安全窗口开 / 安全图形关，再跑一次同一套显示重置。
 */
export function DisplayPanel({ config }: { config: ConfigState }) {
  const [busy, setBusy] = useState<"repair" | "reset" | null>(null)

  async function repair() {
    if (busy) return
    setBusy("repair")
    const reply = await config.repairDisplay()
    setBusy(null)
    if (reply.ok) toast.success("已重置客户端窗口位置")
    else toast.error("修复游戏窗口失败", { description: reply.reason })
  }

  async function reset() {
    if (busy) return
    setBusy("reset")
    const written = await config.saveClient({ safeWindowed: flagOf(true), safeGraphics: flagOf(false) })
    if (!written.ok) {
      setBusy(null)
      toast.error("显示设置没写进去", { description: written.reason })
      return
    }
    const reply = await config.repairDisplay()
    setBusy(null)
    if (reply.ok) toast.success("显示设置已重置为默认值")
    else toast.error("重置显示设置失败", { description: reply.reason })
  }

  return (
    <Panel tag="// DISPLAY" title="显示与窗口">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={repair} disabled={busy !== null}>
          {busy === "repair" ? <Loader2 className="animate-spin" /> : <MonitorCog />}
          修复游戏窗口
        </Button>
        <span className="text-[11px] text-muted-foreground">
          窗口跑到屏幕外或全屏黑屏时点这里
        </span>
      </div>

      <Separator className="my-3" />

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={reset} disabled={busy !== null}>
          {busy === "reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          重置为默认显示设置
        </Button>
        <span className="text-[11px] text-muted-foreground">
          恢复分辨率 / 刷新率 / 窗口模式的出厂值
        </span>
      </div>
    </Panel>
  )
}