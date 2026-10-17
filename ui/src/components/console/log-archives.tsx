import { useCallback, useEffect, useState } from "react"
import { Archive, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { t } from "@/lib/i18n"
import { call, callOr, hasIpc } from "@/lib/ipc"

/** `log:archives` 里的一份存档 */
interface ArchiveFile {
  name: string
  /** 这一份所在的目录（后端给，仅供悬停看完整路径） */
  dir: string
  bytes: number
  mtime: number
}

/** 一组（主服务器 / 市场服务 / 客户端）的存档清单 */
interface ArchiveGroup {
  id: string
  count: number
  bytes: number
  files: ArchiveFile[]
}

interface ArchiveReport {
  ok?: boolean
  root?: string
  groups?: ArchiveGroup[]
}

/** 三组的展示顺序与文案（与后端 logarchive::GROUPS 一一对应） */
const GROUP_ORDER = ["server", "market", "client"] as const
const GROUP_LABEL: Record<string, string> = {
  server: "主服务器",
  market: "市场服务",
  client: "客户端",
}

/** 体积读数：存档日志几百 KB 到几十 MB，B / KB / MB 三档够用 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 100 ? kb.toFixed(1) : Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 修改时间：MM-DD HH:mm，跨年才带上年份 */
function formatTime(ms: number): string {
  if (!ms) return "—"
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return "—"
  const pad = (value: number) => String(value).padStart(2, "0")
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`
}

/**
 * 右栏「存档日志」：主服务器 / 市场服务 / 客户端三组的历史输出。
 *
 * 每轮服务启动都会落一份存档（后端 logarchive），这里只负责列出来 + 清空。
 * 清空用开关而不是按钮：它是个有副作用的一次性动作，开关在手感上更「按下去就生效」，
 * 动作完成后自己弹回未选中，不会留下「一直是开着的」的错觉。
 */
export function LogArchives({ className }: { className?: string }) {
  const [report, setReport] = useState<ArchiveReport | null>(null)
  const [clearing, setClearing] = useState(false)
  /** 正在用默认程序打开的那一份（按文件名去重，同一时刻只允许点一个） */
  const [opening, setOpening] = useState<string | null>(null)
  const ipc = hasIpc()

  const load = useCallback(() => callOr<ArchiveReport>("logArchives", null), [])

  useEffect(() => {
    if (!ipc) return
    let alive = true
    void load().then((next) => {
      if (alive && next?.ok) setReport(next)
    })
    return () => {
      alive = false
    }
  }, [ipc, load])

  async function clearArchives() {
    if (clearing) return
    setClearing(true)
    try {
      const reply = await call<{
        ok?: boolean
        removed?: number
        freedBytes?: number
        reason?: string
      }>("logClearArchives")
      if (reply?.ok !== true) {
        toast.error(t("清空存档日志失败"), { description: reply?.reason ?? "后端没说明原因" })
        return
      }
      toast(
        t("已清空 {count} 份存档 · 释放 {size}", {
          count: String(reply.removed ?? 0),
          size: formatSize(reply.freedBytes ?? 0),
        })
      )
      const next = await load()
      if (next?.ok) setReport(next)
    } catch (reason) {
      toast.error(t("清空存档日志失败"), {
        description: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      setClearing(false)
    }
  }

  /** 用系统默认程序打开一份存档：只报「组 id + 文件名」，路径由后端现算 */
  async function openArchive(group: string, name: string) {
    if (opening) return
    setOpening(name)
    try {
      const reply = await call<{ ok?: boolean; reason?: string }>("logOpenArchive", group, name)
      if (reply?.ok !== true) {
        toast.error(t("打开日志失败"), { description: reply?.reason ?? "后端没说明原因" })
      }
    } catch (reason) {
      toast.error(t("打开日志失败"), {
        description: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      setOpening(null)
    }
  }

  const groups = report?.groups ?? []
  const byId = new Map(groups.map((group) => [group.id, group]))

  return (
    <Panel
      tag="// ARCHIVE"
      title={t("存档日志")}
      className={className}
      meta={
        <span className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.08em] text-tertiary">
            {t("清空日志")}
          </span>
          <Switch
            checked={clearing}
            disabled={!ipc || clearing}
            onCheckedChange={(next) => {
              if (next) void clearArchives()
            }}
            aria-label={t("清空日志")}
          />
        </span>
      }
      bodyClassName="flex h-full flex-col gap-3 overflow-y-auto pr-1"
    >
      {GROUP_ORDER.map((id) => {
        const group = byId.get(id)
        const files = group?.files ?? []
        const hidden = Math.max(0, (group?.count ?? 0) - files.length)
        return (
          <section key={id} className="rounded-md border border-input bg-background/40 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2 pb-1">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <Archive className="size-3 text-tertiary" />
                {t(GROUP_LABEL[id])}
              </span>
              <span className="tabular text-[10px] text-tertiary">
                {t("共 {count} 份 · {size}", {
                  count: String(group?.count ?? 0),
                  size: formatSize(group?.bytes ?? 0),
                })}
              </span>
            </div>

            {files.length > 0 ? (
              <ul className="mt-2 divide-y divide-input/60">
                {files.map((file) => (
                  <li
                    key={file.name}
                    className="flex items-center gap-2 rounded-sm px-1 py-1.5 text-[11px] hover:bg-secondary/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className="tabular truncate text-[11px] text-muted-foreground"
                        title={file.dir ? `${file.dir}\\${file.name}` : file.name}
                      >
                        {file.name}
                      </div>
                      <div className="tabular mt-0.5 text-[10px] text-tertiary">
                        {formatSize(file.bytes)} · {formatTime(file.mtime)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-tertiary hover:text-primary"
                      title={t("打开日志")}
                      disabled={!ipc || opening === file.name}
                      onClick={() => void openArchive(group?.id ?? "", file.name)}
                    >
                      <ExternalLink />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[10px] text-tertiary">{t("暂无存档")}</p>
            )}

            {hidden > 0 ? (
              <p className="mt-1 text-[10px] text-tertiary">
                {t("另有 {count} 份更早的", { count: String(hidden) })}
              </p>
            ) : null}
          </section>
        )
      })}
    </Panel>
  )
}
