import { useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
  Search,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { Panel, SectionHeading } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useHotReload, type HotReloadResult, type HotReloadTable } from "@/hooks/use-hot-reload"
import { CATEGORY_LABEL, tableCategory, tableNameZh } from "@/lib/static-table-meta"
import { cn } from "@/lib/utils"

/**
 * 静态数据（热重载）。
 *
 * 服务端启动时 `preloadAll()` 把 `_local/gameStore/data/<表>/data.json` 全读进内存，
 * 之后只读内存 —— 改文件不重启，游戏里看不到。真正的替换发生在**服务端进程内部**：
 * 启动器启动主服务器时用 `NODE_OPTIONS=--require` 注入 host（src-tauri/src/hotreload/host.js），
 * host 收到请求后用服务端自己的公开 API `gameStore.write(table, "/", data)` 整表覆盖内存副本，
 * 再调用服务端自己导出的 `clear* / reset* / refresh*` 钩子把派生索引一并失效。
 *
 * 「生效方式」的口径（不是猜的，是扫服务端源码得出的，见 hotreload/mod.rs 的 FROZEN_TABLES）：
 *   - 即时：表只经通用读缓存，重载后下次读取就是新值；
 *   - 需重进场景：还决定正在跑的星系里有什么，要等场景重建；
 *   - 需重启：被某个**没有重置入口**的模块级索引冻住，只能重启主服务器。
 *
 * 这一页负责：看得见（表名 / 大小 / 改动 / 生效方式）、点得动（重载选中 / 重载脏表 / 整库）、
 * 退得回（重载前自动快照 + 一键还原）。
 */
