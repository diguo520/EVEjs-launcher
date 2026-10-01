import { useMemo, useState } from "react"
import { toast } from "sonner"

import { cn, copyText } from "@/lib/utils"
import { t } from "@/lib/i18n"
import { useLocale } from "@/components/shell/locale-provider"
import { Panel } from "@/components/common/panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useManualData } from "@/hooks/use-manual-data"
import {
  ITEM_PLACEHOLDER,
  buildItemCommand,
  buildNpcCommand,
  buildShipCommand,
  resolveItemTarget,
} from "@/lib/manual-logic"
import {
  NumberStepper,
  PreviewBar,
} from "@/components/commands/command-shared"

type GenKind = "item" | "ship" | "npc"

const KINDS: { value: GenKind; label: string; desc: string }[] = [
  { value: "item", label: "/item", desc: "向机库添加物品，需停泊" },
  { value: "ship", label: "/ship", desc: "生成船体，需停泊" },
  { value: "npc", label: "/npc", desc: "生成 NPC，需太空" },
]

const PLACEHOLDER: Record<GenKind, string> = {
  item: "输入物品中文名 / 英文名 / typeID",
  ship: "输入舰船名 / typeID，例如 Raven",
  npc: "输入档案键 / typeID，例如 generic_hostile",
}

const SUGGEST_LIMIT = 8

/** 指令生成器：选指令、挑目标、拼出可直接粘贴的命令行 */
export function CommandGenerator() {
  const { locale } = useLocale()
  const [kind, setKind] = useState<GenKind>("item")
  const [target, setTarget] = useState("")
  const [qty, setQty] = useState(100)
  const [focused, setFocused] = useState(false)

  // 联想表等用户真的开始输入再拉，一进页面不碰大表；两张表各自独立 gate
  const wantsSuggest = focused && kind !== "ship"
  const items = useManualData("items", wantsSuggest && kind === "item")
  const npcs = useManualData("npcs", wantsSuggest && kind === "npc")
  const suggestLoading = kind === "npc" ? npcs.loading : items.loading

  const suggestions = useMemo(() => {
    const q = target.trim().toLowerCase()
    if (!q || !wantsSuggest) return []

    if (kind === "npc") {
      return npcs.rows
        .filter(
          (r) =>
            r.key.toLowerCase().includes(q) ||
            r.nameEn.toLowerCase().includes(q) ||
            r.nameCn.toLowerCase().includes(q) ||
            String(r.typeID).includes(q)
        )
        .slice(0, SUGGEST_LIMIT)
        .map((r) => ({
          id: `${r.key}-${r.typeID}`,
          title: r.nameCn || r.nameEn,
          sub: r.nameEn,
          meta: `${r.typeID}`,
          value: r.key,
        }))
    }

    return items.rows
      .filter(
        (r) =>
          r.nameCn.toLowerCase().includes(q) ||
          r.nameEn.toLowerCase().includes(q) ||
          String(r.typeID).includes(q)
      )
      .slice(0, SUGGEST_LIMIT)
      .map((r) => ({
        id: String(r.typeID),
        title: r.nameCn || r.nameEn,
        sub: r.nameEn,
        meta: `${r.typeID}`,
        value: r.nameEn,
      }))
  }, [items.rows, npcs.rows, target, kind, wantsSuggest])

  // 中文名要换成英文名，服务端只认英文
  const resolved = useMemo(
    () => (kind === "item" ? resolveItemTarget(items.rows, target) : target.trim()),
    [kind, items.rows, target]
  )

  // 预览是一段拼好的字符串（占位符的译文在 buildXxxCommand 里取）。useMemo 缓存的是**字符串值**，
  // 不是渲染节点：不把 locale 列进依赖，切完语言这段预览会一直停在旧语言 —— 翻译桥也救不回来，
  // 它挂在 <code> 里，而桥按约定跳过 code / pre。
  const preview = useMemo(() => {
    if (kind === "ship") return buildShipCommand(resolved)
    if (kind === "npc") return buildNpcCommand(resolved, qty)
    return buildItemCommand(resolved, qty)
  }, [kind, resolved, qty, locale])

  async function copy(text: string, message: string) {
    const ok = await copyText(text)
    if (ok) toast.success(message)
    else toast.error("复制失败，请手动选择文本")
  }

  function pick(value: string) {
    setTarget(value)
    setFocused(false)
    const cmd =
      kind === "ship"
        ? buildShipCommand(value)
        : kind === "npc"
          ? buildNpcCommand(value, qty)
          : buildItemCommand(value, qty)
    void copy(cmd, t("已复制并选中 · {value}", { value }))
  }

  return (
    <Panel tag="// GENERATOR" title="指令生成器" meta="v0.12.9.1">
      <div className="grid gap-3 lg:grid-cols-[minmax(190px,1fr)_minmax(240px,1.5fr)_140px_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="gen-cmd">指令类型</Label>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as GenKind)
              setTarget("")
            }}
          >
            <SelectTrigger id="gen-cmd">
              <SelectValue placeholder="选择指令" />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  <span className="tabular text-telemetry">{k.label}</span>
                  <span className="ml-1.5 text-muted-foreground">— {k.desc}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gen-target">目标</Label>
          <div className="relative">
            <Input
              id="gen-target"
              value={target}
              placeholder={PLACEHOLDER[kind]}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTarget(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />

            {wantsSuggest && (suggestions.length > 0 || suggestLoading) ? (
              <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                {suggestLoading ? (
                  <div className="px-3 py-2 text-[11px] text-tertiary">正在载入联想表…</div>
                ) : (
                  suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(s.value)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-secondary"
                    >
                      <span className="truncate text-[13px] text-foreground">{s.title}</span>
                      <span className="tabular truncate text-[11px] text-muted-foreground">
                        {s.sub}
                      </span>
                      <span className="min-w-2 flex-1" />
                      <span className="tabular shrink-0 text-[11px] text-telemetry">
                        {s.meta}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gen-qty">数量</Label>
          <NumberStepper
            id="gen-qty"
            value={qty}
            onChange={setQty}
            className={kind === "ship" ? "pointer-events-none opacity-40" : undefined}
          />
        </div>

        <Button onClick={() => void copy(preview, "指令已复制")} className="h-9">
          复制指令
        </Button>
      </div>

      <PreviewBar value={preview} onCopy={() => void copy(preview, "指令已复制")} className="mt-3" />

      <p
        className={cn(
          "mt-2 text-[11px] leading-relaxed",
          kind === "ship" ? "text-tertiary" : "text-muted-foreground"
        )}
      >
        {kind === "ship"
          ? "/ship 只生成船体，需要手动从机库登舰；不接数量参数。"
          : kind === "item"
            ? t("提示：输入中文名会自动换成英文名（服务端只认英文）；留空则用占位符 {placeholder}。", {
                placeholder: t(ITEM_PLACEHOLDER),
              })
            : "提示：/npc 的第一个参数是 NPC 档案键，不是 typeID。"}
      </p>
    </Panel>
  )
}
