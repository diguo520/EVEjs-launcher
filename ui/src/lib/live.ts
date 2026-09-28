/**
 * 真数据 → 原型视图模型 的纯映射。
 *
 * 这一层只做换算，不碰 React、不发 IPC，所以能直接单测（见 live.test.ts）。
 * 单个服务的 CPU / 内存由后端按 pid 采（services:list 的 cpuPercent / memMB），拿不到
 * 就给 null、由组件画 "—"；运行时长由 startedAt 现算。**不编数字。**
 */
import {
  SERVICES,
  type CheckItem,
  type LogLevel,
  type LogLine,
  type Metric,
  type Service,
  type ServiceState,
} from "@/lib/mock"
import type {
  RawAppInfo,
  RawEnvReport,
  RawHealth,
  RawMarketList,
  RawMetrics,
  RawMod,
  RawModList,
  RawServerLog,
  RawService,
  RawTokenStatus,
} from "@/lib/ipc"

/* ------------------------------ 服务端日志 ------------------------------ */

/** server.log 的标签 → 原型日志级别 */
const TAG_LEVEL: Record<string, LogLevel> = {
  LOG: "INFO",
  DBG: "DEBUG",
  SUC: "INFO",
  WRN: "WARN",
  ERR: "ERROR",
}

const LOG_LINE = /^\[([^\]]+)\]\s*\[([A-Za-z]+)\]\s?([\s\S]*)$/

