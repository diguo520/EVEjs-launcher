import { useEffect, useState } from "react"
import { Save } from "lucide-react"
import { toast } from "sonner"

import { SectionHeading } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import {
  ClientConfigPanel,
  CLIENT_CONFIG_DEFAULT,
  type ClientConfigDraft,
} from "@/components/config/client-config-panel"
import {
  ServerConfigPanel,
  SERVER_CONFIG_DEFAULT,
  type ServerConfigDraft,
} from "@/components/config/server-config-panel"
import {
  LaunchOptionsPanel,
  LAUNCH_OPTIONS_DEFAULT,
  type LaunchOptions,
} from "@/components/config/launch-options-panel"
import { DisplayPanel } from "@/components/config/display-panel"
import { isServerRootValid } from "@/lib/mock"

export function ConfigPage({
  serverRoot,
  onSaveRoot,
}: {
  /** 已经生效的服务端根目录 */
  serverRoot: string
  onSaveRoot: (root: string) => void
}) {
  const [server, setServer] = useState<ServerConfigDraft>({
    ...SERVER_CONFIG_DEFAULT,
    root: serverRoot,
  })
  const [client, setClient] = useState<ClientConfigDraft>(CLIENT_CONFIG_DEFAULT)
  const [launch, setLaunch] = useState<LaunchOptions>(LAUNCH_OPTIONS_DEFAULT)

  /** 别处把根目录改回来了（比如自检里的修复），草稿跟着对齐，免得再点保存又把错的写回去 */
  useEffect(() => {
    setServer((prev) => ({ ...prev, root: serverRoot }))
  }, [serverRoot])

  function save() {
    const root = server.root.trim()
    onSaveRoot(root)
    // 根目录指错地方，依赖与二进制当场就找不到，这个后果要在保存这一刻讲清楚
    if (isServerRootValid(root)) {
      toast.success("配置已保存", {
        description: "已写入 server.json 与 EvEJSConfig.bat",
      })
    } else {
      toast.error("这个目录下没有服务端依赖与二进制", {
        description:
          "主服务器依赖、市场服务二进制都定位在这个目录里，环境自检已把它们记成未检测到，一键启动会被挡住。",
      })
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="配置中心"
        sub="// SERVER & CLIENT CONFIGURATION"
        actions={
          <Button onClick={save}>
            <Save />
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

        <LaunchOptionsPanel
          value={launch}
          onChange={(key, next) =>
            setLaunch((prev) => ({ ...prev, [key]: next }))
          }
        />

        <DisplayPanel />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] text-muted-foreground">
          配置将写入 server.json 与 EvEJSConfig.bat
        </span>
        <div className="min-w-2 flex-1" />
        <Button size="lg" className="px-8" onClick={save}>
          <Save />
          保存配置
        </Button>
      </div>
    </div>
  )
}
