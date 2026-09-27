import { useCallback, useEffect, useRef, useState } from "react"

import { phaseOf, type DownloadPhase } from "@/lib/mod-logic"
import type { RawDownloadProgress } from "@/lib/ipc"
import type { ModEntry } from "@/lib/mock"

export type { DownloadPhase }

export const PHASE_LABEL: Record<DownloadPhase, string> = {
  downloading: "下载中",
  verifying: "校验签名",
  installing: "解包安装",
}

export interface DownloadTask {
  modId: string
  name: string
  /** install = 首次安装，update = 覆盖升级 */
  kind: "install" | "update"
  fromVersion: string
  targetVersion: string
  sizeMB: number
  progress: number
  /** 瞬时速度（MB/s）：后端只报累计字节数，这里按相邻两次采样折算 */
  speed: number
  phase: DownloadPhase
}

/** 采样间隔：后端按块回调，本地按固定节拍重算速度，读数不会跳来跳去 */
const TICK_MS = 250

export interface StartDownloadInput {
  mod: ModEntry
  kind: "install" | "update"
  targetVersion: string
  /** 真正干活的那次调用（mods:marketInstall）；进度另有事件推过来 */
  run: () => Promise<{ ok: boolean; reason?: string }>
}

/**
 * 模组下载队列：进度完全来自后端的 `mod:downloadProgress` 事件，完成与否看那次调用的回包。
 * 原型里那套「本地定时器假装在下载」已经删掉 —— 页面上的进度条现在是真的。
 */
export function useModDownloads(
  onComplete: (task: DownloadTask) => void,
  onFailed?: (mod: ModEntry, reason: string) => void,
  progressById: Record<string, RawDownloadProgress> = {}
) {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const tasksRef = useRef<DownloadTask[]>([])
  const progressRef = useRef(progressById)
  progressRef.current = progressById
  /** 每个任务上一刻的字节数，用来折算瞬时速度 */
  const samplesRef = useRef<Record<string, { bytes: number; at: number; speed: number }>>({})

  const completeRef = useRef(onComplete)
  completeRef.current = onComplete
  const failedRef = useRef(onFailed)
  failedRef.current = onFailed

  const commit = useCallback((next: DownloadTask[]) => {
    tasksRef.current = next
    setTasks(next)
  }, [])

  /* 把后端推来的进度摊到任务上 */
  useEffect(() => {
    if (tasks.length === 0) return
    const next = tasksRef.current.map((task) => {
      const event = progressRef.current[task.modId]
      if (!event) return task
      const percent = typeof event.percent === "number" ? event.percent : task.progress
      const now = Date.now()
      const previous = samplesRef.current[task.modId]
      let speed = task.speed
      if (previous) {
        const elapsed = (now - previous.at) / 1000
        if (elapsed > 0) {
          const deltaBytes = Math.max(0, event.downloaded - previous.bytes)
          speed = deltaBytes / elapsed / (1024 * 1024)
        }
      }
      samplesRef.current[task.modId] = { bytes: event.downloaded, at: now, speed }
      return { ...task, progress: Math.max(task.progress, percent), speed }
    })
    commit(next)
  }, [progressById, tasks.length, commit])

  /* 节拍器：把「已经到 100% 但还在解包」的读数按时间往前推，速度读数会掉下来 */
  useEffect(() => {
    if (tasks.length === 0) return
    const timer = window.setInterval(() => {
      const next = tasksRef.current.map((task) => {
        const event = progressRef.current[task.modId]
        const stalled = !event || event.percent === null
        // 没有 total（服务器不给长度）时按每 tick 1.5% 匀速爬，直到调用返回
        const progress = stalled ? Math.min(99, task.progress + 1.5) : task.progress
        return { ...task, progress, phase: phaseOf(progress), speed: stalled ? 0 : task.speed }
      })
      commit(next)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [tasks.length, commit])

  const start = useCallback(
    ({ mod, kind, targetVersion, run }: StartDownloadInput) => {
      if (tasksRef.current.some((task) => task.modId === mod.id)) return
      delete samplesRef.current[mod.id]
      commit([
        ...tasksRef.current,
        {
          modId: mod.id,
          name: mod.name,
          kind,
          fromVersion: mod.version,
          targetVersion,
          sizeMB: mod.sizeMB,
          progress: 0,
          speed: 0,
          phase: "downloading",
        },
      ])

      void (async () => {
        let result: { ok: boolean; reason?: string }
        try {
          result = await run()
        } catch (error) {
          result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
        const current = tasksRef.current.find((task) => task.modId === mod.id)
        commit(tasksRef.current.filter((task) => task.modId !== mod.id))
        if (!current) return // 中途被取消
        if (!result.ok) {
          failedRef.current?.(mod, result.reason ?? "安装失败")
          return
        }
        completeRef.current({ ...current, progress: 100, phase: "installing", speed: 0 })
      })()
    },
    [commit]
  )

  const cancel = useCallback(
    (modId: string) => {
      delete samplesRef.current[modId]
      commit(tasksRef.current.filter((task) => task.modId !== modId))
    },
    [commit]
  )

  return { tasks, start, cancel }
}
