import { useCallback, useEffect, useState } from "react"

import { call, callOr, hasIpc, type RawConfigBundle } from "@/lib/ipc"

/** 写通道的统一回包：ok=false 时 reason 是给人看的中文原因 */
export interface ConfigReply {
  ok: boolean
  reason?: string
  /** config:setRepoRoot 专有：实际生效（可能被校正过）的根目录 */
  repoRoot?: string
  /** config:setRepoRoot 专有：请求的路径被后端校正到了别的目录 */
  corrected?: boolean
}

export interface ConfigState {
  /** 真配置（server.json + EvEJSConfig.bat）；没拿到就是 null */
  bundle: RawConfigBundle | null
  /** 设置项（settings:get）：一键启动选项这类自由键值 */
  settings: Record<string, unknown>
  loading: boolean
  reload: () => void
  /** 改服务端根目录：后端校验目录并写 launcher.config.json */
  saveRoot: (root: string) => Promise<ConfigReply>
  /** 写客户端配置（EvEJSConfig.bat 的四个键） */
  saveClient: (patch: Record<string, string>) => Promise<ConfigReply>
  /** 修复游戏窗口 / 重置显示设置 */
  repairDisplay: () => Promise<ConfigReply>
  /** 写一个设置项 */
  setSetting: (key: string, value: unknown) => Promise<ConfigReply>
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 配置中心的数据源：配置与设置都走后端。
 *
 * 浏览器里（没有桥）一律返回 ok，界面照常能点 —— 但不会假装写入成功过的样子，
 * 因为那份「成功」只用来让原型对照能跑完。
 */
export function useConfig(): ConfigState {
  const live = hasIpc()
  const [bundle, setBundle] = useState<RawConfigBundle | null>(null)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)

  const reload = useCallback(() => {
    if (!live) return
    setLoading(true)
    void (async () => {
      const [next, current] = await Promise.all([
        callOr<RawConfigBundle>("getConfig", null),
        callOr<Record<string, unknown>>("settingsGet", null),
      ])
      if (next) setBundle(next)
      if (current && typeof current === "object") setSettings(current)
      setLoading(false)
    })()
  }, [live])

  useEffect(() => {
    reload()
  }, [reload])

  const saveRoot = useCallback(
    async (root: string): Promise<ConfigReply> => {
      if (!live) return { ok: true }
      try {
        const reply = await call<ConfigReply>("configSetRepoRoot", root.trim())
        if (!reply) return { ok: false, reason: "后端没有回包" }
        if (reply.ok) reload()
        return reply
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
    [live, reload]
  )

  const saveClient = useCallback(
    async (patch: Record<string, string>): Promise<ConfigReply> => {
      if (!live) return { ok: true }
      try {
        const reply = await call<ConfigReply>("configSetClient", patch)
        if (!reply) return { ok: false, reason: "后端没有回包" }
        if (reply.ok) reload()
        return reply
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
    [live, reload]
  )

  const repairDisplay = useCallback(async (): Promise<ConfigReply> => {
    if (!live) return { ok: true }
    try {
      const reply = await call<ConfigReply>("configRepairClientDisplay")
      return reply ?? { ok: false, reason: "后端没有回包" }
    } catch (error) {
      return { ok: false, reason: reasonOf(error) }
    }
  }, [live])

  const setSetting = useCallback(
    async (key: string, value: unknown): Promise<ConfigReply> => {
      if (!live) return { ok: true }
      try {
        const reply = await callOr<Record<string, unknown>>("settingsSet", null, { [key]: value })
        if (!reply) return { ok: false, reason: "后端没有回包" }
        setSettings(reply)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: reasonOf(error) }
      }
    },
    [live]
  )

  return { bundle, settings, loading, reload, saveRoot, saveClient, repairDisplay, setSetting }
}