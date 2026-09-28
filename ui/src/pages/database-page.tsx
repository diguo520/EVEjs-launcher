import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Panel, SectionHeading, StatTile } from "@/components/common/panel"
import { TableList } from "@/components/database/table-list"
import { TableBrowser } from "@/components/database/table-browser"
import { RowInspector } from "@/components/database/row-inspector"
import { DbPathBar } from "@/components/database/db-path-bar"
import {
  listModel,
  rowKey,
  tableFromRaw,
  type DbRow,
  type DbTableModel,
  type DbValue,
} from "@/components/database/db-model"
import { callOr, hasIpc } from "@/lib/ipc"
import type { RawAck, RawDbBackups, RawDbOverview, RawDbTable } from "@/lib/ipc"
import { DB_META, DB_TABLES } from "@/lib/mock"
import { useLocale } from "@/components/shell/locale-provider"

/** 单次载入的行数：SQLite 表可能几十万行，页面只拉前这么多，其余由总量读数交代 */
const PAGE_ROWS = 200

const EMPTY_TABLE: DbTableModel = { name: "", rows: 0, columns: [], data: [] }

/** 浏览器预览（没有桥）时退回原型自带的演示模型 */
function demoModels(): DbTableModel[] {
  return DB_TABLES.map((table) => ({
    name: table.name,
    rows: table.rows,
    columns: table.columns,
    data: table.data.map((row, index) => ({
      key: rowKey(table.columns, table.name, row, index),
      values: row,
    })),
  }))
}

