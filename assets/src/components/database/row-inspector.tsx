import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { DbValueText } from "@/components/database/value-text"
import { primaryKeyLabel, type DbRow, type DbTableModel } from "@/components/database/db-model"

/** 右栏：选中行的逐字段详情 + 删除 / 保存 */
export function RowInspector({
  table,
  row,
  onDelete,
  className,
}: {
  table: DbTableModel
  row: DbRow | null
  onDelete: (key: string) => void
  className?: string
}) {
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="panel-label">行详情</span>
        <span className="tabular truncate text-[10px] text-tertiary">
          {row ? primaryKeyLabel(table, row) : "未选择"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {row ? (
          <dl className="space-y-2.5">
            {table.columns.map((column) => (
              <div key={column.name} className="border-b border-input pb-2 last:border-b-0">
                <dt className="text-[10px] uppercase tracking-[0.06em] text-tertiary">
                  {column.name}
                </dt>
                <dd className="mt-1 break-all">
                  <DbValueText value={row.values[column.name]} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="grid h-full min-h-[160px] place-items-center">
            <span className="text-[12px] text-tertiary">选择一行查看字段</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-input px-3 py-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled={!row}
              className="flex-1 hover:border-destructive/60 hover:text-destructive"
            >
              <Trash2 />
              删除行
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这一行？</AlertDialogTitle>
              <AlertDialogDescription>
                将从 {table.name} 中移除主键为{" "}
                {row ? primaryKeyLabel(table, row) : "—"} 的记录，此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (!row) return
                  onDelete(row.key)
                }}
              >
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Button
          size="sm"
          className="flex-1"
          disabled={!row}
          onClick={() => toast.success("已保存")}
        >
          保存行
        </Button>
      </div>
    </div>
  )
}
