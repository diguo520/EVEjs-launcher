import { describe, expect, it } from "vitest"

import {
  MARKET_PORT,
  backendServiceId,
  diskVolumesFrom,
  envItemsFrom,
  initKeyOf,
  metricsFrom,
  modDiffLines,
  modLines,
  modsSignature,
  parseServerLog,
  portsOf,
  serviceCards,
  startupBannerLines,
  uptimeText,
} from "@/lib/live"
import type {
  RawAppInfo,
  RawEnvReport,
  RawHealth,
  RawMetrics,
  RawMod,
  RawModList,
  RawServerLog,
  RawService,
} from "@/lib/ipc"
import { SERVICES } from "@/lib/mock"

/* ------------------------------ 服务端日志 ------------------------------ */

function logOf(lines: string[]): RawServerLog {
  return { ok: true, exists: true, path: "server.log", size: 1, mtime: null, lines }
}

describe("parseServerLog", () => {
  it("没有回包或没有行时返回空数组", () => {
    expect(parseServerLog(null)).toEqual([])
    expect(parseServerLog(logOf([]))).toEqual([])
  })

  it("ISO 时间戳折算成本地 HH:MM:SS，标签映射成级别", () => {
    const rows = parseServerLog(
      logOf([
        "[2026-09-27T14:02:11] [LOG] 启动序列完成",
        "[2026-09-27T14:02:09] [WRN] 端口被占用",
        "[2026-09-27T14:02:07] [ERR] 连接失败",
        "[2026-09-27T14:02:05] [DBG] 堆上限 4096 MB",
        "[2026-09-27T14:02:03] [SUC] 世界存档挂载完成",
      ])
    )
    expect(rows.map((r) => r.level)).toEqual(["INFO", "WARN", "ERROR", "DEBUG", "INFO"])
    expect(rows.map((r) => r.t)).toEqual([
      "14:02:11",
      "14:02:09",
      "14:02:07",
      "14:02:05",
      "14:02:03",
    ])
    expect(rows[0].msg).toBe("启动序列完成")
  })

  it("来源固定是 server：这是日志文件，跟 terminal:data 的 node 实时流分开", () => {
    const rows = parseServerLog(logOf(["[2026-09-27T14:02:11] [LOG] x"]))
    expect(rows[0].src).toBe("server")
  })

  it("认不出的行直接丢弃，不做兜底猜测", () => {
    const rows = parseServerLog(logOf(["一堆没有前缀的输出", "", "[2026-09-27T14:02:11] [LOG] 好行"]))
    expect(rows).toHaveLength(1)
    expect(rows[0].msg).toBe("好行")
  })

  it("未知标签按 INFO 处理，正文里的方括号不受影响", () => {
    const rows = parseServerLog(logOf(["[2026-09-27T14:02:11] [XYZ] 内容 [含括号] 尾部"]))
    expect(rows[0].level).toBe("INFO")
    expect(rows[0].msg).toBe("内容 [含括号] 尾部")
  })
})

/* -------------------------------- 端口 / 卡片 -------------------------------- */

describe("portsOf", () => {
  it("没有配置时退回后端默认值（市场端口是 Rust 侧常量）", () => {
    expect(portsOf(null)).toEqual({
      node: 26000,
      market: MARKET_PORT,
      images: 26001,
      gateway: 26002,
    })
  })

  it("配置到手后三项照搬真值，市场端口仍走常量", () => {
    expect(portsOf({ game: 27000, images: 27001, gateway: 27002 })).toEqual({
      node: 27000,
      market: MARKET_PORT,
      images: 27001,
      gateway: 27002,
    })
  })
})

function svc(id: string, state: string, pid?: number | null): RawService {
  return { id, name: id, state, pid: pid ?? null }
}

const HEALTH_UP: RawHealth = { game: true, images: true, gateway: true, market: true }

