import { useState, type FormEvent } from "react"
import { toast } from "sonner"

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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CATEGORY_NAMES } from "@/lib/manual-data"
import {
  REQUIRES_ORDER,
  requiresShort,
  type CommandRow,
} from "@/lib/manual-logic"

interface Draft {
  cmd: string
  alias: string
  cat: string
  desc: string
  params: string
  example: string
  requires: string
  note: string
}

const EMPTY: Draft = {
  cmd: "/",
  alias: "",
  cat: CATEGORY_NAMES[0] ?? "其他指令",
  desc: "",
  params: "",
  example: "",
  requires: "无",
  note: "",
}

/** 添加自定义指令：分类可以直接写新的，写进去就成为一个新分类 */
export function AddCommandDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (row: CommandRow) => boolean
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY)

  function patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function reset() {
    setDraft(EMPTY)
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const cmd = draft.cmd.trim()

    if (!cmd.startsWith("/") || cmd.length < 2) {
      toast.error("指令名不合法", { description: "指令名需以 / 开头，例如 /myspawn" })
      return
    }
    if (!draft.desc.trim()) {
      toast.error("请填写说明", { description: "说明会显示在指令列表里。" })
      return
    }

    const accepted = onSubmit({
      cmd,
      alias: draft.alias.trim(),
      cat: draft.cat.trim() || "其他指令",
      desc: draft.desc.trim(),
      params: draft.params.trim() || "无",
      example: draft.example.trim() || cmd,
      requires: draft.requires,
      typeID: "",
      note: draft.note.trim(),
      custom: true,
    })

    if (!accepted) {
      toast.error("该指令已存在", { description: `${cmd} 已在手册里，换个名字再试。` })
      return
    }

    toast.success(`已添加 ${cmd}`, { description: `归类到「${draft.cat.trim()}」` })
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>添加指令</DialogTitle>
          <DialogDescription>
            自定义指令只存在本机，会标上「自定义」角标，可随时删除。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ac-cmd">
                指令名 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ac-cmd"
                value={draft.cmd}
                onChange={(e) => patch("cmd", e.target.value)}
                placeholder="/myspawn"
                autoComplete="off"
                spellCheck={false}
                className="tabular"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ac-alias">别名</Label>
              <Input
                id="ac-alias"
                value={draft.alias}
                onChange={(e) => patch("alias", e.target.value)}
                placeholder="可选，逗号分隔"
                autoComplete="off"
                spellCheck={false}
                className="tabular"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ac-cat">分类</Label>
              <Input
                id="ac-cat"
                list="ac-cat-options"
                value={draft.cat}
                onChange={(e) => patch("cat", e.target.value)}
                placeholder="可选已有分类或直接写新的"
                autoComplete="off"
              />
              <datalist id="ac-cat-options">
                {CATEGORY_NAMES.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ac-requires">使用条件</Label>
              <Select
                value={draft.requires}
                onValueChange={(v) => patch("requires", v)}
              >
                <SelectTrigger id="ac-requires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUIRES_ORDER.map((level) => (
                    <SelectItem key={level} value={level}>
                      {requiresShort(level)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ac-desc">
              说明 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ac-desc"
              value={draft.desc}
              onChange={(e) => patch("desc", e.target.value)}
              placeholder="一句话说明这条指令做什么"
              autoComplete="off"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ac-params">参数</Label>
              <Input
                id="ac-params"
                value={draft.params}
                onChange={(e) => patch("params", e.target.value)}
                placeholder="<amount> [target]"
                autoComplete="off"
                spellCheck={false}
                className="tabular"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ac-example">示例</Label>
              <Input
                id="ac-example"
                value={draft.example}
                onChange={(e) => patch("example", e.target.value)}
                placeholder="/myspawn 3"
                autoComplete="off"
                spellCheck={false}
                className="tabular"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ac-note">备注</Label>
            <Textarea
              id="ac-note"
              value={draft.note}
              onChange={(e) => patch("note", e.target.value)}
              placeholder="可选 · 使用限制、注意事项"
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
            <Button type="submit">添加指令</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
