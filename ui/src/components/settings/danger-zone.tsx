import type { ReactNode } from "react"
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
import { Badge } from "@/components/ui/badge"

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
  /** 后端还没有这条通道时传 undefined：按钮灰掉并标「未接」，不假装做成了 */
  onConfirm?: () => void
}) {
  const triggerVariant = tone === "destructive" ? "destructive" : "outline"
  const actionClass =
    tone === "warning" ? "hover:border-warning/60 hover:text-warning" : ""

  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-[220px] flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {title}
          {onConfirm ? null : <Badge variant="secondary">未接</Badge>}
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">{desc}</p>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant={triggerVariant}
            size="sm"
            className={actionClass}
            disabled={!onConfirm}
            title={onConfirm ? undefined : "现役后端还没有这条通道"}
          >
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
              onClick={() => onConfirm?.()}
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
        confirmDesc="现役后端还没有清理缓存的通道，这里点不动。"
      />

      <DangerRow
        title="重置配置"
        desc="把服务端与客户端配置恢复默认值（端口、路径、网关代理）"
        actionLabel="重置配置"
        tone="warning"
        confirmTitle="重置配置"
        confirmDesc="现役后端只能一项项改（配置中心），还没有「一键恢复默认」的通道。"
      />

      <DangerRow
        title="擦除世界数据"
        desc="删除全部账号、角色与资产，不可恢复"
        actionLabel="擦除世界数据"
        tone="destructive"
        confirmTitle="擦除世界数据"
        confirmDesc="现役后端没有重建世界存档的通道；要清档请先停服务，再手动替换世界存档文件。"
      />
    </Panel>
  )
}
