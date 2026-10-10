import { Download, MessageSquare, Send, Star, Trash2 } from "lucide-react"

import { t } from "@/lib/i18n"
import { StatusDot } from "@/components/common/status-dot"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { DownloadProgress } from "@/components/modules/download-progress"
import { ConflictStrip, ReviewStrip, UpdateStrip } from "@/components/modules/mod-alerts"
import type { DownloadTask } from "@/hooks/use-mod-downloads"
import {
  hasUpdate,
  isPublished,
  marketVersionDiff,
  pendingReplies,
  ratingOf,
  reasonOf,
  type OverlapFlag,
} from "@/lib/mod-logic"
import { MOD_REVIEW_LABEL, type ModEntry } from "@/lib/mock"
import { cn } from "@/lib/utils"

export type ModStatus = "enabled" | "disabled" | "available"

export function modStatus(mod: ModEntry): ModStatus {
  if (!mod.installed) return "available"
  return mod.enabled ? "enabled" : "disabled"
}

const statusBar: Record<ModStatus, string> = {
  enabled: "bg-primary",
  disabled: "bg-border",
  available: "bg-telemetry",
}

const statusBadge: Record<
  ModStatus,
  { variant: "success" | "secondary" | "telemetry"; label: string }
> = {
  enabled: { variant: "success", label: "已启用" },
  disabled: { variant: "secondary", label: "已停用" },
  available: { variant: "telemetry", label: "未安装" },
}

const REVIEW_BADGE: Record<
  Exclude<ModEntry["review"], undefined>,
  { variant: "success" | "warning" | "secondary" | "destructive"; label: string }
> = {
  draft: { variant: "secondary", label: MOD_REVIEW_LABEL.draft },
  reviewing: { variant: "warning", label: MOD_REVIEW_LABEL.reviewing },
  approved: { variant: "success", label: MOD_REVIEW_LABEL.approved },
  rejected: { variant: "destructive", label: MOD_REVIEW_LABEL.rejected },
  delisted: { variant: "destructive", label: MOD_REVIEW_LABEL.delisted },
}

export interface ModCardProps {
  mod: ModEntry
  /** 该模组正在进行的下载任务 */
  task?: DownloadTask
  /** 双方都已启用的冲突项 */
  conflicts: ModEntry[]
  /** 尚未安装时，会与已启用模组冲突的项 */
  pendingConflicts: ModEntry[]
  onToggle: (next: boolean) => void
  onInstall: () => void
  onUpdate: () => void
  onDetail: () => void
  onSubmit: () => void
  onUninstall: () => void
  /** 移除这条只剩记录撑着的投稿（本机台账，不碰 GitHub 与市场索引，不可撤销） */
  onForget?: () => void
  onCancelDownload: () => void
  onResolveConflict: (other: ModEntry) => void
  /** 点标签按这个标签筛列表；再点一次取消 */
  onTagClick: (tag: string) => void
  /** 当前正在生效的标签筛选，用来把那枚标签点亮 */
  activeTag?: string | null
  /** 预检判定的重叠状态：conflict = 同文件 + 同注入标记（只有一个生效），shared = 只是和别人改了同一份文件 */
  overlap?: OverlapFlag | null
}

