import { useCallback, useState } from "react"
import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"

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
import { t } from "@/lib/i18n"
import { call } from "@/lib/ipc"

/** 三条危险通道的统一回包形状；成功分支各自带自己的字段 */
interface DangerReply {
  ok?: boolean
  reason?: string
  removed?: string[]
  freedBytes?: number
  backupDir?: string
}

type DangerKey = "cache" | "config" | "world"

/** 释放空间给一个量级读数就好，不追求精确到字节 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B"
  const kb = bytes / 1024
  if (kb < 1024) return kb.toFixed(1) + " KB"
  return (kb / 1024).toFixed(1) + " MB"
}

/** 危险操作行：左说明 + 右按钮，点击后必须二次确认 */
function DangerRow({
  title,
  desc,
  actionLabel,
  tone,
  confirmTitle,
  confirmDesc,
  busy,
  onConfirm,
}: {
  title: string
  desc: ReactNode
  actionLabel: string
  tone: "outline" | "warning" | "destructive"
  confirmTitle: string
  confirmDesc: string
  /** 有动作在跑时三行一起锁住：不允许一边重置配置一边清世界数据 */
  busy: boolean
  onConfirm: () => void
}) {
  const triggerVariant = tone === "destructive" ? "destructive" : "outline"
  const actionClass =
    tone === "warning" ? "hover:border-warning/60 hover:text-warning" : ""

  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-[220px] flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {title}
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-tertiary">{desc}</p>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant={triggerVariant} size="sm" className={actionClass} disabled={busy}>
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
              disabled={busy}
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
  const [busy, setBusy] = useState<DangerKey | null>(null)

  /**
   * 三条通道的共同收尾：跑的时候锁住整块，失败一定把后端给的原因说出来 ——
   * 「服务在跑」「没有世界存档」这类拒绝都靠它交代，不能只弹一句失败。
   */
  const run = useCallback(
    async (
      key: DangerKey,
      channel: string,
      failTitle: string,
      onDone: (reply: DangerReply) => void
    ) => {
      if (busy) return
      setBusy(key)
      try {
        const reply = await call<DangerReply>(channel)
        if (reply?.ok !== true) {
          toast.error(failTitle, { description: reply?.reason ?? "后端没说明原因" })
          return
        }
        onDone(reply)
      } catch (reason) {
        toast.error(failTitle, {
          description: reason instanceof Error ? reason.message : String(reason),
        })
      } finally {
        setBusy(null)
      }
    },
    [busy]
  )

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
        desc="清理模组索引、评分与赞助人名单等联网缓存，下次用到会自动重拉"
        actionLabel="清空缓存"
        tone="outline"
        confirmTitle="清空缓存"
        confirmDesc="只会删掉启动器联网拉来的缓存，身份 key 与令牌不受影响。"
        busy={busy !== null}
        onConfirm={() =>
          void run("cache", "dangerClearCache", "清空缓存失败", (reply) =>
            toast.success(
              t("已清空 {count} 项缓存 · 释放 {size}", {
                count: String(reply.removed?.length ?? 0),
                size: formatBytes(reply.freedBytes ?? 0),
              })
            )
          )
        }
      />

      <DangerRow
        title="重置配置"
        desc="把服务端 config 里的参数恢复默认值（端口、倍率等），写前自动整份备份"
        actionLabel="重置配置"
        tone="warning"
        confirmTitle="重置配置"
        confirmDesc="服务端的 config 域会写回默认值；当前值会整份备份到 _local/config-backups，随时可以拿回来。"
        busy={busy !== null}
        onConfirm={() =>
          void run("config", "dangerResetConfig", "重置配置失败", (reply) =>
            toast.success("配置已恢复默认值", {
              description: reply.backupDir ? t("备份：{path}", { path: reply.backupDir }) : undefined,
            })
          )
        }
      />

      <DangerRow
        title="擦除世界数据"
        desc="删除全部账号、角色与资产，不可恢复"
        actionLabel="擦除世界数据"
        tone="destructive"
        confirmTitle="擦除世界数据"
        confirmDesc="账号、角色与资产会全部消失，原存档会先改名保存一份。服务在跑时无法执行。"
        busy={busy !== null}
        onConfirm={() =>
          void run("world", "dangerEraseWorld", "擦除世界数据失败", (reply) =>
            toast.success("世界数据已清空，正在重建数据库", {
              description: reply.backupDir
                ? t("原存档已改名保存：{path}", { path: reply.backupDir })
                : undefined,
            })
          )
        }
      />
    </Panel>
  )
}
