import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  LOGS,
  METRICS,
  SERVICES,
  type LogLevel,
  type LogLine,
  type Metric,
  type Service,
} from "@/lib/mock"

function stamp(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false })
}

/** 模拟运行时的自发日志：让"实时日志"真的在动 */
const AMBIENT: { level: LogLevel; src: string; msg: string }[] = [
  { level: "INFO", src: "node", msg: "世界时钟推进 · 服务器 tick 412ms" },
  { level: "INFO", src: "node", msg: "NPC 舰队状态同步完成 · 1,204 个实体" },
  { level: "DEBUG", src: "sys", msg: "会话心跳 · 3 个角色在线" },
  { level: "INFO", src: "market", msg: "撮合引擎完成一轮扫描 · 成交 18 笔" },
  { level: "WARN", src: "market", msg: "检测到异常挂单 · 价格偏离中位数 42%" },
  { level: "INFO", src: "gateway", msg: "客户端保活包 · 延迟 12ms" },
  { level: "INFO", src: "node", msg: "异常空间状态刷新 · 活跃 7 个" },
  { level: "DEBUG", src: "images", msg: "图片缓存命中 · 舰船渲染图 42 张" },
  { level: "WARN", src: "node", msg: "星系 30000142 实体数接近上限 (94%)" },
  { level: "INFO", src: "client", msg: "客户端帧同步 · 60 FPS 稳定" },
  { level: "ERROR", src: "client", msg: "渲染线程短暂卡顿 210ms · 已恢复" },
  { level: "INFO", src: "sys", msg: "内存占用平稳 · 无 GC 压力" },
]

export interface LauncherState {
  services: Service[]
  logs: LogLine[]
  metrics: Metric[]
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

export function useLauncher(): LauncherState {
  const [services, setServices] = useState<Service[]>(SERVICES)
  const [logs, setLogs] = useState<LogLine[]>(LOGS)
  const [metrics, setMetrics] = useState<Metric[]>(METRICS)
  const [busyId, setBusyId] = useState<string | null>(null)
  const seq = useRef(LOGS.length)
  const ambientIdx = useRef(0)

  const appendLog = useCallback((level: LogLevel, src: string, msg: string) => {
    seq.current += 1
    const line: LogLine = { id: seq.current, t: stamp(), level, src, msg }
    setLogs((prev) => [...prev.slice(-240), line])
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  const patchService = useCallback(
    (id: string, patch: Partial<Service>) => {
      setServices((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
      )
    },
    []
  )

  const startService = useCallback(
    (id: string) => {
      const svc = SERVICES.find((s) => s.id === id)
      if (!svc) return
      setBusyId(id)
      appendLog("INFO", id, `${svc.name} 正在启动 · 端口 ${svc.port}`)
      window.setTimeout(() => {
        patchService(id, {
          state: "running",
          pid: 15000 + Math.floor(Math.random() * 900),
          uptime: "00:00:02",
          cpu: 4 + Math.random() * 10,
        })
        appendLog("INFO", id, `${svc.name} 已就绪 · 监听 ${svc.port}`)
        setBusyId(null)
      }, 900)
    },
    [appendLog, patchService]
  )

  const stopService = useCallback(
    (id: string) => {
      const svc = SERVICES.find((s) => s.id === id)
      if (!svc) return
      setBusyId(id)
      appendLog("WARN", id, `${svc.name} 正在停止 · 等待连接排空`)
      window.setTimeout(() => {
        patchService(id, { state: "stopped", pid: null, uptime: "—", cpu: 0 })
        appendLog("INFO", id, `${svc.name} 已停止`)
        setBusyId(null)
      }, 700)
    },
    [appendLog, patchService]
  )

  const restartService = useCallback(
    (id: string) => {
      const svc = SERVICES.find((s) => s.id === id)
      if (!svc) return
      setBusyId(id)
      appendLog("INFO", id, `${svc.name} 重启中 · 保留世界状态`)
      window.setTimeout(() => {
        patchService(id, {
          state: "running",
          pid: 15000 + Math.floor(Math.random() * 900),
          uptime: "00:00:01",
        })
        appendLog("INFO", id, `${svc.name} 重启完成`)
        setBusyId(null)
      }, 1100)
    },
    [appendLog, patchService]
  )

  const launchAll = useCallback(() => {
    appendLog("INFO", "sys", "一键启动序列开始 · 环境自检门禁通过")
    setBusyId("all")
    setServices((prev) =>
      prev.map((s, i) => ({ ...s, state: i === 0 ? "running" : "ready" }))
    )
    let step = 0
    const order = SERVICES.map((s) => s)
    const timer = window.setInterval(() => {
      const svc = order[step]
      if (!svc) {
        window.clearInterval(timer)
        appendLog("INFO", "sys", "全部服务已启动 · 集群 ONLINE")
        setBusyId(null)
        return
      }
      setServices((prev) =>
        prev.map((s) =>
          s.id === svc.id
            ? {
                ...s,
                state: "running",
                pid: 15000 + Math.floor(Math.random() * 900),
                uptime: "00:00:01",
              }
            : s
        )
      )
      appendLog("INFO", svc.id, `${svc.name} 已就绪 · 监听 ${svc.port}`)
      step += 1
    }, 620)
  }, [appendLog])

  // 自发日志：每 4 秒来一条，证明链路是活的
  useEffect(() => {
    const timer = window.setInterval(() => {
      const item = AMBIENT[ambientIdx.current % AMBIENT.length]
      ambientIdx.current += 1
      appendLog(item.level, item.src, item.msg)
    }, 4200)
    return () => window.clearInterval(timer)
  }, [appendLog])

  // 资源读数轻微抖动：数值不该是死的
  useEffect(() => {
    const timer = window.setInterval(() => {
      setMetrics((prev) =>
        prev.map((m) => {
          const drift = (Math.random() - 0.5) * 6
          const next = Math.min(96, Math.max(3, m.value + drift))
          const display = m.unit.includes("GB")
            ? ((next / 100) * (m.unit.includes("32") ? 32 : 8)).toFixed(1)
            : next.toFixed(1)
          // 读数往后挪一格，曲线末端始终就是当前这个数
          return { ...m, value: next, display, series: [...m.series.slice(1), Number(next.toFixed(1))] }
        })
      )
    }, 2000)
    return () => window.clearInterval(timer)
  }, [])

  const runningCount = useMemo(
    () => services.filter((s) => s.state === "running").length,
    [services]
  )

  return {
    services,
    logs,
    metrics,
    runningCount,
    onlineCount: 3,
    busyId,
    launchAll,
    startService,
    stopService,
    restartService,
    appendLog,
    clearLogs,
  }
}
