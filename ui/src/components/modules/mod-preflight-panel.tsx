import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Radar } from "lucide-react"

import { StatusDot, type DotTone } from "@/components/common/status-dot"
import { useLocale } from "@/components/shell/locale-provider"
import { Button } from "@/components/ui/button"
import type { RawModPreflightDryRun, RawModPreflightReport } from "@/lib/ipc"

/**
 * 启动前预检面板（模组页「已安装」页签）。
 *
 * 为什么要有它：现役口径下「某个模组没生效」只有真启动一次、再去翻
 * `_launcher/logs/mod-load-report.json` 才知道；而最常见的两种失效在启动前就能看见 ——
 *   1. 模组目录被静默跳过（清单缺失 / 清单被套在下一层子目录里）；
 *   2. 模组引用了同一份服务端源码，但声明的基线指纹与当前文件对不上（会静默放弃注入）。
 * 第三件事（loader 在加载期抛错 → `--require` 失败 → 服务端起不来）没有捷径，
 * 只能在一个一次性 Node 进程里真 require 一遍，所以单独做成「运行预检」按钮。
 *
 * 文案口径：静态那半一律标「静态推测」，不承诺「一定没问题」——运行期补丁是否命中，
 * 仍然要真的启动一次才知道。
 *
 * 标签用大白话（版本对得上 / 版本对不上 / 模组没写版本 / 服务端缺这个文件）：
 * 2026-10-04 反馈是「怕用户看不懂、也怕作者看不懂」，所以底部留了一张可展开的说明，
 * 作者那半直接给出补丁脚本里该写的两行。
 */

/** 基线指纹判定的配色 */
const VERDICT_TONE: Record<string, DotTone> = {
  ok: "success",
  stale: "warning",
  unknown: "idle",
  "missing-file": "destructive",
}

/**
 * 标签一律说人话：2026-10-04 反馈 —— 「基线」是行话，玩家看不懂，模组作者也看不懂。
 * 术语只留在面板底部那张可展开的说明里（VERDICT_HELP），并且直接告诉作者该写哪两行。
 */
const VERDICT_LABEL: Record<string, string> = {
  ok: "版本对得上",
  stale: "版本对不上",
  unknown: "模组没写版本",
  "missing-file": "服务端缺这个文件",
}

/** 每种判定配一句人话解释；ok 不必解释，不列 */
const VERDICT_HELP: { label: string; body: string }[] = [
  {
    label: "版本对得上",
    body: "版本对得上：模组是按你这份文件写出来的，能正常生效。",
  },
  {
    label: "版本对不上",
    body: "版本对不上：模组是按另一个版本的文件写的，启动时会被自动跳过 —— 不报错，也不生效。等模组作者更新，或换上模组要求的那一版服务端文件。",
  },
  {
    label: "模组没写版本",
    body: "模组没写版本：模组没说它是按哪一版改的，启动器没法提前判断，以实际启动结果为准。",
  },
  {
    label: "服务端缺这个文件",
    body: "服务端缺这个文件：你这份服务端里没有模组要改的文件，模组会跳过它。",
  },
]

function verdictLabel(t: (text: string) => string, verdict: string): string {
  return t(VERDICT_LABEL[verdict] ?? verdict)
}

