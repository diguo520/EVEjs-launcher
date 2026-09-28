import { useEffect, useState } from "react"
import { t } from "@/lib/i18n"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { SectionHeading } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { ClientConfigPanel } from "@/components/config/client-config-panel"
import { ServerConfigPanel } from "@/components/config/server-config-panel"
import {
  LaunchOptionsPanel,
  type LaunchOptionsValue,
} from "@/components/config/launch-options-panel"
import { DisplayPanel } from "@/components/config/display-panel"
import { useConfig } from "@/hooks/use-config"
import {
  EMPTY_CLIENT_DRAFT,
  EMPTY_SERVER_DRAFT,
  clientDraftFrom,
  clientPatchOf,
  flagOf,
  serverDraftFrom,
  startMarketOf,
  switchOf,
  type ClientConfigDraft,
  type ServerConfigDraft,
} from "@/lib/config-map"

/**
 * 配置中心。
 *
 * 服务端端口 / 来源文件与客户端脚本路径都是后端读出来的只读展示；能写的三处：
 * 服务端根目录（config:setRepoRoot）、客户端四项（config:setClient）、
 * 一键启动选项（settings:set + config:setClient.safeWindowed）。
 */
export function ConfigPage({
  serverRoot,
  onRootSaved,
}: {
  /** 已经生效的服务端根目录（来自 app:info，可能被配置中心改过） */
  serverRoot: string
  onRootSaved: (root: string) => void
}) {
  const config = useConfig()
  const [server, setServer] = useState<ServerConfigDraft>(EMPTY_SERVER_DRAFT)
  const [client, setClient] = useState<ClientConfigDraft>(EMPTY_CLIENT_DRAFT)
  const [saving, setSaving] = useState(false)

  /** 真配置到手后填草稿；根目录那份跟着外壳走，别处改了（自检修复）也一起对齐 */
  useEffect(() => {
    setServer(serverDraftFrom(config.bundle, serverRoot))
  }, [config.bundle, serverRoot])

  useEffect(() => {
    setClient(clientDraftFrom(config.bundle))
  }, [config.bundle])

  const launch: LaunchOptionsValue = {
    market: startMarketOf(config.settings),
    safeWindow: switchOf(config.bundle?.client.safeWindowed),
  }

  function changeLaunch(key: keyof LaunchOptionsValue, next: boolean) {
    void (async () => {
      const reply =
        key === "market"
          ? await config.setSetting("startMarket", next)
          : await config.saveClient({ safeWindowed: flagOf(next) })
      if (!reply.ok) {
        toast.error("选项没保存", { description: reply.reason })
        return
      }
      toast.success(key === "market" ? "已更新一键启动选项" : "已更新客户端窗口模式")
    })()
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const root = server.root.trim()
      if (root && root !== serverRoot.trim()) {
        const reply = await config.saveRoot(root)
        if (!reply.ok) {
          toast.error("服务端根目录没生效", { description: reply.reason })
          return
        }
        onRootSaved(reply.repoRoot ?? root)
        if (reply.corrected) {
          toast.info("根目录已按实际位置校正", {
            description: t("保存为 {path}", { path: reply.repoRoot ?? root }),
          })
        }
      }

      const written = await config.saveClient(clientPatchOf(client))
      if (!written.ok) {
        toast.error("客户端配置没写进去", { description: written.reason })
        return
      }
      toast.success("配置已保存", { description: "已写入 EvEJSConfig.bat" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="配置中心"
        sub="// SERVER & CLIENT CONFIGURATION"
        actions={
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存配置
          </Button>
        }
      />

      {/* 四块配置两列排：服务端 | 客户端，启动 | 显示 */}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <ServerConfigPanel
          value={server}
          onChange={(patch) => setServer((prev) => ({ ...prev, ...patch }))}
        />

        <ClientConfigPanel
          value={client}
          onChange={(patch) => setClient((prev) => ({ ...prev, ...patch }))}
        />

        <LaunchOptionsPanel value={launch} onChange={changeLaunch} disabled={saving} />

        <DisplayPanel config={config} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] text-muted-foreground">
          服务端根目录写入 launcher.config.json，客户端配置写入 EvEJSConfig.bat
        </span>
        <div className="min-w-2 flex-1" />
        <Button size="lg" className="px-8" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存配置
        </Button>
      </div>
    </div>
  )
}
