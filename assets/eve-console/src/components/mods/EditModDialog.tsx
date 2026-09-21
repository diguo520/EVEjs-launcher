import { useState } from "react"
import { toast } from "sonner"
import { Info, Pencil } from "lucide-react"
import type { MarketMod, ModSubmissionDraft } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Field, Input, Textarea } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { MOD_CATEGORY_OPTIONS } from "./ModToolbar"

const CATEGORY_CHOICES = MOD_CATEGORY_OPTIONS.filter((option) => option.value !== "ALL")

interface FormState {
  version: string
  changelog: string
  desc: string
  readmeText: string
  highlightsText: string
  tagsText: string
  repo: string
  category: string
  requiresRestart: boolean
}

/** 拿当前上架的内容把表单填满：改资料是「在原文上改」，不该让人从空白重写一遍。 */
function formFrom(entry: MarketMod): FormState {
  return {
    version: entry.version,
    changelog: entry.changelog ?? "",
    desc: entry.desc,
    readmeText: entry.readme.join("\n\n"),
    highlightsText: entry.highlights.join("\n"),
    tagsText: entry.tags.join(", "),
    repo: entry.repo ?? "",
    category: entry.category,
    requiresRestart: entry.requiresRestart,
  }
}

export interface EditModDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 要改的那条市场条目，必须是本机作者自己发的。 */
  entry: MarketMod | null
  onSubmit: (id: string, draft: ModSubmissionDraft) => void
}

/** 关闭即卸载，重开时表单重新按当前内容填一遍。 */
export function EditModDialog({ open, onOpenChange, entry, onSubmit }: EditModDialogProps) {
  if (!open || !entry) return null
  return <EditModForm entry={entry} onOpenChange={onOpenChange} onSubmit={onSubmit} />
}

export function EditModForm({
  entry,
  onOpenChange,
  onSubmit,
}: Omit<EditModDialogProps, "open"> & { entry: MarketMod }) {
  const [form, setForm] = useState<FormState>(() => formFrom(entry))
  const [error, setError] = useState("")

  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }))

  const versionChanged = form.version.trim() !== entry.version
  /* 老条目没有历史字段，就把当前这一版当作唯一发过的一版。 */
  const shipped = entry.history ?? [
    { version: entry.version, changelog: entry.changelog ?? "", at: entry.updatedAt },
  ]

  const submit = () => {
    const version = form.version.trim()
    const desc = form.desc.trim()

    if (version === "" || desc === "") {
      setError("版本号和一句话简介都要填")
      return
    }

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

    onSubmit(entry.id, {
      // 名称、作者、体积、互斥关系不在这里改：那些跟着条目本身走。
      name: entry.name,
      author: entry.author,
      version,
      category: form.category,
      sizeMb: entry.sizeMb,
      desc,
      readme: readme.length > 0 ? readme : [desc],
      highlights,
      tags,
      conflicts: entry.conflicts,
      requiresRestart: form.requiresRestart,
      repo: form.repo.trim(),
      changelog: form.changelog.trim(),
    })

    toast.success(`「${entry.name}」的更新已提交`, {
      description: versionChanged
        ? `版本 ${entry.version} → ${version}，通过审核后市场目录换成新版`
        : "资料改动已进审核队列，通过后市场目录同步",
    })
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,760px)]"
      title="更新模组资料"
      description={`改的是「${entry.name}」在市场上的展示内容，改完重新走一遍审核。`}
      footer={
        <>
          {error ? <span className="mr-auto text-xs text-red-300">{error}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit}>
            <Pencil className="h-3.5 w-3.5" />
            提交更新
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="版本号"
            hint={versionChanged ? `${entry.version} → ${form.version.trim()}` : "没发新版就不用动它"}
          >
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
          <Field label="源码 / 下载地址" hint="选填，只作登记用">
            <Input
              value={form.repo}
              onChange={(e) => patch({ repo: e.target.value })}
              className="font-mono"
              placeholder="https://…"
            />
          </Field>
        </div>

        <Field
          label="本次更新"
          hint="一句话说清这次改了什么；会记进详情页的版本记录"
        >
          <Input
            value={form.changelog}
            onChange={(e) => patch({ changelog: e.target.value })}
            placeholder="例如：修了天气带在低安星系越界的问题，顺手把跃迁速度改成可配置"
          />
        </Field>

        {/* 把已经发过的版本摆出来，写新说明时心里有数，也免得版本号写重。 */}
        {shipped.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/40 px-3 py-2">
            <span className="hud-label text-[10px] text-muted-foreground/70">
              已发布 {shipped.length} 版
            </span>
            <ul className="hud-scroll flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
              {[...shipped].reverse().map((item) => (
                <li key={`${item.version}-${item.at}`} className="flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {item.version}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {item.changelog || "首个版本"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Field label="一句话简介" hint="列表卡片上显示，控制在 40 字以内最耐看">
          <Input value={form.desc} onChange={(e) => patch({ desc: e.target.value })} />
        </Field>

        <Field label="详细介绍" hint="空行分段，会原样显示在详情页的「模组说明」里">
          <Textarea
            value={form.readmeText}
            onChange={(e) => patch({ readmeText: e.target.value })}
            className="min-h-[96px]"
          />
        </Field>

        <Field label="功能要点" hint="一行一条，详情页会逐条列出">
          <Textarea
            value={form.highlightsText}
            onChange={(e) => patch({ highlightsText: e.target.value })}
            className="min-h-[72px]"
          />
        </Field>

        <Field label="标签" hint="逗号或空格分隔，最多 4 个">
          <Input
            value={form.tagsText}
            onChange={(e) => patch({ tagsText: e.target.value })}
            placeholder="玩法, 环境, 体验"
          />
        </Field>

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

        <p className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            提交后条目会进入审核队列，期间市场里显示的还是旧内容，可以随时撤回。通过审核后就地换成新版，
            已经装了旧版的人会在市场里看到「可更新」——下载量和评分不会因为这次更新清零。
          </span>
        </p>
      </div>
    </Modal>
  )
}