export function ModPreflightPanel({
  report,
  dryRun,
  running,
  onRun,
}: {
  report: RawModPreflightReport | null
  dryRun: RawModPreflightDryRun | null
  running: boolean
  onRun: (dryRun: boolean) => void
}) {
  const { t } = useLocale()
  const [showOutput, setShowOutput] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const ignored = report?.ignored ?? []
  /** 只列「值得看一眼」的：共享同一份文件的，或基线对不上的 */
  const targets = useMemo(
    () =>
      (report?.targets ?? []).filter(
        (item) => item.shared || item.mods.some((mod) => mod.verdict === "stale")
      ),
    [report]
  )

  const loaders = dryRun?.loaders ?? []
  const hasDryRun = Boolean(dryRun)

  return (
    <section className="rounded-lg border border-border bg-card/40 p-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/60">
          <Radar className="size-4 text-primary" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">启动前预检</div>
          <div className="text-[11px] text-muted-foreground">
            不启动服务端也能先看一眼：哪些模组会被跳过、哪些在抢同一份服务端文件。静态推测，未经启动验证。
          </div>
        </div>
        <div className="min-w-2 flex-1" />
        <Button variant="outline" size="sm" disabled={running} onClick={() => onRun(true)}>
          {running ? <Loader2 className="animate-spin" /> : <Radar />}
          {running ? "预检中…" : "运行预检"}
        </Button>
      </div>

      {/* 被忽略的目录 */}
      {ignored.length > 0 ? (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5">
          <div className="text-[12px] font-semibold text-warning">
            {t("有 {count} 个目录没有被当作模组加载", { count: ignored.length })}
          </div>
          <ul className="mt-2 space-y-2">
            {ignored.map((item) => (
              <li key={item.folder} className="rounded border border-warning/25 bg-background/40 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-x-2">
                  <StatusDot tone="warning" />
                  <span className="text-[12px] font-semibold text-foreground">{item.folder}</span>
                  <span className="text-[11px] text-tertiary">
                    {item.loaderFiles.length > 0 ? item.loaderFiles.join(" / ") : ""}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {item.reasonKind === "nested"
                    ? t("模组清单在子目录 {sub} 里，启动器只认 mods/{folder}/evejs-launcher.mod.json。把子目录里的内容挪到上一层就能被识别。", {
                        sub: item.subFolder,
                        folder: item.folder,
                      })
                    : t("目录里有 loader 却没有 evejs-launcher.mod.json，启动器不会加载它。补一份清单，或重新用启动器创建一个模组。")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 共享服务端文件 / 基线指纹 */}
      {targets.length > 0 ? (
        <div className="mt-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="text-[12px] font-semibold text-foreground">
            {t("有 {count} 处服务端文件需要留意", { count: targets.length })}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("多个模组改同一份文件不算冲突，启动器会按顺序依次注入。只有标着「版本对不上」的才真的不生效。")}
          </p>
          <ul className="mt-2 space-y-2">
            {targets.map((item) => (
              <li key={item.file} className="rounded border border-border/70 bg-card/40 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="tabular break-all text-[11px] text-foreground">{item.file}</span>
                  {item.shared ? (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-tertiary">
                      {t("{count} 个模组", { count: item.mods.length })}
                    </span>
                  ) : null}
                </div>
                <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {item.mods.map((mod) => (
                    <li key={mod.folder} className="flex items-center gap-1.5">
                      <StatusDot tone={VERDICT_TONE[mod.verdict] ?? "idle"} />
                      <span className="text-[11px] text-foreground">{mod.id || mod.folder}</span>
                      <span className="text-[10px] text-tertiary">
                        {verdictLabel(t, mod.verdict)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 干跑结果 */}
      {hasDryRun ? (
        <div className="mt-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2">
            <StatusDot tone={dryRun?.ok ? "success" : "destructive"} pulse={running} />
            <span className="text-[12px] font-semibold text-foreground">
              {dryRun?.ok
                ? t("加载期预检通过：{count} 个模组都没报错", { count: loaders.length })
                : t("有 {count} 个模组在加载期就报错了", { count: dryRun?.failed ?? 0 })}
            </span>
            {typeof dryRun?.elapsedMs === "number" ? (
              <span className="text-[11px] text-tertiary">
                {t("加载这批模组用了 {seconds} 秒", { seconds: (dryRun.elapsedMs / 1000).toFixed(1) })}
              </span>
            ) : null}
          </div>
          {dryRun?.reason ? (
            <p className="mt-1 text-[11px] text-destructive">{dryRun.reason}</p>
          ) : null}
          <ul className="mt-2 space-y-1">
            {loaders.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-2">
                <StatusDot tone={item.ok ? "success" : "destructive"} />
                <span className="text-[11px] text-foreground">{item.id}</span>
                <span className="tabular text-[10px] text-tertiary">{item.ms}ms</span>
                {item.ok ? null : (
                  <span className="text-[10px] text-destructive">{item.reason}</span>
                )}
              </li>
            ))}
          </ul>
          {(dryRun?.output?.length ?? 0) > 0 ? (
            <>
              <button
                type="button"
                className="mt-2 flex items-center gap-1 text-[11px] text-tertiary hover:text-foreground"
                onClick={() => setShowOutput((value) => !value)}
              >
                {showOutput ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {t("预检输出")}
              </button>
              {showOutput ? (
                <pre className="mt-1.5 max-h-60 overflow-auto rounded border border-border/70 bg-background/60 p-2 text-[10px] leading-relaxed text-tertiary">
                  {dryRun?.output?.join("\n")}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* 标签说明：看不懂「版本对不上」、不知道该怎么办时展开这里 */}
      {targets.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-tertiary hover:text-foreground"
            onClick={() => setShowHelp((value) => !value)}
          >
            {showHelp ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("这些标签是什么意思？")}
          </button>
          {showHelp ? (
            <div className="mt-1.5 space-y-1.5 rounded-md border border-border bg-background/40 px-3 py-2.5">
              {VERDICT_HELP.map((item) => (
                <div key={item.label} className="flex gap-x-2">
                  <span className="w-24 shrink-0 text-[11px] text-tertiary">{t(item.label)}</span>
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {t(item.body)}
                  </span>
                </div>
              ))}
              <div className="space-y-1.5 border-t border-border/60 pt-2">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("模组作者：在补丁脚本里写上目标文件的 sha256（校验值），启动器就能在启动前替你核对。")}
                </p>
                <pre className="overflow-auto rounded border border-border/70 bg-background/60 p-2 text-[10px] leading-relaxed text-tertiary">
                  {'const RELATIVE_PATH = "server/src/network/tcp/handshake.js";\nconst BASELINES = new Set(["<sha256>"]);'}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
