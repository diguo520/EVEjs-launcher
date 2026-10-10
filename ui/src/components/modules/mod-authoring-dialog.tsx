import { useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ExternalLink, FileWarning, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { callOr, hasIpc, type RawAck, type RawAuthoringDoc } from "@/lib/ipc"
import { getActiveLocale } from "@/lib/i18n"

/** 内置规范文档的语言：中文母版 + 七种翻译，内容逐行对齐 */
const DOC_LANGS = ["zh", "en", "ja", "ko", "fr", "de", "ru", "es"] as const

type DocLang = (typeof DOC_LANGS)[number]

/** 语言名按各自母语显示，跟设置里的界面语言同一口径，不翻译 */
const DOC_TABS: { id: DocLang; label: string }[] = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "ru", label: "Русский" },
  { id: "es", label: "Español" },
]

/**
 * 打开时默认看当前界面语言那一份（界面语言不在文档语言里，比如荷兰语，就退回英文），
 * 省掉每次手动切一次的动作。
 */
function initialDocLang(): DocLang {
  const active = getActiveLocale()
  return (DOC_LANGS as readonly string[]).includes(active) ? (active as DocLang) : "en"
}

/**
 * 「模组制作规范」弹窗：在启动器里直接渲染 Markdown，中英可切换。
 * 正文来自后端 mods:authoringDocText（与 _launcher/mods/MOD_AUTHORING*.md 同源），
 * 纯浏览器预览拿不到后端时只说清楚原因，不编造文档内容。
 * 表格与行内代码靠 remark-gfm 支撑，版式由 .md-body 提供（见 index.css）。
 */
export function ModAuthoringDialog({
  open,
  onOpenChange,
  onOpenExternal,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 「用系统程序打开」：走 mods:openAuthoringDoc，把盘上的 md 交给默认编辑器 */
  onOpenExternal: () => Promise<RawAck>
}) {
  const [lang, setLang] = useState<DocLang>(initialDocLang)
  const [texts, setTexts] = useState<Partial<Record<DocLang, string>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 打开时按需取文，取到就缓存：来回切语言不重复要
  useEffect(() => {
    if (!open || texts[lang] !== undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void callOr<RawAuthoringDoc>("modsAuthoringDocText", null, lang).then((reply) => {
      if (cancelled) return
      setLoading(false)
      if (reply?.ok && reply.text) {
        setTexts((prev) => ({ ...prev, [lang]: reply.text }))
        return
      }
      setError(
        hasIpc()
          ? "读取内置规范文档失败，稍后再试。"
          : "当前不在启动器环境里，看不到内置规范文档；打包好的启动器里可以正常阅读。"
      )
    })
    return () => {
      cancelled = true
    }
  }, [open, lang, texts])

  const text = texts[lang]

  async function openExternal() {
    const reply = await onOpenExternal()
    if (!reply.ok) {
      toast.error("打不开规范文档", {
        description: reply.reason ?? "系统拒绝了这次打开",
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2">
            <span className="tabular text-[10px] font-semibold tracking-[0.18em] text-primary/85">
              // MOD AUTHORING
            </span>
            <span>模组制作规范</span>
          </DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            从零到一个能上架市场的模组，全程不用改服务端文件。八种语言内容一致，按需切换。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={lang} onValueChange={(next) => setLang(next as DocLang)}>
            <TabsList>
              {DOC_TABS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="min-w-2 flex-1" />
          <Button variant="outline" size="sm" onClick={() => void openExternal()}>
            <ExternalLink />
            用系统程序打开
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-background/40">
          <div className="md-body px-4 py-3">
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" />
                正在读取规范文档…
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 py-6 text-[12px] text-warning">
                <FileWarning className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : text ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            ) : null}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