describe("serviceCards", () => {
  it("顺序与张数跟原型一致，且每张卡都补齐了后端没有的读数", () => {
    const cards = serviceCards([], null, null)
    expect(cards.map((c) => c.id)).toEqual(SERVICES.map((s) => s.id))
    for (const card of cards) {
      expect(card.cpu).toBeNull()
      expect(card.memMB).toBeNull()
      expect(card.uptime).toBe("—")
      expect(card.logs).toBe(0)
    }
  })

  it("进程状态优先：running 带 pid，error 直接照搬", () => {
    const cards = serviceCards([svc("mainServer", "running", 14872), svc("marketServer", "error")], null, null)
    const node = cards.find((c) => c.id === "node")!
    const market = cards.find((c) => c.id === "market")!
    expect(node.state).toBe("running")
    expect(node.pid).toBe(14872)
    expect(market.state).toBe("error")
  })

  it("没有进程但端口探针活着也算运行中", () => {
    const cards = serviceCards([], HEALTH_UP, null)
    expect(cards.every((c) => c.state === "running")).toBe(true)
  })

  it("starting 按运行中画（转圈由 busy 管）", () => {
    const cards = serviceCards([svc("mainServer", "starting")], null, null)
    expect(cards.find((c) => c.id === "node")!.state).toBe("running")
  })

  it("探测不到也不算错：未启动就是 ready，不是 error", () => {
    const down: RawHealth = { game: false, images: false, gateway: false, market: false }
    const cards = serviceCards([svc("mainServer", "idle")], down, null)
    expect(cards.every((c) => c.state === "ready")).toBe(true)
  })

  it("端口取真实配置值", () => {
    const cards = serviceCards([], null, { game: 27000, images: 27001, gateway: 27002 })
    expect(cards.map((c) => c.port)).toEqual([27000, MARKET_PORT, 27001, 27002])
  })

  it("图片与网关卡共用主服务器进程的读数（它们不是独立进程）", () => {
    const cards = serviceCards(
      [svc("mainServer", "running", 1), svc("marketServer", "running", 2)],
      HEALTH_UP,
      null
    )
    const node = cards.find((c) => c.id === "node")!
    const images = cards.find((c) => c.id === "images")!
    const gateway = cards.find((c) => c.id === "gateway")!
    // 26001 / 26002 是主服务器进程起的 HTTP 子服务，读数当然来自那个进程
    expect(images.pid).toBe(1)
    expect(gateway.pid).toBe(1)
    expect(images.cpu).toBe(node.cpu)
    expect(gateway.uptime).toBe(node.uptime)
    // 市场服务是另一个进程，不会串到这两张卡上
    expect(images.memMB).toBe(node.memMB)
  })

  it("图片与网关的开关只认自己的端口探针，不跟着主服务器一起亮", () => {
    const partial: RawHealth = { game: true, images: false, gateway: false, market: false }
    const cards = serviceCards([svc("mainServer", "running", 1)], partial, null)
    expect(cards.find((c) => c.id === "node")!.state).toBe("running")
    // 主服务器在跑，但这两个端口还没起来 → 卡片必须是未启动，不能显示运行中
    expect(cards.find((c) => c.id === "images")!.state).toBe("ready")
    expect(cards.find((c) => c.id === "gateway")!.state).toBe("ready")
  })
})

describe("backendServiceId", () => {
  it("只有主服务器与市场服务能映射到后端进程", () => {
    expect(backendServiceId("node")).toBe("mainServer")
    expect(backendServiceId("market")).toBe("marketServer")
    expect(backendServiceId("images")).toBeNull()
    expect(backendServiceId("gateway")).toBeNull()
  })

  it("未知卡片返回 null 而不是抛错", () => {
    expect(backendServiceId("nope")).toBeNull()
  })
})

/* -------------------------------- 资源读数 -------------------------------- */

const METRICS: RawMetrics = {
  cpuPercent: 12.34,
  memUsedGB: 12.4,
  memTotalGB: 32,
  virtualMemUsedGB: 5.8,
  virtualMemTotalGB: 32,
  diskRoot: "C:",
  diskUsedGB: 421,
  diskTotalGB: 2048,
  netBytesPerSec: 1024 * 1024 * 8,
  onlinePlayers: 3,
  gpuPercent: null,
  gpuDedicatedUsedGB: null,
  gpuDedicatedTotalGB: null,
  gpuSharedUsedGB: null,
  gpuMemoryUsedGB: null,
  gpuMemoryTotalGB: null,
  volumes: [
    { root: "C:\\", usedGB: 421.4, totalGB: 1024, freeGB: 602.6, percent: 41.1 },
    { root: "C:\\", usedGB: 421.4, totalGB: 1024, freeGB: 602.6, percent: 41.1 },
    { root: "E:\\", usedGB: 264.2, totalGB: 2048, freeGB: 1783.8, percent: 12.9 },
  ],
}

