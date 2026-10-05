import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useLocale } from "@/components/shell/locale-provider"

/**
 * 物品简介弹窗。
 *
 * 简介原本在「简介 / 属性」页签的顶上，占掉半屏；现在挪到右栏标题栏那个书页图标上，
 * 点开才看，正文也就有了整块地方放长文（多数舰船简介都是三四段）。
 *
 * 正文是 SDE 数据（侧车已按界面语言取好），必须标 `data-i18n-skip` —— 不标的话
 * 翻译桥会拿整段简介去查目录，虽然查不到不会改，但每段都要白查一遍。
 */
export function DescriptionDialog({
  typeName,
  text,
  onClose,
}: {
  /** 物品名（正行语言），放在标题下面告诉用户这是谁的简介 */
  typeName: string
  /** 简介正文，可能带换行 */
  text: string
  onClose: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("物品简介")}</DialogTitle>
          <DialogDescription data-i18n-skip className="truncate">
            {typeName}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-input bg-background/40 px-3 py-2">
          <p
            data-i18n-skip
            className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90"
          >
            {text}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
