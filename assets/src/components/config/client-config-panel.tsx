import { Panel } from "@/components/common/panel"
import { ConfigField } from "@/components/config/config-field"
import { CLIENT_CONFIG } from "@/lib/mock"

export interface ClientConfigDraft {
  path: string
  exe: string
  caPem: string
  proxy: string
  scriptPath: string
}

export const CLIENT_CONFIG_DEFAULT: ClientConfigDraft = {
  path: CLIENT_CONFIG.path,
  exe: CLIENT_CONFIG.exe,
  caPem: CLIENT_CONFIG.caPem,
  proxy: CLIENT_CONFIG.proxy,
  scriptPath: CLIENT_CONFIG.scriptPath,
}

export function ClientConfigPanel({
  value,
  onChange,
}: {
  value: ClientConfigDraft
  onChange: (patch: Partial<ClientConfigDraft>) => void
}) {
  return (
    <Panel
      tag="// CLIENT"
      title="客户端配置 · EvEJSConfig.bat"
      meta={CLIENT_CONFIG.path}
    >
      <div className="grid gap-3">
        <ConfigField
          label="客户端路径"
          value={value.path}
          onChange={(next) => onChange({ path: next })}
          hint="EVE 客户端安装目录，一键启动时从这里拉起程序。"
        />
        <ConfigField
          label="客户端 EXE 文件名"
          value={value.exe}
          onChange={(next) => onChange({ exe: next })}
          hint="不同客户端版本文件名可能不同，需与实际可执行文件一致。"
        />
        <ConfigField
          label="CA 证书路径"
          value={value.caPem}
          onChange={(next) => onChange({ caPem: next })}
          hint="私服自签根证书，客户端凭它信任本地服务端。"
        />
        <ConfigField
          label="代理地址"
          value={value.proxy}
          onChange={(next) => onChange({ proxy: next })}
          hint="客户端连接的网关地址，需与网关端口一致。"
        />
        <ConfigField
          label="配置脚本路径"
          value={value.scriptPath}
          onChange={(next) => onChange({ scriptPath: next })}
          hint="保存配置时改写这个脚本，客户端启动前由它写入运行参数。"
        />
      </div>
    </Panel>
  )
}
