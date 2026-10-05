import { useMemo, useState, type FormEvent } from "react"
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
import { useLocale } from "@/components/shell/locale-provider"
import type {
  RawMarketAttrsInput,
  RawMarketSetAttrs,
  RawMarketTypeInfo,
} from "@/lib/ipc"
import { attributeSections, DERIVED_ATTR_IDS, formatAttrValue } from "@/lib/type-info-logic"
import { cn } from "@/lib/utils"

/**
 * 改一个物品的 dogma 属性（舰船 / 装备 / 弹药…）的弹窗。
 *
 * 输入框里是 dogma 的**原始值**（不是属性面板上格式化过的显示值）：unitID=101 的
 * 「回充时间」面板上写 `10分15秒`，这里要填的就是 615000；108 的抗性面板上写 `50%`，
 * 这里填 0.5。所以每行右侧同时给出当前显示值，避免用户照着显示值填。
 *
 * 只提交**改动过**的行，值没变的行不进请求体 —— 服务端那边也以「值真的不同」为准决定
 * 要不要写盘（changed=0 时一个字节都不动）。
 *
 * 保存后怎么生效由后端说了算，界面只如实转述（armed / needsRestart），不替它打包票：
 * 舰船属性是直读静态表、离舰再登舰就生效；装备属性在服务端有进程级缓存，多数要重启。
 *
 * **质量 / 容量 / 体积不在这个弹窗里**：它们不在 typeDogma 里，是侧车从类型字段补进
 * 属性列表的（见 `DERIVED_ATTR_IDS`），改不动，列出来只会让人白填一遍。
 */
export function AttributeEditDialog({
  typeId,
  typeName,
  info,
  onClose,
  onSubmit,
}: {
  typeId: number
  typeName: string
  info: RawMarketTypeInfo
  onClose: () => void
  onSubmit: (input: RawMarketAttrsInput) => Promise<RawMarketSetAttrs | null>
}) {
  const { t } = useLocale()
  const sections = useMemo(
    () =>
      attributeSections(info.attributes, info.categories)
        .map((section) => ({
          ...section,
          rows: section.rows.filter((attr) => !DERIVED_ATTR_IDS.has(attr.id)),
        }))
        .filter((section) => section.rows.length > 0),
    [info]
  )
  const totalRows = useMemo(
    () => sections.reduce((sum, section) => sum + section.rows.length, 0),
    [sections]
  )
  // 只存改过的行：没碰过的行不占状态，保存时也只有它们进请求体
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)

  const edits = useMemo(() => {
    const out: { id: number; value: number }[] = []
    for (const section of sections) {
      for (const attr of section.rows) {
        const raw = draft[attr.id]
        if (raw === undefined) continue
        const value = Number(raw)
        if (!Number.isFinite(value) || value === attr.value) continue
        out.push({ id: attr.id, value })
      }
    }
    return out
  }, [sections, draft])

  // 空串与不是数字的草稿都拦下来：宁可让用户改回来，也不要把 NaN 交给写盘路径
  const invalid = useMemo(() => {
    const out = new Set<number>()
    for (const section of sections) {
      for (const attr of section.rows) {
        const raw = draft[attr.id]
        if (raw === undefined) continue
        if (raw.trim() === "" || !Number.isFinite(Number(raw))) out.add(attr.id)
      }
    }
    return out
  }, [sections, draft])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    if (invalid.size > 0) {
      toast.error(t("没法保存"), { description: t("属性值要填数字，不能留空。") })
      return
    }
    if (edits.length === 0) {
      toast.info(t("没有改动"))
      return
    }

    setSaving(true)
    const reply = await onSubmit({ typeId, attributes: edits })
    setSaving(false)

    if (!reply || reply.ok !== true) {
      // reason 是后端原话（侧车的英文/中文报错，或「连不上」这类）；过一遍 t() 让目录里
      // 有的那几条跟着语言走，目录里没有的原样显示
      const reason = reply?.reason?.trim()
      toast.error(t("修改失败"), {
        description: reason ? t(reason) : t("写入失败，稍后再试。"),
      })
      return
    }
    if ((reply.changed ?? 0) === 0) {
      toast.info(t("没有改动"))
      onClose()
      return
    }

    if (reply.armed === false) {
      toast.success(t("属性已写入"), {
        description: t("主服务器不是本启动器启动的（或没在运行）：改动已落盘，下次启动生效。"),
      })
    } else if (reply.needsRestart) {
      toast.success(t("属性已热重载"), {
        description: t("改的是装备 / 物品属性：重启主服务器后生效。"),
      })
    } else {
      toast.success(t("属性已热重载"), {
        description: t("改的是舰船属性：离舰再登舰就能看到新值，不用重启。"),
      })
    }
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>修改属性</DialogTitle>
          <DialogDescription>
            改的是服务端静态表里的 dogma 原始值（不是面板上格式化后的显示值）。舰船属性保存后离舰再登舰即可看到；装备 / 物品属性大多要重启主服务器。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-input bg-background/40 px-3 py-2">
          <div data-i18n-skip className="truncate text-[12px] text-foreground">
            {typeName}
          </div>
          <div data-i18n-skip className="truncate text-[11px] text-tertiary">
            {typeId} · {t("共 {count} 项", { count: totalRows })}
            {edits.length > 0 ? ` · ${t("已改 {count} 项", { count: edits.length })}` : ""}
          </div>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
          <div className="max-h-[52vh] min-h-0 space-y-2 overflow-y-auto pr-1">
            {sections.map((section) => (
              <div
                key={section.id}
                className="overflow-hidden rounded-md border border-input bg-background/40"
              >
                <div className="border-b border-input/60 bg-muted/20 px-2 py-1 text-[11px] font-semibold text-primary">
                  {section.title}
                </div>
                <div className="divide-y divide-input/30">
                  {section.rows.map((attr) => {
                    const raw = draft[attr.id]
                    return (
                      <div key={attr.id} className="flex items-center gap-2 px-2 py-1">
                        <span
                          data-i18n-skip
                          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                          title={attr.name}
                        >
                          {attr.name}
                        </span>
                        <span
                          data-i18n-skip
                          className="tabular w-24 shrink-0 truncate text-right text-[10px] text-tertiary"
                          title={formatAttrValue(attr)}
                        >
                          {formatAttrValue(attr)}
                        </span>
                        <Input
                          value={raw ?? String(attr.value)}
                          onChange={(event) =>
                            setDraft((prev) => ({ ...prev, [attr.id]: event.target.value }))
                          }
                          inputMode="decimal"
                          autoComplete="off"
                          spellCheck={false}
                          className={cn(
                            "tabular h-7 w-32 shrink-0 text-right text-[11px]",
                            invalid.has(attr.id) ? "border-destructive" : ""
                          )}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            {/* 不因为「有非法输入」把按钮禁用掉：禁用只会让人不知道为什么点不动，
                交给提交时的 toast 说清哪一条要填数字 */}
            <Button type="submit" disabled={saving}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
