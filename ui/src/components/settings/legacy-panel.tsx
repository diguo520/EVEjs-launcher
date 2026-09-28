import { useEffect, useState } from "react"
import { CheckCircle2, PackageOpen } from "lucide-react"

import { Panel } from "@/components/common/panel"
import { Badge } from "@/components/ui/badge"
import { callOr, hasIpc } from "@/lib/ipc"
import { t } from "@/lib/i18n"
import type { RawAppInfo, RawLegacyAdoption } from "@/lib/ipc"

/** 接管条目的中文说法：路径 → 人话 */
const ITEM_LABEL: Record<string, string> = {
  "author.json": "作者身份（署名 / 作者标识 / keyId）",
  "github-token.bin": "GitHub 令牌（DPAPI 加密，原样搬过来）",
  "launcher-settings.json": "账号登录凭据（settings 里的 accountCredentials）",
}

function labelOf(item: string): string {
  // 老版 author.json 由 path.join 写成反斜杠，台账里正/反斜杠都可能出现
  const normalized = item.replace(/\\/g, "/")
  if (ITEM_LABEL[normalized]) return ITEM_LABEL[normalized]
  if (normalized.startsWith("mod-keys/")) {
    return t("签名私钥 {name}", { name: normalized.slice("mod-keys/".length) })
  }
  // `launcher-settings.json:accountCredentials` 这类「文件:字段」条目
  const [entryFile, entryField] = normalized.split(":")
  if (ITEM_LABEL[entryFile]) {
    return entryField
      ? t("{label}（{field}）", { label: t(ITEM_LABEL[entryFile]), field: entryField })
      : ITEM_LABEL[entryFile]
  }
  return item
}

/**
 * 老启动器数据接管。
 *
 * 老版 Electron 启动器把身份 key、GitHub 令牌和账号凭据放在
 * `<服务端根>/launcher/launcher/_launcher/data`（解包版另有 release/win-unpacked 一份）。
 * 新版在**首次启动**时把这些文件搬进自己的数据目录，所以老用户升级过来
 * **不需要重新生成身份 key，也不需要重填 GitHub 令牌**。
 *
 * 接管是单向、只补不缺的：新启动器里已有的文件一个都不覆盖，
 * 老启动器那份数据也不动，想回退照样能用。
 *
 * 干净服务端（机器上根本没有老启动器数据目录）**整块不渲染**：后端把「没找到目录」和
 * 「找到了但没什么可接管」都报成 `adopted=false + source=null`，两种情况都没有内容可讲，
 * 占一块版面只会让人以为哪里出了问题。
 */
export function LegacyPanel() {
  const ipc = hasIpc()
  const [legacy, setLegacy] = useState<RawLegacyAdoption | null>(null)

  useEffect(() => {
    if (!ipc) return
    void callOr<RawAppInfo>("appInfo", null).then((info) => {
      setLegacy(info?.legacy ?? null)
    })
  }, [ipc])

  // 没接管到东西（含浏览器预览、隔离模式、干净服务端）就不画
  if (legacy?.adopted !== true) return null

  const tokenAdopted = (legacy.items ?? []).some(
    (item) => item.replace(/\\/g, "/") === "github-token.bin"
  )

  return (
    <Panel
      tag="// MIGRATION"
      title="老启动器数据接管"
      meta={
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="size-3.5" />
          已接管
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          检测到本机的老启动器（Electron 版）数据，已经把下面这些原样搬进新启动器：
          <span className="text-foreground">
            {tokenAdopted
              ? "身份 key 与 GitHub 令牌都不用重置"
              : "身份 key 不用重新生成"}
          </span>
          ，打开「令牌配置」就能看到。
        </p>

        {tokenAdopted ? null : (
          <p className="text-[11px] leading-relaxed text-tertiary">
            这次没搬 GitHub 令牌：老启动器当时没有保存过。
            如果它存过（github-token.bin），会在这一步一并带过来，不用重填。
          </p>
        )}

        <ul className="space-y-1.5">
          {(legacy.items ?? []).map((item) => (
            <li key={item} className="flex items-center gap-2 text-[12px]">
              <PackageOpen className="size-3.5 shrink-0 text-primary" />
              <span className="text-foreground">{labelOf(item)}</span>
              <span className="tabular min-w-0 flex-1 truncate text-[10px] text-tertiary">
                {item}
              </span>
            </li>
          ))}
        </ul>

        {legacy.source ? (
          <p className="text-[11px] text-tertiary">
            来源目录：
            <code className="tabular break-all">{legacy.source}</code>
          </p>
        ) : null}

        <div className="space-y-1.5 border-t border-input pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">只补不覆盖</Badge>
            <Badge variant="secondary">老启动器那份数据不动</Badge>
          </div>
          <p className="text-[11px] leading-relaxed text-tertiary">
            接管规则：新启动器数据目录里已经有的文件一个都不覆盖；只在缺文件时从老目录补过来。
            同一份身份 key 与令牌在新老两个启动器之间是通用的，随时可以回退到老版。
          </p>
        </div>
      </div>
    </Panel>
  )
}
