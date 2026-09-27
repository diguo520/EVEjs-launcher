import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  CHECK_ITEMS,
  ENV_META,
  MARKET_BIN,
  applyDerivedChecks,
  binTargetVersion,
  type CheckInputs,
  type CheckItem,
} from "@/lib/mock"

/** 单项检测的耗时，六项加起来一秒出头，够看清走到哪一项 */
const STEP_MS = 190
/** 单项修复的耗时：签证书不是瞬间的事，太快反而像没做 */
const FIX_MS = 1400
/** 单项重测的耗时，比整轮慢一点，好让「正在重测」这句话被看见 */
const RETRY_MS = 900

/** 检测时间戳，格式与日志一致：14:05:32 */
function stampNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface EnvCheckState {
  items: CheckItem[]
  /** 整轮检测是否在跑 */
  checking: boolean
  /** 已经检测完的项数，等于 items.length 就是跑完了 */
  done: number
  checkedAt: string
  /** 单项操作：正在处理哪一项、界面上怎么描述它 */
  busy: { id: string; label: string } | null
  passCount: number
  warnCount: number
  /** 未检测到的项数 */
  missingCount: number
  /** 缺了就没法启动的项名，用来挡一键启动 */
  blockers: string[]
  recheck: () => void
  retryOne: (id: string) => void
  fixOne: (id: string) => void
  clearWarnings: () => void
}

/**
 * 环境自检的结果提升到这里：面板、底部状态栏、一键启动的门禁都要看同一份结论，
 * 各存一份状态迟早会互相打架（面板说缺东西、状态栏还说 READY）。
 *
 * 依赖与二进制两项不吃死数据：serverRoot 是配置里的服务端根目录，
 * launcherVersion 是启动器当前构建（它一更新，本地二进制就落后一个版本）；
 * onRestoreRoot 是根目录那两项的修复动作——把根目录改回默认位置。
 */