function bytesToMB(bytes: number | undefined): number {
  if (!bytes || bytes <= 0) return 0
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

export function DatabasePage() {
  const { t } = useLocale()
  const ipc = hasIpc()
  const [overview, setOverview] = useState<RawDbOverview | null>(null)
  const [tables, setTables] = useState<DbTableModel[]>(() => (ipc ? [] : demoModels()))
  const [activeName, setActiveName] = useState<string>(() => (ipc ? "" : DB_TABLES[0].name))
  const [loaded, setLoaded] = useState<DbTableModel | null>(null)
  const [tableLoading, setTableLoading] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [backups, setBackups] = useState<RawDbBackups | null>(null)

  /* ---------------- 读：概览 → 表清单 ---------------- */

  const loadOverview = useCallback(async () => {
    if (!ipc) return
    const reply = await callOr<RawDbOverview>("databaseOverview", null)
    if (!reply?.ok) {
      toast.error("读数据库概览失败", { description: reply?.reason ?? "后端没说明原因" })
      return
    }
    setOverview(reply)
    const list = (reply.tables ?? []).map(listModel)
    setTables(list)
    setActiveName((prev) => prev || list[0]?.name || "")
  }, [ipc])

  const loadBackups = useCallback(async () => {
    if (!ipc) return
    const reply = await callOr<RawDbBackups>("databaseBackups", null)
    if (reply?.ok) setBackups(reply)
  }, [ipc])

  useEffect(() => {
    void loadOverview()
    void loadBackups()
  }, [loadOverview, loadBackups])

  /* ---------------- 读：当前表（按需载入前若干行） ---------------- */

  const loadTable = useCallback(
    async (name: string) => {
      if (!ipc || !name) return
      setTableLoading(true)
      const reply = await callOr<RawDbTable>("databaseTable", null, name, PAGE_ROWS, 0)
      setTableLoading(false)
      if (!reply?.ok) {
        toast.error(t("读表 {name} 失败", { name }), {
          description: reply?.reason ?? "后端没说明原因",
        })
        return
      }
      setLoaded(tableFromRaw(reply))
      setSelectedKey(null)
    },
    [ipc]
  )

  useEffect(() => {
    if (!ipc || !activeName) return
    setSelectedKey(null)
    void loadTable(activeName)
  }, [ipc, activeName, loadTable])

  /* ---------------- 视图模型 ---------------- */

  const activeTable = useMemo<DbTableModel>(() => {
    if (!ipc) return tables.find((t) => t.name === activeName) ?? tables[0] ?? EMPTY_TABLE
    if (loaded && loaded.name === activeName) return loaded
    const info = tables.find((t) => t.name === activeName)
    return info ?? EMPTY_TABLE
  }, [ipc, tables, activeName, loaded])

  const selectedRow: DbRow | null =
    activeTable.data.find((r) => r.key === selectedKey) ?? null

  const columnsOf = useCallback(
    (name: string) => {
      const info = overview?.tables?.find((entry) => entry.name === name)
      return info?.columns ?? 0
    },
    [overview]
  )

  const activeColumns = ipc ? columnsOf(activeTable.name) : activeTable.columns.length

  /* ---------------- 写 ---------------- */

  async function deleteRow(key: string) {
    const row = activeTable.data.find((r) => r.key === key)
    if (!row) return
    if (!ipc) {
      toast.error("没有连接后端，无法删除行")
      return
    }
    const reply = await callOr<RawAck>("databaseDelete", null, activeTable.name, row.values)
    if (!reply?.ok) {
      toast.error("删除失败", { description: reply?.reason ?? "后端没说明原因" })
      return
    }
    setSelectedKey(null)
    toast.error("已删除 1 行")
    await loadTable(activeTable.name)
    await loadOverview()
  }

  async function backup() {
    if (!ipc) {
      toast.error("没有连接后端，无法创建备份")
      return
    }
    const reply = await callOr<RawAck>("databaseBackup", null)
    if (!reply?.ok) {
      toast.error("备份失败", { description: reply?.reason ?? "后端没说明原因" })
      return
    }
    const name = typeof reply.name === "string" ? reply.name : "（后端未返回文件名）"
    toast.success(t("已创建备份 {name}", { name }))
    await loadBackups()
  }

  async function restore() {
    if (!ipc) {
      toast.error("没有连接后端，无法恢复备份")
      return
    }
    const list = backups?.backups ?? []
    if (list.length === 0) {
      toast.error("还没有可恢复的备份", { description: "先点「备份」生成一份。" })
      return
    }
    const newest = list.reduce((best, item) =>
      (item.createdAt ?? 0) > (best.createdAt ?? 0) ? item : best
    )
    if (!window.confirm(t("用备份「{name}」覆盖当前世界存档？服务端运行时会拒绝。", { name: newest.name })))
      return
    const reply = await callOr<RawAck>("databaseRestore", null, newest.name)
    if (!reply?.ok) {
      toast.error("恢复失败", { description: reply?.reason ?? "后端没说明原因" })
      return
    }
    toast.success(t("已从 {name} 恢复", { name: newest.name }))
    await loadOverview()
    await loadTable(activeName)
  }

  /** 新增行：后端要整行值，这里先取一次结构，再按列名给空值骨架 */
  async function insertRow() {
    if (!ipc) {
      toast.error("没有连接后端，无法新增行")
      return
    }
    if (!activeTable.columns.length) {
      toast.error("先选中一张表")
      return
    }
    const skeleton: Record<string, DbValue> = {}
    for (const column of activeTable.columns) skeleton[column.name] = null
    const reply = await callOr<RawAck>("databaseInsert", null, activeTable.name, skeleton)
    if (!reply?.ok) {
      toast.error("新增行失败", { description: reply?.reason ?? "后端会拒绝空行或必填列" })
      return
    }
    toast.success("已新增 1 行（各列为空，请在表结构里补值）")
    await loadTable(activeTable.name)
    await loadOverview()
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="数据库"
        sub="// PERSISTENCE LAYER"
        actions={
          <span className="tabular truncate text-[11px] text-muted-foreground">
            {ipc ? overview?.path ?? "正在读取…" : DB_META.file}
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="DB SIZE"
          value={ipc ? bytesToMB(overview?.sizeBytes) : DB_META.sizeMB}
          unit="MB"
          tone="telemetry"
          delta="SQLite"
        />
        <StatTile
          label="数据表"
          value={ipc ? overview?.tableCount ?? 0 : DB_META.tableCount}
          tone="primary"
          delta="REAL"
        />
        <StatTile
          label="总行数"
          value={ipc ? (overview?.totalRows ?? 0).toLocaleString("en-US") : DB_META.rowTotal.toLocaleString("en-US")}
          tone="primary"
          delta="TOTAL"
        />
        <StatTile
          label="日志模式"
          value={ipc ? overview?.journalMode ?? "—" : DB_META.journal}
          tone="warning"
          delta="MODE"
        />
      </div>

      <Panel
        flush
        tag="// WORKBENCH"
        title="数据浏览器"
        meta={
          ipc
            ? t("{count} 张表已挂载{extra}", {
                count: tables.length,
                extra:
                  activeTable.loaded !== undefined
                    ? t(" · 本表载入 {loaded} / {rows} 行", {
                        loaded: activeTable.loaded.toLocaleString("en-US"),
                        rows: activeTable.rows.toLocaleString("en-US"),
                      })
                    : "",
              })
            : t("{count} 张表已挂载", { count: tables.length })
        }
        className="min-h-[520px]"
        bodyClassName="flex min-h-0"
      >
        <div className="grid min-h-0 w-full flex-1 grid-rows-[auto_auto_auto] lg:grid-rows-1 lg:grid-cols-[180px_1fr_220px]">
          <TableList
            tables={tables}
            activeName={activeTable.name}
            onSelect={(name) => {
              setActiveName(name)
              setSelectedKey(null)
            }}
            className="border-b border-input lg:border-b-0 lg:border-r"
          />
          <TableBrowser
            table={activeTable}
            selectedKey={selectedKey}
            onSelectRow={setSelectedKey}
            onBackup={() => void backup()}
            onRestore={() => void restore()}
            onRefresh={() => {
              void loadOverview()
              void loadTable(activeTable.name)
            }}
            onInsert={() => void insertRow()}
            loading={tableLoading}
            extra={t("{count} 列", { count: activeColumns })}
            /* min-w-0：格子里是宽表格，不给它收缩的余地就会把整个网格撑出横向滚动 */
            className="min-w-0 border-b border-input lg:border-b-0 lg:border-r"
          />
          <RowInspector
            table={activeTable}
            row={selectedRow}
            onDelete={(key) => void deleteRow(key)}
            onRefresh={() => void loadTable(activeTable.name)}
          />
        </div>
      </Panel>

      <DbPathBar
        path={ipc ? overview?.path ?? "" : DB_META.path}
        backupDir={backups?.directory ?? ""}
        backupCount={backups?.backups?.length ?? 0}
        onRefresh={() => {
          void loadOverview()
          void loadBackups()
          void loadTable(activeTable.name)
        }}
      />
    </div>
  )
}
