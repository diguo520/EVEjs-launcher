import { useState } from "react"
import { toast } from "sonner"
import { Info, Upload } from "lucide-react"
import type { MarketMod, ModSubmissionDraft } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Modal } from "@/components/ui/dialog"
import { Field, Input, Textarea } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { MOD_CATEGORY_OPTIONS } from "./ModToolbar"
import { cn } from "@/lib/utils"

const CATEGORY_CHOICES = MOD_CATEGORY_OPTIONS.filter((option) => option.value !== "ALL")

interface FormState {
  name: string
  author: string
  version: string
  category: string
  sizeText: string
  desc: string
  readmeText: string
  highlightsText: string
  tagsText: string
  repo: string
  requiresRestart: boolean
  conflicts: string[]
}

const EMPTY: FormState = {
  name: "",
  author: "",
  version: "1.0.0",
  category: "玩法",
  sizeText: "24",
  desc: "",
  readmeText: "",
  highlightsText: "",
  tagsText: "",
  repo: "",
  requiresRestart: true,
  conflicts: [],
}

/** 从本地已有的模组发起上架时，先把已经填过的资料带进表单。 */
export interface SubmitModPrefill {
  name: string
  version: string
  category: string
  sizeMb: number
  desc: string
  conflicts: string[]
}

export interface SubmitModDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 市场现有条目，用来勾选互斥关系。 */
  market: MarketMod[]
  /** 本机作者的署名，预填进表单，省得每次手打。 */
  authorName: string
  /** 预填资料，只在「把本地模组提交上架」时有。 */
  prefill?: SubmitModPrefill
  onSubmit: (draft: ModSubmissionDraft) => void
}

/** 关闭即卸载，重开时表单天然是空的，不需要用 effect 清空。 */
export function SubmitModDialog({
  open,
  onOpenChange,
  market,
  authorName,
  prefill,
  onSubmit,
}: SubmitModDialogProps) {
  if (!open) return null
  return (
    <SubmitModForm
      onOpenChange={onOpenChange}
      market={market}
      authorName={authorName}
      prefill={prefill}
      onSubmit={onSubmit}
    />
  )
}

