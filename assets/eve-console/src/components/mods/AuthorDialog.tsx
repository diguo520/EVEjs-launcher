import { useState } from "react"
import { toast } from "sonner"
import { Check, Copy, Info } from "lucide-react"
import { useEngine } from "@/lib/engine"
import { isValidAuthorId } from "@/lib/author"
import { formatDateTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Field, Input } from "@/components/ui/input"

export interface AuthorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 关闭即卸载，重开时输入框回到当前的署名。 */
export function AuthorDialog({ open, onOpenChange }: AuthorDialogProps) {
  if (!open) return null
  return <AuthorPanel onOpenChange={onOpenChange} />
}

export function AuthorPanel({ onOpenChange }: Omit<AuthorDialogProps, "open">) {
  const { author, updateAuthor, adoptAuthor, market, submissions } = useEngine()
  const [name, setName] = useState(author.name)
  const [copied, setCopied] = useState(false)
  const [adoptText, setAdoptText] = useState("")
  /* 认回是两步：先点一下把后果摊开，再点一下才真的换。 */
  const [armed, setArmed] = useState(false)

  const published = market.filter((entry) => entry.authorId === author.id).length
  const reviewing = submissions.filter(
    (item) => item.authorId === author.id && item.status !== "published",
  ).length

  const trimmed = name.trim()
  const changed = trimmed !== "" && trimmed !== author.name

  const save = () => {
    if (!changed) {
      onOpenChange(false)
      return
    }
    updateAuthor({ name: trimmed })
    toast.success(`署名已改为「${trimmed}」`, {
      description: published + reviewing > 0 ? "名下模组的署名一并更新" : undefined,
    })
    onOpenChange(false)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(author.id)
      setCopied(true)
      toast.success("作者标识已复制")
    } catch {
      toast.error("复制没成功，可以手动选中复制")
    }
  }

  const candidate = adoptText.trim().toLowerCase()
  const looksLikeId = isValidAuthorId(candidate)
  const isCurrent = candidate !== "" && candidate === author.id
  const canAdopt = looksLikeId && !isCurrent

  const adopt = () => {
    if (!canAdopt) return
    if (!armed) {
      setArmed(true)
      return
    }
    adoptAuthor(candidate)
    setArmed(false)
    setAdoptText("")
    toast.success("已认回这个身份", { description: "之后创建和提交的模组都记在这个名下" })
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="w-[min(94vw,560px)]"
      title="作者身份"
      description="控制台靠这串标识认出哪些模组是你发的，跟署名写成什么无关。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={!changed}>
            保存署名
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="署名" hint="显示在模组卡片和详情页上；改名会同步刷到名下所有模组">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：DeepSpaceWorks"
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            作者标识
          </span>
          <div className="flex items-center gap-2">
            <Input readOnly value={author.id} className="font-mono text-[11px]" />
            <Button variant="outline" size="md" onClick={copy} className="shrink-0">
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-background/40 px-2.5 py-1.5">
            <span className="hud-label text-[10px] text-muted-foreground/60">已上架</span>
            <span className="font-mono text-xs tabular-nums text-foreground">{published} 个</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-background/40 px-2.5 py-1.5">
            <span className="hud-label text-[10px] text-muted-foreground/60">审核中</span>
            <span className="font-mono text-xs tabular-nums text-foreground">{reviewing} 个</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-background/40 px-2.5 py-1.5">
            <span className="hud-label text-[10px] text-muted-foreground/60">启用时间</span>
            <span className="truncate font-mono text-[11px] tabular-nums text-foreground">
              {formatDateTime(author.since)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <span className="hud-label text-[10px] text-muted-foreground/70">认回旧身份</span>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            换了机器，或者清了浏览器数据，把之前复制过的标识粘回来，就能接上原来的身份 ——
            之后发的模组还记在同一个名下。
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={adoptText}
              onChange={(e) => {
                setAdoptText(e.target.value)
                setArmed(false)
              }}
              placeholder="au-xxxxxxxxxxxx"
              className="font-mono text-[11px]"
            />
            <Button
              variant={armed ? "danger" : "outline"}
              size="md"
              disabled={!canAdopt}
              onClick={adopt}
              className="shrink-0"
            >
              {armed ? "确认认回" : "认回"}
            </Button>
          </div>
          {adoptText.trim() !== "" && !looksLikeId ? (
            <span className="text-[11px] text-red-300">
              这不像一串作者标识，格式是 au- 开头的一小段字符
            </span>
          ) : isCurrent ? (
            <span className="text-[11px] text-muted-foreground/70">这就是你现在用的标识</span>
          ) : null}
          {armed ? (
            <p className="text-[11px] leading-relaxed text-amber-300">
              认回之后，这台机器上按现在这个标识创建的内容就不再算你名下了 ——
              它们还挂在市场里，只是你改不了资料也下架不了。想留着，先把上面的标识复制走。
            </p>
          ) : null}
        </div>

        <p className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            署名只是个文本，谁都能填成别人的名字，所以认人不看它。你创建和提交的模组都会盖上这串标识，
            市场里带「我的」角标的条目就是自己的，打开就能改资料、提版本、下架。
          </span>
        </p>
      </div>
    </Modal>
  )
}
