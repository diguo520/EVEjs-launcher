import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { callOr, hasIpc, subscribe } from "@/lib/ipc"
import { t } from "@/lib/i18n"
import type {
  RawAccount,
  RawAccountList,
  RawAck,
  RawLogotypeList,
  RawRole,
  RawService,
} from "@/lib/ipc"
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  accountStats,
  bloodlineFromId,
  genderFromCode,
  raceFromId,
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
 * 后端给到 `characterId / characterName / avatar / shipName / skillPoints / isk /
 * securityStatus / location`，以及角色表里的 `raceID / bloodlineID / gender /
 * corporationID / allianceID`（军团与联盟名字由 CLI 反查）。换算不出来的
 * 字段就留空、界面画「未记录」，绝不拿演示数据顶替。
 */
function toCharacter(role: RawRole, online: boolean): Character {
  const where = role.location
  const system = typeof where?.solarSystemName === "string" ? where.solarSystemName : ""
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
  if (typeof role.isk === "number") character.isk = role.isk
  if (system) character.system = system

  const race = raceFromId(role.raceID)
  if (race) character.race = race
  const bloodline = bloodlineFromId(role.bloodlineID)
  if (bloodline) character.bloodline = bloodline
  const gender = genderFromCode(role.gender)
  if (gender) character.gender = gender

  if (typeof role.corporationID === "number" && role.corporationID > 0) {
    character.corporationId = role.corporationID
    if (role.corporationName) character.corporationName = role.corporationName
    if (role.corporationTicker) character.corporationTicker = role.corporationTicker
  }
  if (typeof role.allianceID === "number" && role.allianceID > 0) {
    character.allianceId = role.allianceID
    if (role.allianceName) character.allianceName = role.allianceName
    if (role.allianceTicker) character.allianceTicker = role.allianceTicker
  }
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
  /**
   * 军团 / 联盟的**专属**徽标（data URL），键为 `kind:id`（如 `alliances:99000000`）。
   *
   * 值缺失或为 null = 服务端没有这个实体的专属徽标。这时界面画短标识
   * （军团 ticker / 联盟简称），**不要**回退到服务端那张兜底图 ——
   * `evejscorp.png` 与 `alliance-default.png` 是同一张画，画出来军团和联盟一模一样。
   */
  logotypes: Record<string, string | null>
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
  /** 军团 / 联盟专属徽标：`kind:id` → data URL（null = 服务端没有专属徽标） */
  const [logotypes, setLogotypes] = useState<Record<string, string | null>>({})
  /** 已经问过外壳的徽标键：null 也是答案，不重复问 */
  const logotypeAsked = useRef<Set<string>>(new Set())
  /** 客户端进程此刻是否在跑（订阅外壳的 client 服务态，见下面的「关窗口」效应） */
  const clientAlive = useRef(false)

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

  /**
   * 军团 / 联盟徽标：外壳直接从服务端图片目录读盘（服务端关着也能画），
   * 拿不到专属徽标就回 null，界面改画短标识。问过的键（含 null）不再重复问。
   */
  useEffect(() => {
    if (!ipc) return
    const wanted = new Map<string, { kind: "corporations" | "alliances"; id: number }>()
    for (const account of accounts) {
      for (const character of account.characters) {
        if (character.corporationId) {
          wanted.set(`corporations:${character.corporationId}`, {
            kind: "corporations",
            id: character.corporationId,
          })
        }
        if (character.allianceId) {
          wanted.set(`alliances:${character.allianceId}`, {
            kind: "alliances",
            id: character.allianceId,
          })
        }
      }
    }
    const pending = [...wanted.entries()].filter(([key]) => !logotypeAsked.current.has(key))
    if (pending.length === 0) return
    for (const [key] of pending) logotypeAsked.current.add(key)
    let alive = true
    void callOr<RawLogotypeList>(
      "accountsLogotypes",
      null,
      pending.map(([, request]) => request)
    ).then((reply) => {
      // 失败就把键放回去：下次列表变化时重问一遍，别把一次失败当成「没有徽标」
      if (!alive || !reply?.ok || !Array.isArray(reply.data)) {
        for (const [key] of pending) logotypeAsked.current.delete(key)
        return
      }
      setLogotypes((prev) => {
        const next = { ...prev }
        for (const item of reply.data ?? []) next[`${item.kind}:${item.id}`] = item.dataUrl ?? null
        return next
      })
    })
    return () => {
      alive = false
    }
  }, [ipc, accounts])

  /**
   * 客户端进程退出 = 用户把游戏窗口关了：立刻把「在线」标记全清掉。
   *
   * 原先这里探的是**服务端端口**（accounts:checkRunning）：服务端只要开着就恒为 true，
   * 于是关掉游戏窗口后角色一直挂着在线徽标与「下线」按钮，永远不恢复。外壳其实已经把
   * 客户端进程的退出写进 client 服务态（子进程 wait 返回后置 error / 清 pid），订阅它才对。
   */
  useEffect(() => {
    if (!ipc) return
    return subscribe("onServicesChanged", (payload) => {
      const list = Array.isArray(payload) ? (payload as RawService[]) : null
      const client = list?.find((service) => service.id === "client")
      if (!client) return
      const alive = client.state === "running" || client.state === "starting"
      const was = clientAlive.current
      clientAlive.current = alive
      if (alive || !was) return
      // 连 ref 一起同步清零：紧接着的 load() 才不会按旧映射把在线又标回来
      onlineRef.current = {}
      setOnlineByAccount({})
      setCreating(null)
      setAccounts((prev) =>
        prev.map((account) => ({
          ...account,
          characters: account.characters.map((character) =>
            character.online ? { ...character, online: false, onlineSince: undefined } : character
          ),
        }))
      )
      void load()
    })
  }, [ipc, load])

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
        return { ok: false, reason: t("账号「{name}」已存在", { name: trimmed }) }
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
        toast.success(t("账号「{name}」已创建", { name: trimmed }), {
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

  /** 删单个角色：走 delete-character（只删角色，账号保留） */
  const deleteCharacter = useCallback<LauncherAccountsState["deleteCharacter"]>(
    (accountId, characterId) => {
      const account = accountsRef.current.find((a) => a.id === accountId)
      const character = account?.characters.find((c) => c.id === characterId)
      if (!character) return { ok: false, reason: "角色不存在" }
      if (character.online) return { ok: false, reason: "角色正在线上，先在客户端里退出" }
      if (!ipc) return { ok: false, reason: "没有连接后端，无法删除角色" }
      void (async () => {
        // 只删这一个角色：走 accounts:deleteCharacter（账号与其余角色都保留）。
        // 绝不能退回 accounts:delete —— 那条通道传角色名会反查出账号并**连账号一起删**。
        const reply = await callOr<RawAck>("accountsDeleteCharacter", null, character.id, true)
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
        return {
          ok: false,
          reason: t("同账号的 {name} 正在线上，先让它下线", { name: online.name }),
        }
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
      if (online)
        return {
          ok: false,
          reason: t("同账号的 {name} 正在线上，先让它下线", { name: online.name }),
        }
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
              toast.success(t("角色 {name} 已在游戏内创建", { name }), {
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
    offline: !ipc,
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
    logotypes,
  }
}
