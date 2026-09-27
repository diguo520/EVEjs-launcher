import type { ReactNode } from "react"
import { toast } from "sonner"
import { TriangleAlert } from "lucide-react"

import { Panel } from "@/components/common/panel"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { SERVER_CONFIG, WORLD_STORE } from "@/lib/mock"

/** 危险操作行：左说明 + 右按钮，点击后必须二次确认 */
function DangerRow({
  title,
  desc,
  actionLabel,
  tone,
  confirmTitle,
  confirmDesc,
  onConfirm,
}: {
  title: string
  desc: ReactNode
  actionLabel: string
  tone: "outline" | "warning" | "destructive"
  confirmTitle: string
  confirmDesc: string
  onConfirm: () => void
}) {
  const triggerVariant = tone === "destructive" ? "destructive" : "outline"
  const actionClass =
    tone === "warning" ? "hover:border-warning/60 hover:text-warning" : ""

  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-[220px] flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">{desc}</p>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant={triggerVariant} size="sm" className={actionClass}>
            {actionLabel}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirm}
              className={
                tone === "destructive"
                  ? undefined
                  : "bg-warning text-primary-foreground hover:bg-warning/85"
              }
            >
              {actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function DangerZone() {
  return (
    <Panel
      tag="// DANGER ZONE"
      title="危险操作"
      className="border-destructive/35"
      meta={
        <span className="flex items-center gap-1.5 text-destructive">
          <TriangleAlert className="size-3.5" />
          以下操作不可撤销
        </span>
      }
      bodyClassName="divide-y divide-input"
    >
      <DangerRow
        title="清空缓存"
        desc="清理图片与静态数据缓存，下次启动会重新生成"
        actionLabel="清空缓存"
        tone="outline"
        confirmTitle="清空缓存"
        confirmDesc="将删除全部图片缓存与静态数据索引。下次启动会自动重新生成，首次启动耗时约 1-2 分钟，不影响账号与角色数据。"
        onConfirm={() =>
          toast.success("缓存已清空", {
            description: "下次启动将重新生成图片与静态数据缓存。",
          })
        }
      />

      <DangerRow
        title="重置配置"
        desc={
          <>
            把服务端与客户端配置恢复默认值（
            <span className="tabular">{SERVER_CONFIG.sourcePath}</span>）
          </>
        }
        actionLabel="重置配置"
        tone="warning"
        confirmTitle="重置配置"
        confirmDesc="服务端与客户端配置将全部恢复默认值，包括端口、路径与网关代理设置。自定义的配置项会被覆盖，需要重新填写。"
        onConfirm={() =>
          toast.success("配置已重置为默认值", {
            description: "端口、路径与网关代理设置已恢复默认。",
          })
        }
      />

      <DangerRow
        title="擦除世界数据"
        desc={
          <>
            删除全部账号、角色与资产，不可恢复（
            <span className="tabular">{WORLD_STORE}</span>）
          </>
        }
        actionLabel="擦除世界数据"
        tone="destructive"
        confirmTitle="擦除世界数据"
        confirmDesc="将删除全部账号、角色、资产、市场订单与击杀记录，并重建世界存档。该操作不可撤销，也无法从自动备份中恢复。"
        onConfirm={() =>
          toast.error("世界数据已擦除", {
            description: "全部角色与资产已清空，世界存档已重建。",
          })
        }
      />
    </Panel>
  )
}
