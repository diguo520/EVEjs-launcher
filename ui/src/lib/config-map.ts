/**
 * 配置中心的纯映射：真 `config:get` 回包 ↔ 页面草稿。
 *
 * 单独放一层是为了能直接单测（见 config-map.test.ts）——这层只做换算，不碰 React、
 * 不发 IPC。原型里的端口与路径都是演示值（3001 / 8080 / /opt/evejs），真实值一律
 * 以后端回包为准，读不到就是空串，不用假数据填。
 */
import type { RawConfigBundle } from "@/lib/ipc"

export interface ServerConfigDraft {
  gamePort: string
  imagesPort: string
  gatewayPort: string
  sourcePath: string
  root: string
}

export interface ClientConfigDraft {
  path: string
  exe: string
  caPem: string
  proxy: string
  scriptPath: string
}

export const EMPTY_SERVER_DRAFT: ServerConfigDraft = {
  gamePort: "",
  imagesPort: "",
  gatewayPort: "",
  sourcePath: "",
  root: "",
}

export const EMPTY_CLIENT_DRAFT: ClientConfigDraft = {
  path: "",
  exe: "",
  caPem: "",
  proxy: "",
  scriptPath: "",
}

/** 服务端草稿：端口与来源文件是只读展示，只有根目录可改（config:setRepoRoot） */
export function serverDraftFrom(
  bundle: RawConfigBundle | null,
  root: string
): ServerConfigDraft {
  return {
    gamePort: bundle ? String(bundle.server.ports.game) : "",
    imagesPort: bundle ? String(bundle.server.ports.images) : "",
    gatewayPort: bundle ? String(bundle.server.ports.gateway) : "",
    sourcePath: bundle?.server.sourceFile ?? "",
    root,
  }
}

export function clientDraftFrom(bundle: RawConfigBundle | null): ClientConfigDraft {
  const client = bundle?.client
  return {
    path: client?.clientPath ?? "",
    exe: client?.clientExe ?? "",
    caPem: client?.caPem ?? "",
    proxy: client?.proxyUrl ?? "",
    scriptPath: client?.sourceFile ?? "",
  }
}

/**
 * 客户端草稿 → `config:setClient` 的补丁。
 *
 * 只带写通道认得的四个字段（clientPath / clientExe / caPem / proxyUrl）；
 * 脚本来源路径是后端读出来的，不回写。
 */
export function clientPatchOf(draft: ClientConfigDraft): Record<string, string> {
  return {
    clientPath: draft.path.trim(),
    clientExe: draft.exe.trim(),
    caPem: draft.caPem.trim(),
    proxyUrl: draft.proxy.trim(),
  }
}

/** 客户端配置里的开关是字符串 "on" / "off" */
export function switchOf(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "on"
}

export function flagOf(on: boolean): string {
  return on ? "on" : "off"
}

/** 一键启动是否拉起市场服务：后端读 settings.startMarket，缺省为开 */
export function startMarketOf(settings: Record<string, unknown> | null): boolean {
  return settings?.startMarket !== false
}

/** `{}` 与缺省都表示「没设过」——用于判断设置项是否真被写坏过 */
export function setSettingReplyOk(reply: unknown): boolean {
  return !!reply && typeof reply === "object" && !Array.isArray(reply)
}