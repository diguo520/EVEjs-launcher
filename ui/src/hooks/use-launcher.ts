import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  call,
  callOr,
  hasIpc,
  subscribe,
  type RawAppInfo,
  type RawConfigBundle,
  type RawHealth,
  type RawHealthPing,
  type RawMarketList,
  type RawMetrics,
  type RawModList,
  type RawServerLog,
  type RawService,
  type RawTokenStatus,
} from "@/lib/ipc"
import {
  backendServiceId,
  diskVolumesFrom,
  metricsFrom,
  modDiffLines,
  modLines,
  modsSignature,
  parseServerLog,
  serviceCards,
  startupBannerLines,
  type LogDraft,
} from "@/lib/live"
import { lineKey, overlapTail } from "@/lib/log-logic"
import type { LogLevel, LogLine, Metric, Service } from "@/lib/mock"

/** 服务表 + 端口探针 + 资源读数：2s 一轮，够快又不至于把主进程叫醒太频繁 */
const POLL_MS = 2000
/** 服务端日志尾巴：服务器重启才变，慢一点没关系 */
const LOG_POLL_MS = 4000
/** 模组目录的变化（装了/卸了/启停）：本地读盘，不用太勤 */
const MODS_POLL_MS = 6000
/** 日志面板保留的最大行数（与现役版一致） */
const MAX_LOGS = 400

export interface DiskVolume {
  name: string
  used: number
  total: number
  series: number[]
}

export interface SessionReadout {
  pilots: string
  ping: string
  alerts: number
  uptime: string
}

export interface LauncherState {
  services: Service[]
  logs: LogLine[]
  metrics: Metric[]
  diskVolumes: DiskVolume[]
  session: SessionReadout
  runningCount: number
  onlineCount: number
  busyId: string | null
  launchAll: () => void
  startService: (id: string) => void
  stopService: (id: string) => void
  restartService: (id: string) => void
  appendLog: (level: LogLevel, src: string, msg: string) => void
  clearLogs: () => void
}

function stamp(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false })
}

/**
 * 启动器运行期状态：服务表、服务器日志、资源读数。
 *
 * 数据来源全是真 IPC（services:list / service:* / engage:* / log:read / metrics:get /
 * health:check，以及 services:changed / terminal:data / terminal:exit 事件）。
 *
 * 日志有两条来源：log:read 每 4s 拉 server.log 的尾巴（服务没起来时也有历史），
 * terminal:data 推来的是服务端进程的实时 stdout（起来之后才是热乎的）。
 */