describe("metricsFrom", () => {
  it("没有回包时返回空数组", () => {
    expect(metricsFrom(null)).toEqual([])
  })

  it("每行都带满 SERIES_LEN 个采样点，第二轮起沿用历史", () => {
    const first = metricsFrom(METRICS)
    for (const row of first) expect(row.series).toHaveLength(14)

    const previous = Object.fromEntries(first.map((r) => [r.key, r.series]))
    const second = metricsFrom({ ...METRICS, cpuPercent: 30 }, previous)
    const cpu = second.find((r) => r.key === "cpu")!
    expect(cpu.series).toHaveLength(14)
    expect(cpu.series.at(-1)).toBe(30)
    expect(cpu.series[0]).toBe(first.find((r) => r.key === "cpu")!.series[1])
  })

  it("本机没有独显计数器时 GPU 三项显示 —，不编数字", () => {
    const rows = metricsFrom(METRICS)
    expect(rows.find((r) => r.key === "gpu")!.display).toBe("—")
    expect(rows.find((r) => r.key === "gpuDed")!.display).toBe("—")
    expect(rows.find((r) => r.key === "gpuMem")!.display).toBe("—")
  })

  it("有读数时按真值格式化", () => {
    const rows = metricsFrom({
      ...METRICS,
      gpuPercent: 7.25,
      gpuDedicatedUsedGB: 3.5,
      gpuDedicatedTotalGB: 8,
      gpuSharedUsedGB: 1.7,
    })
    expect(rows.find((r) => r.key === "gpu")!.display).toBe("7.3")
    expect(rows.find((r) => r.key === "gpuDed")!.display).toBe("3.5")
    expect(rows.find((r) => r.key === "gpuDed")!.unit).toContain("8GB")
    expect(rows.find((r) => r.key === "gpuMem")!.display).toBe("1.7")
  })

  it("内存按 已用/总量 折算百分比，网络按 MB/s 换算", () => {
    const rows = metricsFrom(METRICS)
    expect(rows.find((r) => r.key === "mem")!.value).toBeCloseTo(38.75, 1)
    expect(rows.find((r) => r.key === "net")!.display).toBe("8.0")
  })
})

describe("diskVolumesFrom", () => {
  it("去掉盘符结尾反斜杠，重复盘符只留一份，数值取整", () => {
    const volumes = diskVolumesFrom(METRICS)
    expect(volumes.map((v) => v.name)).toEqual(["C:", "E:"])
    expect(volumes[0]).toMatchObject({ used: 421, total: 1024 })
    expect(volumes[1]).toMatchObject({ used: 264, total: 2048 })
  })

  it("没有回包时返回空数组", () => {
    expect(diskVolumesFrom(null)).toEqual([])
  })
})

/* -------------------------------- 环境自检 -------------------------------- */

const ENV: RawEnvReport = {
  repoRoot: "E:\\Games\\EveJS-v0.12.8",
  totalCount: 3,
  passCount: 1,
  checks: [
    { key: "serverDeps", label: "服务端依赖", message: "缺少 node_modules", ok: false },
    { key: "rust", label: "Rust 工具链", message: "未检测到 cargo", ok: false },
    { key: "localDb", label: "本地数据库", message: "已就绪", ok: true, warn: true },
  ],
  node: { ok: true, version: "v26.5.0" },
  sys: { level: "ok", message: "内存充足", memGB: 32, memRaw: 34359738368, cpuThreads: 16 },
}

describe("envItemsFrom", () => {
  it("没有回包时返回空数组", () => {
    expect(envItemsFrom(null)).toEqual([])
  })

  it("缺依赖是可修复项（missing + 修复按钮），工具链缺失只能人工装", () => {
    const items = envItemsFrom(ENV)
    const deps = items.find((i) => i.id === "serverDeps")!
    const rust = items.find((i) => i.id === "rust")!

    expect(deps.level).toBe("missing")
    expect(deps.blocking).toBe(true)
    expect(deps.fix?.action).toContain("服务端依赖")

    expect(rust.level).toBe("error")
    expect(rust.fix).toBeUndefined()
    expect(rust.blocking).toBe(false)
  })

  it("通过但带提醒的项画成 warn，不加修复按钮", () => {
    const items = envItemsFrom(ENV)
    const db = items.find((i) => i.id === "localDb")!
    expect(db.level).toBe("warn")
    expect(db.fix).toBeUndefined()
  })
})

