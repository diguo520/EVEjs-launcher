import { MonitorCog, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export function DisplayPanel() {
  return (
    <Panel tag="// DISPLAY" title="显示与窗口">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => toast.success("已重置客户端窗口位置")}
        >
          <MonitorCog />
          修复游戏窗口
        </Button>
        <span className="text-[11px] text-muted-foreground">
          窗口跑到屏幕外或全屏黑屏时点这里
        </span>
      </div>

      <Separator className="my-3" />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={() => toast.success("显示设置已重置为默认值")}
        >
          <RotateCcw />
          重置为默认显示设置
        </Button>
        <span className="text-[11px] text-muted-foreground">
          恢复分辨率 / 刷新率 / 窗口模式的出厂值
        </span>
      </div>
    </Panel>
  )
}