export function useLauncher(): LauncherState {
  const live = hasIpc()

  const [rawServices, setRawServices] = useState<RawService[]>([])
  const [health, setHealth] = useState<RawHealth | null>(null)
  const [ports, setPorts] = useState<RawConfigBundle["server"]["ports"] | null>(null)
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [diskVolumes, setDiskVolumes] = useState<DiskVolume[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [onlinePlayers, setOnlinePlayers] = useState<number | null>(null)
  const [ping, setPing] = useState<string>("—")
  const [busyId, setBusyId] = useState<string | null>(null)

  /** 资源曲线的采样历史：后端只给当前值，走势由本地按轮次攒 */
  const seriesRef = useRef<Record<string, number[]>>({})

  /**
   * 上一次 server.log 尾巴的指纹。
   * 4s 轮询读的是「最后 N 行」这个滑动窗口，靠它认出哪些行已经收过，只接新行 —— 
   * 早先的整段替换会把 terminal:data 推来的实时行一起冲掉。
   */
  const serverTailRef = useRef<string[]>([])

  /** 上一次 mods:list 的回包：用来比出「新加载 / 卸下 / 启停」 */
  const modsSnapshotRef = useRef<RawModList | null>(null)

  /** 启动横幅只发一次（首屏） */
  const bannerSentRef = useRef(false)

  /**
   * 见过「在跑」的卡片 id。
   *
   * 后端把「从没启动过」和「用户停掉了」都报成 idle（process.rs 的 set_state），
   * 只看状态字符串分不清这两种，界面上就没法「未启动灰 / 已停止红」。
   * 这里记一笔本地观察：跑起来过、现在不在跑 → STOPPED（红），否则 IDLE（灰）。
   */
  const everRunningRef = useRef<Set<string>>(new Set())

  const services = useMemo(() => {
    return serviceCards(rawServices, health, ports).map((card) => {
      if (card.state === "running") {
        everRunningRef.current.add(card.id)
        return card
      }
      if (card.state === "ready" && everRunningRef.current.has(card.id)) {
        return { ...card, state: "stopped" as const }
      }
      return card
    })
  }, [rawServices, health, ports])

  /** 批量接日志：id 由这里统一发牌，末尾按 MAX_LOGS 截断 */
  const appendLines = useCallback((incoming: LogDraft[]) => {
    if (!incoming.length) return
    setLogs((prev) => {
      let id = prev.at(-1)?.id ?? 0
      const fresh = incoming.map((line) => ({ ...line, id: (id += 1) }))
      return [...prev, ...fresh].slice(-MAX_LOGS)
    })
  }, [])

  const appendLog = useCallback(
    (level: LogLevel, src: string, msg: string) => {
      appendLines([{ t: stamp(), level, src, msg }])
    },
    [appendLines]
  )

  /**
   * 日志尾巴增量合并：拿上一批的尾巴与这一批的开头比出重叠，只把新滑进来的行接上。
   * 一次都没对上（文件被轮转 / 内容整段换掉）就整批收下，宁可多几条也不丢新行。
   */
  const mergeServerLog = useCallback(
    (raw: RawServerLog | null) => {
      if (raw && raw.exists === false) {
        serverTailRef.current = []
        return
      }
      const parsed = parseServerLog(raw)
      if (!parsed.length) {
        serverTailRef.current = []
        return
      }
      const keys = parsed.map(lineKey)
      const overlap = overlapTail(serverTailRef.current, keys)
      serverTailRef.current = keys
      const fresh = parsed.slice(overlap)
      if (fresh.length) {
        appendLines(fresh.map(({ t, level, src, msg, badge }) => ({ t, level, src, msg, badge })))
      }
    },
    [appendLines]
  )

  const clearLogs = useCallback(() => setLogs([]), [])

  const applyMetrics = useCallback((raw: RawMetrics) => {
    const next = metricsFrom(raw, seriesRef.current)
    seriesRef.current = Object.fromEntries(next.map((row) => [row.key, row.series]))
    setMetrics(next)
    setDiskVolumes(diskVolumesFrom(raw, seriesRef.current))
  }, [])

  /**
   * 首屏横幅 + 模组全量清单。
   *
   * 用的是只读通道里的 app:info / mods:githubTokenStatus / mods:marketList / mods:list：
   *   - 令牌只看本地落盘状态（mods:githubTokenCheck 会联网打 GitHub，冷启动不能用）；
   *   - 市场清单走缓存优先的 mods:marketList（不带 force）。
   */
  const emitStartup = useCallback(async () => {
    if (bannerSentRef.current) return
    bannerSentRef.current = true
    const at = Date.now()
    const [app, token, market, mods] = await Promise.all([
      callOr<RawAppInfo>("appInfo", null),
      callOr<RawTokenStatus>("modsGithubTokenStatus", null),
      callOr<RawMarketList>("modsMarketList", null),
      callOr<RawModList>("modsList", null),
    ])
    modsSnapshotRef.current = mods
    appendLines([...startupBannerLines({ app, token, market, at }), ...modLines(mods, at)])
  }, [appendLines])

  const refreshServices = useCallback(async () => {
    const list = await callOr<RawService[]>("servicesList", [])
    if (Array.isArray(list)) setRawServices(list)
  }, [])

  useEffect(() => {
    if (!live) return
    let alive = true

    /* ---- 首屏：端口配置、探针、服务表、日志尾巴 ---- */
    void (async () => {
      const [config, healthReply, list, log] = await Promise.all([
        callOr<RawConfigBundle>("getConfig", null),
        callOr<RawHealth>("healthCheck", null),
        callOr<RawService[]>("servicesList", []),
        callOr<RawServerLog>("readServerLog", null),
      ])
      if (!alive) return
      setPorts(config?.server.ports ?? null)
      setHealth(healthReply)
      setRawServices(Array.isArray(list) ? list : [])
      mergeServerLog(log)
      void emitStartup()
    })()

    const pollTimer = window.setInterval(() => {
      void callOr<RawService[]>("servicesList", []).then((list) => {
        if (alive && Array.isArray(list)) setRawServices(list)
      })
      void callOr<RawHealth>("healthCheck", null).then((reply) => {
        if (alive && reply) setHealth(reply)
      })
      void callOr<RawMetrics>("metricsGet", null).then((reply) => {
        if (!alive || !reply) return
        applyMetrics(reply)
        setOnlinePlayers(reply.onlinePlayers ?? null)
      })
      // health:ping 回 { ok, port, ms }：端口没人监听时 ms 是 null，界面画 "—"，不要编数字
      void callOr<RawHealthPing>("healthPing", null).then((reply) => {
        if (!alive || !reply) return
        setPing(reply.ms === null || reply.ms === undefined ? "—" : String(Math.round(reply.ms)))
      })
    }, POLL_MS)

    const logTimer = window.setInterval(() => {
      void callOr<RawServerLog>("readServerLog", null).then((reply) => {
        if (alive && reply) mergeServerLog(reply)
      })
    }, LOG_POLL_MS)

    // 模组目录是本地读盘：指纹变了才补日志，没变一个字都不写
    const modsTimer = window.setInterval(() => {
      void callOr<RawModList>("modsList", null).then((next) => {
        if (!alive || !next) return
        const previous = modsSnapshotRef.current
        if (modsSignature(previous) === modsSignature(next)) return
        modsSnapshotRef.current = next
        if (previous) {
          const drafts = modDiffLines(previous, next, Date.now())
          if (drafts.length) appendLines(drafts)
        }
      })
    }, MODS_POLL_MS)

    /* ---- 事件：服务状态变化、服务端进程 stdout、进程退出 ---- */
    const offServices = subscribe("onServicesChanged", (payload) => {
      const list = Array.isArray(payload) ? (payload as RawService[]) : null
      if (list) setRawServices(list)
    })

    const offTerminal = subscribe("onTerminalData", (tabId, data) => {
      const text = typeof data === "string" ? data : ""
      if (!text) return
      const src = tabId === "market" ? "market" : tabId === "client" ? "client" : "node"
      for (const raw of text.split(/\r?\n/)) {
        // 去掉 ANSI 颜色码：日志面板自己按级别着色
        const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()
        if (line.trim()) appendLog("INFO", src, line)
      }
    })

    const offExit = subscribe("onTerminalExit", (_tabId, code) => {
      appendLog("WARN", "node", `服务端进程已退出（code=${String(code)}）`)
    })

    return () => {
      alive = false
      window.clearInterval(pollTimer)
      window.clearInterval(logTimer)
      window.clearInterval(modsTimer)
      offServices()
      offTerminal()
      offExit()
    }
  }, [live, applyMetrics, appendLog, appendLines, mergeServerLog, emitStartup])

  /**
   * 单卡启动/停止/重启。
   *
   * 图片服务与网关代理这两个端口是主服务器进程树里的子服务（后端只有三个可控进程：
   * client / mainServer / marketServer），所以这两张卡的动作落在主服务器上。
   */
  const runServiceAction = useCallback(
    (cardId: string, action: "serviceStart" | "serviceStop" | "serviceRestart") => {
      const target = backendServiceId(cardId)
      if (!target) {
        toast.info("这一项随主服务器进程启动", {
          description: "图片服务与网关代理不是独立进程，启停请用主服务器那张卡或一键启动。",
        })
        return
      }
      setBusyId(cardId)
      appendLog("INFO", "sys", `${cardId} · ${action} → ${target}`)
      void call<unknown>(action, target)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          toast.error("操作失败", { description: message })
        })
        .finally(() => {
          window.setTimeout(() => setBusyId(null), 600)
          void refreshServices()
        })
    },
    [appendLog, refreshServices]
  )

  const startService = useCallback(
    (id: string) => runServiceAction(id, "serviceStart"),
    [runServiceAction]
  )
  const stopService = useCallback(
    (id: string) => runServiceAction(id, "serviceStop"),
    [runServiceAction]
  )
  const restartService = useCallback(
    (id: string) => runServiceAction(id, "serviceRestart"),
    [runServiceAction]
  )

  /** 一键启动：后端 engage:start 会按「主服务器 → 市场服务（受启动选项控制）」的顺序拉起来 */
  const launchAll = useCallback(() => {
    setBusyId("all")
    appendLog("INFO", "sys", "一键启动序列开始 · 环境自检门禁通过")
    void call<{ ok?: boolean; reason?: string }>("engageStart")
      .then((result) => {
        if (result && result.ok === false) {
          appendLog("ERROR", "sys", `启动序列失败 · ${result.reason ?? "未知原因"}`)
          toast.error("启动失败", { description: result.reason })
          return
        }
        appendLog("INFO", "sys", "启动序列完成")
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        appendLog("ERROR", "sys", `启动序列失败 · ${message}`)
        toast.error("启动失败", { description: message })
      })
      .finally(() => {
        window.setTimeout(() => setBusyId(null), 800)
        void refreshServices()
      })
  }, [appendLog, refreshServices])

  const runningCount = useMemo(
    () => services.filter((s) => s.state === "running").length,
    [services]
  )

  const session = useMemo<SessionReadout>(
    () => ({
      pilots: onlinePlayers === null ? "—" : String(onlinePlayers),
      ping,
      alerts: 0,
      uptime: "—",
    }),
    [onlinePlayers, ping]
  )

  return {
    services,
    logs,
    metrics,
    diskVolumes,
    session,
    runningCount,
    onlineCount: onlinePlayers ?? 0,
    busyId,
    launchAll,
    startService,
    stopService,
    restartService,
    appendLog,
    clearLogs,
  }
}