export function ModCard({
  mod,
  task,
  conflicts,
  pendingConflicts,
  onToggle,
  onInstall,
  onUpdate,
  onDetail,
  onSubmit,
  onUninstall,
  onForget,
  onCancelDownload,
  onResolveConflict,
  onTagClick,
  activeTag = null,
  overlap = null,
}: ModCardProps) {
  const status = modStatus(mod)
  const badge = statusBadge[status]
  const reviewBadge = mod.review ? REVIEW_BADGE[mod.review] : null
  const reviewing = mod.review === "reviewing"
  const published = isPublished(mod)
  const canInstall = published && !mod.installed
  const updatable = hasUpdate(mod)
  /** 本地与市场不一样时的市场那一版；两边一致 / 没装 / 市场没这条就是 undefined */
  const marketDiff = marketVersionDiff(mod)
  const rating = ratingOf(mod)
  const pending = pendingReplies(mod)

  /** 冲突压过一切，其次审核中 */
  const bar = conflicts.length
    ? "bg-destructive"
    : reviewing
      ? "bg-warning"
      : statusBar[status]

  return (
    <div
      className={cn(
        // h-full：卡片永远填满外层给它的大小。这一条让"同一行卡片等高"不依赖调用方
        // 用的是 grid（默认 stretch）还是 flex —— 换布局时不会又缩回自然高度。
        "relative flex h-full flex-col overflow-hidden rounded-lg border bg-card transition-colors",
        conflicts.length
          ? "border-destructive/55 shadow-[0_0_0_1px_hsl(var(--destructive)_/_0.25)]"
          : reviewing
            ? "border-warning/45"
            : "border-border"
      )}
    >
      <span className={cn("absolute inset-x-0 top-0 h-[2px]", bar)} />

      <div className="flex flex-1 flex-col p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold text-foreground">
              {mod.name}
            </span>
            {marketDiff ? (
              /* 两个都写出来：只靠「可更新」那一条，本地更高时界面上一个数字都不变，
                 作者看不出市场收没收到自己刚发的那一版（2026-09-30 报障） */
              <span className="tabular shrink-0 text-[10px] text-tertiary">
                {t("本地 {local} · 市场 {market}", { local: mod.version, market: marketDiff })}
              </span>
            ) : (
              <span className="tabular shrink-0 text-[11px] text-tertiary">{mod.version}</span>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {overlap === "conflict" ? (
              <Badge variant="destructive">{t("注入标记冲突")}</Badge>
            ) : overlap === "shared" ? (
              <Badge variant="warning">{t("疑似重叠")}</Badge>
            ) : null}
            {conflicts.length ? (
              <Badge variant="destructive">冲突</Badge>
            ) : null}
            {mod.installed && mod.needsRestart ? (
              <Badge variant="warning">需重启</Badge>
            ) : null}
            {mod.mine && reviewBadge ? (
              <Badge variant={reviewBadge.variant}>{reviewBadge.label}</Badge>
            ) : null}
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
        </div>

        {reviewing ? <ReviewStrip mod={mod} className="mt-2.5" /> : null}

        {(mod.review === "rejected" || mod.review === "delisted") && mod.reviewNote ? (
          <div className="mt-2.5 rounded-md border border-destructive/45 bg-destructive/10 px-2.5 py-2">
            <div className="text-[12px] font-semibold text-destructive">
              {mod.review === "delisted" ? "已下架" : "审核未通过"}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {mod.reviewNote}
            </p>
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-[11px] text-muted-foreground">{mod.author}</span>
          <Badge variant="secondary">{mod.cat}</Badge>
          {rating.count > 0 ? (
            <span className="flex items-center gap-1">
              <Star className="size-3 text-telemetry" fill="currentColor" />
              <span className="tabular text-[11px] text-foreground">
                {rating.average.toFixed(1)}
              </span>
              <span className="tabular text-[10px] text-tertiary">
                ({rating.count.toLocaleString()})
              </span>
            </span>
          ) : (
            <span className="text-[11px] text-tertiary">暂无评分</span>
          )}
          {/* 自己的模组：点出还有几条评价等着回，不然入口藏在详情里没人发现 */}
          {mod.mine && pending > 0 ? (
            <span className="flex items-center gap-1 text-[11px] text-warning">
              <MessageSquare className="size-3" />
              <span className="tabular">{pending}</span> 条待回复
            </span>
          ) : null}
          <span className="flex items-center gap-1 text-[11px] text-tertiary">
            <Download className="size-3" />
            <span className="tabular">
              {mod.downloads > 0 ? mod.downloads.toLocaleString() : "—"}
            </span>
          </span>
        </div>

        {/* 三行封顶，超出的部分浏览器会自己补省略号；鼠标停上去看全文 */}
        <p
          className="mt-2.5 line-clamp-3 text-[12px] leading-relaxed text-muted-foreground"
          title={mod.desc}
        >
          {mod.desc}
        </p>

        {updatable ? (
          <UpdateStrip
            mod={mod}
            onUpdate={onUpdate}
            disabled={task !== undefined}
            className="mt-2.5"
          />
        ) : null}

        {conflicts.length ? (
          <ConflictStrip
            mod={mod}
            others={conflicts}
            reasonOf={(other) => reasonOf(mod, other)}
            onDisable={onResolveConflict}
            className="mt-2.5"
          />
        ) : pendingConflicts.length ? (
          <ConflictStrip
            mod={mod}
            others={pendingConflicts}
            reasonOf={(other) => reasonOf(mod, other)}
            className="mt-2.5"
          />
        ) : null}

        {/* mt-auto：同一行的卡片高度被拉齐，标签靠底排就跟相邻卡片的标签落在同一条线上，
            简介长的那张不会再把自己这排标签顶到别处去 */}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-2.5">
          {mod.tags.map((tag) => {
            const on = tag === activeTag
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                aria-pressed={on}
                title={
                  on
                    ? t("取消「{tag}」标签筛选", { tag })
                    : t("只看带「{tag}」标签的模组", { tag })
                }
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors",
                  "focus-visible:outline-none focus-visible:shadow-focus",
                  on
                    ? "border-primary/55 bg-primary/10 text-primary"
                    : "border-input text-tertiary hover:border-primary/45 hover:text-primary"
                )}
              >
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      {task ? (
        <div className="border-t border-input px-3 py-2">
          <DownloadProgress task={task} onCancel={onCancelDownload} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-input px-3 py-2">
          {mod.installed ? (
            <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Switch checked={mod.enabled} onCheckedChange={onToggle} />
              启用
            </span>
          ) : reviewing ? (
            <span className="flex items-center gap-2 text-[12px] text-warning">
              <StatusDot tone="warning" pulse />
              上架审核中
            </span>
          ) : !published ? (
            <span className="flex items-center gap-2 text-[12px] text-tertiary">
              <StatusDot tone="idle" />
              {mod.review === "draft" ? "尚未提交" : "未上架"}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-[12px] text-tertiary">
              <StatusDot tone="idle" />
              市场可安装
            </span>
          )}

          <div className="flex-1" />

          <Button variant="ghost" size="sm" onClick={onDetail}>
            详情
          </Button>

          {mod.installed ? (
            <>
              {updatable ? (
                <Button size="sm" onClick={onUpdate}>
                  更新
                </Button>
              ) : null}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="hover:text-destructive"
                  >
                    卸载
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>卸载「{mod.name}」？</AlertDialogTitle>
                    <AlertDialogDescription>
                      该模组会从 mods 目录移除，相关配置与缓存一并清理。此操作不可撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={onUninstall}>
                      确认卸载
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <>
              {/*
                只剩记录的投稿（被驳回 / 已下架 / 审核中，而本地文件夹和索引都没了）：
                给一条清掉的路径，否则这条记录会永远挂在「我创建的」里（2026-10-01 报障）。
                换过身份的机器上 own=false，那是旧身份的投稿，不在这里给入口。
              */}
              {mod.mine && mod.recordOnly && mod.own !== false && onForget ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="hover:text-destructive">
                      <Trash2 />
                      {t("移除记录")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("移除「{name}」的提交记录？", { name: mod.name })}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t(
                          "只删本机的投稿记录（含历史版本），不会动 GitHub 仓库、Release 与市场收录。此操作不可撤销；删掉后在本地重建同名模组再刷新，就能重新提交上架。"
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
                      <AlertDialogAction onClick={onForget}>{t("确认移除")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {mod.mine && (mod.review === "draft" || mod.review === "rejected") ? (
                <Button size="sm" onClick={onSubmit}>
                  <Send />
                  {mod.review === "rejected" ? "重新提交" : "提交审核"}
                </Button>
              ) : null}
              {canInstall ? (
                <Button size="sm" onClick={onInstall}>
                  安装
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}
