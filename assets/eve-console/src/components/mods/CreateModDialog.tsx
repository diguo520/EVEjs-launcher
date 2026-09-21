import { useState } from "react"
import { toast } from "sonner"
import { Check, FolderTree, Info, PackagePlus } from "lucide-react"
import type { MarketMod, ModDraft } from "@/lib/types"
import { MOD_TEMPLATES, slugifyModId } from "@/lib/modTemplate"
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
const FALLBACK = MOD_TEMPLATES[0]

interface FormState {
  templateId: string
  name: string
  author: string
  version: string
  category: string
  sizeText: string
  desc: string
  tagsText: string
  highlightsText: string
  readmeText: string
  repo: string
  requiresRestart: boolean
  conflicts: string[]
  enabled: boolean
  publish: boolean
}

const EMPTY: FormState = {
  templateId: FALLBACK.id,
  name: "",
  author: "",
  version: "1.0.0",
  category: FALLBACK.category,
  sizeText: String(FALLBACK.sizeMb),
  desc: "",
  tagsText: "",
  highlightsText: FALLBACK.highlights.join("\n"),
  readmeText: FALLBACK.readme,
  repo: "",
  requiresRestart: FALLBACK.requiresRestart,
  conflicts: [],
  enabled: false,
  publish: false,
}

export interface CreateModDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 市场现有条目，用来勾选互斥关系。 */
  market: MarketMod[]
  /** 本机作者的署名，预填进表单，省得每次手打。 */
  authorName: string
  onCreate: (draft: ModDraft) => void
}

/** 关闭即卸载，重开时表单天然是空的，不需要用 effect 清空。 */
export function CreateModDialog({
  open,
  onOpenChange,
  market,
  authorName,
  onCreate,
}: CreateModDialogProps) {
  if (!open) return null
  return (
    <CreateModForm
      onOpenChange={onOpenChange}
      market={market}
      authorName={authorName}
      onCreate={onCreate}
    />
  )
}

export function CreateModForm({
  onOpenChange,
  market,
  authorName,
  onCreate,
}: Omit<CreateModDialogProps, "open">) {
  const [form, setForm] = useState<FormState>(() => ({ ...EMPTY, author: authorName }))
  const [error, setError] = useState("")

  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }))

  const toggleConflict = (id: string, checked: boolean) =>
    patch({
      conflicts: checked
        ? [...form.conflicts, id]
        : form.conflicts.filter((item) => item !== id),
    })

  /* 换模板会重置分类、体积与重启要求 —— 这三项本来就是模板的一部分。
     用户已经动过手的要点和介绍则保留，别把写好的东西冲掉。 */
  const applyTemplate = (nextId: string) =>
    setForm((prev) => {
      const next = MOD_TEMPLATES.find((item) => item.id === nextId)
      if (!next) return prev
      const current = MOD_TEMPLATES.find((item) => item.id === prev.templateId)
      const highlightsUntouched =
        prev.highlightsText.trim() === "" || prev.highlightsText === current?.highlights.join("\n")
      return {
        ...prev,
        templateId: next.id,
        category: next.category,
        sizeText: String(next.sizeMb),
        requiresRestart: next.requiresRestart,
        highlightsText: highlightsUntouched ? next.highlights.join("\n") : prev.highlightsText,
        readmeText: prev.readmeText.trim() === "" ? next.readme : prev.readmeText,
      }
    })

  const template = MOD_TEMPLATES.find((item) => item.id === form.templateId) ?? FALLBACK
  const slug = slugifyModId(form.name)
  const previewId = slug === "" ? "mod-xxxxxx" : `mod-${slug}`

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

    onCreate({
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
      enabled: form.enabled,
      publish: form.publish,
    })

    toast.success(`「${name}」已创建`, {
      description: form.publish
        ? "已写入本地清单，并提交市场审核"
        : "已写入本地清单，去「已安装」里看看",
    })
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,760px)]"
      title="创建模组"
      description="挑一个骨架模板，填好基本信息，建出来直接进本地模组清单。"
      footer={
        <>
          {error ? <span className="mr-auto text-xs text-red-300">{error}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit}>
            <PackagePlus className="h-3.5 w-3.5" />
            创建模组
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            从模板开始
          </span>
          <div className="grid gap-2 sm:grid-cols-2">
            {MOD_TEMPLATES.map((item) => {
              const active = item.id === form.templateId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => applyTemplate(item.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-border bg-background/40 hover:border-primary/30",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "text-xs font-semibold",
                        active ? "text-primary" : "text-foreground",
                      )}
                    >
                      {item.name}
                    </span>
                    {active ? <Check className="h-3 w-3 text-primary" /> : null}
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/60">
                      {item.sizeMb} MB
                    </span>
                  </span>
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {item.desc}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

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

        <Field label="标签" hint="逗号或空格分隔，最多 4 个">
          <Input
            value={form.tagsText}
            onChange={(e) => patch({ tagsText: e.target.value })}
            placeholder="玩法, 环境, 体验"
          />
        </Field>

        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FolderTree className="h-3.5 w-3.5 text-primary" />
            <span className="hud-label text-[10px] text-muted-foreground/70">将生成</span>
            <span className="ml-auto font-mono text-[10px] text-primary">{previewId}</span>
          </div>
          <div className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            <div className="text-foreground/80">mods/{previewId}/</div>
            {template.files.map((file, index) => (
              <div key={file} className="pl-1">
                <span className="text-muted-foreground/40">
                  {index === template.files.length - 1 ? "└─" : "├─"}
                </span>
                {` ${file}`}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-foreground">创建后立即启用</p>
            <p className="text-[11px] text-muted-foreground/70">启用后下次启动服务端时加载</p>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-foreground">同时提交到市场审核</p>
            <p className="text-[11px] text-muted-foreground/70">
              打开后要补一份上架资料，通过审核即自动上架
            </p>
          </div>
          <Switch checked={form.publish} onCheckedChange={(v) => patch({ publish: v })} />
        </div>

        {form.publish ? (
          <div className="flex flex-col gap-4 rounded-md border border-primary/30 bg-primary/8 p-3">
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
              上架资料
            </span>

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

            <Field label="源码 / 下载地址" hint="选填，只作登记用，不会真的去拉取">
              <Input
                value={form.repo}
                onChange={(e) => patch({ repo: e.target.value })}
                className="font-mono"
                placeholder="https://…"
              />
            </Field>

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
                      className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-1.5 py-1 transition-colors hover:bg-secondary/50"
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
          </div>
        ) : null}

        <p className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            创建只写入本地模组清单，不会上传到任何外部服务。建好后可以在「已安装」里调整加载顺序、
            随时停用或卸载；勾了同时提交的话，还能在市场里跟踪它的审核进度。
          </span>
        </p>
      </div>
    </Modal>
  )
}
