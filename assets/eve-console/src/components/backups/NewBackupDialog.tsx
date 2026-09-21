import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Modal } from "@/components/ui/dialog"
import { Field, Input, Textarea } from "@/components/ui/input"

export interface NewBackupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (label: string, note: string) => void
}

/** 关闭即卸载，重开时表单天然是空的，不需要用 effect 清空。 */
export function NewBackupDialog({ open, onOpenChange, onCreate }: NewBackupDialogProps) {
  if (!open) return null
  return <NewBackupForm onOpenChange={onOpenChange} onCreate={onCreate} />
}

function NewBackupForm({
  onOpenChange,
  onCreate,
}: Omit<NewBackupDialogProps, "open">) {
  const [labelText, setLabelText] = useState<string>("")
  const [noteText, setNoteText] = useState<string>("")
  const [errorText, setErrorText] = useState<string>("")

  const submit = () => {
    const label = labelText.trim()
    if (label === "") {
      setErrorText("快照名称不能为空")
      return
    }
    onCreate(label, noteText.trim())
    toast.success(`快照「${label}」已创建`, { description: "已写入存档目录，可随时回滚" })
    onOpenChange(false)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="新建快照"
      description="立即把当前世界状态打包成一份手动快照。"
      footer={
        <>
          {errorText ? <span className="mr-auto text-xs text-red-300">{errorText}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit}>
            创建快照
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="快照名称" hint="时间线里显示的标题，建议写清版本或事件">
          <Input
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder="例如：堡垒更新前 / 大战前夜"
          />
        </Field>

        <Field label="备注" hint="选填，只给管理员看">
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="例如：本次调整了市场税率与星域规模，出问题回滚到这里"
          />
        </Field>

        <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          类型固定为 <span className="text-primary">手动</span>
          ；自动与启动前快照由服务端在存档周期和冷启动前自行写入。
        </p>
      </div>
    </Modal>
  )
}
