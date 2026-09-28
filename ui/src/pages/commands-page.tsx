import { useMemo, useRef, useState } from "react"
import { Download, Plus, Upload } from "lucide-react"
import { toast } from "sonner"

import { SectionHeading } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { useCustomCommands } from "@/hooks/use-custom-commands"
import { COMMAND_CATEGORIES, BASE_COMMAND_ROWS, MANUAL_META } from "@/lib/manual-data"
import { t } from "@/lib/i18n"
import type { CommandRow } from "@/lib/manual-logic"
import { CommandGenerator } from "@/components/commands/command-generator"
import { CommandStats, CommandUsageHint } from "@/components/commands/command-overview"
import { CommandReference } from "@/components/commands/command-reference"
import { AddCommandDialog } from "@/components/commands/add-command-dialog"

const EXPORT_NAME = "evejs_commands_all.json"

function isCommandRow(v: unknown): v is CommandRow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as CommandRow).cmd === "string" &&
    typeof (v as CommandRow).desc === "string" &&
    typeof (v as CommandRow).cat === "string"
  )
}

export function CommandsPage() {
  const { version } = useLauncherVersion()
  const { custom, add, remove, replaceAll } = useCustomCommands()
  const [dialogOpen, setDialogOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const rows = useMemo<CommandRow[]>(
    () => [...BASE_COMMAND_ROWS, ...custom],
    [custom]
  )

  function exportJson() {
    const payload = {
      source: MANUAL_META.source,
      exportedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      counts: {
        commands: MANUAL_META.commands,
        templates: MANUAL_META.templates,
        items: MANUAL_META.items,
        npcs: MANUAL_META.npcs,
        qa: MANUAL_META.qa,
      },
      categories: COMMAND_CATEGORIES,
      custom,
    }

    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = EXPORT_NAME
      a.click()
      URL.revokeObjectURL(url)
      toast.success("已导出指令包", {
        description: t("{total} 条指令 · 含 {custom} 条自定义", {
          total: MANUAL_META.commands + custom.length,
          custom: custom.length,
        }),
      })
    } catch {
      toast.error("导出失败", { description: "浏览器不允许下载文件。" })
    }
  }

  function importFile(file: File) {
    const reader = new FileReader()

    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(String(reader.result))
        const list = Array.isArray(parsed)
          ? parsed
          : isRecord(parsed) && Array.isArray(parsed.custom)
            ? parsed.custom
            : null

        if (!list) throw new Error("结构不对")

        const cleaned = list.filter(isCommandRow)
        if (cleaned.length === 0) throw new Error("没有可用条目")

        replaceAll(cleaned)
        toast.success(t("已导入 {count} 条自定义指令", { count: cleaned.length }), {
          description: "原有自定义指令已被替换。",
        })
      } catch {
        toast.error("导入失败", { description: "请选择本页导出的 JSON 文件。" })
      }
    }

    reader.onerror = () => toast.error("读取失败", { description: "文件无法读取。" })
    reader.readAsText(file)
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="指令手册"
        sub={`// GM COMMAND REFERENCE · ${version}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus />
              添加指令
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload />
              导入 JSON
            </Button>
            <Button size="sm" variant="outline" onClick={exportJson}>
              <Download />
              导出 JSON
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) importFile(file)
                e.target.value = ""
              }}
            />
          </div>
        }
      />

      <CommandStats customCount={custom.length} />

      <CommandUsageHint />

      <CommandGenerator />

      <CommandReference rows={rows} onDeleteCustom={remove} />

      <AddCommandDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={add} />
    </div>
  )
}

function isRecord(v: unknown): v is { custom?: unknown } {
  return typeof v === "object" && v !== null
}
