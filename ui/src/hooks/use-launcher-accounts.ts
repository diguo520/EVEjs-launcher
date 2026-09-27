import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { callOr, hasIpc } from "@/lib/ipc"
import type { RawAccount, RawAccountList, RawAccountRunning, RawAck, RawRole } from "@/lib/ipc"
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  accountStats,
  seedAccounts,
  type Account,
  type AccountRole,
  type AccountStats,
  type Character,
  type CharacterDraft,
  type Guard,
  type InGameCreation,
} from "@/lib/launcher-logic"

/** 建号期间轮询账号列表的节拍与上限：客户端捏人慢，给足两分钟 */
const ROLE_POLL_MS = 5000
const ROLE_POLL_MAX = 24

function runOk(reply: unknown): reply is { ok: true } {
  return typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true
}

function reasonOf(reply: unknown, fallback: string): string {
  if (typeof reply === "object" && reply !== null) {
    const reason = (reply as { reason?: unknown }).reason
    if (typeof reason === "string" && reason) return reason
  }
  return fallback
}

/**
 * 后端 `accounts:list` 的一条 → 页面视图模型。
 *
 * 后端只给到 `characterId / characterName / avatar / shipName / skillPoints /
 * isk / securityStatus / location`；老启动器那份数据里还有种族、血统、性别，
 * 那是本地演示才有的东西，这里**不编**：拿不到就留空，界面上画「未记录」。
 */
function toCharacter(role: RawRole, online: boolean): Character {
  const where = role.location
  const location = [where?.solarSystemName, where?.stationName || where?.label]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ")
  const character: Character = {
    id: String(role.characterId ?? ""),
    name: role.characterName ?? "(未命名)",
    ship: role.shipName ?? "—",
    sp: typeof role.skillPoints === "number" ? role.skillPoints : 0,
    location: location || "—",
    online,
    bornAt: "—",
  }
  if (role.avatar) character.avatar = role.avatar
  return character
}

function toAccount(raw: RawAccount, onlineId: string | null): Account {
  const roles = Array.isArray(raw.roles) ? raw.roles : []
  const characters = roles.map((role) => toCharacter(role, String(role.characterId) === onlineId))
  const role: AccountRole = raw.isGM ? "GM" : "PLAYER"
  return {
    id: String(raw.accountId),
    name: raw.accountKey,
    role,
    status: raw.banned ? "SUSPENDED" : characters.length > 0 ? "READY" : "NEW",
    // 后端账号接口不返回创建时间 / 上次登录：界面画「—」，不拿演示值顶替
    createdAt: "—",
    lastLogin: "—",
    characters,
  }
}

export interface LauncherAccountsState {
  accounts: Account[]
  stats: AccountStats
  hydrated: boolean
  /** 真后端读不到时（浏览器预览）用种子数据，界面照样能看 */
  offline: boolean
  addAccount: (input: {
    name: string
    password?: string
    role: AccountRole
    character?: CharacterDraft
  }) => Guard
  /**
   * 到游戏里建号：拉起客户端，角色在客户端内捏好后由轮询同步回来。
   * 期间 creating 指向那个账号与当前的步骤，槽位显示为进行中。
   */
  createInGame: (accountId: string) => Guard
  /** 正在建号的那个账号走到哪一步了，同时只允许一个 */
  creating: InGameCreation | null
  deleteCharacter: (accountId: string, characterId: string) => Guard
  /** 删掉账号本身（连带其中的角色）；有角色在线时拒绝 */
  deleteAccount: (accountId: string) => Guard
  enterGame: (accountId: string, characterId: string) => Guard
  exitGame: (accountId: string, characterId: string) => void
  verify: (accountId: string, password: string) => Promise<Guard>
  setPassword: (accountId: string, oldPassword: string, newPassword: string) => Promise<Guard>
  /** 重新从后端读一遍账号列表 */
  reload: () => void
}

/**
 * 账号数据源：真值全部来自后端 `accounts:*`（CLI 读写账号数据库）。
 *
 * 与老启动器的差别：账号与角色的增删改查都落到服务端账号库，不再是本地演示数据；
 * 密码由启动器 DPAPI 加密保存（`accounts:create` 时顺手记住），所以「一键进游戏」
 * 不需要每次重填密码。没有桥时（浏览器里看原型）退回种子数据。
 */