describe("initKeyOf", () => {
  it("只有后端支持的初始化动作才给 key", () => {
    expect(initKeyOf("serverDeps")).toBe("deps")
    expect(initKeyOf("localDb")).toBe("db")
    expect(initKeyOf("market")).toBe("market")
    expect(initKeyOf("clientPath")).toBe("client")
    expect(initKeyOf("caCert")).toBe("ca")
    expect(initKeyOf("rust")).toBeNull()
    expect(initKeyOf("nope")).toBeNull()
  })
})
/* ------------------------------ 逐进程读数 ------------------------------ */

describe("uptimeText", () => {
  const base = 1_700_000_000_000

  it("不满 1 分钟按秒", () => {
    expect(uptimeText(base, base + 12_000)).toBe("12 秒")
  })
  it("不满 1 小时按分秒", () => {
    expect(uptimeText(base, base + 3 * 60_000 + 12_000)).toBe("3 分 12 秒")
  })
  it("不满 1 天按时分", () => {
    expect(uptimeText(base, base + 3600_000 + 3 * 60_000)).toBe("1 小时 3 分")
  })
  it("超过 1 天按天小时", () => {
    expect(uptimeText(base, base + 27 * 3600_000)).toBe("1 天 3 小时")
  })
  it("没有起点就画 —，不猜", () => {
    expect(uptimeText(null)).toBe("—")
    expect(uptimeText(undefined)).toBe("—")
  })
})

describe("serviceCards 的逐进程读数", () => {
  const raw: RawService = {
    id: "marketServer",
    name: "market",
    state: "running",
    pid: 42,
    cpuPercent: 3.1,
    memMB: 412,
    startedAt: 1_000_000,
  }

  it("CPU / 内存 / 运行时长照搬后端采样值", () => {
    const market = serviceCards([raw], null, null, 1_000_000 + 65_000).find((c) => c.id === "market")!
    expect(market.cpu).toBe(3.1)
    expect(market.memMB).toBe(412)
    expect(market.uptime).toBe("1 分 5 秒")
  })

  it("采样没到（null）就画 —，不拿 0 顶替", () => {
    const market = serviceCards(
      [{ ...raw, cpuPercent: null, memMB: null, startedAt: null }],
      null,
      null
    ).find((c) => c.id === "market")!
    expect(market.cpu).toBeNull()
    expect(market.memMB).toBeNull()
    expect(market.uptime).toBe("—")
  })
})

/* ------------------------------ 启动横幅 / 模组 ------------------------------ */

const APP: RawAppInfo = {
  name: "EvEJS Launcher",
  version: "0.2.0",
  evejsVersion: "0.12.9",
  phase: "S9",
  platform: "windows",
  repoRoot: "E:\\Games\\EveJS-v0.12.9",
}

describe("startupBannerLines", () => {
  it("版本 / 仓库 / 令牌 / 市场清单四行，全部走 sys 来源", () => {
    const lines = startupBannerLines({
      app: APP,
      token: { hasToken: true, encrypted: true, path: "p" },
      market: { ok: true, mods: [], cached: true },
      at: 0,
    })
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => l.src === "sys")).toBe(true)
    expect(lines.every((l) => l.badge === undefined)).toBe(true)
    expect(lines[0].msg).toContain("v0.2.0")
    expect(lines[1].msg).toContain("EveJS-v0.12.9")
    expect(lines[2].msg).toContain("已配置")
    expect(lines[3].msg).toContain("本地缓存")
  })

  it("令牌没配 / 市场拿不到都是 WARN，并把失败原因带上", () => {
    const lines = startupBannerLines({
      app: null,
      token: { hasToken: false, encrypted: false, path: "p" },
      market: { ok: false, reason: "离线", mods: [] },
      at: 0,
    })
    expect(lines[0].msg).toContain("版本未知")
    expect(lines[2].level).toBe("WARN")
    expect(lines[3].level).toBe("WARN")
    expect(lines[3].msg).toContain("离线")
  })

  it("老启动器数据被接管时补一行", () => {
    const app: RawAppInfo = {
      ...APP,
      legacy: { adopted: true, items: ["author.json"], source: "x", skipped: "" },
    }
    const lines = startupBannerLines({ app, token: null, market: null, at: 0 })
    expect(lines.some((l) => l.msg.includes("接管"))).toBe(true)
  })
})