export function StaticDataPage() {
  const { t } = useLocale()
  const store = useHotReload()
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string[]>([])

  const state = store.state
  const tables = state?.tables ?? []
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return tables
    return tables.filter(
      (table) =>
        table.name.toLowerCase().includes(keyword) ||
        (tableNameZh(table.name) ?? "").toLowerCase().includes(keyword) ||
        (tableNameZh(table.name) ? t(tableNameZh(table.name) as string) : "")
          .toLowerCase()
          .includes(keyword)
    )
  }, [tables, query, t])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const dirtyNames = useMemo(
    () => tables.filter((table) => table.dirty).map((table) => table.name),
    [tables]
  )
  const frozenNames = useMemo(
    () => tables.filter((table) => table.needsRestart).map((table) => table.name),
    [tables]
  )
  const busy = store.applying

  function toggle(name: string, next: boolean) {
    setSelected((prev) =>
      next ? (prev.includes(name) ? prev : [...prev, name]) : prev.filter((item) => item !== name)
    )
  }

  function toggleAll(next: boolean) {
    setSelected(next ? visible.map((table) => table.name) : [])
  }

  async function run(names: string[], doneMessage: string) {
    const reply = await store.apply(names, true)
    if (reply.ok) {
      toast.success(doneMessage, { description: summaryLine(reply, t) })
    } else {
      toast.error(t("重载没有全部成功"), { description: reply.reason ?? summaryLine(reply, t) })
    }
    setSelected([])
  }

  async function restore(snapshotId: string) {
    const reply = await store.restore(snapshotId)
    if (reply.ok) {
      toast.success(t("已还原 {n} 张表", { n: reply.reloaded?.length ?? 0 }))
    } else {
      toast.error(t("重载没有全部成功"), { description: reply.reason ?? summaryLine(reply, t) })
    }
  }

  if (store.error && !state) {
    return (
      <div className="space-y-4">
        <SectionHeading title={t("静态数据")} sub="// STATIC DATA HOT RELOAD" />
        <Panel title={t("读不到静态数据清单")}>
          <p className="text-[12px] leading-relaxed text-muted-foreground">{store.error}</p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={store.reload} disabled={store.loading}>
              {store.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("刷新")}
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  const armed = state?.armed ?? false
  const frozenCount = state?.frozenCount ?? frozenNames.length
  const sceneCount = (state?.frozenTables ?? []).filter((table) => table.scene).length

  return (
    <div className="space-y-4">
      <SectionHeading
        title={t("静态数据")}
        sub="// STATIC DATA HOT RELOAD"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-[11px] text-muted-foreground">
              {store.loading
                ? t("读取中…")
                : t(
                    "{total} 张可重载 · {dirty} 张有改动 · {frozen} 张需重启 · {runtime} 张运行时表",
                    {
                      total: tables.length,
                      dirty: state?.dirtyCount ?? 0,
                      frozen: frozenCount,
                      runtime: state?.sqliteRuntimeTables ?? 0,
                    }
                  )}
            </span>
            <Button variant="secondary" size="sm" onClick={store.reload} disabled={store.loading || busy}>
              {store.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("刷新")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void run(dirtyNames, t("重载完成"))}
              disabled={!armed || busy || dirtyNames.length === 0}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Zap />}
              {t("重载改动过的")}
              <span className="tabular text-[10px] text-tertiary">{dirtyNames.length}</span>
            </Button>
            <Button
              size="sm"
              onClick={() => void run(selected, t("重载完成"))}
              disabled={!armed || busy || selected.length === 0}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Zap />}
              {t("重载选中")}
              <span className="tabular text-[10px] opacity-70">{selected.length}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void run([], t("重载完成"))}
              disabled={!armed || busy}
            >
              {t("重载全部")}
            </Button>
          </div>
        }
      />

      {!armed ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {state?.supported === false
              ? t("这台机器的服务端没有 gameStore，热重载不可用。")
              : t("当前主服务器不是由本启动器启动的，热重载不可用。请在「主控台」里启动主服务器。")}
          </p>
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-telemetry" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">{t("即时生效")}</span>
            {" · "}
            {t("重载后服务端下次读取就是新值，客户端打开对应窗口即可看到。")}
          </p>
        </div>
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">{t("需重进场景")}</span>
            {" · "}
            {t(
              "这几张表还决定正在运行的星系里有什么；重载后要等场景重建（跳出去再进来），或直接重启主服务器。"
            )}
            <span className="tabular ml-1 text-tertiary">{sceneCount}</span>
          </p>
        </div>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">{t("需重启服务端")}</span>
            {" · "}
            {t("被服务端启动时建好的内存索引冻结了，只有重启主服务器才会生效。")}
            <span className="tabular ml-1 text-tertiary">
              {t("重启才生效的 {n} 张", { n: frozenCount })}
            </span>
          </p>
        </div>
      </div>

      <Panel
        title={t("数据表")}
        tag="DATA TABLES"
        meta={t("已选中 {n} 张表", { n: selected.length })}
        flush
        className="[&>header]:border-b-0"
        actions={
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
              <Checkbox
                checked={visible.length > 0 && visible.every((table) => selectedSet.has(table.name))}
                aria-label={t("全选")}
                onCheckedChange={(next) => toggleAll(next === true)}
              />
              {t("全选")}
            </label>
            <div className="relative w-52">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("搜索表名")}
                className="h-8 pl-8 text-[12px]"
              />
            </div>
          </div>
        }
      >
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            {t("没有匹配的数据表")}
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
            {visible.map((table) => (
              <TableRow
                key={table.name}
                table={table}
                checked={selectedSet.has(table.name)}
                onToggle={(next) => toggle(table.name, next)}
              />
            ))}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title={t("上次重载")} tag="LAST RUN">
          {state?.last ? <ResultBody result={state.last} /> : (
            <p className="text-[12px] text-muted-foreground">{t("还没有重载记录")}</p>
          )}
        </Panel>

        <Panel
          title={t("快照")}
          tag="SNAPSHOTS"
          meta={t("重载前会自动留一份快照，最多保留 10 份。")}
        >
          {(state?.snapshots ?? []).length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t("还没有快照")}</p>
          ) : (
            <div className="space-y-2">
              {(state?.snapshots ?? []).map((snapshot) => (
                <div
                  key={snapshot.id}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="tabular block text-[11px] text-foreground">
                      {formatStamp(Number(snapshot.id) || snapshot.at)}
                    </span>
                    <span className="block text-[10px] text-tertiary">
                      {t("{n} 张表", { n: snapshot.tables.length })}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!armed || busy}
                    onClick={() => void restore(snapshot.id)}
                  >
                    <RotateCcw />
                    {t("还原")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

/**
 * 一行表。
 *
 * 表 ID 是给人认路的（就是 `data/<ID>/data.json` 的目录名），
 * 中文名是给人看懂的，分类是给人扫的，右侧徽章回答「重载完到底生不生效」。
 */
function TableRow({
  table,
  checked,
  onToggle,
}: {
  table: HotReloadTable
  checked: boolean
  onToggle: (next: boolean) => void
}) {
  const { t } = useLocale()
  const zh = tableNameZh(table.name)
  const category = tableCategory(table.name)
  const reason = table.needsRestart
    ? t("冻结它的服务端模块：{owners}", { owners: table.frozenBy })
    : undefined
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 border-b border-input px-4 py-2.5 last:border-b-0",
        checked && "bg-primary/5"
      )}
      title={reason}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(next) => onToggle(next === true)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {zh ? (
            <span className="truncate text-[12px] font-medium text-foreground">{t(zh)}</span>
          ) : null}
          <span className={cn("truncate text-[11px]", zh ? "text-tertiary" : "text-[12px] font-medium text-foreground")}>
            {table.name}
          </span>
          {table.dirty ? <Badge variant="warning">{t("有改动")}</Badge> : null}
          {table.needsRestart ? (
            <Badge variant="destructive">{t("需重启服务端")}</Badge>
          ) : table.sceneBound ? (
            <Badge variant="outline">{t("需重进场景")}</Badge>
          ) : null}
        </span>
        <span className="tabular mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-tertiary">
          {category ? (
            <span className="text-muted-foreground">{t(CATEGORY_LABEL[category])}</span>
          ) : null}
          <span>{t("约 {size}", { size: formatBytes(table.sizeBytes) })}</span>
          <span>{formatStamp(table.mtimeMs)}</span>
        </span>
      </span>
    </label>
  )
}

/** 重载结果正文：成功 / 跳过 / 失败 三段，失败项把表名与原因都摊开 */
function ResultBody({ result }: { result: HotReloadResult }) {
  const { t } = useLocale()
  const reloaded = result.reloaded ?? []
  const skipped = result.skipped ?? []
  const failed = result.failed ?? []
  return (
    <div className="space-y-2">
      <p
        className={cn(
          "text-[12px]",
          result.ok ? "text-success" : "text-destructive"
        )}
      >
        {result.ok
          ? t("重载成功 {n} 张 · 跳过 {skipped} · 失败 {failed} · 耗时 {ms} 毫秒", {
              n: reloaded.length,
              skipped: skipped.length,
              failed: failed.length,
              ms: result.elapsedMs ?? 0,
            })
          : result.reason ?? t("重载没有全部成功")}
      </p>
      {failed.length > 0 ? (
        <div>
          <div className="panel-label">{t("失败项")}</div>
          <ul className="mt-1 space-y-1">
            {failed.map((item) => (
              <li key={item.table + item.reason} className="text-[11px] text-muted-foreground">
                <span className="text-foreground">{item.table}</span>
                {" · "}
                {item.reason}
                {" · "}
                {item.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div>
          <div className="panel-label">{t("跳过项")}</div>
          <ul className="mt-1 space-y-1">
            {skipped.slice(0, 12).map((item) => (
              <li key={item.table + item.reason} className="text-[11px] text-muted-foreground">
                <span className="text-foreground">{item.table}</span>
                {" · "}
                {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {(result.derivedRefreshed ?? []).length > 0 ? (
        <p className="text-[10px] text-tertiary">
          derived: {(result.derivedRefreshed ?? []).join(", ")}
        </p>
      ) : null}
    </div>
  )
}

function summaryLine(
  result: HotReloadResult,
  t: (key: string, values?: Record<string, string | number>) => string
) {
  return t("重载成功 {n} 张 · 跳过 {skipped} · 失败 {failed} · 耗时 {ms} 毫秒", {
    n: result.reloaded?.length ?? 0,
    skipped: result.skipped?.length ?? 0,
    failed: result.failed?.length ?? 0,
    ms: result.elapsedMs ?? 0,
  })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB"
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB"
  return bytes + " B"
}

function formatStamp(ms: number): string {
  if (!ms) return "—"
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds())
  )
}