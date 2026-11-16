import { useCallback, useEffect, useState } from "react"

import { callOr } from "@/lib/ipc"
import { compareVersions } from "@/lib/mock"

/** `download:index` / `download:clientIndex` 的回包：清单归一化结果 */
export interface RemoteIndex {
  ok?: boolean
  reason?: string
  versions?: { file?: unknown; version?: unknown; sizeBytes?: unknown }[]
}

const SERVER_SEEN_KEY = "evejs.download.seen.server"
const CLIENT_SEEN_KEY = "evejs.download.seen.client"

function readSeen(key: string): string {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    // WebView 隐私模式等拿不到存储：退化成当次会话内有效
    return ""
  }
}

function writeSeen(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
  } catch {
    // 存不进去不影响主流程，只是下次启动可能重新脉冲一次
  }
}

/** 清单里版本号最大的那条；清单不可用返回空串 */
function latestVersion(reply: RemoteIndex | null): string {
  if (!reply?.ok || !Array.isArray(reply.versions)) return ""
  let best = ""
  for (const row of reply.versions) {
    const value = row.version
    if (typeof value !== "string" || !value) continue
    if (best === "" || compareVersions(value, best) > 0) best = value
  }
  return best
}

/**
 * 首页「服务端 / 客户端种子文件」按钮的「有新下载」脉冲。
 *
 * 拉取两份清单（服务端 down/index.json、客户端 down/client.json），各取最新版本号，
 * 与本机记住的「已看过版本」比对：出现更新的版本才脉冲；用户查看一次（打开版本弹窗 /
 * 点客户端种子按钮）就记为已看过，脉冲取消，直到再次出现新版本。
 */
export function useDownloadAvailability() {
  const [serverLatest, setServerLatest] = useState("")
  const [clientLatest, setClientLatest] = useState("")
  const [serverSeen, setServerSeen] = useState(() => readSeen(SERVER_SEEN_KEY))
  const [clientSeen, setClientSeen] = useState(() => readSeen(CLIENT_SEEN_KEY))

  useEffect(() => {
    let alive = true
    void (async () => {
      const [server, client] = await Promise.all([
        callOr<RemoteIndex>("downloadIndex", null),
        callOr<RemoteIndex>("downloadClientIndex", null),
      ])
      if (!alive) return
      const s = latestVersion(server)
      const c = latestVersion(client)
      setServerLatest(s)
      setClientLatest(c)
      // 首次拿到清单：先把当前版本记为已看过，避免为存量版本一启动就脉冲
      if (s && !readSeen(SERVER_SEEN_KEY)) {
        writeSeen(SERVER_SEEN_KEY, s)
        setServerSeen(s)
      }
      if (c && !readSeen(CLIENT_SEEN_KEY)) {
        writeSeen(CLIENT_SEEN_KEY, c)
        setClientSeen(c)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const serverPulse = serverLatest !== "" && serverLatest !== serverSeen
  const clientPulse = clientLatest !== "" && clientLatest !== clientSeen

  const markServerViewed = useCallback(() => {
    if (!serverLatest) return
    writeSeen(SERVER_SEEN_KEY, serverLatest)
    setServerSeen(serverLatest)
  }, [serverLatest])

  const markClientViewed = useCallback(() => {
    if (!clientLatest) return
    writeSeen(CLIENT_SEEN_KEY, clientLatest)
    setClientSeen(clientLatest)
  }, [clientLatest])

  return { serverPulse, clientPulse, markServerViewed, markClientViewed }
}
