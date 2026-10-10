import { useRef, useState, type DragEvent } from "react"
import { ChevronDown, ChevronRight, GripVertical, ListOrdered, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { listSeparator, t } from "@/lib/i18n"
import type { RawModPlan } from "@/lib/ipc"
import { moveWithin } from "@/lib/mod-logic"
import { cn } from "@/lib/utils"

/**
 * 「加载顺序」面板：把**真正生效的顺序**摊开给用户看。
 *
 * 为什么要单独一块：模组列表上的拖拽是"我想让它怎么排"，这块是"实际会怎么加载" ——
 * 两者不一定一样（清单里的 loadAfter / loadBefore 会插进来调整；模组还可能因为缺依赖、
 * 冲突、清单坏了被整条跳过）。这些以前只写在 `_launcher/mods/mod-plan.json` 里，
 * 界面上一个字都看不到，用户只能靠猜。
 *
 * 面板里也能直接拖：拖的是**用户那一份基准顺序**（不是面板上显示的生效顺序），
 * 拖完和卡片上拖是一回事 —— 写 mod-order.json，然后清单约束再作用一次。
 * 所以拖完位置上仍可能显示「清单约束调整过位置」，那是约束在起作用，不是没生效。
 */
export function ModLoadOrderPanel({
  plan,
  enabledOrder,
  onReorder,
}: {
  plan: RawModPlan | null
  /** 用户基准顺序里的「已启用」那一段（folder 列表），拖拽落位用它 */
  enabledOrder: string[]
  onReorder: (next: string[]) => void
}) {
  const [open, setOpen] = useState(true)
  // 正在拖的 folder 用 ref 存：dragstart → dragover → drop 只隔几个事件 tick，
  // 走 state 会在 drop 里读到旧值（null），表现就是「拖了没反应」
  const dragKey = useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  /** 落点提示：`after` = 插到这一行后面。靠它画一条主色分割线 */
  const [dropHint, setDropHint] = useState<{ key: string; after: boolean } | null>(null)

  function dropOnRow(event: DragEvent<HTMLLIElement>, target: string) {
    event.preventDefault()
    const from = dragKey.current
    dragKey.current = null
    setDraggingKey(null)
    setDropHint(null)
    if (!from || from === target) return
    // 落在行上半 ⇒ 插到它前面，下半 ⇒ 插到它后面
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    onReorder(moveWithin(enabledOrder, from, target, after))
  }

  if (!plan) return null
  const total = plan.order.length
  const trouble = plan.skipped.length + plan.ignored.length

  return (
    <section className="rounded-lg border border-border bg-card/60">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-1 h-6 gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <ListOrdered className="size-3.5" />
          加载顺序
        </Button>
        <span className="text-[11px] text-tertiary">
          {t("共 {count} 个模组参与加载（按上面的拖拽顺序，清单约束会插进来微调）", {
            count: total,
          })}
        </span>
        {trouble > 0 ? (
          <Badge variant="warning">
            {t("{skipped} 个未加载 · {ignored} 条声明未生效", {
              skipped: plan.skipped.length,
              ignored: plan.ignored.length,
            })}
          </Badge>
        ) : (
          <Badge variant="success">全部生效</Badge>
        )}
      </div>

      {open ? (
        <div className="space-y-2 border-t border-input px-3 py-2">
          {/* 成环时的口径要说清楚：这时候"完全按你拖的顺序"就是最终行为 */}
          {plan.cycle ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/45 bg-warning/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>
                检测到循环依赖：本次退回完全按你的手动顺序加载，清单里的前置 / 后置声明全部忽略。
              </span>
            </div>
          ) : null}

          {total === 0 ? (
            <p className="py-1 text-[11px] text-tertiary">还没有模组参与加载。</p>
          ) : (
            <ol className="space-y-1">
              {plan.order.map((entry) => (
                <li
                  key={entry.id}
                  draggable
                  onDragStart={(event) => {
                    dragKey.current = entry.folder
                    setDraggingKey(entry.folder)
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData("text/plain", entry.folder)
                  }}
                  onDragEnd={() => {
                    dragKey.current = null
                    setDraggingKey(null)
                    setDropHint(null)
                  }}
                  onDragOver={(event) => {
                    const from = dragKey.current
                    if (!from || from === entry.folder) {
                      setDropHint(null)
                      return
                    }
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "move"
                    const rect = event.currentTarget.getBoundingClientRect()
                    const after = event.clientY > rect.top + rect.height / 2
                    setDropHint((current) =>
                      current && current.key === entry.folder && current.after === after
                        ? current
                        : { key: entry.folder, after }
                    )
                  }}
                  onDrop={(event) => dropOnRow(event, entry.folder)}
                  className={cn(
                    "relative flex cursor-grab flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-sm px-1 py-0.5 text-[11px] transition-colors hover:bg-secondary/40 active:cursor-grabbing",
                    draggingKey === entry.folder && "opacity-50"
                  )}
                >
                  {/* 落点分割线：拖到哪一行就在它的上/下边缘亮一条主色 */}
                  {dropHint?.key === entry.folder ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute inset-x-0 z-20 h-[2px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)_/_0.85)]",
                        dropHint.after ? "-bottom-px" : "-top-px"
                      )}
                    />
                  ) : null}
                  <GripVertical className="size-3 shrink-0 self-center text-tertiary" />
                  <span className="tabular w-6 shrink-0 text-right font-semibold text-primary">
                    #{entry.index + 1}
                  </span>
                  <span
                    data-i18n-skip
                    className="min-w-0 truncate font-semibold text-foreground"
                  >
                    {entry.name}
                  </span>
                  <span data-i18n-skip className="tabular min-w-0 truncate text-tertiary">
                    {entry.folder}
                  </span>
                  {entry.reordered ? (
                    <Badge variant="warning">清单约束调整过位置</Badge>
                  ) : (
                    <Badge variant="secondary">手动顺序</Badge>
                  )}
                  {entry.loadAfter.length > 0 ? (
                    <span className="text-[10px] text-tertiary">
                      {t("前置 {ids}", { ids: entry.loadAfter.join(listSeparator()) })}
                    </span>
                  ) : null}
                  {entry.loadBefore.length > 0 ? (
                    <span className="text-[10px] text-tertiary">
                      {t("后置 {ids}", { ids: entry.loadBefore.join(listSeparator()) })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          {plan.skipped.length > 0 ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/[0.07] px-2.5 py-1.5">
              <div className="text-[11px] font-semibold text-destructive">
                这些模组本次不会加载
              </div>
              <ul className="mt-1 space-y-0.5">
                {plan.skipped.map((item) => (
                  <li key={item.id} className="text-[11px] leading-relaxed text-muted-foreground">
                    <span data-i18n-skip className="tabular font-semibold text-foreground">
                      {item.id}
                    </span>
                    <span> · </span>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.ignored.length > 0 ? (
            <div className="rounded-md border border-warning/40 bg-warning/[0.06] px-2.5 py-1.5">
              <div className="text-[11px] font-semibold text-warning">
                这些顺序声明本次没生效
              </div>
              <ul className="mt-1 space-y-0.5">
                {plan.ignored.map((item, index) => (
                  <li
                    key={`${item.field}-${item.id ?? ""}-${item.target}-${index}`}
                    className="text-[11px] leading-relaxed text-muted-foreground"
                  >
                    <span data-i18n-skip className={cn("tabular font-semibold text-foreground")}>
                      {item.id ? `${item.id} · ${item.field}` : item.field}
                    </span>
                    <span> → </span>
                    <span data-i18n-skip className="tabular">
                      {item.target}
                    </span>
                    <span> · </span>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