/** ISO 时间戳 → 与日志面板一致的 HH:MM:SS（本地时间） */
function clockOf(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "--:--:--"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(parsed.getHours())}:${p(parsed.getMinutes())}:${p(parsed.getSeconds())}`
}

/**
 * 主服务器日志 → 日志行。
 *
 * 全部标 src="server"（日志文件来源，区别于 terminal:data 推来的 "node" 实时流）：
 * log:read 读的就是服务端主日志（server/logs/server.log）；市场服务与客户端目前没有
 * 各自的日志文件，所以那两页签会是空的 —— 空就是实情，不要拿主服务器的行去填。
 */
export function parseServerLog(raw: RawServerLog | null): LogLine[] {
  const lines = raw?.lines ?? []
  const out: LogLine[] = []
  lines.forEach((text, index) => {
    const match = LOG_LINE.exec(text)
    if (!match) return
    const [, iso, tag, rest] = match
    out.push({
      id: index,
      t: clockOf(iso),
      level: TAG_LEVEL[tag.toUpperCase()] ?? "INFO",
      src: "server",
      msg: rest.trim(),
    })
  })
  return out
}

/* -------------------------------- 服务卡片 -------------------------------- */

/**
 * 市场服务的端口：Rust 侧 config::DEFAULT_MARKET_PORT（config/server.json 里不写它，
 * 与现役版一致）。写在这里是因为界面要显示它，而后端只在探活时用。
 */
export const MARKET_PORT = 40110

/**
 * 原型的四张卡与后端真实资源的关系。
 *
 * 后端只有三个可控进程（client / mainServer / marketServer）：图片服务（26001）与
 * 网关代理（26002）**不是独立进程**，它们是主服务器进程里起的 HTTP 子服务
 * （现役版的配置面板就是这么写的：主服务器一栏的端口是 "26000 · 26001 · 26002"）。
 * 所以这两张卡的 PID / CPU / 内存 / 运行时长取主服务器进程的读数 —— 不再恒为 "—"
 * （2026-09-28 报障：图片服务 / 网关代理启动后下面的统计没反应）。
 * 端口活没活仍由各自健康探针决定，与进程读数互不代替。
 */
const CARD_BINDING: Record<
  string,
  {
    /** 启停动作落到哪个后端服务；null = 没有独立进程，动作只能提示 */
    real: string | null
    /** 读数（PID / CPU / 内存 / 运行时长）取自哪个后端进程 */
    statsFrom: string
    health: keyof RawHealth
  }
> = {
  node: { real: "mainServer", statsFrom: "mainServer", health: "game" },
  market: { real: "marketServer", statsFrom: "marketServer", health: "market" },
  images: { real: null, statsFrom: "mainServer", health: "images" },
  gateway: { real: null, statsFrom: "mainServer", health: "gateway" },
}

/** 端口绑定：主服务器/图片/网关来自 config/server.json，市场服务用后端常量 */
export function portsOf(ports: { game: number; images: number; gateway: number } | null) {
  return {
    node: ports?.game ?? 26000,
    market: MARKET_PORT,
    images: ports?.images ?? 26001,
    gateway: ports?.gateway ?? 26002,
  }
}

/**
 * 卡片状态：
 *   error / starting → 直接照搬（启动中按运行中画，转圈图标由 busy 管）
 *   运行中（进程态或端口活着）→ running
 *   其他 → ready（原型的「未启动」，启动按钮可点）
 */
function stateOf(rawState: string | undefined, alive: boolean | undefined): ServiceState {
  if (rawState === "error") return "error"
  if (rawState === "running" || rawState === "starting") return "running"
  if (alive === true) return "running"
  return "ready"
}

/**
 * 运行时长读数：不满 1 分钟按秒、不满 1 小时按分秒、再往上按时分/天。
 * startedAt 缺（端口被外部占用、后端还没记到 pid）时给 "—"，不猜。
 */
export function uptimeText(
  startedAt: number | null | undefined,
  now: number = Date.now()
): string {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "—"
  const seconds = Math.floor(Math.max(0, now - startedAt) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

export function serviceCards(
  raw: RawService[],
  health: RawHealth | null,
  ports: { game: number; images: number; gateway: number } | null,
  now: number = Date.now()
): Service[] {
  const byId = new Map(raw.map((item) => [item.id, item]))
  const real = portsOf(ports)

  return SERVICES.map((template) => {
    const binding = CARD_BINDING[template.id]
    if (!binding) return { ...template, state: "ready", pid: null, cpu: null, memMB: null, uptime: "—", logs: 0 }
    // 状态只认「属于这张卡的那个进程 / 端口」：图片与网关不是独立进程，
    // 所以它们的状态完全由各自的健康探针决定，不能被主服务器的 running 带跑。
    const owned = binding.real ? byId.get(binding.real) : undefined
    // 读数取自真正在服务这些端口的进程（图片 / 网关 = 主服务器进程）
    const stats = byId.get(binding.statsFrom)
    const alive = health ? health[binding.health] : undefined
    return {
      ...template,
      port: real[template.id as keyof typeof real] ?? template.port,
      state: stateOf(owned?.state, alive),
      pid: stats?.pid ?? null,
      // 逐进程读数由后端按 pid 采；采样没到 / 拿不到句柄时是 null → 界面显示 "—"
      cpu: typeof stats?.cpuPercent === "number" ? stats.cpuPercent : null,
      memMB: typeof stats?.memMB === "number" ? stats.memMB : null,
      uptime: uptimeText(stats?.startedAt, now),
      logs: 0,
    }
  })
}

/** 按 id 找后端服务名（启停动作要用真实 id） */
export function backendServiceId(cardId: string): string | null {
  return CARD_BINDING[cardId]?.real ?? null
}

/* -------------------------------- 资源读数 -------------------------------- */

const SERIES_LEN = 14

function push(value: number, previous: number[] | undefined): number[] {
  const base = previous && previous.length ? previous : Array.from({ length: SERIES_LEN }, () => value)
  return [...base.slice(-(SERIES_LEN - 1)), value]
}

function percent(used: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export function metricsFrom(
  raw: RawMetrics | null,
  previous: Record<string, number[]> = {}
): Metric[] {
  if (!raw) return []
  const cpu = Number(raw.cpuPercent ?? 0)
  const mem = Number(raw.memUsedGB ?? 0)
  const memTotal = Number(raw.memTotalGB ?? 0)
  const vmem = Number(raw.virtualMemUsedGB ?? 0)
  const vmemTotal = Number(raw.virtualMemTotalGB ?? 0)
  const net = Number(raw.netBytesPerSec ?? 0) / 1024 / 1024
  const diskUsed = Number(raw.diskUsedGB ?? 0)
  const diskTotal = Number(raw.diskTotalGB ?? 0)

  // series 由下面的 map 统一补，这里先不写
  const rows: Omit<Metric, "series">[] = [
    { key: "cpu", label: "处理器 CPU", value: cpu, display: cpu.toFixed(1), unit: "%", tone: "primary" },
    raw.gpuPercent === null || raw.gpuPercent === undefined
      ? { key: "gpu", label: "显卡 GPU", value: 0, display: "—", unit: "%", tone: "telemetry" }
      : { key: "gpu", label: "显卡 GPU", value: raw.gpuPercent, display: raw.gpuPercent.toFixed(1), unit: "%", tone: "telemetry" },
    raw.gpuDedicatedUsedGB === null || raw.gpuDedicatedUsedGB === undefined
      ? { key: "gpuDed", label: "专用 GPU 内存", value: 0, display: "—", unit: "GB", tone: "telemetry" }
      : {
          key: "gpuDed",
          label: "专用 GPU 内存",
          value: percent(raw.gpuDedicatedUsedGB, Number(raw.gpuDedicatedTotalGB ?? 0)),
          display: raw.gpuDedicatedUsedGB.toFixed(1),
          unit: `GB / ${Math.round(Number(raw.gpuDedicatedTotalGB ?? 0))}GB`,
          tone: "telemetry",
        },
    raw.gpuSharedUsedGB === null || raw.gpuSharedUsedGB === undefined
      ? { key: "gpuMem", label: "GPU 共享内存", value: 0, display: "—", unit: "GB", tone: "primary" }
      : {
          key: "gpuMem",
          label: "GPU 共享内存",
          value: Math.min(100, raw.gpuSharedUsedGB * 10),
          display: raw.gpuSharedUsedGB.toFixed(1),
          unit: "GB",
          tone: "primary",
        },
    {
      key: "mem",
      label: "内存 MEMORY",
      value: percent(mem, memTotal),
      display: mem.toFixed(1),
      unit: `GB / ${Math.round(memTotal)}GB`,
      tone: "primary",
    },
    {
      key: "vmem",
      label: "虚拟内存",
      value: percent(vmem, vmemTotal),
      display: vmem.toFixed(1),
      unit: `GB / ${Math.round(vmemTotal)}GB`,
      tone: "telemetry",
    },
    {
      key: "disk",
      label: `磁盘卷 ${raw.diskRoot ?? "C:"}`,
      value: percent(diskUsed, diskTotal),
      display: diskUsed.toFixed(0),
      unit: `GB / ${(diskTotal / 1024).toFixed(1)}TB`,
      tone: "warning",
    },
    { key: "net", label: "网络 I/O", value: Math.min(100, net), display: net.toFixed(1), unit: "MB/s", tone: "primary" },
  ]

  return rows.map((row) => ({ ...row, series: push(row.value, previous[row.key]) }))
}

/** 磁盘占用面板：真实卷列表（按盘符去重，顺序与系统一致） */
export function diskVolumesFrom(
  raw: RawMetrics | null,
  previous: Record<string, number[]> = {}
) {
  const seen = new Set<string>()
  const out: { name: string; used: number; total: number; series: number[] }[] = []
  for (const volume of raw?.volumes ?? []) {
    const name = String(volume.root ?? "").replace(/\\+$/, "")
    if (!name || seen.has(name)) continue
    seen.add(name)
    const value = Number(volume.percent ?? 0)
    out.push({
      name: name.length === 2 ? name : name,
      used: Math.round(Number(volume.usedGB ?? 0)),
      total: Math.round(Number(volume.totalGB ?? 0)),
      series: push(value, previous[name]),
    })
  }
  return out
}

/* -------------------------------- 环境自检 -------------------------------- */

/**
 * 真实自检项 → 原型自检项。
 *
 * 「修复」按钮只在后端真的有初始化动作时才给：init:run 支持 deps / db / market / client / ca
 * （见 src-tauri/src/init.rs 的 label_of）。其余项（Node、工具链）只能人工装，
 * 所以只给结论不给按钮 —— 原型里那套「点一下就变绿」的假修复不接。
 */
const INIT_KEY: Record<string, string> = {
  serverDeps: "deps",
  localDb: "db",
  market: "market",
  clientPath: "client",
  caCert: "ca",
}

/** 缺了它服务器就起不来（工具链只影响本地编译模组） */
const NON_BLOCKING = new Set(["rust", "vsBuildTools"])

export function envItemsFrom(report: RawEnvReport | null): CheckItem[] {
  if (!report) return []
  return report.checks.map((check) => {
    const initKey = INIT_KEY[check.key]
    const level: CheckItem["level"] = check.ok
      ? check.warn
        ? "warn"
        : "ok"
      : initKey
        ? "missing"
        : "error"
    return {
      id: check.key,
      name: check.label,
      detail: check.message,
      ok: check.ok,
      level,
      blocking: NON_BLOCKING.has(check.key) ? false : true,
      fix:
        !check.ok && initKey
          ? {
              hint: check.message,
              action: `执行「${check.label}」初始化`,
              okDetail: check.message,
              done: `${check.label} 初始化已执行，重新自检确认结果。`,
            }
          : undefined,
    }
  })
}

/** 自检项 id → init:run 的 key（没有可执行动作的返回 null） */
export function initKeyOf(id: string): string | null {
  return INIT_KEY[id] ?? null
}
/* ------------------------------ 启动横幅与模组 ------------------------------ */

/** 不带 id 的日志行草稿：id 与去重由 use-launcher 统一发牌 */
export type LogDraft = Omit<LogLine, "id">

/** 毫秒时间戳 → 日志面板的 HH:MM:SS（本地时间） */
function stampOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 启动横幅：老启动器那套「我是谁 / 仓库在哪 / GitHub 通不通 / 市场清单能不能拿」，
 * 一行一条，全部落 src="sys"（系统页签）。
 */
export function startupBannerLines(input: {
  app: RawAppInfo | null
  token: RawTokenStatus | null
  market: RawMarketList | null
  at: number
}): LogDraft[] {
  const { app, token, market, at } = input
  const t = stampOf(at)
  const line = (level: LogLevel, msg: string): LogDraft => ({ t, level, src: "sys", msg })
  const out: LogDraft[] = [
    line(
      "INFO",
      `[启动器] EvEJS Launcher ${app ? `v${app.version}` : "版本未知"} · EVEJS ${app?.evejsVersion ?? "—"} · ${app?.platform ?? "—"}`
    ),
    line("INFO", `[启动器] 仓库: ${app?.repoRoot ?? "—"}`),
    token?.hasToken
      ? line("INFO", `[启动器] GitHub 令牌: 已配置${token.encrypted ? "（DPAPI 加密）" : ""}`)
      : line("WARN", "[启动器] GitHub 令牌: 未配置 · MOD制作者需要配置令牌，可在模组市场里设置"),
    market?.ok
      ? line(
          "INFO",
          `[启动器] 模组市场清单: 可获取 · 索引 ${market.mods.length} 条${market.cached ? "（本地缓存）" : ""}`
        )
      : line("WARN", `[启动器] 模组市场清单: 获取失败 · ${market?.reason ?? "未知原因"}`),
  ]
  const legacy = app?.legacy
  if (legacy?.adopted && legacy.items.length) {
    out.push(line("INFO", `[启动器] 已接管老启动器数据 ${legacy.items.length} 项`))
  }
  return out
}

/** 模组清单的指纹：加载/卸下/启停/换版本都会变，用来决定要不要补日志 */
export function modsSignature(mods: RawModList | null): string {
  if (!mods) return ""
  return mods.mods
    .map((m) => `${m.folder}:${m.version}:${m.enabled ? 1 : 0}:${m.valid ? 1 : 0}`)
    .join("|")
}

/** 一条模组行的正文：名字 + 版本 + 分类 + 启停 + 不健康的地方 */
function modLine(msg: string, level: LogLevel, at: number): LogDraft {
  return { t: stampOf(at), level, src: "sys", msg, badge: "MOD" }
}

/** 首次加载：全量模组逐条列出（行尾挂 MOD 徽标），前面先给一句汇总 */
export function modLines(mods: RawModList | null, at: number): LogDraft[] {
  if (!mods?.ok) return []
  const out: LogDraft[] = []
  const { total, enabled, disabled, conflicts } = mods.stats
  out.push({
    t: stampOf(at),
    level: conflicts > 0 ? "WARN" : "INFO",
    src: "sys",
    msg: `[启动器] 已加载模组: 共 ${total} 个 · 启用 ${enabled} · 禁用 ${disabled}${conflicts ? ` · 冲突 ${conflicts}` : ""}`,
  })
  for (const mod of mods.mods) out.push(modLogOf(mod, at))
  return out
}

/** 单个模组 → 一行（供全量清单与增量变化共用） */
function modLogOf(mod: RawMod, at: number): LogDraft {
  const parts = [`模组 ${mod.displayName} v${mod.version}`, mod.category, mod.enabled ? "已启用" : "已禁用"]
  if (!mod.valid) parts.push(`无效: ${mod.error || "结构不合法"}`)
  else if (!mod.supported) parts.push(`不兼容: ${mod.unsupportedReason || "与当前服务端版本不匹配"}`)
  if (mod.activeConflicts.length) parts.push(`冲突: ${mod.activeConflicts.join("、")}`)
  const level: LogLevel = !mod.valid || !mod.supported || mod.activeConflicts.length ? "ERROR" : mod.enabled ? "INFO" : "DEBUG"
  return modLine(parts.join(" · "), level, at)
}

/** 增量：拿相邻两次 mods:list 比出「新加载 / 已卸下 / 启停 / 换版本」，没有变化就返回空 */
export function modDiffLines(
  previous: RawModList | null,
  next: RawModList | null,
  at: number
): LogDraft[] {
  if (!previous || !next) return []
  const keyOf = (m: RawMod) => `${m.folder}:${m.version}:${m.enabled ? 1 : 0}:${m.valid ? 1 : 0}`
  const was = new Map(previous.mods.map((m) => [m.folder, m]))
  const now = new Map(next.mods.map((m) => [m.folder, m]))
  const out: LogDraft[] = []
  for (const [folder, mod] of now) {
    const before = was.get(folder)
    if (!before) {
      out.push(modLine(`模组已加载 · ${mod.displayName} v${mod.version} · ${mod.category}`, "INFO", at))
      continue
    }
    if (before.version !== mod.version) {
      out.push(modLine(`模组已更新 · ${mod.displayName} ${before.version} → ${mod.version}`, "INFO", at))
    }
    if (before.enabled !== mod.enabled) {
      out.push(
        modLine(`模组${mod.enabled ? "已启用" : "已禁用"} · ${mod.displayName} v${mod.version}`, mod.enabled ? "INFO" : "WARN", at)
      )
    }
    if (keyOf(before) === keyOf(mod)) continue
    if (before.valid !== mod.valid || before.activeConflicts.length !== mod.activeConflicts.length) {
      out.push(modLogOf(mod, at))
    }
  }
  for (const [folder, mod] of was) {
    if (!now.has(folder)) out.push(modLine(`模组已卸下 · ${mod.displayName} v${mod.version}`, "WARN", at))
  }
  return out
}
