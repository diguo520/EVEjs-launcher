import { useCallback, useEffect, useRef, useState } from "react"

import { phaseOf, stepFor, type DownloadPhase } from "@/lib/mod-logic"
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
  /** 瞬时速度（MB/s），仅下载阶段有意义 */
  speed: number
  phase: DownloadPhase
}

const TICK_MS = 120

/** 瞬时速度：按每 tick 实际搬运的体积折算，叠一点抖动让读数像真的 */
function speedFor(sizeMB: number, step: number): number {
  const base = (sizeMB * step) / 100 / (TICK_MS / 1000)
  return Math.max(0.1, base * (0.82 + Math.random() * 0.36))
}

export interface StartDownloadInput {
  mod: ModEntry
  kind: "install" | "update"
  targetVersion: string
}

/**
 * 模组下载队列：同时只跑一条，串行推进。
 * 进度完全由本地定时器模拟，不产生任何网络请求。
 */
export function useModDownloads(onComplete: (task: DownloadTask) => void) {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const tasksRef = useRef<DownloadTask[]>([])
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete

  const commit = useCallback((next: DownloadTask[]) => {
    tasksRef.current = next
    setTasks(next)
  }, [])

  useEffect(() => {
    if (tasks.length === 0) return
    const timer = window.setInterval(() => {
      const finished: DownloadTask[] = []
      const next = tasksRef.current
        .map((task) => {
          const step = stepFor(task.sizeMB)
          const progress = Math.min(100, task.progress + step)
          return {
            ...task,
            progress,
            speed: progress < 82 ? speedFor(task.sizeMB, step) : 0,
            phase: phaseOf(progress),
          }
        })
        .filter((task) => {
          if (task.progress >= 100) {
            finished.push(task)
            return false
          }
          return true
        })

      commit(next)
      finished.forEach((task) => completeRef.current(task))
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [tasks.length, commit])

  const start = useCallback(
    ({ mod, kind, targetVersion }: StartDownloadInput) => {
      if (tasksRef.current.some((task) => task.modId === mod.id)) return
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
    },
    [commit]
  )

  const cancel = useCallback(
    (modId: string) => {
      commit(tasksRef.current.filter((task) => task.modId !== modId))
    },
    [commit]
  )

  return { tasks, start, cancel }
}
