/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type {
  Account,
  AccountRole,
  AccountStatus,
  Backup,
  BackupKind,
  Faction,
  InstallTask,
  LogEntry,
  LogLevel,
  LogModule,
  MarketMod,
  MetricSample,
  ModDraft,
  ModEntry,
  ModSubmission,
  ModSubmissionDraft,
  ServerStatus,
  UniverseConfig,
} from "./types"
import { marketEntryFromSubmission } from "./market"
import { slugifyModId } from "./modTemplate"
import { clearProgress, loadProgress, saveProgress } from "./persist"
import {
  authorSinceFromId,
  isValidAuthorId,
  loadAuthor,
  saveAuthor,
  type AuthorProfile,
} from "./author"
import {
  BOOT_LOGS,
  BOOT_STAGES,
  DEFAULT_CONFIG,
  PRESETS,
  RUNNING_LOG_POOL,
  SEED_ACCOUNTS,
  SEED_BACKUPS,
  SEED_MARKET,
  SEED_MODS,
} from "./seed"

export interface AccountDraft {
  username: string
  character: string
  corp: string
  faction: Faction
  role: AccountRole
  isk: number
  skillPoints: number
  shipName: string
  solarSystem: string
  note: string
}

export interface EngineValue {
  /* 服务端 */
  serverStatus: ServerStatus
  startedAt: number | null
  now: number
  uptime: number
  bootProgress: number
  bootStageIndex: number
  crashReason: string
  samples: MetricSample[]
  tickCount: number
  /* 数据 */
  logs: LogEntry[]
  config: UniverseConfig
  accounts: Account[]
  backups: Backup[]
  mods: ModEntry[]
  /* 服务端动作 */
  start: () => void
  stop: () => void
  restart: () => void
  simulateCrash: () => void
  /* 配置 */
  updateConfig: (patch: Partial<UniverseConfig>) => void
  applyPreset: (id: string) => void
  resetConfig: () => void
  /* 账号 */
  createAccount: (draft: AccountDraft) => void
  updateAccount: (id: string, patch: Partial<Account>) => void
  removeAccount: (id: string) => void
  grantIsk: (ids: string[], amount: number) => void
  grantSp: (ids: string[], amount: number) => void
  setAccountStatus: (ids: string[], status: AccountStatus) => void
  /* 存档 */
  createBackup: (label: string, note: string, kind: BackupKind) => void
  restoreBackup: (id: string) => void
  deleteBackup: (id: string) => void
  /* 模组 */
  toggleMod: (id: string) => void
  moveMod: (id: string, dir: -1 | 1) => void
  createMod: (draft: ModDraft) => void
  /* 模组市场 */
  market: MarketMod[]
  installQueue: InstallTask[]
  installMod: (id: string) => void
  updateMod: (id: string) => void
  uninstallMod: (id: string) => void
  cancelInstall: (id: string) => void
  /* 提交上架 */
  submissions: ModSubmission[]
  /** existingId 用来把「本地新建的模组」和「它的上架条目」绑成同一个 id。 */
  submitMod: (draft: ModSubmissionDraft, existingId?: string) => void
  withdrawSubmission: (id: string) => void
  /* 作者身份 */
  /** 本机作者档案。署名只负责显示，认人靠里面的标识。 */
  author: AuthorProfile
  /** 改署名，名下所有模组一起跟着改。 */
  updateAuthor: (patch: { name?: string }) => void
  /** 作者更新自己已上架的模组：改资料 + 提版本，重新走一遍审核。 */
  updateOwnMod: (id: string, draft: ModSubmissionDraft) => void
  /** 认回一串已有的作者标识：换了机器或清了浏览器数据之后，把自己接回原来的身份。 */
  adoptAuthor: (id: string) => void
  /* 评分 */
  /** 给市场里的模组打分，1–5 的整数；改分直接再打一次。 */
  rateMod: (id: string, stars: number) => void
  /** 收回自己那一票，分数回到别人打出来的样子。 */
  clearRating: (id: string) => void
  /* 评价 */
  /** 写 / 改自己那条评价。没打过分不能写 —— 评价要挂在自己那一票上。 */
  saveReview: (id: string, text: string) => void
  /** 删掉自己写的那条评价。分还留着，只是话收回了。 */
  clearReview: (id: string) => void
  /** 把自己发的条目从市场撤下来。别人看不到，自己的本地副本不动。 */
  delistMod: (id: string) => void
  /** 把下架的条目重新挂回市场。 */
  relistMod: (id: string) => void
  /* 日志 */
  pushLog: (level: LogLevel, module: LogModule, message: string, trace?: string) => void
  clearLogs: () => void
  /* 本机进度 */
  /** 上次写进本机的时间；一次都没存过就是 null。 */
  savedAt: number | null
  autoSave: boolean
  setAutoSave: (on: boolean) => void
  /** 立刻写一次，不等自动保存的延迟。 */
  saveNow: () => void
  /** 清掉本机存档，所有数据回到初始状态。 */
  resetProgress: () => void
}