function modOf(folder: string, extra: Partial<RawMod> = {}): RawMod {
  return {
    id: folder,
    folder,
    dir: folder,
    displayName: folder,
    version: "1.0.0",
    description: "",
    category: "功能",
    tags: [],
    authorId: "au-1",
    authorName: "指挥官",
    enabled: true,
    kind: "mod",
    valid: true,
    supported: true,
    error: "",
    unsupportedReason: "",
    signatureState: "ok",
    signatureError: "",
    signatureKeyId: "",
    sizeBytes: 1024,
    loadAfter: [],
    loadBefore: [],
    missingRequires: [],
    activeConflicts: [],
    modules: [],
    source: "local",
    sourceRepo: "",
    sourceVersion: "",
    updatedAt: 0,
    ...extra,
  }
}

function modListOf(mods: RawMod[]): RawModList {
  return {
    ok: true,
    exists: true,
    mods,
    order: mods.map((m) => m.folder),
    conflicts: [],
    root: "mods",
    repoRoot: "repo",
    repoRootLooksValid: true,
    stats: {
      total: mods.length,
      enabled: mods.filter((m) => m.enabled).length,
      disabled: mods.filter((m) => !m.enabled).length,
      conflicts: 0,
      bytes: mods.length * 1024,
    },
  }
}

describe("modLines / modsSignature / modDiffLines", () => {
  it("汇总一行，之后每个模组一行、行尾挂 MOD 徽标", () => {
    const list = modListOf([
      modOf("evejs-market-pack", { displayName: "市场增强包", version: "1.2.0" }),
      modOf("evejs-quiet-dock", { displayName: "静音船坞", enabled: false }),
    ])
    const lines = modLines(list, 0)
    expect(lines).toHaveLength(3)
    expect(lines[0].msg).toContain("共 2 个")
    expect(lines[0].badge).toBeUndefined()
    expect(lines[1].badge).toBe("MOD")
    expect(lines[1].msg).toContain("市场增强包 v1.2.0")
    expect(lines[1].msg).toContain("已启用")
    expect(lines[2].msg).toContain("已禁用")
    expect(lines[2].level).toBe("DEBUG")
  })

  it("坏模组（无效 / 不兼容 / 冲突）画成 ERROR 并带上原因", () => {
    const lines = modLines(
      modListOf([modOf("evejs-broken", { valid: false, error: "manifest 缺字段" })]),
      0
    )
    expect(lines[1].level).toBe("ERROR")
    expect(lines[1].msg).toContain("manifest 缺字段")
  })

  it("指纹盖住 启停 / 版本 / 有效性", () => {
    const a = modListOf([modOf("m1")])
    const b = modListOf([modOf("m1", { enabled: false })])
    const c = modListOf([modOf("m1", { version: "2.0.0" })])
    expect(modsSignature(a)).not.toBe(modsSignature(b))
    expect(modsSignature(a)).not.toBe(modsSignature(c))
    expect(modsSignature(a)).toBe(modsSignature(modListOf([modOf("m1")])))
  })

  it("增量只报变化：新加载 / 卸下 / 启停 / 换版本", () => {
    const before = modListOf([modOf("m1"), modOf("m2")])
    const after = modListOf([
      modOf("m1", { enabled: false }),
      modOf("m3", { displayName: "新模组" }),
    ])
    const msgs = modDiffLines(before, after, 0).map((l) => l.msg)
    expect(msgs.some((m) => m.includes("已禁用 · m1"))).toBe(true)
    expect(msgs.some((m) => m.includes("已加载 · 新模组"))).toBe(true)
    expect(msgs.some((m) => m.includes("已卸下 · m2"))).toBe(true)
    expect(modDiffLines(before, before, 0)).toEqual([])
  })
})
