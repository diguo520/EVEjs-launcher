import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { call, callOr, hasIpc, subscribe, type RawEnvReport, type RawInitState } from "@/lib/ipc"
import { envItemsFrom, initKeyOf } from "@/lib/live"
import { CHECK_ITEMS, ENV_META, type CheckItem } from "@/lib/mock"

/** 检测时间戳，格式与日志一致：14:05:32 */
function stampNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface EnvCheckState {
  items: CheckItem[]
  checking: boolean
  done: number
  checkedAt: string
  busy: { id: string; label: string } | null
  passCount: number
  warnCount: number
  missingCount: number
  blockers: string[]
  /** 运行时与机器读数（env:check 的真值；浏览器里退回原型常量） */
  runtime: string
  ramGB: string
  threads: number
  recheck: () => void
  retryOne: (id: string) => void
  fixOne: (id: string) => void
  clearWarnings: () => void
}

/**
 * 环境自检：跑的是后端真检查（env:check），修复动作走后端初始化（init:run）。
 *
 * 与原型最大的差别是「没有假的逐项动画」：每一项都是真结论，一秒钟之内一起回来；
 * 带修复按钮的项只在后端真有初始化动作时才给按钮（deps / db / market / client / ca），
 * Node、工具链这些只能人工装，所以只给结论与指引。
 *
 * 浏览器里（没有桥）退回原型自带的静态自检项，界面还是完整的。
 */
export function useEnvCheck(): EnvCheckState {
  const live = hasIpc()
  const [report, setReport] = useState<RawEnvReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string>(ENV_META.checkedAt)
  const [busy, setBusy] = useState<{ id: string; label: string } | null>(null)
  /** 任务进度（init:changed）落到这里，界面上的进度条用它 */
  const [job, setJob] = useState<RawInitState | null>(null)
  const busyRef = useRef(false)
  busyRef.current = busy !== null || (job?.busy ?? false)

  const items = useMemo<CheckItem[]>(
    () => (live ? envItemsFrom(report) : CHECK_ITEMS),
    [live, report]
  )

  const refresh = useCallback(async () => {
    if (!live) {
      setCheckedAt(stampNow())
      return
    }
    setChecking(true)
    const next = await callOr<RawEnvReport>("envCheck", null)
    if (next) {
      setReport(next)
      setCheckedAt(stampNow())
    }
    setChecking(false)
  }, [live])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* 初始化任务：后端跑完之后（busy=false）再拉一次自检，让结论跟着更新 */
  useEffect(() => {
    if (!live) return
    const off = subscribe("onInitChanged", (payload) => {
      const next = (payload ?? null) as RawInitState | null
      setJob(next)
      if (!next) return
      setBusy(
        next.busy ? { id: next.key ?? "", label: next.label || "初始化中" } : null
      )
      if (!next.busy) {
        void refresh()
      }
    })
    return off
  }, [live, refresh])

  const recheck = useCallback(() => {
    if (busyRef.current) return
    void refresh()
  }, [refresh])

  /** 单项重测：真跑一次自检（不做假的「重测中」动画） */
  const retryOne = useCallback(
    (id: string) => {
      if (busyRef.current) return
      const item = items.find((entry) => entry.id === id)
      void refresh().then(() => {
        toast.info(item ? `${item.name} 已重测` : "已重测", {
          description: "结果以刚刚这一轮自检为准。",
        })
      })
    },
    [items, refresh]
  )

  /** 修复：调后端初始化（init:run），失败就如实报错 */
  const fixOne = useCallback(
    (id: string) => {
      const key = initKeyOf(id)
      const item = items.find((entry) => entry.id === id)
      if (!key) {
        const hint = item?.fix?.hint
        toast.warning("这一项需要手工处理", { description: hint ?? "按面板里的指引操作。" })
        return
      }
      if (busyRef.current) {
        toast.info("已有初始化任务在跑", { description: "等它结束再试。" })
        return
      }
      setBusy({ id, label: item?.fix?.action ?? "初始化中" })
      void call<{ ok?: boolean; reason?: string }>("initRun", key)
        .then((result) => {
          if (result && result.ok === false) {
            toast.error("初始化失败", { description: result.reason })
          } else {
            toast.success(`${item?.name ?? id} 初始化已提交`, {
              description: "跑完之后本文自检会自动刷新。",
            })
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          toast.error("初始化失败", { description: message })
        })
        .finally(() => setBusy(null))
    },
    [items]
  )

  /** 一键修复：把所有「缺且有初始化动作」的项依次跑一遍 */
  const clearWarnings = useCallback(() => {
    const pending = items.filter((item) => !item.ok && initKeyOf(item.id))
    if (pending.length === 0) {
      toast.info("没有可由启动器自动处理的项目")
      return
    }
    pending.forEach((item) => fixOne(item.id))
  }, [items, fixOne])

  // Node 版本与内存/线程数都取真报告；报告还没回来时用原型常量兜底，避免出现 "NaN GB"
  const runtime = report ? `Node ${report.node.version}` : ENV_META.runtime
  const ramGB = report ? `${Math.round(report.sys.memGB)} GB` : ENV_META.ram
  const threads = report ? report.sys.cpuThreads : ENV_META.threads

  const passCount = items.filter((i) => i.level === "ok").length
  const warnCount = items.filter((i) => i.level === "warn").length
  const missingCount = items.filter((i) => i.level === "missing" || i.level === "error").length

  return {
    items,
    checking,
    done: checking ? 0 : items.length,
    checkedAt,
    busy,
    passCount,
    warnCount,
    missingCount,
    runtime,
    ramGB,
    threads,
    blockers: items
      .filter((i) => (i.level === "missing" || i.level === "error") && i.blocking !== false)
      .map((i) => i.name),
    recheck,
    retryOne,
    fixOne,
    clearWarnings,
  }
}