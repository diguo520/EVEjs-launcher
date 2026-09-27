import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { buildDdl, type DbTableModel } from "@/components/database/db-model"

/** 中栏「结构」页签：列定义清单 */
export function SchemaView({ table }: { table: DbTableModel }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky top-0 z-10 bg-card">列名</TableHead>
            <TableHead className="sticky top-0 z-10 bg-card">类型</TableHead>
            <TableHead className="sticky top-0 z-10 bg-card">主键</TableHead>
            <TableHead className="sticky top-0 z-10 bg-card">非空</TableHead>
            <TableHead className="sticky top-0 z-10 bg-card">默认值</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {table.columns.map((column) => (
            <TableRow key={column.name} className="hover:bg-transparent">
              <TableCell className="tabular whitespace-nowrap py-1.5 text-[12px] text-foreground">
                {column.name}
              </TableCell>
              <TableCell className="tabular whitespace-nowrap py-1.5 text-[12px] text-primary/85">
                {column.type}
              </TableCell>
              <TableCell className="py-1.5">
                {column.pk ? (
                  <Badge variant="telemetry">PK</Badge>
                ) : (
                  <span className="text-[12px] text-tertiary">—</span>
                )}
              </TableCell>
              <TableCell className="py-1.5">
                {column.notNull ? (
                  <span className="text-[12px] text-success">✓</span>
                ) : (
                  <span className="text-[12px] text-tertiary">—</span>
                )}
              </TableCell>
              <TableCell className="tabular whitespace-nowrap py-1.5 text-[12px] text-muted-foreground">
                {column.def}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 中栏「SQL」页签：只读建表语句 */
export function SqlView({ table }: { table: DbTableModel }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <Textarea
        readOnly
        spellCheck={false}
        value={buildDdl(table)}
        className="min-h-[320px] font-mono text-[12px] leading-relaxed text-foreground/85"
        aria-label="建表语句"
      />
    </div>
  )
}
