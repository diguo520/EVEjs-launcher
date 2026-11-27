import * as React from "react"
import { CheckCircle2, FolderOpen, Loader2, Rocket, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { callOr, hasIpc, subscribe } from "@/lib/ipc"
import { t } from "@/lib/i18n"
import { formatBytes } from "@/lib/format"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

type DeployPurpose = "server" | "play"
type MarketSeed = "none" | "v1" | "v2" | "v3" | "v4"
type DeployPhase = "idle" | "checked" | "running" | "done" | "error" | "canceled"

interface RemoteServer {
  ok?: boolean
  latestVersion?: string
  file?: string
  sizeBytes?: number
  reason?: string
}

interface DeployResult {
  ok?: boolean
  reason?: string
  canceled?: boolean
  checked?: boolean
  deployed?: boolean
  repoRoot?: string
  root?: string
  logPath?: string
}

interface SetupRecord {
  label?: string
  title?: string
  detail?: string
  action?: string
}

interface DeployProgress {
  kind?: "phase" | "result" | "log" | "done" | "error" | string
  phase?: string
  percent?: number
  message?: string
  record?: SetupRecord | null
}

interface ResultRow {
  label: string
  title: string
  detail: string
}

const PHASE_TITLES: Record<string, string> = {
  "Node.js runtime": "Node.js 运行时",
  "Setup packages (certificate tooling)": "安装包（证书工具）",
  "Server packages": "服务端依赖包",
  "Game save format": "游戏存档格式",
  "Game database and moon composition": "游戏数据库与月球产物",
  "Local TLS certificates": "本地 TLS 证书",
  "Standalone market": "独立市场",
  "EVE client setup and certificate trust": "EVE 客户端补丁与证书信任",
  "Mandatory offline client gates": "客户端离线校验",
  "Recommended client firewall": "推荐客户端防火墙规则",
  "Node.js and npm": "Node.js 与 npm",
  "Windows Node.js and npm": "Windows Node.js 与 npm",
  "Backend configuration and local ports": "服务端配置与本地端口",
  "EVE client copy": "EVE 客户端副本",
  "Client records for game data": "客户端游戏数据记录",
  "Standalone market build tools": "独立市场构建工具",
  "CCP static data download": "CCP 静态数据下载",
}

const MARKET_HELP: Record<MarketSeed, string> = {
  none: "不生成市场数据库；之后也可以单独安装。",
  v1: "Jita 与 New Caldari 的合成买卖单。",
  v2: "Jita 的 Tranquility 快照订单与 NPC 库存。",
  v3: "按成本定价的 Jita 4-4 市场与 NPC 库存。",
  v4: "只导入 NPC 库存与回购，不生成玩家订单。",
}

function displayVersion(remote: RemoteServer | null): string {
  if (!remote) return "—"
  if (remote.latestVersion?.endsWith(".")) {
    const match = remote.file?.match(/^EveJS-(.+)\.zip$/i)
    if (match?.[1]) return match[1]
  }
  return remote.latestVersion || "—"
}

function phaseTitle(title: string): string {
  const key = PHASE_TITLES[title]
  return key ? t(key) : title
}

function statusText(label: string): string {
  switch (label) {
    case "[ok]":
      return t("通过")
    case "[todo]":
      return t("待处理")
    case "[work]":
      return t("运行中")
    case "[warn]":
      return t("警告")
    case "[skip]":
      return t("已跳过")
    case "[done]":
      return t("完成")
    case "[FAIL]":
      return t("失败")
    default:
      return label || t("状态")
  }
}

function statusTone(label: string): string {
  if (label === "[FAIL]") return "border-destructive/45 bg-destructive/10 text-destructive"
  if (label === "[work]") return "border-primary/45 bg-primary/10 text-primary"
  if (label === "[done]" || label === "[ok]") {
    return "border-success/45 bg-success/10 text-success"
  }
  if (label === "[skip]") return "border-border bg-secondary/45 text-muted-foreground"
  return "border-warning/45 bg-warning/10 text-warning"
}

export function ServerDeployDialog({
  open,
  onOpenChange,
  onDeployed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeployed: (root: string) => void
}) {
  const [target, setTarget] = React.useState("")
  const [purpose, setPurpose] = React.useState<DeployPurpose>("play")
  const [clientPath, setClientPath] = React.useState("")
  const [installFirewall, setInstallFirewall] = React.useState(false)
  const [marketSeed, setMarketSeed] = React.useState<MarketSeed>("none")
  const [latest, setLatest] = React.useState<RemoteServer | null>(null)
  const [loadingLatest, setLoadingLatest] = React.useState(false)
  const [phase, setPhase] = React.useState<DeployPhase>("idle")
  const [busyAction, setBusyAction] = React.useState<"check" | "install" | null>(null)
  const [lastAction, setLastAction] = React.useState<"check" | "install" | null>(null)
  const [checkedOk, setCheckedOk] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [message, setMessage] = React.useState("")
  const [error, setError] = React.useState("")
  const [results, setResults] = React.useState<ResultRow[]>([])
  const [logLines, setLogLines] = React.useState<string[]>([])
  const [logPath, setLogPath] = React.useState("")
  const [deployedRoot, setDeployedRoot] = React.useState("")

  const busy = phase === "running"
  const canRun =
    Boolean(target.trim()) &&
    Boolean(latest?.file) &&
    (purpose === "server" || Boolean(clientPath.trim()))

  const invalidateCheck = React.useCallback(() => {
    if (busy) return
    setCheckedOk(false)
    setPhase("idle")
    setProgress(0)
    setMessage("")
    setError("")
    setResults([])
    setLogLines([])
    setLogPath("")
    setDeployedRoot("")
  }, [busy])

  React.useEffect(() => {
    if (!open) return
    setPhase("idle")
    setBusyAction(null)
    setLastAction(null)
    setCheckedOk(false)
    setStopping(false)
    setProgress(0)
    setMessage("")
    setError("")
    setResults([])
    setLogLines([])
    setLogPath("")
    setDeployedRoot("")
    setLoadingLatest(true)
    void (async () => {
      const result = await callOr<RemoteServer>("serverUpdateCheck", null)
      setLoadingLatest(false)
      if (!result?.latestVersion || !result.file) {
        setLatest(null)
        setError(result?.reason || t("部署失败"))
        return
      }
      setLatest(result)
    })()
  }, [open])

  React.useEffect(() => {
    if (!open) return
    return subscribe("onServerDeployProgress", (...args) => {
      const frame = (args[0] ?? {}) as DeployProgress
      if (frame.kind === "log") {
        if (frame.message) {
          setLogLines((prev) => [...prev, frame.message as string].slice(-240))
        }
        return
      }
      if (typeof frame.percent === "number" && frame.percent > 0) {
        setProgress(frame.percent)
      }
      if (frame.message) setMessage(frame.message)
      if (frame.kind === "error" && frame.message) setError(frame.message)
      const record = frame.record
      if (!record?.title) return
      setResults((prev) => {
        const next = [...prev]
        const index = next.findIndex((row) => row.title === record.title)
        const row: ResultRow = {
          label: record.label || "",
          title: record.title as string,
          detail: record.detail || "",
        }
        if (index >= 0) next[index] = row
        else next.push(row)
        return next
      })
    })
  }, [open])

  React.useEffect(() => {
    if (!open || !busy || !latest?.file) return
    return subscribe("onDownloadProgress", (...args) => {
      const frame = (args[0] ?? {}) as {
        file?: string
        received?: number
        total?: number
      }
      if (frame.file && frame.file !== latest.file) return
      if (typeof frame.received !== "number" || !frame.total) return
      setProgress(3 + Math.round((frame.received / frame.total) * 42))
    })
  }, [open, busy, latest?.file])

  const close = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
  }

  async function pickFolder(kind: "target" | "client") {
    if (!hasIpc()) {
      setError(t("请在启动器中使用此功能"))
      return
    }
    const result = await callOr<{ ok?: boolean; path?: string; reason?: string }>(
      "serverDeployPickDir",
      null,
      kind === "target" ? t("选择服务端部署目录") : t("选择客户端目录")
    )
    if (result?.ok && result.path) {
      if (kind === "target") setTarget(result.path)
      else setClientPath(result.path)
      invalidateCheck()
    }
    if (result?.reason) setError(result.reason)
  }

  async function start(action: "check" | "install") {
    const path = target.trim()
    if (!path) {
      setError(t("部署目录不能为空"))
      return
    }
    if (purpose === "play" && !clientPath.trim()) {
      setError(t("客户端路径不能为空"))
      return
    }
    if (action === "install" && !checkedOk) {
      setError(t("请先通过环境检查"))
      return
    }
    if (!latest?.file || !latest.latestVersion) {
      setError(t("部署失败"))
      return
    }
    if (!hasIpc()) {
      setError(t("请在启动器中使用此功能"))
      return
    }

    setPhase("running")
    setBusyAction(action)
    setLastAction(action)
    setStopping(false)
    setCheckedOk(false)
    setError("")
    setResults([])
    setLogLines([])
    setLogPath("")
    setProgress(2)
    setMessage(action === "check" ? t("正在检查环境…") : t("正在下载服务端…"))

    const result = await callOr<DeployResult>(
      "serverDeploy",
      null,
      path,
      latest.file,
      latest.latestVersion,
      {
        purpose,
        clientPath: clientPath.trim(),
        installFirewall,
        marketSeed,
        checkOnly: action === "check",
      }
    )

    if (result?.logPath) setLogPath(result.logPath)
    if (!result) {
      setPhase("error")
      setBusyAction(null)
      setError(t("部署失败"))
      return
    }
    if (result.canceled) {
      setPhase("canceled")
      setBusyAction(null)
      setMessage(result.reason || t("部署已停止，已完成步骤会保留"))
      return
    }
    if (!result.ok) {
      setPhase("error")
      setBusyAction(null)
      setError(result.reason || t("部署失败"))
      return
    }
    if (action === "check") {
      setPhase("checked")
      setBusyAction(null)
      setCheckedOk(true)
      setProgress(100)
      setMessage(t("环境检查通过，可以开始部署"))
      toast.success(t("环境检查通过"))
      return
    }

    const root = result.repoRoot || result.root || path
    setPhase("done")
    setBusyAction(null)
    setProgress(100)
    setMessage(t("部署完成"))
    setDeployedRoot(root)
    onDeployed(root)
    toast.success(t("部署完成"), { description: t("已部署到 {path}", { path: root }) })
  }

  async function stop() {
    if (!hasIpc()) return
    setStopping(true)
    const result = await callOr<{ ok?: boolean; reason?: string }>(
      "serverDeployCancel",
      null
    )
    if (!result?.ok) {
      setStopping(false)
      setError(result?.reason || t("部署失败"))
    }
  }

  async function openLog() {
    if (!hasIpc()) return
    const result = await callOr<{ ok?: boolean; reason?: string }>(
      "serverDeployOpenLog",
      null
    )
    if (!result?.ok) {
      toast.error(result?.reason || t("部署失败"))
    }
  }

  const stageTitle = busy
    ? busyAction === "check"
      ? t("正在检查环境…")
      : t("正在部署服务端…")
    : phase === "checked"
      ? t("环境检查通过")
      : phase === "done"
        ? t("部署完成")
        : phase === "canceled"
          ? t("部署已停止")
          : phase === "error"
            ? lastAction === "check"
              ? t("检查未通过")
              : t("部署失败")
            : t("准备部署")

  const progressTone = phase === "error" ? "destructive" : "primary"
  const showActions = !busy && phase !== "done"

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-w-5xl"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            {t("完整部署服务端")}
          </DialogTitle>
          <DialogDescription>
            {t("使用服务端发布包自带的完整安装向导；先检查环境，再安装依赖、数据库、证书与可选组件。")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[285px_minmax(0,1fr)]">
          <div className="space-y-4 rounded-lg border border-border bg-secondary/25 p-3">
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t("部署目录")}
              </div>
              <div className="flex gap-2">
                <Input
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value)
                    invalidateCheck()
                  }}
                  placeholder={"D:\\Games\\EveJS-server"}
                  disabled={busy}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => void pickFolder("target")}
                  disabled={busy}
                  title={t("选择目录")}
                >
                  <FolderOpen />
                </Button>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t("选择空目录，或已解压但尚未安装的服务端目录。")}
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t("安装用途")}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={purpose === "server" ? "default" : "outline"}
                  onClick={() => {
                    setPurpose("server")
                    invalidateCheck()
                  }}
                  disabled={busy}
                >
                  {t("仅部署服务端")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={purpose === "play" ? "default" : "outline"}
                  onClick={() => {
                    setPurpose("play")
                    invalidateCheck()
                  }}
                  disabled={busy}
                >
                  {t("服务端 + 客户端")}
                </Button>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {purpose === "server"
                  ? t("只安装后端、证书与数据库，不修改客户端。")
                  : t("同时给单独的 EVE 客户端副本打补丁并安装证书。")}
              </p>
              {purpose === "server" ? (
                <p className="text-[10px] leading-relaxed text-warning">
                  {t("仅服务端需要已有的客户端数据记录；没有记录时请选择服务端 + 客户端。")}
                </p>
              ) : null}
            </div>

            {purpose === "play" ? (
              <div className="space-y-3 rounded-md border border-warning/25 bg-warning/5 p-2.5">
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    {t("客户端目录")}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={clientPath}
                      onChange={(event) => {
                        setClientPath(event.target.value)
                        invalidateCheck()
                      }}
                      placeholder={"E:\\EVE-sharedcache"}
                      disabled={busy}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => void pickFolder("client")}
                      disabled={busy}
                      title={t("选择客户端目录")}
                    >
                      <FolderOpen />
                    </Button>
                  </div>
                </div>
                <p className="text-[10px] leading-relaxed text-warning">
                  {t("会修改所选客户端的副本，请先备份。")}
                </p>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-muted-foreground">
                    {t("添加推荐的防火墙规则")}
                  </span>
                  <Switch
                    checked={installFirewall}
                    onCheckedChange={(checked) => {
                      setInstallFirewall(checked)
                      invalidateCheck()
                    }}
                    disabled={busy}
                  />
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t("市场种子")}
              </div>
              <Select
                value={marketSeed}
                onValueChange={(value) => {
                  setMarketSeed(value as MarketSeed)
                  invalidateCheck()
                }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("无独立市场")}</SelectItem>
                  <SelectItem value="v1">{t("v1 合成起步市场")}</SelectItem>
                  <SelectItem value="v2">{t("v2 静寂星域快照")}</SelectItem>
                  <SelectItem value="v3">{t("v3 Jita 成本定价")}</SelectItem>
                  <SelectItem value="v4">{t("v4 钢铁侠")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t(MARKET_HELP[marketSeed])}
              </p>
            </div>

            <div className="rounded-md border border-border bg-background/45 p-2.5 text-[11px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t("最新版本")}</span>
                <span className="tabular font-semibold text-foreground">
                  {loadingLatest ? "…" : displayVersion(latest)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t("下载体积")}</span>
                <span className="tabular text-foreground">
                  {latest?.sizeBytes ? formatBytes(latest.sizeBytes) : "—"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t("后端")}</span>
                <span className="text-foreground">{t("原生 Windows")}</span>
              </div>
            </div>
          </div>

          <div className="flex min-h-[430px] flex-col gap-3">
            <div className="rounded-lg border border-border bg-secondary/25 p-3">
              <div className="flex items-center gap-2">
                {busy ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : phase === "checked" || phase === "done" ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <ShieldCheck className="size-4 text-primary" />
                )}
                <div className="text-sm font-medium text-foreground">{stageTitle}</div>
                <span className="ml-auto text-[11px] tabular text-muted-foreground">
                  {progress}%
                </span>
              </div>
              <Progress className="mt-3" value={progress} tone={progressTone} />
              <p className="mt-2 min-h-4 text-[11px] text-muted-foreground">
                {message || t("先检查环境，检查通过后再开始完整部署。")}
              </p>
              {phase === "done" ? (
                <p className="mt-1 text-[11px] text-success">
                  {t("已部署到 {path}", { path: deployedRoot })}
                </p>
              ) : null}
              {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
            </div>

            <div className="min-h-0 flex-1 rounded-lg border border-border bg-background/35">
              <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("检查与安装步骤")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t("{count} 项", { count: results.length })}
                </span>
              </div>
              <div className="max-h-[240px] min-h-[150px] space-y-2 overflow-y-auto p-3">
                {results.length === 0 ? (
                  <div className="flex h-[130px] items-center justify-center text-center text-[11px] text-muted-foreground">
                    {t("还没有检查结果。选择部署选项后点「检查环境」。")}
                  </div>
                ) : (
                  results.map((row) => (
                    <div
                      key={row.title}
                      className="rounded-md border border-border/70 bg-secondary/25 px-2.5 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${statusTone(
                            row.label
                          )}`}
                        >
                          {statusText(row.label)}
                        </span>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground">
                            {phaseTitle(row.title)}
                          </div>
                          {row.detail ? (
                            <div className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground">
                              {row.detail}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/35">
              <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("部署日志")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => void openLog()}
                  disabled={!logPath}
                >
                  {t("打开日志")}
                </Button>
              </div>
              <pre className="max-h-24 min-h-12 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {logLines.length
                  ? logLines.slice(-80).join("\n")
                  : t("安装器的输出会显示在这里。")}
              </pre>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <div className="mr-auto flex flex-wrap gap-2">
            {showActions ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void start("check")}
                  disabled={!canRun || loadingLatest}
                >
                  <ShieldCheck />
                  {checkedOk ? t("重新检查") : t("检查环境")}
                </Button>
                <Button
                  type="button"
                  onClick={() => void start("install")}
                  disabled={!canRun || !checkedOk || loadingLatest}
                >
                  <Rocket />
                  {t("开始完整部署")}
                </Button>
              </>
            ) : null}
            {busy ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void stop()}
                disabled={stopping}
              >
                {stopping ? <Loader2 className="animate-spin" /> : null}
                {t("停止（完成当前步骤后）")}
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={busy}
          >
            {t("关闭")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
