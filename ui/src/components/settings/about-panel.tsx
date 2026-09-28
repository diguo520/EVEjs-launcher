import { useState } from "react"
import { toast } from "sonner"
import { Copy, FolderOpen, RefreshCw, ScrollText } from "lucide-react"

import { cn, copyText } from "@/lib/utils"
import { t } from "@/lib/i18n"
import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { LauncherUpdateDialog } from "@/components/shell/launcher-update-dialog"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { callOr } from "@/lib/ipc"
import { LAUNCHER_META } from "@/lib/mock"

interface AboutField {
  label: string
  value: string
  tone?: "warning"
}

/**
 * 关于面板：能查到的都走真通道（`app:info` 的版本 / EveJS 版本 / 服务端根目录，
 * 更新状态来自 `update:state`）；查不到的（发布日期、安装包大小）画「—」，不编数字。
 */
export function AboutPanel() {
  const { version, latestVersion, outdated, evejsVersion, repoRoot } = useLauncherVersion()
  const [updateOpen, setUpdateOpen] = useState(false)

  const fields: AboutField[] = [
    { label: "版本", value: version },
    {
      label: "最新版本",
      value: latestVersion,
      tone: outdated ? "warning" : undefined,
    },
    { label: "EveJS 服务端版本", value: evejsVersion || "—" },
    { label: "通道", value: LAUNCHER_META.channel },
    { label: "平台", value: "Windows" },
    { label: "服务端根目录", value: repoRoot || "—" },
  ]

  async function copyRoot() {
    const ok = await copyText(repoRoot || "")
    if (ok) toast.success("服务端根目录已复制")
    else toast.error("复制失败，请手动选择文本")
  }

  async function openRoot() {
    if (!repoRoot) {
      toast.error("还没读到服务端根目录")
      return
    }
    const reply = await callOr<boolean>("shellOpenExternal", null, repoRoot)
    if (reply !== true) {
      toast.error("没能打开目录", {
        description: "启动器只允许打开已校验的地址，可先复制路径再手动打开。",
      })
    }
  }

  return (
    <Panel
      tag="// ABOUT"
      title="关于"
      meta={t("通道 {channel}", { channel: LAUNCHER_META.channel })}
    >
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => (
          <div
            key={f.label}
            className="grid grid-cols-[minmax(0,88px)_1fr] items-baseline gap-2 border-b border-input pb-2"
          >
            <dt className="text-[11px] uppercase tracking-[0.06em] text-tertiary">
              {f.label}
            </dt>
            <dd
              className={cn(
                "tabular min-w-0 truncate text-[12px]",
                f.tone === "warning" ? "text-warning" : "text-foreground"
              )}
              title={f.value}
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
      </div>

      <LauncherUpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />

      {/* 工程位置：想自己改启动器的人可以直接定位到服务端根目录 */}
      <div className="flex flex-wrap items-center gap-3 border-t border-input pt-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted-foreground">服务端根目录</div>
          <p className="tabular mt-0.5 truncate text-[10px] text-tertiary" title={repoRoot}>
            {repoRoot || "—"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void openRoot()}>
          <FolderOpen />
          打开
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copyRoot()}>
          <Copy />
          复制
        </Button>
      </div>

    </Panel>
  )
}