export function SubmitModForm({
  onOpenChange,
  market,
  authorName,
  prefill,
  onSubmit,
}: Omit<SubmitModDialogProps, "open">) {
  const [form, setForm] = useState<FormState>(() => ({
    ...EMPTY,
    author: authorName,
    ...(prefill
      ? {
          name: prefill.name,
          version: prefill.version,
          category: prefill.category,
          sizeText: String(prefill.sizeMb),
          desc: prefill.desc,
          conflicts: prefill.conflicts,
        }
      : {}),
  }))
  const [error, setError] = useState("")

  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }))

  const toggleConflict = (id: string, checked: boolean) =>
    patch({
      conflicts: checked
        ? [...form.conflicts, id]
        : form.conflicts.filter((item) => item !== id),
    })

  const submit = () => {
    const name = form.name.trim()
    const author = form.author.trim()
    const version = form.version.trim()
    const desc = form.desc.trim()

    if (name === "" || author === "" || version === "" || desc === "") {
      setError("模组名称、作者署名、版本号和一句话简介都要填")
      return
    }

    // 详细介绍按空行分段；没填就退回用一句话简介，详情页不会开天窗。
    const readme = form.readmeText
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part !== "")
    const highlights = form.highlightsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    const tags = form.tagsText
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "")
      .slice(0, 4)

    onSubmit({
      name,
      author,
      version,
      category: form.category,
      sizeMb: Math.max(1, Number(form.sizeText.replace(/[^0-9]/g, "")) || 0),
      desc,
      readme: readme.length > 0 ? readme : [desc],
      highlights,
      tags,
      conflicts: form.conflicts,
      requiresRestart: form.requiresRestart,
      repo: form.repo.trim(),
    })

    toast.success(`「${name}」已提交`, {
      description: "已进入审核队列，通过后自动上架市场",
    })
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,760px)]"
      title="提交模组"
      description="填好资料提交审核，通过后会自动上架到市场目录。"
      footer={
        <>
          {error ? <span className="mr-auto text-xs text-red-300">{error}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit}>
            <Upload className="h-3.5 w-3.5" />
            提交审核
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="模组名称">
            <Input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="例如：星域天气系统"
            />
          </Field>
          <Field label="作者署名">
            <Input
              value={form.author}
              onChange={(e) => patch({ author: e.target.value })}
              placeholder="例如：YourName"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="版本号">
            <Input
              value={form.version}
              onChange={(e) => patch({ version: e.target.value })}
              className="font-mono"
              placeholder="1.0.0"
            />
          </Field>
          <Field label="分类">
            <Select
              value={form.category}
              onValueChange={(v) => patch({ category: v })}
              options={CATEGORY_CHOICES}
            />
          </Field>
          <Field label="体积 (MB)">
            <Input
              value={form.sizeText}
              inputMode="numeric"
              onChange={(e) => patch({ sizeText: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>

        <Field label="一句话简介" hint="列表卡片上显示，控制在 40 字以内最耐看">
          <Input
            value={form.desc}
            onChange={(e) => patch({ desc: e.target.value })}
            placeholder="例如：给每个星系加上会移动的天气带，影响跃迁与锁定"
          />
        </Field>

        <Field label="详细介绍" hint="空行分段，会原样显示在详情页的「模组说明」里">
          <Textarea
            value={form.readmeText}
            onChange={(e) => patch({ readmeText: e.target.value })}
            className="min-h-[96px]"
            placeholder={"第一段：这个模组改了什么，为什么值得装。\n\n第二段：有什么已知限制，或者需要注意的地方。"}
          />
        </Field>

        <Field label="功能要点" hint="一行一条，详情页会逐条列出">
          <Textarea
            value={form.highlightsText}
            onChange={(e) => patch({ highlightsText: e.target.value })}
            className="min-h-[72px]"
            placeholder={"每个星系独立的天气周期\n跃迁速度随天气变化\n可以在配置里关掉"}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="标签" hint="逗号或空格分隔，最多 4 个">
            <Input
              value={form.tagsText}
              onChange={(e) => patch({ tagsText: e.target.value })}
              placeholder="玩法, 环境, 体验"
            />
          </Field>
          <Field label="源码 / 下载地址" hint="选填，只作登记用，不会真的去拉取">
            <Input
              value={form.repo}
              onChange={(e) => patch({ repo: e.target.value })}
              className="font-mono"
              placeholder="https://…"
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            互斥模组
          </span>
          <p className="text-xs text-muted-foreground/70">
            勾选与之不能同时启用的模组，安装时会提前提醒玩家。
          </p>
          <div className="hud-scroll max-h-36 overflow-y-auto rounded-sm border border-border bg-background/40 p-2">
            <div className="flex flex-col gap-1.5">
              {market.map((entry) => (
                <label
                  key={entry.id}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-sm px-1.5 py-1 transition-colors",
                    "hover:bg-secondary/50",
                  )}
                >
                  <Checkbox
                    checked={form.conflicts.includes(entry.id)}
                    onCheckedChange={(checked) => toggleConflict(entry.id, checked)}
                    aria-label={`与 ${entry.name} 互斥`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {entry.name}
                  </span>
                  <Badge tone="outline" className="shrink-0 px-1 py-0 text-[10px]">
                    {entry.category}
                  </Badge>
                </label>
              ))}
            </div>
          </div>
          {form.conflicts.length > 0 ? (
            <span className="font-mono text-[10px] text-amber-300">
              已勾选 {form.conflicts.length} 个互斥模组
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-foreground">需要重启服务端才生效</p>
            <p className="text-[11px] text-muted-foreground/70">
              纯客户端资源（贴图、天空盒之类）可以关掉
            </p>
          </div>
          <Switch
            checked={form.requiresRestart}
            onCheckedChange={(checked) => patch({ requiresRestart: checked })}
          />
        </div>

        <p className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/8 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            提交只写入本地市场索引，不会上传到任何外部服务。审核通过后条目会出现在市场目录里，
            你可以像其他模组一样安装、更新和卸载；审核期间可以随时撤回。
          </span>
        </p>
      </div>
    </Modal>
  )
}
