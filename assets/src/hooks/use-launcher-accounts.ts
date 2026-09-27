import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  accountStats,
  canCreateInGame,
  canDeleteAccount,
  canLogin,
  createCharacter,
  formatDate,
  formatStamp,
  loginCharacter,
  logoutCharacter,
  normalizeAccounts,
  pickInGamePilot,
  raceOf,
  removeAccount,
  removeCharacter,
  seedAccounts,
  validateAccountName,
  type Account,
  type AccountRole,
  type AccountStats,
  type CharacterDraft,
  type Guard,
  type InGameCreation,
} from "@/lib/launcher-logic"

/** 建号三步各自的耗时：拉起客户端最慢，取回角色最快，加起来够看清走到哪一步 */
const LAUNCH_MS = 900
const EDIT_MS = 2400
const SYNC_MS = 700

/** 账号与角色留在本地，刷新后仍在；换真数据库时只替换这一层 */
const STORAGE_KEY = "evejs_launcher_accounts"

function isAccountArray(v: unknown): v is Account[] {
  return (
    Array.isArray(v) &&
    v.every(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as Account).name === "string" &&
        Array.isArray((a as Account).characters)
    )
  )
}

function readStored(): Account[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isAccountArray(parsed) ? normalizeAccounts(parsed) : null
  } catch {
    return null
  }
}

export interface LauncherAccountsState {
  accounts: Account[]
  stats: AccountStats
  hydrated: boolean
  addAccount: (input: {
    name: string
    role: AccountRole
    character?: CharacterDraft
  }) => Guard
  /**
   * 到游戏里建号：拉起客户端，角色在客户端内捏好后回填到空槽。
   * 期间 creating 指向那个账号与当前的步骤，槽位显示为进行中。
   */
  createInGame: (accountId: string) => Guard
  /** 正在建号的那个账号走到哪一步了，同时只允许一个 */
  creating: InGameCreation | null
  deleteCharacter: (accountId: string, characterId: string) => void
  /** 删掉账号本身（连带其中的角色）；有角色在线时拒绝 */
  deleteAccount: (accountId: string) => Guard
  enterGame: (accountId: string, characterId: string) => Guard
  exitGame: (accountId: string, characterId: string) => void
  /** 重新从本地存储读一遍（多标签页同时改过时用） */
  reload: () => void
}

/**
 * 账号数据源：种子数据 + 本地持久化 + 全部状态迁移。
 * 首屏渲染始终用种子，读盘放在 effect 里，避免服务端与客户端首帧不一致。
 *
 * 状态挂在外壳上而不是账号页里：到游戏里建号要等客户端几秒，
 * 这期间用户切到别的页面看日志很正常，回到账号页时角色不该丢。
 */