const EngineContext = createContext<EngineValue | null>(null)

const BOOT_TOTAL_MS = 9600
const TOTAL_WEIGHT = BOOT_STAGES.reduce((sum, s) => sum + s.weight, 0)
const MAX_SAMPLES = 120
const MAX_LOGS = 400

/** 每段启动占用的毫秒数。 */
function stageDuration(index: number): number {
  return (BOOT_STAGES[index].weight / TOTAL_WEIGHT) * BOOT_TOTAL_MS
}

export function ServerEngineProvider({ children }: { children: ReactNode }) {
  /* 本机存档只读一次，下面所有初始 state 都从这里取值；没有存档就退回种子数据。
     放在 useState 的惰性初始化里，StrictMode 重渲染也不会读第二遍。 */
  const [restored] = useState(loadProgress)

  const [serverStatus, setServerStatus] = useState<ServerStatus>("stopped")
  const [bootElapsed, setBootElapsed] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [samples, setSamples] = useState<MetricSample[]>([])
  const [tickCount, setTickCount] = useState(0)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [config, setConfig] = useState<UniverseConfig>(() => restored?.config ?? DEFAULT_CONFIG)
  const [accounts, setAccounts] = useState<Account[]>(() => restored?.accounts ?? SEED_ACCOUNTS)
  const [backups, setBackups] = useState<Backup[]>(() => restored?.backups ?? SEED_BACKUPS)
  const [mods, setMods] = useState<ModEntry[]>(() => restored?.mods ?? SEED_MODS)
  const [installQueue, setInstallQueue] = useState<InstallTask[]>([])
  const [market, setMarket] = useState<MarketMod[]>(() => restored?.market ?? SEED_MARKET)
  const [submissions, setSubmissions] = useState<ModSubmission[]>(
    () => restored?.submissions ?? [],
  )
  const [crashReason, setCrashReason] = useState("")
  const [savedAt, setSavedAt] = useState<number | null>(restored?.savedAt ?? null)
  const [autoSave, setAutoSave] = useState(true)
  const [author, setAuthor] = useState(loadAuthor)

  const logIdRef = useRef(0)
  const bootStageRef = useRef(-1)
  const metricsRef = useRef({ cpu: 21, mem: 1460, players: 0, net: 4.5, frameMs: 44 })
  const timersRef = useRef<number[]>([])
  /* 这些 ref 让动作回调与定时器读到最新状态。setState 的更新函数必须是纯函数 —— 在它
     里面调 pushLog 会在 StrictMode 下重复执行，日志会凭空多出一条。所以副作用一律留在
     更新函数外面，靠 ref 拿当前值。无依赖数组，每次提交后同步一次；读它们的地方全是
     事件回调与定时器，都发生在提交之后。 */
  const configRef = useRef(config)
  const serverStatusRef = useRef(serverStatus)
  const accountsRef = useRef(accounts)
  const backupsRef = useRef(backups)
  const modsRef = useRef(mods)
  const installQueueRef = useRef(installQueue)
  const marketRef = useRef(market)
  const submissionsRef = useRef(submissions)
  const authorRef = useRef(author)

  useEffect(() => {
    configRef.current = config
    serverStatusRef.current = serverStatus
    accountsRef.current = accounts
    backupsRef.current = backups
    modsRef.current = mods
    installQueueRef.current = installQueue
    marketRef.current = market
    submissionsRef.current = submissions
    authorRef.current = author
  })

  /* 作者档案单独落盘：它不属于「进度」，清进度时不会跟着被清掉。 */
  useEffect(() => {
    saveAuthor(author)
  }, [author])

  /* ---------------- 本机进度：自动保存 ---------------- */
  /* 只有上面那几份「玩家改得动」的数据进存档。这个 useMemo 同时充当保存的
     触发信号：它的引用一变，下面的 effect 就重新计时。 */
  const progressPayload = useMemo(
    () => ({ config, accounts, backups, mods, market, submissions }),
    [config, accounts, backups, mods, market, submissions],
  )

  const saveNow = useCallback(() => {
    if (saveProgress(progressPayload)) setSavedAt(Date.now())
  }, [progressPayload])

  /* 连续操作合并成一笔：改动停下 700ms 才真正落盘。saveNow 的引用跟着数据走，
     所以依赖里不用再列一遍数据字段。 */
  const skipSaveRef = useRef(false)
  useEffect(() => {
    if (!autoSave) return
    const id = window.setTimeout(() => {
      // 刚清过进度就跳过这一轮，否则清完立刻又被写回去，看着像没清掉。
      if (skipSaveRef.current) {
        skipSaveRef.current = false
        return
      }
      saveNow()
    }, 700)
    return () => window.clearTimeout(id)
  }, [autoSave, saveNow])

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms)
    timersRef.current.push(id)
  }, [])

  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id))
    },
    [],
  )

  const pushLog = useCallback(
    (level: LogLevel, module: LogModule, message: string, trace?: string) => {
      logIdRef.current += 1
      const entry: LogEntry = {
        id: logIdRef.current,
        ts: Date.now(),
        level,
        module,
        message,
        trace,
      }
      setLogs((prev) => {
        const next = [...prev, entry]
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
      })
    },
    [],
  )

  /* ---------------- 时钟：驱动运行时长与相对时间 ---------------- */
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  /* ---------------- 冷启动推进 ---------------- */
  /* 用本地累加器而不是读 bootElapsed，这样「推进」和「到点转运行」都发生在定时器回调
     里，不会在 effect 体内同步 setState 引发级联渲染。 */
  useEffect(() => {
    if (serverStatus !== "starting") return
    let elapsed = 0
    const id = window.setInterval(() => {
      elapsed += 120
      if (elapsed >= BOOT_TOTAL_MS) {
        window.clearInterval(id)
        setBootElapsed(0)
        setServerStatus("running")
        setStartedAt(Date.now())
        metricsRef.current = { cpu: 26, mem: 1620, players: 3, net: 7.5, frameMs: 42 }
        return
      }
      setBootElapsed(elapsed)
    }, 120)
    return () => window.clearInterval(id)
  }, [serverStatus])

  /* 启动分段切换时播报该段日志。 */
  useEffect(() => {
    if (serverStatus !== "starting") {
      bootStageRef.current = -1
      return
    }
    let acc = 0
    let index = 0
    for (let i = 0; i < BOOT_STAGES.length; i += 1) {
      acc += stageDuration(i)
      if (bootElapsed < acc) {
        index = i
        break
      }
      index = i
    }
    if (index !== bootStageRef.current) {
      bootStageRef.current = index
      const lines = BOOT_LOGS[BOOT_STAGES[index].id] ?? []
      lines.forEach((line, offset) => {
        later(() => pushLog(line.level, line.module, line.message), offset * 260)
      })
    }
  }, [bootElapsed, serverStatus, pushLog, later])

  /* ---------------- 运行循环：指标采样 + 日志播报 ---------------- */
  useEffect(() => {
    if (serverStatus !== "running") return
    const id = window.setInterval(() => {
      const cfg = configRef.current
      const m = metricsRef.current
      const playerTarget = Math.min(cfg.maxPlayers, 14 + Math.round(cfg.systems / 900))

      m.players += (playerTarget - m.players) * 0.08 + (Math.random() - 0.45) * 1.4
      m.players = Math.max(0, Math.min(cfg.maxPlayers, m.players))
      const load = 0.45 + m.players / Math.max(1, cfg.maxPlayers)
      m.cpu = Math.max(6, Math.min(97, m.cpu + (Math.random() - 0.48) * 6 + load * 1.4))
      m.mem = Math.max(900, Math.min(6400, m.mem + (Math.random() - 0.4) * 26 + load * 3))
      m.net = Math.max(0.4, Math.min(180, m.net + (Math.random() - 0.47) * 5 + load * 0.6))
      m.frameMs = Math.max(
        8,
        Math.min(320, 1000 / Math.max(1, cfg.tickRate) + (Math.random() - 0.45) * 12 + load * 6),
      )

      setSamples((prev) => {
        const next = [
          ...prev,
          {
            t: Date.now(),
            cpu: Number(m.cpu.toFixed(1)),
            mem: Math.round(m.mem),
            tick: cfg.tickRate,
            players: Math.round(m.players),
            net: Number(m.net.toFixed(1)),
            frameMs: Number(m.frameMs.toFixed(1)),
          },
        ]
        return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
      })
      setTickCount((prev) => prev + cfg.tickRate)

      // 随机播报：tick 越慢日志越稀。
      if (Math.random() < 0.55) {
        const line = RUNNING_LOG_POOL[Math.floor(Math.random() * RUNNING_LOG_POOL.length)]
        pushLog(line.level, line.module, line.message)
      }
      if (m.frameMs > 220 && Math.random() < 0.25) {
        pushLog(
          "WARN",
          "内核",
          `tick 耗时 ${m.frameMs.toFixed(0)}ms，已超过阈值，建议降低星域规模或提高 tick 间隔`,
        )
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [serverStatus, pushLog])

  /* ---------------- 市场下载队列：逐条推进，跑满 100 才真正落地 ---------------- */
  useEffect(() => {
    if (installQueue.length === 0) return
    const id = window.setInterval(() => {
      const pending = installQueueRef.current
      if (pending.length === 0) return

      const finished: InstallTask[] = []
      const advanced = pending.map((task) => {
        const progress = Math.min(100, task.progress + 5 + Math.random() * 13)
        if (progress >= 100) finished.push({ ...task, progress: 100 })
        return { ...task, progress }
      })
      setInstallQueue(advanced.filter((task) => task.progress < 100))

      /* 落地动作放在定时器回调里而不是 setState 更新函数里 —— 后者在 StrictMode 下会被
         重放，模组会凭空多出一份。 */
      finished.forEach((task) => {
        const entry = marketRef.current.find((m) => m.id === task.id)
        if (!entry) return
        const current = modsRef.current
        const existing = current.find((m) => m.id === task.id)

        if (task.mode === "update" && existing) {
          setMods((prev) =>
            prev.map((m) =>
              m.id === entry.id ? { ...m, version: entry.version, sizeMb: entry.sizeMb } : m,
            ),
          )
          pushLog("INFO", "内核", `模组「${entry.name}」已更新至 ${entry.version}`)
          return
        }

        const maxOrder = current.reduce((max, m) => Math.max(max, m.order), 0)
        setMods((prev) => [
          ...prev,
          {
            id: entry.id,
            name: entry.name,
            author: entry.author,
            version: entry.version,
            category: entry.category,
            enabled: false,
            order: maxOrder + 10,
            sizeMb: entry.sizeMb,
            desc: entry.desc,
            conflicts: entry.conflicts,
          },
        ])
        pushLog("INFO", "内核", `模组「${entry.name}」已安装，默认停用，启用后下次启动生效`)
      })
    }, 140)
    return () => window.clearInterval(id)
  }, [installQueue.length, pushLog])

  /* ---------------- 提交审核流水线：排队 → 复核 → 上架 ---------------- */
  /* 依赖用「待审条数」而不是 submissions 数组本身：数组每 tick 都换新引用，
     直接依赖它会让 interval 每 220ms 被拆掉重建一次。条数在审核期间是恒定的。 */
  const pendingReviewCount = submissions.filter((item) => item.status !== "published").length

  useEffect(() => {
    if (pendingReviewCount === 0) return
    const id = window.setInterval(() => {
      const list = submissionsRef.current
      if (list.length === 0) return

      const approved: ModSubmission[] = []
      const advanced: ModSubmission[] = list.map((item) => {
        if (item.status === "published") return item
        const progress = Math.min(100, item.progress + 4 + Math.random() * 9)
        const next: ModSubmission = {
          ...item,
          progress,
          status: progress >= 100 ? "published" : progress >= 45 ? "reviewing" : "pending",
        }
        if (next.status === "published") approved.push(next)
        return next
      })
      setSubmissions(advanced)

      approved.forEach((item) => {
        /* 目录里已经有同 id 的条目，说明这是作者发的新版本：就地换掉，
           下载量与评分接着算；没有才是新上架，追加一条。 */
        const existing = marketRef.current.find((m) => m.id === item.id)
        setMarket((prev) =>
          existing
            ? prev.map((m) => (m.id === item.id ? marketEntryFromSubmission(item, existing) : m))
            : [...prev, marketEntryFromSubmission(item)],
        )
        pushLog(
          "INFO",
          "网络",
          existing
            ? `模组「${item.name}」已更新至 ${item.version}，市场目录已刷新`
            : `模组「${item.name}」已通过审核，正式上架市场`,
        )
      })
    }, 220)
    return () => window.clearInterval(id)
  }, [pendingReviewCount, pushLog])

  /* ---------------- 服务端动作 ---------------- */
  const start = useCallback(() => {
    const current = serverStatusRef.current
    if (current === "running" || current === "starting") return
    setCrashReason("")
    setBootElapsed(0)
    bootStageRef.current = -1
    setServerStatus("starting")
    pushLog("INFO", "内核", "收到启动指令，开始冷启动序列")
  }, [pushLog])

  const stop = useCallback(() => {
    const current = serverStatusRef.current
    if (current === "stopped" || current === "stopping") return
    setServerStatus("stopping")
    pushLog("INFO", "内核", "收到停止指令，正在安全下线 …")
    later(() => {
      pushLog("INFO", "存档", "退出前自动存档已写入")
      pushLog("INFO", "内核", "世界心跳已停止")
      setServerStatus("stopped")
      setStartedAt(null)
      setSamples([])
      metricsRef.current = { cpu: 21, mem: 1460, players: 0, net: 4.5, frameMs: 44 }
    }, 1500)
  }, [pushLog, later])

  const restart = useCallback(() => {
    const current = serverStatusRef.current
    if (current === "starting" || current === "stopping") return
    setServerStatus("stopping")
    pushLog("INFO", "内核", "收到重启指令，先执行安全下线 …")
    later(() => {
      pushLog("INFO", "存档", "退出前自动存档已写入")
      setSamples([])
      metricsRef.current = { cpu: 21, mem: 1460, players: 0, net: 4.5, frameMs: 44 }
      setCrashReason("")
      setBootElapsed(0)
      bootStageRef.current = -1
      pushLog("INFO", "内核", "重启冷启动序列")
      setServerStatus("starting")
    }, 1500)
  }, [pushLog, later])

  const simulateCrash = useCallback(() => {
    if (serverStatusRef.current !== "running") return
    const reason = "market/orderbook.cpp:412 段错误（模拟）"
    setCrashReason(reason)
    setStartedAt(null)
    setServerStatus("crashed")
    pushLog("ERROR", "市场", "订单簿写入时发生段错误，服务端已中止", reason)
    pushLog("WARN", "存档", "检测到非正常退出，最近一份自动存档可作为回滚点")
  }, [pushLog])

  /* ---------------- 配置 ---------------- */
  const updateConfig = useCallback((patch: Partial<UniverseConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }, [])

  const applyPreset = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id)
      if (!preset) return
      setConfig((prev) => ({ ...prev, ...preset.patch }))
      pushLog("INFO", "内核", `宇宙参数已套用「${preset.name}」预设`)
    },
    [pushLog],
  )

  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_CONFIG)
    pushLog("INFO", "内核", "宇宙参数已恢复默认值")
  }, [pushLog])

  /* ---------------- 账号 ---------------- */
  const createAccount = useCallback(
    (draft: AccountDraft) => {
      const stamp = Date.now()
      const account: Account = {
        id: `acc-${stamp.toString(36)}`,
        username: draft.username,
        character: draft.character,
        corp: draft.corp,
        faction: draft.faction,
        role: draft.role,
        isk: draft.isk,
        skillPoints: draft.skillPoints,
        securityStatus: 0,
        status: "offline",
        shipName: draft.shipName,
        solarSystem: draft.solarSystem,
        playtimeHours: 0,
        lastSeen: stamp,
        createdAt: stamp,
        note: draft.note,
      }
      setAccounts((prev) => [account, ...prev])
      pushLog("INFO", "账号", `新建账号 ${draft.username}，角色 ${draft.character} 已入库`)
    },
    [pushLog],
  )

  const updateAccount = useCallback((id: string, patch: Partial<Account>) => {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }, [])

  const removeAccount = useCallback(
    (id: string) => {
      const target = accountsRef.current.find((a) => a.id === id)
      if (!target) return
      setAccounts((prev) => prev.filter((a) => a.id !== id))
      pushLog("WARN", "账号", `账号 ${target.username} 已从世界移除`)
    },
    [pushLog],
  )

  const grantIsk = useCallback(
    (ids: string[], amount: number) => {
      const idSet = new Set(ids)
      setAccounts((prev) =>
        prev.map((a) => (idSet.has(a.id) ? { ...a, isk: Math.max(0, a.isk + amount) } : a)),
      )
      pushLog(
        "INFO",
        "账号",
        `${ids.length} 个账号发放 ISK ${amount >= 0 ? "+" : ""}${amount.toLocaleString("en-US")}`,
      )
    },
    [pushLog],
  )

  const grantSp = useCallback(
    (ids: string[], amount: number) => {
      const idSet = new Set(ids)
      setAccounts((prev) =>
        prev.map((a) =>
          idSet.has(a.id) ? { ...a, skillPoints: Math.max(0, a.skillPoints + amount) } : a,
        ),
      )
      pushLog(
        "INFO",
        "账号",
        `${ids.length} 个账号发放技能点 ${amount >= 0 ? "+" : ""}${amount.toLocaleString("en-US")}`,
      )
    },
    [pushLog],
  )

  const setAccountStatus = useCallback(
    (ids: string[], status: AccountStatus) => {
      const idSet = new Set(ids)
      setAccounts((prev) => prev.map((a) => (idSet.has(a.id) ? { ...a, status } : a)))
      const label = status === "banned" ? "封禁" : status === "online" ? "置为在线" : "解封"
      pushLog("WARN", "账号", `${ids.length} 个账号已${label}`)
    },
    [pushLog],
  )

  /* ---------------- 存档 ---------------- */
  const createBackup = useCallback(
    (label: string, note: string, kind: BackupKind) => {
      const stamp = Date.now()
      const snapshot: Backup = {
        id: `bk-${stamp.toString(36)}`,
        label: label || "未命名快照",
        createdAt: stamp,
        sizeMb: 320 + Math.round(Math.random() * 900),
        kind,
        version: "v14.22",
        note,
        playersAt: Math.round(metricsRef.current.players),
      }
      setBackups((prev) => [snapshot, ...prev])
      pushLog("INFO", "存档", `快照「${snapshot.label}」已写入，${snapshot.sizeMb} MB`)
    },
    [pushLog],
  )

  const restoreBackup = useCallback(
    (id: string) => {
      const target = backupsRef.current.find((b) => b.id === id)
      if (!target) return
      pushLog("WARN", "存档", `正在回滚到「${target.label}」…`)
      later(() => {
        pushLog("INFO", "存档", `回滚完成，世界状态已还原至 ${target.version}`)
      }, 900)
    },
    [pushLog, later],
  )

  const deleteBackup = useCallback(
    (id: string) => {
      const target = backupsRef.current.find((b) => b.id === id)
      if (!target) return
      setBackups((prev) => prev.filter((b) => b.id !== id))
      pushLog("WARN", "存档", `快照「${target.label}」已删除`)
    },
    [pushLog],
  )

  /* ---------------- 模组 ---------------- */
  const toggleMod = useCallback(
    (id: string) => {
      const target = modsRef.current.find((m) => m.id === id)
      if (!target) return
      const enabled = !target.enabled
      setMods((prev) => prev.map((m) => (m.id === id ? { ...m, enabled } : m)))
      pushLog(
        enabled ? "INFO" : "WARN",
        "内核",
        `模组「${target.name}」已${enabled ? "启用，下次启动生效" : "停用"}`,
      )
    },
    [pushLog],
  )

  const moveMod = useCallback((id: string, dir: -1 | 1) => {
    setMods((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order)
      const index = sorted.findIndex((m) => m.id === id)
      const swapIndex = index + dir
      if (index < 0 || swapIndex < 0 || swapIndex >= sorted.length) return prev
      const a = sorted[index]
      const b = sorted[swapIndex]
      return prev.map((m) => {
        if (m.id === a.id) return { ...m, order: b.order }
        if (m.id === b.id) return { ...m, order: a.order }
        return m
      })
    })
  }, [])

  /* ---------------- 模组市场 ---------------- */
  /** 同一模组同时只允许一个任务在跑，重复点击直接忽略。 */
  const enqueue = useCallback(
    (id: string, mode: InstallTask["mode"]) => {
      const entry = marketRef.current.find((m) => m.id === id)
      if (!entry || installQueueRef.current.some((task) => task.id === id)) return
      setInstallQueue((prev) => [...prev, { id, progress: 0, mode }])
      pushLog("INFO", "网络", `开始下载「${entry.name}」${entry.version}（${entry.sizeMb} MB）`)
    },
    [pushLog],
  )

  const installMod = useCallback((id: string) => enqueue(id, "install"), [enqueue])
  const updateMod = useCallback((id: string) => enqueue(id, "update"), [enqueue])

  const cancelInstall = useCallback(
    (id: string) => {
      const entry = marketRef.current.find((m) => m.id === id)
      setInstallQueue((prev) => prev.filter((task) => task.id !== id))
      if (entry) pushLog("WARN", "网络", `「${entry.name}」的下载已取消`)
    },
    [pushLog],
  )

  const uninstallMod = useCallback(
    (id: string) => {
      const target = modsRef.current.find((m) => m.id === id)
      if (!target) return
      setMods((prev) => prev.filter((m) => m.id !== id))
      pushLog("WARN", "内核", `模组「${target.name}」已从本地卸载`)
    },
    [pushLog],
  )

  /* ---------------- 提交上架 ---------------- */
  const submitMod = useCallback(
    (draft: ModSubmissionDraft, existingId?: string) => {
      const stamp = Date.now()
      const id = existingId ?? `sub-${stamp.toString(36)}`
      // 同一个模组只挂一条提交，重复点不会在审核队列里排两份。
      if (submissionsRef.current.some((item) => item.id === id)) return

      /* 提交一律盖上本机的作者标识：之后市场里认「这条是不是我发的」全靠它，
         跟署名写了什么无关。 */
      const submission: ModSubmission = {
        ...draft,
        id,
        authorId: authorRef.current.id,
        submittedAt: stamp,
        status: "pending",
        progress: 0,
      }
      setSubmissions((prev) => [submission, ...prev])

      const isUpdate = marketRef.current.some((m) => m.id === id)
      pushLog(
        "INFO",
        "网络",
        isUpdate
          ? `模组「${draft.name}」的更新 ${draft.version} 已提交，进入审核队列`
          : `已提交模组「${draft.name}」${draft.version}，进入审核队列`,
      )
    },
    [pushLog],
  )

  const withdrawSubmission = useCallback(
    (id: string) => {
      const target = submissionsRef.current.find((item) => item.id === id)
      if (!target) return
      setSubmissions((prev) => prev.filter((item) => item.id !== id))
      pushLog("WARN", "网络", `已撤回「${target.name}」的提交`)
    },
    [pushLog],
  )

  /* ---------------- 作者身份 ---------------- */
  const updateAuthor = useCallback(
    (patch: { name?: string }) => {
      const name = patch.name?.trim()
      if (!name) return
      const id = authorRef.current.id
      setAuthor((prev) => ({ ...prev, name }))
      /* 改名不只是改档案：名下已经发出去的模组得一起换署名，
         否则市场里同一个作者会挂着两个名字。 */
      const rename = <T extends { author: string; authorId?: string }>(item: T): T =>
        item.authorId === id ? { ...item, author: name } : item
      setMods((prev) => prev.map(rename))
      setMarket((prev) => prev.map(rename))
      setSubmissions((prev) => prev.map(rename))
      pushLog("INFO", "内核", `作者署名已改为「${name}」，名下模组一并更新`)
    },
    [pushLog],
  )

  /**
   * 认回旧身份。只换标识，署名沿用现在的 —— 署名是显示用的标签，
   * 标识才是认人的那串东西。之后新发的内容都记在这个名下。
   */
  const adoptAuthor = useCallback(
    (id: string) => {
      const next = id.trim().toLowerCase()
      if (!isValidAuthorId(next) || next === authorRef.current.id) return
      // 时间戳就编在标识里，认回之后「启用时间」显示的仍是这个身份最初的时间。
      setAuthor((prev) => ({ ...prev, id: next, since: authorSinceFromId(next) ?? Date.now() }))
      pushLog("INFO", "内核", "已认回作者身份，之后发布的内容都记在这个名下")
    },
    [pushLog],
  )

  /** 更新自己已上架的模组：沿用条目 id 提交，通过审核后市场里就地换新版。 */
  const updateOwnMod = useCallback(
    (id: string, draft: ModSubmissionDraft) => {
      const entry = marketRef.current.find((m) => m.id === id)
      // 只能改自己发的：别人家的条目没有本机作者标识。
      if (!entry || entry.authorId !== authorRef.current.id) return
      submitMod({ ...draft, authorId: authorRef.current.id }, id)
    },
    [submitMod],
  )

  /* ---------------- 评分 ---------------- */
  /**
   * 给一条市场模组打分。目录里那对评分/人数记的是「别人打的」，本机这一票单独存，
   * 显示时合到一起 —— 所以每次改分都拿 baseRating 重算，而不是在结果上再叠一票。
   */
  const applyRating = useCallback(
    (id: string, stars: number | null) => {
      const entry = marketRef.current.find((m) => m.id === id)
      if (!entry) return
      // 自己发的作品不用自己抬分，抬了也只是把作者总览的数字搅浑。
      if (entry.authorId !== undefined && entry.authorId === authorRef.current.id) return

      const baseRating = entry.baseRating ?? entry.rating
      const baseCount = entry.baseRatingCount ?? entry.ratingCount

      setMarket((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m
          if (stars === null) {
            // 收回那一票：分数回到别人打出来的样子，基线也不必再留。
            // 评价是挂在这一票上的，票没了，写的话也跟着撤，免得留下一条没有星的评价。
            return {
              ...m,
              myRating: undefined,
              baseRating: undefined,
              baseRatingCount: undefined,
              myReview: undefined,
              rating: baseRating,
              ratingCount: baseCount,
            }
          }
          const ratingCount = baseCount + 1
          const sum = baseRating * baseCount + stars
          return {
            ...m,
            myRating: stars,
            baseRating,
            baseRatingCount: baseCount,
            rating: Math.round((sum / ratingCount) * 10) / 10,
            ratingCount,
          }
        }),
      )

      if (stars === null) {
        pushLog("INFO", "网络", `已收回对「${entry.name}」的评分`)
      } else {
        pushLog("INFO", "网络", `给「${entry.name}」打了 ${stars} 分`)
      }
    },
    [pushLog],
  )

  const rateMod = useCallback((id: string, stars: number) => applyRating(id, stars), [applyRating])
  const clearRating = useCallback((id: string) => applyRating(id, null), [applyRating])

  /* ---------------- 评价 ---------------- */
  /**
   * 写 / 改 / 删自己那条评价。评价挂在评分上：没打过分就写不了，
   * 免得出现一条没有星的评价挂在列表里不知道按什么排。
   */
  const applyReview = useCallback(
    (id: string, text: string | null) => {
      const entry = marketRef.current.find((m) => m.id === id)
      if (!entry) return
      // 自己发的作品不给自己写评价，跟打分是同一个道理。
      if (entry.authorId !== undefined && entry.authorId === authorRef.current.id) return

      const trimmed = text?.trim() ?? ""
      if (text === null) {
        if (!entry.myReview) return
      } else if (trimmed === "" || entry.myRating === undefined) {
        return
      }

      const at = Date.now()
      setMarket((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, myReview: text === null ? undefined : { text: trimmed, at } }
            : m,
        ),
      )

      if (text === null) pushLog("INFO", "网络", `已删除对「${entry.name}」的评价`)
      else pushLog("INFO", "网络", `给「${entry.name}」写了评价`)
    },
    [pushLog],
  )

  const saveReview = useCallback((id: string, text: string) => applyReview(id, text), [applyReview])
  const clearReview = useCallback((id: string) => applyReview(id, null), [applyReview])

  /** 下架 / 重新上架。只有作者本人动得了自己那条。 */
  const setDelisted = useCallback(
    (id: string, delisted: boolean) => {
      const entry = marketRef.current.find((m) => m.id === id)
      if (!entry || entry.authorId !== authorRef.current.id) return
      setMarket((prev) => prev.map((m) => (m.id === id ? { ...m, delisted } : m)))
      if (delisted) {
        /* 下架时顺手撤掉在审的更新：否则那条提交过审后会把条目重新挂出来，
           作者以为撤干净了，市场里却又冒出来。 */
        const pending = submissionsRef.current.some(
          (item) => item.id === id && item.status !== "published",
        )
        if (pending) setSubmissions((prev) => prev.filter((item) => item.id !== id))
        pushLog(
          "WARN",
          "网络",
          `模组「${entry.name}」已下架${pending ? "，在审的更新一并撤回" : ""}，市场目录不再展示`,
        )
        return
      }
      pushLog("INFO", "网络", `模组「${entry.name}」已重新上架`)
    },
    [pushLog],
  )

  const delistMod = useCallback((id: string) => setDelisted(id, true), [setDelisted])
  const relistMod = useCallback((id: string) => setDelisted(id, false), [setDelisted])

  /* ---------------- 新建模组 ---------------- */
  /* 建好的模组直接进本地清单，排在最末一位；开启「立即启用」就顺手启用。
     勾了「同时提交」的话，上架条目沿用同一个 id —— 通过审核后市场里会直接显示成
     已安装，而不是又冒出一个要重新下载的副本。 */
  const createMod = useCallback(
    (draft: ModDraft) => {
      const stamp = Date.now()
      const slug = slugifyModId(draft.name)
      let id = slug === "" ? `mod-${stamp.toString(36)}` : `mod-${slug}`
      if (modsRef.current.some((m) => m.id === id)) id = `${id}-${stamp.toString(36).slice(-4)}`

      const maxOrder = modsRef.current.reduce((max, m) => Math.max(max, m.order), 0)
      setMods((prev) => [
        ...prev,
        {
          id,
          name: draft.name,
          author: draft.author,
          authorId: authorRef.current.id,
          version: draft.version,
          category: draft.category,
          enabled: draft.enabled,
          order: maxOrder + 10,
          sizeMb: draft.sizeMb,
          desc: draft.desc,
          conflicts: draft.conflicts,
        },
      ])
      pushLog(
        "INFO",
        "内核",
        `模组「${draft.name}」已创建，${draft.enabled ? "已启用，下次启动生效" : "默认停用"}`,
      )

      if (draft.publish) {
        submitMod(
          {
            name: draft.name,
            author: draft.author,
            version: draft.version,
            category: draft.category,
            sizeMb: draft.sizeMb,
            desc: draft.desc,
            readme: draft.readme,
            highlights: draft.highlights,
            tags: draft.tags,
            conflicts: draft.conflicts,
            requiresRestart: draft.requiresRestart,
            repo: draft.repo,
          },
          id,
        )
      }
    },
    [pushLog, submitMod],
  )

  const clearLogs = useCallback(() => setLogs([]), [])

  const resetProgress = useCallback(() => {
    clearProgress()
    // 让自动保存放过下一轮，别把刚清掉的东西又原样写回去。
    skipSaveRef.current = true
    setConfig(DEFAULT_CONFIG)
    setAccounts(SEED_ACCOUNTS)
    setBackups(SEED_BACKUPS)
    setMods(SEED_MODS)
    setMarket(SEED_MARKET)
    setSubmissions([])
    setInstallQueue([])
    setSavedAt(null)
    pushLog("WARN", "内核", "本机保存的进度已清除，全部数据回到初始状态")
  }, [pushLog])

  /* ---------------- 派生值 ---------------- */
  const bootProgress = useMemo(() => {
    if (serverStatus === "running") return 1
    if (serverStatus !== "starting") return 0
    return Math.min(1, bootElapsed / BOOT_TOTAL_MS)
  }, [bootElapsed, serverStatus])

  const bootStageIndex = useMemo(() => {
    if (serverStatus !== "starting") return -1
    let acc = 0
    for (let i = 0; i < BOOT_STAGES.length; i += 1) {
      acc += stageDuration(i)
      if (bootElapsed < acc) return i
    }
    return BOOT_STAGES.length - 1
  }, [bootElapsed, serverStatus])

  const uptime = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0

  const value: EngineValue = {
    serverStatus,
    startedAt,
    now,
    uptime,
    bootProgress,
    bootStageIndex,
    crashReason,
    samples,
    tickCount,
    logs,
    config,
    accounts,
    backups,
    mods,
    start,
    stop,
    restart,
    simulateCrash,
    updateConfig,
    applyPreset,
    resetConfig,
    createAccount,
    updateAccount,
    removeAccount,
    grantIsk,
    grantSp,
    setAccountStatus,
    createBackup,
    restoreBackup,
    deleteBackup,
    toggleMod,
    moveMod,
    createMod,
    market,
    installQueue,
    installMod,
    updateMod,
    uninstallMod,
    cancelInstall,
    submissions,
    submitMod,
    withdrawSubmission,
    author,
    updateAuthor,
    updateOwnMod,
    adoptAuthor,
    rateMod,
    clearRating,
    saveReview,
    clearReview,
    delistMod,
    relistMod,
    pushLog,
    clearLogs,
    savedAt,
    autoSave,
    setAutoSave,
    saveNow,
    resetProgress,
  }

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

export function useEngine(): EngineValue {
  const ctx = useContext(EngineContext)
  if (!ctx) throw new Error("useEngine 必须在 ServerEngineProvider 内使用")
  return ctx
}

/** 启动分段清单，供进度面板渲染。 */
export const bootStages = BOOT_STAGES
