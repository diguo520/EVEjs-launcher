import { useState } from "react"
import { toast } from "sonner"
import { Check, Copy, Download, FileCode2, FolderTree, Info, ScrollText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { OFFLINE_BUNDLE, assetUrl } from "@/lib/offline"

/** 跟 OFFLINE_BUNDLE.entries 一一对应，按顺序取用。 */
const ENTRY_ICONS = [FileCode2, FolderTree, ScrollText]

export interface OfflineExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 关闭即卸载，重开时「已复制」的标记天然归零。 */
export function OfflineExportDialog({ open, onOpenChange }: OfflineExportDialogProps) {
  if (!open) return null
  return <OfflineExportPanel onOpenChange={onOpenChange} />
}

export function OfflineExportPanel({
  onOpenChange,
}: Omit<OfflineExportDialogProps, "open">) {
  const [copied, setCopied] = useState(false)

  const url = assetUrl(OFFLINE_BUNDLE.path)
  const absolute = typeof window === "undefined" ? url : new URL(url, window.location.href).href

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute)
      setCopied(true)
      toast.success("下载地址已复制")
    } catch {
      toast.error("复制没成功，可以手动选中地址复制")
    }
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,620px)]"
      title="下载离线版"
      description="把整个指挥台打包带走，双击就能打开，不用装任何东西。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {/* 直接给真链接：右键另存、复制链接都能用，比 onClick 里造 a 标签稳。 */}
          <a
            href={url}
            download={OFFLINE_BUNDLE.fileName}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            <Download className="h-3.5 w-3.5" />
            下载压缩包
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          {OFFLINE_BUNDLE.entries.map((entry, index) => {
            const Icon = ENTRY_ICONS[index] ?? FileCode2
            return (
              <div
                key={entry.name}
                className="flex items-center gap-2.5 rounded-md border border-border bg-background/40 px-3 py-2"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="shrink-0 text-xs font-semibold text-foreground">{entry.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {entry.desc}
                </span>
              </div>
            )
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            下载地址
          </span>
          <div className="flex items-center gap-2">
            <Input readOnly value={absolute} className="font-mono text-[11px]" />
            <Button variant="outline" size="md" onClick={copy} className="shrink-0">
              {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground/70">
            点上面的按钮没反应的话，把这段地址粘到浏览器地址栏回车，效果一样。
          </p>
        </div>

        <p className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            包里是当前这份指挥台的完整快照。界面上的服务端状态、玩家账号、日志与模组市场都是演示数据，
            打开后不需要联网，也不会向任何外部服务发送东西。
          </span>
        </p>
      </div>
    </Modal>
  )
}