export function useLauncherAccounts(): LauncherAccountsState {
  const [accounts, setAccounts] = useState<Account[]>(seedAccounts)
  const [creating, setCreating] = useState<InGameCreation | null>(null)
  const [hydrated, setHydrated] = useState(false)

  /** 建号要等客户端，回调里必须看到最新的账号，不能用闭包里那份 */
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  /** 建号的三段定时器，外壳卸载时一并清掉 */
  const timers = useRef<number[]>([])

  useEffect(() => {
    const stored = readStored()
    if (stored) setAccounts(stored)
    setHydrated(true)
  }, [])

  useEffect(() => {
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t))
      timers.current = []
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
    } catch {
      // 隐私模式 / 配额写满时忽略，界面照常可用
    }
  }, [accounts, hydrated])

  const stats = useMemo(() => accountStats(accounts), [accounts])

  const addAccount = useCallback<LauncherAccountsState["addAccount"]>(
    ({ name, role, character }) => {
      const guard = validateAccountName(name, accounts)
      if (!guard.ok) return guard

      const stamp = Date.now()
      const account: Account = {
        id: `acc-${stamp}`,
        name: name.trim(),
        role,
        createdAt: formatDate(new Date(stamp)),
        lastLogin: "—",
        status: "NEW",
        characters: [],
      }
      const withCharacter = character
        ? createCharacter(account, character, `chr-${stamp}`, account.createdAt)
        : account

      setAccounts((prev) => [withCharacter, ...prev])
      return { ok: true, reason: "" }
    },
    [accounts]
  )

  const createInGame = useCallback<LauncherAccountsState["createInGame"]>(
    (accountId) => {
      const account = accounts.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      if (creating?.accountId === accountId) {
        return { ok: false, reason: "客户端已经在角色创建界面" }
      }

      const guard = canCreateInGame(account)
      if (!guard.ok) return guard

      const draft = pickInGamePilot(accounts)
      const characterId = `chr-${Date.now()}`
      setCreating({ accountId, step: "launching" })
      toast.info("正在把客户端拉起来", {
        description: "角色在游戏内捏好后会自动同步回账号列表。",
      })

      timers.current.push(
        window.setTimeout(() => setCreating({ accountId, step: "editing" }), LAUNCH_MS),
        window.setTimeout(
          () => setCreating({ accountId, step: "syncing" }),
          LAUNCH_MS + EDIT_MS
        )
      )

      timers.current.push(
        window.setTimeout(() => {
          setCreating(null)
          const fresh = accountsRef.current.find((a) => a.id === accountId)
          const late = fresh
            ? canCreateInGame(fresh)
            : { ok: false, reason: "账号已被删除" }
          if (!late.ok) {
            toast.error("角色没有建成", { description: late.reason })
            return
          }

          const at = Date.now()
          setAccounts((prev) =>
            prev.map((a) => {
              if (a.id !== accountId) return a
              // 建完就人在船上，直接按登录态放回槽位
              const stamp = formatStamp(new Date(at))
              return loginCharacter(
                createCharacter(a, draft, characterId, stamp),
                characterId,
                stamp,
                at
              )
            })
          )
          toast.success(`角色 ${draft.name} 已在游戏内创建`, {
            description: `${raceOf(draft.race).name} · ${draft.bloodline} · 已同步回启动器并自动登录。`,
          })
        }, LAUNCH_MS + EDIT_MS + SYNC_MS)
      )

      return { ok: true, reason: "" }
    },
    [accounts, creating]
  )

  const deleteCharacter = useCallback<LauncherAccountsState["deleteCharacter"]>(
    (accountId, characterId) => {
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? removeCharacter(a, characterId) : a
        )
      )
    },
    []
  )

  const deleteAccount = useCallback<LauncherAccountsState["deleteAccount"]>(
    (accountId) => {
      const account = accounts.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }

      const guard = canDeleteAccount(account)
      if (!guard.ok) return guard

      setAccounts((prev) => removeAccount(prev, accountId))
      return { ok: true, reason: "" }
    },
    [accounts]
  )

  const enterGame = useCallback<LauncherAccountsState["enterGame"]>(
    (accountId, characterId) => {
      const account = accounts.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      const character = account.characters.find((c) => c.id === characterId)
      if (!character) return { ok: false, reason: "角色不存在" }

      const guard = canLogin(account, character)
      if (!guard.ok) return guard

      const at = Date.now()
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? loginCharacter(a, characterId, formatStamp(new Date(at)), at)
            : a
        )
      )
      return { ok: true, reason: "" }
    },
    [accounts]
  )

  const exitGame = useCallback<LauncherAccountsState["exitGame"]>(
    (accountId, characterId) => {
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? logoutCharacter(a, characterId) : a
        )
      )
    },
    []
  )

  const reload = useCallback(() => {
    setAccounts(readStored() ?? seedAccounts())
  }, [])

  return {
    accounts,
    stats,
    hydrated,
    addAccount,
    createInGame,
    creating,
    deleteCharacter,
    deleteAccount,
    enterGame,
    exitGame,
    reload,
  }
}
