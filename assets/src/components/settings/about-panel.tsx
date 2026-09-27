import { useState } from "react"
import { toast } from "sonner"
import { Copy, Download, ScrollText, RefreshCw } from "lucide-react"

import { cn, copyText } from "@/lib/utils"
import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { LauncherUpdateDialog } from "@/components/shell/launcher-update-dialog"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { LAUNCHER_META, SOURCE_ARCHIVE } from "@/lib/mock"

interface AboutField {
  label: string
  value: string
  tone?: "warning"
}

function aboutFields(version: string, outdated: boolean): AboutField[] {
  return [
  { label: "版本", value: version },
  {
    label: "最新版本",
    value: LAUNCHER_META.latestVersion,
    tone: outdated ? "warning" : undefined,
  },
  { label: "通道", value: LAUNCHER_META.channel },
  { label: "发布日期", value: LAUNCHER_META.releaseDate },
  { label: "安装包大小", value: LAUNCHER_META.size },
  { label: "服务端根目录", value: LAUNCHER_META.rootPath },
  { label: "作者", value: LAUNCHER_META.author },
  { label: "赞助", value: LAUNCHER_META.sponsor },
  ]
}

export function AboutPanel() {
  const { version, outdated } = useLauncherVersion()
  const [updateOpen, setUpdateOpen] = useState(false)

  /** 隔离预览里下载可能被浏览器拦下，链接也给一份，粘到地址栏一样能下 */
  async function copySourceLink() {
    const url = new URL(SOURCE_ARCHIVE.file, window.location.href).href
    const ok = await copyText(url)
    if (ok) {
      toast.success("下载链接已复制", { description: "粘到浏览器地址栏即可下载。" })
    } else {
      toast.error("复制失败，请手动选择文本")
    }
  }

  return (
    <Panel
      tag="// ABOUT"
      title="关于"
      meta={`通道 ${LAUNCHER_META.channel}`}
      bodyClassName="space-y-4"
    >
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {aboutFields(version, outdated).map((f) => (
          <div
            key={f.label}
            className="flex items-baseline justify-between gap-3 border-b border-input pb-2"
          >
            <dt className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-tertiary">
              {f.label}
            </dt>
            <dd
              className={cn(
                "tabular min-w-0 truncate text-[12px]",
                f.tone === "warning" ? "text-warning" : "text-foreground"
              )}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setUpdateOpen(true)}>
          <RefreshCw />
          检查更新
        </Button>
        {/* 更新内容随时可翻：已经是最新版本时进来就是回顾 */}
        <Button variant="ghost" size="sm" onClick={() => setUpdateOpen(true)}>
          <ScrollText />
          更新内容
        </Button>
        <span className="text-[11px] text-tertiary">
          发布于 {LAUNCHER_META.releaseDate} · 安装包 {LAUNCHER_META.size}
        </span>
      </div>

      <LauncherUpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />

      {/* 源码包：想自己改启动器的人从这里拿走整个工程 */}
      <div className="flex flex-wrap items-center gap-3 border-t border-input pt-3">
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground">源码包</div>
          <p className="tabular mt-0.5 text-[10px] text-tertiary">
            zip · {SOURCE_ARCHIVE.size} · {SOURCE_ARCHIVE.note}
          </p>
        </div>
        <div className="min-w-2 flex-1" />
        <Button variant="outline" size="sm" asChild>
          <a href={SOURCE_ARCHIVE.file} download>
            <Download />
            下载源码包
          </a>
        </Button>
        <Button variant="ghost" size="sm" onClick={copySourceLink}>
          <Copy />
          复制链接
        </Button>
      </div>

      <p className="border-t border-input pt-3 text-[11px] text-warning">
        © {LAUNCHER_META.sponsor}
      </p>
    </Panel>
  )
}
