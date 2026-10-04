import { Link2, TriangleAlert } from "lucide-react"

import { StatusDot } from "@/components/common/status-dot"
import { useLocale } from "@/components/shell/locale-provider"
import { Button } from "@/components/ui/button"
import { modByFolderOrId, type OverlapReport } from "@/lib/mod-logic"
import { type ModEntry } from "@/lib/mock"

/**
 * 「疑似重叠」面板（模组页「启动预检」页签）。
 *
 * 为什么单开一块、而不是并进「冲突数」：多个模组改同一份服务端文件本身是设计允许的
 * （注入总线按 slot 依次串链，每层只追加自己那一段），把它算成冲突会天天催用户去停用。
 * 真正会让**只有一个生效**的只有一种情形 —— 同一份文件 + 同一个注入标记：后注册的那层
 * 看到标记已经在源码里，就整段跳过自己，既不报错也不生效（2026-10-04 实测两个模组
 * 各自以为自己在跑）。
 *
 * 所以这里分两段说话：上面那几行是能定位到具体模组的**标记冲突**，给出逐个停用；
 * 下面那行只是「另有 N 处被多个模组同时改动」的计数，说明它们都能生效，不催用户动手。
 */
export function ModOverlapPanel({
  report,
  mods,
  onDisable,
}: {
  report: OverlapReport
  mods: ModEntry[]
  onDisable: (mod: ModEntry) => void
}) {
  const { t } = useLocale()

  if (report.markers.length === 0 && report.sharedOnly === 0) return null

  return (
    <section className="rounded-lg border border-warning/45 bg-warning/10 p-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-warning/45 bg-warning/10">
          <Link2 className="size-4 text-warning" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-warning">{t("疑似重叠")}</div>
          <div className="text-[11px] text-muted-foreground">
            {t(
              "多个模组改同一份服务端文件不算冲突，启动器会按 slot 依次注入；但两边用了同一个注入标记时，后注册的那个会被静默跳过 —— 只有一个能生效。"
            )}
          </div>
        </div>
      </div>

      {report.markers.length > 0 ? (
        <ul className="mt-3 space-y-2.5">
          {report.markers.map((row) => (
            <li
              key={row.target + "|" + row.marker}
              className="rounded-md border border-destructive/30 bg-background/40 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                <span className="text-[12px] font-semibold text-destructive">
                  {t("注入标记冲突")}
                </span>
                <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 text-[11px] text-foreground">
                  {row.marker}
                </span>
                <span className="text-[11px] text-tertiary">{row.target}</span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {row.mods.map((ref) => {
                  const mod = modByFolderOrId(mods, ref)
                  return (
                    <li
                      key={ref.folder || ref.id}
                      className="flex flex-wrap items-center gap-x-2 rounded border border-border/60 bg-background/40 px-2 py-1.5"
                    >
                      <StatusDot tone="destructive" pulse />
                      <span className="text-[11px] font-semibold text-foreground">
                        {mod?.name ?? ref.id ?? ref.folder}
                      </span>
                      <span className="text-[10px] text-tertiary">{ref.folder || ref.id}</span>
                      <div className="min-w-2 flex-1" />
                      {mod ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => onDisable(mod)}
                        >
                          {t("停用「{name}」", { name: mod.name })}
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {report.sharedOnly > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "另有 {count} 处服务端文件被多个模组同时改动，都能生效，明细见下方「启动前预检」。",
            { count: report.sharedOnly }
          )}
        </p>
      ) : null}
    </section>
  )
}
