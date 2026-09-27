import { useCallback, useEffect, useState } from "react"

import type { CommandRow } from "@/lib/manual-logic"

/** 自定义指令留在本地，刷新后仍在 */
const STORAGE_KEY = "evejs_custom_commands"

function isRowArray(v: unknown): v is CommandRow[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as CommandRow).cmd === "string" &&
        typeof (r as CommandRow).cat === "string"
    )
  )
}

function readStored(): CommandRow[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isRowArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface CustomCommandsState {
  custom: CommandRow[]
  hydrated: boolean
  /** 指令名重复时返回 false，不覆盖 */
  add: (row: CommandRow) => boolean
  remove: (cmd: string) => void
  /** 导入 JSON 时整体替换 */
  replaceAll: (rows: CommandRow[]) => void
}

/** 自定义条目的稳定标识：同一指令名只会存在一条，用名字即可 */
const asCustom = (r: CommandRow): CommandRow => ({
  ...r,
  custom: true,
  uid: `custom:${r.cmd}`,
})

export function useCustomCommands(): CustomCommandsState {
  const [custom, setCustom] = useState<CommandRow[]>([])
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    const stored = readStored()
    if (stored) setCustom(stored.map(asCustom))
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(custom))
    } catch {
      // 隐私模式 / 配额写满时忽略，界面照常可用
    }
  }, [custom, hydrated])

  const add = useCallback<CustomCommandsState["add"]>((row) => {
    let accepted = false
    setCustom((prev) => {
      if (prev.some((r) => r.cmd === row.cmd)) return prev
      accepted = true
      return [...prev, asCustom(row)]
    })
    return accepted
  }, [])

  const remove = useCallback<CustomCommandsState["remove"]>((cmd) => {
    setCustom((prev) => prev.filter((r) => r.cmd !== cmd))
  }, [])

  const replaceAll = useCallback<CustomCommandsState["replaceAll"]>((rows) => {
    setCustom(rows.map(asCustom))
  }, [])

  return { custom, hydrated, add, remove, replaceAll }
}
