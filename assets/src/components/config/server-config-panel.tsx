import { Panel } from "@/components/common/panel"
import { ConfigField } from "@/components/config/config-field"
import { SERVER_CONFIG, isServerRootValid } from "@/lib/mock"

export interface ServerConfigDraft {
  gamePort: string
  imagesPort: string
  gatewayPort: string
  sourcePath: string
  root: string
}

export const SERVER_CONFIG_DEFAULT: ServerConfigDraft = {
  gamePort: String(SERVER_CONFIG.gamePort),
  imagesPort: String(SERVER_CONFIG.imagesPort),
  gatewayPort: String(SERVER_CONFIG.gatewayPort),
  sourcePath: SERVER_CONFIG.sourcePath,
  root: SERVER_CONFIG.root,
}

export function ServerConfigPanel({
  value,
  onChange,
}: {
  value: ServerConfigDraft
  onChange: (patch: Partial<ServerConfigDraft>) => void
}) {
  return (
    <Panel
      tag="// SERVER"
      title="服务端配置 · server.json"
      meta={SERVER_CONFIG.sourcePath}
    >
      <div className="grid gap-3">
        <ConfigField
          label="游戏服务器端口 (TCP)"
          note="需与服务端配置一致"
          value={value.gamePort}
          onChange={(next) => onChange({ gamePort: next })}
          hint="世界模拟主入口，客户端登录与星系同步都走这个端口。"
        />
        <ConfigField
          label="图片服务端口 (HTTP)"
          note="需与服务端配置一致"
          value={value.imagesPort}
          onChange={(next) => onChange({ imagesPort: next })}
          hint="舰船 / 头像 / 物品图标由本端口提供，被占用时图标会空白。"
        />
        <ConfigField
          label="网关 / 代理端口 (HTTP)"
          note="需与服务端配置一致"
          value={value.gatewayPort}
          onChange={(next) => onChange({ gatewayPort: next })}
          hint="TLS 终结与客户端接入端口，需与客户端代理地址保持一致。"
        />
        <ConfigField
          label="配置文件源路径"
          value={value.sourcePath}
          onChange={(next) => onChange({ sourcePath: next })}
          hint="启动器读写服务端配置的落盘位置。"
        />
        <ConfigField
          label="服务端根目录"
          value={value.root}
          onChange={(next) => onChange({ root: next })}
          placeholder={"例如 E:\\Games\\EveJS-v0.12.8"}
          hint="服务端主程序所在目录，模组目录与静态数据都相对此路径定位。"
        />
        {/* 目录指错地方不是填错个字段的事：依赖、二进制、模组目录全跟着错 */}
        {isServerRootValid(value.root) ? null : (
          <p className="text-[11px] leading-relaxed text-destructive">
            这个目录下找不到主服务器依赖与市场服务二进制，环境自检会把这两项记成未检测到，一键启动被挡住。
          </p>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-warning">
        修改端口后需要重启对应服务才会生效。
      </p>
    </Panel>
  )
}
