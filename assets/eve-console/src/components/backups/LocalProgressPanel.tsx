import { useState } from "react"
import { toast } from "sonner"
import { RotateCcw, Save } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { formatRelative } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export function LocalProgressPanel() {
  const { savedAt, autoSave, setAutoSave, saveNow, resetProgress, now } = useEngine()
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <Panel>
      <PanelHeader
        eyebrow="local progress"
        title="本机进度"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                saveNow()
                toast.success("已保存到本机")
              }}
            >
              <Save className="h-3.5 w-3.5" />
              立即保存
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              清除
            </Button>
          </>
        }
      />

      <PanelBody className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              savedAt === null ? "bg-muted-foreground/40" : "bg-primary",
            )}
          />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {savedAt === null ? "还没保存过" : `上次保存 ${formatRelative(savedAt, now)}`}
          </span>
        </div>

        <label className="flex cursor-pointer select-none items-center gap-2">
          <Switch checked={autoSave} onCheckedChange={setAutoSave} id="auto-save-progress" />
          <span className="text-xs text-muted-foreground">自动保存</span>
        </label>

        <p className="w-full text-xs leading-relaxed text-muted-foreground/70">
          改动会自动记在这台机器上，关掉页面再打开还在。日志、运行时长、下载进度这类实时数据不保存。
        </p>
      </PanelBody>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="清除本机进度"
        description="这台机器上记的改动会全部消失，数据回到初始状态。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                resetProgress()
                setConfirmOpen(false)
                toast.warning("本机进度已清除")
              }}
            >
              确认清除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>会一起清掉的内容：</p>
          <ul className="flex flex-col gap-1 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed">
            <li>宇宙参数的所有调整</li>
            <li>自己创建的玩家账号与角色</li>
            <li>新增或改动过的快照</li>
            <li>模组清单、加载顺序与自建模组</li>
            <li>市场安装记录与待审的提交</li>
          </ul>
          <p className="text-xs leading-relaxed">
            清除后服务端会回到停止状态，日志也会重新开始记。
          </p>
        </div>
      </Modal>
    </Panel>
  )
}