export function useLauncherAccounts(): LauncherAccountsState {
  const ipc = hasIpc()
  const [accounts, setAccounts] = useState<Account[]>(() => (ipc ? [] : seedAccounts()))
  const [creating, setCreating] = useState<InGameCreation | null>(null)
  const [hydrated, setHydrated] = useState(false)
  /** 本启动器这轮拉起过的角色：accountId → characterId（后端不报「谁在线」） */
  const [onlineByAccount, setOnlineByAccount] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)

  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const onlineRef = useRef(onlineByAccount)
  onlineRef.current = onlineByAccount
  const creatingRef = useRef(creating)
  creatingRef.current = creating
  const timers = useRef<number[]>([])

  const load = useCallback(async () => {
    if (!ipc) {
      setHydrated(true)
      return
    }
    const reply = await callOr<RawAccountList>("accountsList", null)
    if (!reply?.ok || !Array.isArray(reply.data)) {
      setHydrated(true)
      return
    }
    const online = onlineRef.current
    setAccounts(reply.data.map((raw) => toAccount(raw, online[String(raw.accountId)] ?? null)))
    setHydrated(true)
  }, [ipc])

  useEffect(() => {
    void load()
  }, [load])

  /** 客户端是否在跑：不在跑就把「在线」标记全清掉（本启动器只认自己拉起的进程） */
  useEffect(() => {
    if (!ipc) return
    let alive = true
    const timer = window.setInterval(() => {
      void callOr<RawAccountRunning>("accountsCheckRunning", null).then((reply) => {
        if (!alive || !reply) return
        const next = reply.running === true
        setRunning(next)
        if (!next) {
          setOnlineByAccount((prev) => (Object.keys(prev).length === 0 ? prev : {}))
        }
      })
    }, 8000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [ipc])

  useEffect(() => {
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t))
      timers.current = []
    }
  }, [])

  const stats = useMemo(() => accountStats(accounts), [accounts])

  const reload = useCallback(() => {
    void load()
  }, [load])

  const addAccount = useCallback<LauncherAccountsState["addAccount"]>(
    ({ name, password, role }) => {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, reason: "账号名不能为空" }
      if (accountsRef.current.some((a) => a.name.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, reason: `账号「${trimmed}」已存在` }
      }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法创建账号" }
      const secret = password ?? ""
      if (!secret) return { ok: false, reason: "请填写账号密码" }
      void (async () => {
        const reply = await callOr<RawAck>("accountsCreate", null, trimmed, secret, role === "GM" || role === "ADMIN")
        if (!runOk(reply)) {
          toast.error("账号创建失败", { description: reasonOf(reply, "后端没说明原因") })
          return
        }
        await load()
        toast.success(`账号「${trimmed}」已创建`, {
          description: "密码已用当前 Windows 账户加密保存，进游戏不用重填。",
        })
      })()
      return { ok: true, reason: "" }
    },
    [ipc, load]
  )

  const deleteAccount = useCallback<LauncherAccountsState["deleteAccount"]>(
    (accountId) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      if (account.characters.some((c) => c.online)) {
        return { ok: false, reason: "有角色正在线上，先让它下线再删除账号" }
      }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法删除账号" }
      void (async () => {
        const reply = await callOr<RawAck>("accountsDelete", null, account.name, true)
        if (!runOk(reply)) {
          toast.error("删除账号失败", { description: reasonOf(reply, "后端没说明原因") })
          return
        }
        setOnlineByAccount((prev) => {
          const next = { ...prev }
          delete next[accountId]
          return next
        })
        await load()
      })()
      return { ok: true, reason: "" }
    },
    [ipc, load]
  )

  /** 删单个角色：后端按角色名删，不需要账号上下文 */
  const deleteCharacter = useCallback<LauncherAccountsState["deleteCharacter"]>(
    (accountId, characterId) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      const character = account?.characters.find((c) => c.id === characterId)
      if (!character) return { ok: false, reason: "角色不存在" }
      if (character.online) return { ok: false, reason: "角色正在线上，先在客户端里退出" }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法删除角色" }
      void (async () => {
        const reply = await callOr<RawAck>("accountsDelete", null, character.name, true)
        if (!runOk(reply)) {
          toast.error("删除角色失败", { description: reasonOf(reply, "后端没说明原因") })
          return
        }
        await load()
      })()
      return { ok: true, reason: "" }
    },
    [ipc, load]
  )

  const enterGame = useCallback<LauncherAccountsState["enterGame"]>(
    (accountId, characterId) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      if (account.status === "SUSPENDED") return { ok: false, reason: "账号已停用，进不去客户端" }
      const online = account.characters.find((c) => c.online)
      if (online && online.id !== characterId) {
        return { ok: false, reason: `同账号的 ${online.name} 正在线上，先让它下线` }
      }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法拉起客户端" }
      void (async () => {
        const reply = await callOr<RawAck>("accountsLaunch", null, account.name, characterId)
        if (!runOk(reply)) {
          toast.error("无法登录", { description: reasonOf(reply, "客户端没能拉起") })
          return
        }
        setOnlineByAccount((prev) => ({ ...prev, [accountId]: characterId }))
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId
              ? {
                  ...a,
                  characters: a.characters.map((c) => ({
                    ...c,
                    online: c.id === characterId,
                    onlineSince: c.id === characterId ? Date.now() : undefined,
                  })),
                }
              : a
          )
        )
      })()
      return { ok: true, reason: "" }
    },
    [ipc]
  )

  const exitGame = useCallback<LauncherAccountsState["exitGame"]>(
    (accountId, characterId) => {
      setOnlineByAccount((prev) => {
        const next = { ...prev }
        delete next[accountId]
        return next
      })
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                characters: a.characters.map((c) =>
                  c.id === characterId ? { ...c, online: false, onlineSince: undefined } : c
                ),
              }
            : a
        )
      )
    },
    []
  )

  /** 到游戏里建号：拉起客户端，然后轮询账号列表，等新角色出现 */
  const createInGame = useCallback<LauncherAccountsState["createInGame"]>(
    (accountId) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      if (account.status === "SUSPENDED") return { ok: false, reason: "账号已停用，进不去客户端" }
      if (account.characters.length >= MAX_CHARACTERS_PER_ACCOUNT) {
        return { ok: false, reason: "槽位已满，已无法再建号" }
      }
      const online = account.characters.find((c) => c.online)
      if (online) return { ok: false, reason: `同账号的 ${online.name} 正在线上，先让它下线` }
      if (creatingRef.current?.accountId === accountId) {
        return { ok: false, reason: "客户端已经在角色创建界面" }
      }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法拉起客户端" }

      const before = account.characters.length
      void (async () => {
        const reply = await callOr<RawAck>("accountsLaunch", null, account.name, null)
        if (!runOk(reply)) {
          toast.error("无法进入角色创建界面", { description: reasonOf(reply, "客户端没能拉起") })
          return
        }
        setCreating({ accountId, step: "editing" })
        toast.info("正在把客户端拉起来", {
          description: "角色在游戏内捏好后会自动同步回账号列表。",
        })
        let ticks = 0
        const poll = window.setInterval(() => {
          ticks += 1
          void callOr<RawAccountList>("accountsList", null).then(async (list) => {
            if (!list?.ok || !Array.isArray(list.data)) return
            const fresh = list.data.find((raw) => String(raw.accountId) === accountId)
            const count = Array.isArray(fresh?.roles) ? fresh.roles.length : 0
            if (count > before) {
              window.clearInterval(poll)
              const name = fresh?.roles?.[count - 1]?.characterName ?? "新角色"
              setCreating(null)
              await load()
              toast.success(`角色 ${name} 已在游戏内创建`, {
                description: "已同步回启动器。",
              })
              return
            }
            if (ticks >= ROLE_POLL_MAX) {
              window.clearInterval(poll)
              setCreating((current) => (current?.accountId === accountId ? null : current))
              void load()
            }
          })
        }, ROLE_POLL_MS)
        timers.current.push(poll)
      })()
      return { ok: true, reason: "" }
    },
    [ipc, load]
  )

  const verify = useCallback<LauncherAccountsState["verify"]>(
    async (accountId, password) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      const reply = await callOr<RawAck>("accountsVerify", null, account.name, password)
      if (!runOk(reply)) return { ok: false, reason: reasonOf(reply, "密码不正确") }
      return { ok: true, reason: "" }
    },
    []
  )

  const setPassword = useCallback<LauncherAccountsState["setPassword"]>(
    async (accountId, oldPassword, newPassword) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      if (!account) return { ok: false, reason: "账号不存在" }
      const reply = await callOr<RawAck>(
        "accountsSetPassword",
        null,
        account.name,
        oldPassword,
        newPassword
      )
      if (!runOk(reply)) return { ok: false, reason: reasonOf(reply, "改密码失败") }
      await load()
      return { ok: true, reason: "" }
    },
    [load]
  )

  return {
    accounts,
    stats,
    hydrated,
    offline: !ipc || !running,
    addAccount,
    createInGame,
    creating,
    deleteCharacter,
    deleteAccount,
    enterGame,
    exitGame,
    verify,
    setPassword,
    reload,
  }
}