export function useEnvCheck({
  serverRoot,
  launcherVersion,
  onRestoreRoot,
}: {
  serverRoot: string
  launcherVersion: string
  onRestoreRoot: () => void
}): EnvCheckState {
  /** 本地那份市场服务二进制的版本，同步之后就追上启动器 */
  const [binVersion, setBinVersion] = useState(MARKET_BIN.version)
  const [items, setItems] = useState<CheckItem[]>(() =>
    applyDerivedChecks(CHECK_ITEMS, {
      root: serverRoot,
      binVersion: MARKET_BIN.version,
      launcherVersion,
    })
  )
  const [checking, setChecking] = useState(false)
  const [done, setDone] = useState(0)
  const [checkedAt, setCheckedAt] = useState(ENV_META.checkedAt)
  const [busy, setBusy] = useState<{ id: string; label: string } | null>(null)

  /** 单项操作的回调在计时器里跑，得读到最新的 items */
  const itemsRef = useRef(items)
  itemsRef.current = items
  const busyTimer = useRef<number | null>(null)
  /** 正在整轮检测时不许插单项操作，两边的 done 会串 */
  const checkingRef = useRef(checking)
  checkingRef.current = checking

  /** 修复回调挂 ref：父级换了函数身份不该把重算带跑 */
  const restoreRoot = useRef(onRestoreRoot)
  restoreRoot.current = onRestoreRoot
  /** 修复动作里要用到当下的启动器构建，回调不能直接吃闭包里的旧值 */
  const launcherRef = useRef(launcherVersion)
  launcherRef.current = launcherVersion
  /** 记着上一次算过的输入，只在它真的变了的时候重算 */
  const appliedKey = useRef(`${serverRoot}|${MARKET_BIN.version}|${launcherVersion}`)

  /**
   * 三项输入任一变了就重算依赖与二进制：目录改错当场变红挡住启动、改回来又都在，
   * 启动器更新之后二进制当场变成「落后一个版本」。不用等下一次整轮检测。
   */
  useEffect(() => {
    const key = `${serverRoot}|${binVersion}|${launcherVersion}`
    if (appliedKey.current === key) return
    appliedKey.current = key
    const input: CheckInputs = { root: serverRoot, binVersion, launcherVersion }
    setItems((prev) => applyDerivedChecks(prev, input))
  }, [serverRoot, binVersion, launcherVersion])

  useEffect(
    () => () => {
      if (busyTimer.current !== null) window.clearTimeout(busyTimer.current)
    },
    []
  )

  /**
   * 逐项检测：每 STEP_MS 落定一项，走到哪一项就把那一项的结果写出来。
   * 提醒项在重测里视为已处理，未检测到的项仍然未检测到——缺的东西不会因为重测就出现。
   * 带修复动作的提醒项除外（二进制版本落后）：重测不会把版本追平，得真去同步。
   */
  useEffect(() => {
    if (!checking) return
    if (done >= items.length) {
      setChecking(false)
      setCheckedAt(stampNow())
      // 收尾时按当下的结果数，提醒项这一轮已经被抹平了
      const missing = itemsRef.current.filter((i) => i.level === "missing")
      const failed = itemsRef.current.filter((i) => i.level === "error").length
      const warned = itemsRef.current.filter((i) => i.level === "warn")
      if (missing.length > 0) {
        toast.error("环境自检未通过", {
          description: `${missing.map((i) => i.name).join("、")} 未检测到，补上才能启动。`,
        })
      } else if (failed > 0) {
        toast.error("环境自检未通过", {
          description: `${failed} 项检查失败，处理完才能启动`,
        })
      } else if (warned.length > 0) {
        // 提醒不挡启动，但别报成「全部通过」
        toast.warning("环境自检已完成，有提醒项", {
          description: `${warned.map((i) => i.name).join("、")} 需要处理。`,
        })
      } else {
        toast.success("环境自检已完成", {
          description: `${items.length} 项检查全部通过`,
        })
      }
      return
    }
    const timer = window.setTimeout(() => {
      setItems((prev) =>
        prev.map((item, index) =>
          index === done && item.level === "warn" && !item.fix
            ? { ...item, level: "ok" as const }
            : item
        )
      )
      setDone((prev) => prev + 1)
    }, STEP_MS)
    return () => window.clearTimeout(timer)
  }, [checking, done, items.length])

  function stopBusy() {
    if (busyTimer.current !== null) {
      window.clearTimeout(busyTimer.current)
      busyTimer.current = null
    }
  }

  /** 整轮重跑：已经补好的项保持已就绪，提醒项视为已处理 */
  const recheck = useCallback(() => {
    stopBusy()
    setBusy(null)
    setDone(0)
    setChecking(true)
  }, [])

  /** 只重测一项：作者自己动手装完之后，得能单独确认这一项 */
  const retryOne = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item || checkingRef.current) return
    stopBusy()
    setBusy({ id, label: `正在重测「${item.name}」…` })
    busyTimer.current = window.setTimeout(() => {
      busyTimer.current = null
      setBusy(null)
      setCheckedAt(stampNow())
      if (item.level === "missing") {
        toast.error(`${item.name} 仍未检测到`, {
          description: item.fix?.hint ?? "确认装好之后再重测一次。",
        })
      } else if (item.level === "warn" && item.fix) {
        // 重测改变不了落后这件事：版本得真同步过去，别报成「正常」
        toast.warning(`${item.name} 仍然落后`, { description: item.fix.hint })
      } else {
        toast.success(`${item.name} 正常`, { description: item.detail })
      }
    }, RETRY_MS)
  }, [])

  /** 启动器能自己补的那一项：补完当场变成已检测到，门禁随之放行 */
  const fixOne = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id)
    const fix = item?.fix
    if (!item || !fix?.action || checkingRef.current) return
    stopBusy()
    setBusy({ id, label: `正在${fix.action}…` })
    busyTimer.current = window.setTimeout(() => {
      busyTimer.current = null
      setBusy(null)
      setCheckedAt(stampNow())
      // 依赖与二进制这两项没什么好补的，缺的原因是配置：把根目录改回去，重算会接上
      if (fix.repair === "root") {
        restoreRoot.current()
        toast.success(`${item.name} 已就绪`, { description: fix.done })
        return
      }
      // 版本落后不是缺文件：把本地这份同步到启动器当前构建，重算会接上
      if (fix.repair === "bin") {
        setBinVersion(binTargetVersion(launcherRef.current))
        toast.success(`${item.name} 已就绪`, { description: fix.done })
        return
      }
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? { ...i, level: "ok" as const, ok: true, detail: fix.okDetail }
            : i
        )
      )
      toast.success(`${item.name} 已就绪`, { description: fix.done })
    }, FIX_MS)
  }, [])

  /**
   * 一键修复提醒项：带修复动作的（二进制版本落后）要真的同步过去。
   * 光把界面抹平会让读数与状态对不上——显示的版本还是旧的，却标成通过。
   */
  const clearWarnings = useCallback(() => {
    const stale = itemsRef.current.some((i) => i.level === "warn" && i.fix?.repair)
    if (stale) setBinVersion(binTargetVersion(launcherRef.current))
    setItems((prev) =>
      prev.map((i) =>
        i.level === "warn" && !i.fix ? { ...i, level: "ok" as const } : i
      )
    )
  }, [])

  return {
    items,
    checking,
    done,
    checkedAt,
    busy,
    passCount: items.filter((i) => i.level === "ok").length,
    warnCount: items.filter((i) => i.level === "warn").length,
    missingCount: items.filter((i) => i.level === "missing").length,
    blockers: items
      .filter((i) => i.level === "missing" && i.blocking !== false)
      .map((i) => i.name),
    recheck,
    retryOne,
    fixOne,
    clearWarnings,
  }
}
