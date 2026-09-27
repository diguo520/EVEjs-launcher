import { Panel } from "@/components/common/panel"
import { ConfigField } from "@/components/config/config-field"
import type { ClientConfigDraft } from "@/lib/config-map"

/**
 * 客户端配置：四项真能写回 EvEJSConfig.bat（clientPath / clientExe / caPem / proxyUrl 见
 * config::write_client_config 的映射表），脚本来源路径是后端读出来的，只读展示。
 */
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
      meta={value.scriptPath || "尚未读到"}
    >
      <div className="grid gap-3 sm:grid-cols-2">
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
          note="只读"
          value={value.scriptPath}
          readOnly
          hint="保存配置时改写这个脚本，客户端启动前由它写入运行参数。"
          className="sm:col-span-2"
        />
      </div>
    </Panel>
  )
}