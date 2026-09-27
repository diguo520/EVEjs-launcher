import { Panel } from "@/components/common/panel"
import { ConfigField } from "@/components/config/config-field"
import type { ServerConfigDraft } from "@/lib/config-map"

/**
 * 服务端配置。
 *
 * 三个端口与配置文件来源路径都是后端读出来的（config:get），**启动器没有写端口这个通道**，
 * 所以这里只读展示 —— 原型把它们画成可编辑的输入框，但真去写会毫无效果，那才是骗人。
 * 只有服务端根目录能改，走 config:setRepoRoot。
 */
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
      meta={value.sourcePath || "尚未读到"}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ConfigField
          label="游戏服务器端口 (TCP)"
          note="只读"
          value={value.gamePort}
          readOnly
          hint="世界模拟主入口，客户端登录与星系同步都走这个端口。改端口请直接改 server.json。"
        />
        <ConfigField
          label="图片服务端口 (HTTP)"
          note="只读"
          value={value.imagesPort}
          readOnly
          hint="舰船 / 头像 / 物品图标由本端口提供，被占用时图标会空白。"
        />
        <ConfigField
          label="网关 / 代理端口 (HTTP)"
          note="只读"
          value={value.gatewayPort}
          readOnly
          hint="TLS 终结与客户端接入端口，需与客户端代理地址保持一致。"
        />
        <ConfigField
          label="配置文件源路径"
          note="只读"
          value={value.sourcePath}
          readOnly
          hint="启动器读取服务端配置的位置，由服务端根目录定位。"
          className="sm:col-span-2"
        />
        <ConfigField
          label="服务端根目录"
          value={value.root}
          onChange={(next) => onChange({ root: next })}
          placeholder={"例如 E:\\Games\\EveJS-v0.12.8"}
          hint="服务端主程序所在目录，模组目录与静态数据都相对此路径定位；保存时由后端校验目录是否有效。"
          className="sm:col-span-2"
        />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-warning">
        端口由服务端 server.json 提供，启动器只读；改完端口请重启对应服务。
      </p>
    </Panel>
  )
}