import type { ReactNode } from "react"
import {
  Check,
  FolderOpen,
  History,
  ListChecks,
  Pencil,
  Send,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DownloadProgress } from "@/components/modules/download-progress"
import { ConflictStrip, ReviewStrip } from "@/components/modules/mod-alerts"
import { ModReviews } from "@/components/modules/mod-reviews"
import type { DownloadTask } from "@/hooks/use-mod-downloads"
import {
  hasUpdate,
  isPublished,
  readmeSections,
  reasonOf as conflictReasonOf,
} from "@/lib/mod-logic"
import {
  MOD_REVIEW_LABEL,
  NETWORK_PERMS,
  formatMB,
  permLabel,
  type ModEntry,
} from "@/lib/mock"
import { cn } from "@/lib/utils"

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-input bg-background/40 px-2.5 py-1.5">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-tertiary">
        {label}
      </span>
      <span className="tabular truncate text-[12px] font-semibold text-telemetry">
        {value}
      </span>
    </div>
  )
}

/** 功能要点：一列能扫的短句，比整段正文先看得进去 */
function FeatureList({ features }: { features: string[] }) {
  return (
    <ul className="space-y-1.5">
      {features.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
        >
          <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <h4 className="panel-label">{title}</h4>
      </div>
      {children}
    </section>
  )
}

export interface ModDetailDialogProps {
  mod: ModEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
  task?: DownloadTask
  conflicts: ModEntry[]
  pendingConflicts: ModEntry[]
  onInstall: () => void
  onUpdate: () => void
  onUninstall: () => void
  onEdit: () => void
  onDeleteDraft: () => void
  onSubmit: () => void
  onCancelDownload: () => void
  onResolveConflict: (other: ModEntry) => void
  onAddReview: (input: { stars: number; body: string }) => void
  onReply: (reviewId: string, body: string) => void
  onEditReply: (reviewId: string, body: string) => void
  onDeleteReply: (reviewId: string) => void
  onEditReview: (reviewId: string, input: { stars: number; body: string }) => void
  onDeleteReview: (reviewId: string) => void
}

export function ModDetailDialog({
  mod,
  open,
  onOpenChange,
  task,
  conflicts,
  pendingConflicts,
  onInstall,
  onUpdate,
  onUninstall,
  onEdit,
  onDeleteDraft,
  onSubmit,
  onCancelDownload,
  onResolveConflict,
  onAddReview,
  onReply,
  onEditReply,
  onDeleteReply,
  onEditReview,
  onDeleteReview,
}: ModDetailDialogProps) {
  if (!mod) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl" />
      </Dialog>
    )
  }

  const published = isPublished(mod)
  const canInstall = published && !mod.installed
  const updatable = hasUpdate(mod)
  const reasonOf = (other: ModEntry) => conflictReasonOf(mod, other)
  // 正文按约定拆成要点与正文两块，拆不动就整段照原样显示
  const { features, paragraphs } = readmeSections(mod)
  /**
   * 卡片上的简介只有三行，写长的那截在列表里读不到，详情开头补一句完整的。
   * 作者没写正文时正文兜底的就是这句，那种情况下不再重复显示。
   */
  const showIntro =
    mod.desc.trim().length > 0 && (paragraphs[0] ?? "").trim() !== mod.desc.trim()
  /** 声明了会主动对外连接的权限，安装前要单独拦一下 */
  const netPerms = mod.perms.filter((perm) => NETWORK_PERMS.includes(perm))
  const permLine = mod.perms.map((perm) => permLabel(perm)).join("、")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2 pr-6">
            {mod.name}
            <span className="tabular text-[11px] font-normal text-tertiary">
              {mod.version}
            </span>
            {updatable ? (
              <span className="tabular text-[11px] font-normal text-primary">
                → {mod.latest}
              </span>
            ) : null}
          </DialogTitle>
          {/* 徽章是 div，塞进 <p> 里是非法嵌套；换成 div 承接这一行 */}
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-1.5">
              <span>
                {mod.author} · {mod.cat} 分类 · {formatMB(mod.sizeMB)}
              </span>
              {mod.mine ? <Badge variant="default">我创建的</Badge> : null}
              {mod.review ? (
                <Badge
                  variant={
                    mod.review === "approved"
                      ? "success"
                      : mod.review === "reviewing"
                        ? "warning"
                        : mod.review === "rejected"
                          ? "destructive"
                          : "secondary"
                  }
                >
                  {MOD_REVIEW_LABEL[mod.review]}
                </Badge>
              ) : null}
              {conflicts.length ? <Badge variant="destructive">加载冲突</Badge> : null}
              {mod.installed ? (
                <Badge variant={mod.enabled ? "success" : "secondary"}>
                  {mod.enabled ? "已启用" : "已停用"}
                </Badge>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mr-2 max-h-[54vh] pr-2">
          <div className="space-y-4">
            {showIntro ? (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {mod.desc}
              </p>
            ) : null}

            {task ? <DownloadProgress task={task} onCancel={onCancelDownload} /> : null}

            {mod.review === "reviewing" ? <ReviewStrip mod={mod} /> : null}

            {mod.review === "rejected" && mod.reviewNote ? (
              <div className="rounded-md border border-destructive/45 bg-destructive/10 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-destructive">
                  <TriangleAlert className="size-3.5" />
                  审核未通过
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {mod.reviewNote}
                </p>
              </div>
            ) : null}

            {conflicts.length ? (
              <ConflictStrip
                mod={mod}
                others={conflicts}
                reasonOf={reasonOf}
                onDisable={onResolveConflict}
              />
            ) : pendingConflicts.length ? (
              <ConflictStrip mod={mod} others={pendingConflicts} reasonOf={reasonOf} />
            ) : null}

            <Section title="概览">
              <div className="grid gap-2 sm:grid-cols-2">
                <Readout label="模组 ID" value={mod.id} />
                <Readout label="版本" value={mod.version} />
                <Readout label="作者" value={mod.author} />
                <Readout label="分类" value={mod.cat} />
                <Readout
                  label="下载量"
                  value={mod.downloads > 0 ? mod.downloads.toLocaleString() : "—"}
                />
                <Readout label="安装包" value={formatMB(mod.sizeMB)} />
                <Readout label="最近更新" value={mod.updatedAt} />
                {mod.submittedAt ? (
                  <Readout label="提交审核" value={mod.submittedAt} />
                ) : null}
                <Readout
                  label="市场状态"
                  value={
                    !published
                      ? mod.review === "reviewing"
                        ? "上架审核中"
                        : "未上架"
                      : mod.installed
                        ? "已安装"
                        : "市场可安装"
                  }
                />
              </div>
            </Section>

            {/* 作者没写要点（正文只有一句话）时整节不出现，不留一个空标题 */}
            {features.length > 0 ? (
              <Section
                icon={<ListChecks className="size-3.5 text-tertiary" />}
                title="功能要点"
              >
                <FeatureList features={features} />
              </Section>
            ) : null}

            <Section title="功能说明">
              {paragraphs.length > 0 ? (
                <div className="space-y-2">
                  {paragraphs.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 12)}
                      className="text-[12px] leading-relaxed text-muted-foreground"
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  还没有填写功能说明。
                </p>
              )}
            </Section>

            <Section icon={<History className="size-3.5 text-tertiary" />} title="版本历史">
              {mod.changelog.length > 0 ? (
                <ol className="space-y-3">
                  {mod.changelog.map((entry) => (
                    <li
                      key={entry.version}
                      className="relative border-l border-input pl-3"
                    >
                      <span
                        className={cn(
                          "absolute -left-[3px] top-1.5 size-1.5 rounded-full",
                          entry.version === mod.version ? "bg-primary" : "bg-border"
                        )}
                      />
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="tabular text-[12px] font-semibold text-foreground">
                          {entry.version}
                        </span>
                        <span className="tabular text-[10px] text-tertiary">
                          {entry.date}
                        </span>
                        {entry.version === mod.version ? (
                          <Badge variant="default">当前版本</Badge>
                        ) : null}
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {entry.items.map((item) => (
                          <li
                            key={item}
                            className="text-[11px] leading-relaxed text-muted-foreground"
                          >
                            · {item}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  暂无版本历史
                </p>
              )}
            </Section>

            {/* 评价最长，放在版本历史后面：先看完这个模组本身，再看别人怎么说 */}
            {/* 评分汇总行自带标题层级，这里不再套一层，免得出现两个「评分」 */}
            {published ? (
              <ModReviews
                key={mod.id}
                mod={mod}
                onAddReview={onAddReview}
                onReply={onReply}
                onEditReply={onEditReply}
                onDeleteReply={onDeleteReply}
                onEditReview={onEditReview}
                onDeleteReview={onDeleteReview}
              />
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">关闭</Button>
          </DialogClose>
          <Button
            variant="ghost"
            onClick={() =>
              toast("已打开所在目录", { description: `mods\\${mod.id}` })
            }
          >
            <FolderOpen />
            打开所在目录
          </Button>

          {mod.mine ? (
            <Button variant="outline" onClick={onEdit}>
              <Pencil />
              编辑信息
            </Button>
          ) : null}

          {mod.installed ? (
            <>
              {mod.mine && mod.review === "approved" ? (
                <Button variant="outline" onClick={onSubmit}>
                  <Send />
                  发布新版本
                </Button>
              ) : null}
              {updatable ? (
                <Button onClick={onUpdate} disabled={task !== undefined}>
                  更新到 {mod.latest}
                </Button>
              ) : null}
              {/* 卸载是不可撤销的，这里给一次确认；卡片上不再放这个入口 */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
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
          ) : mod.mine && (mod.review === "draft" || mod.review === "rejected") ? (
            <>
              {/* 草稿还没上架，删掉不留痕迹；上架后要走卸载 */}
              {mod.review === "draft" ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" className="hover:text-destructive">
                      <Trash2 />
                      删除草稿
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除草稿「{mod.name}」？</AlertDialogTitle>
                      <AlertDialogDescription>
                        这份草稿还没提交过审核，删掉后本地目录里的清单一并移除。此操作不可撤销。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction onClick={onDeleteDraft}>
                        确认删除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              <Button onClick={onSubmit}>
                <Send />
                {mod.review === "rejected" ? "重新提交审核" : "提交审核"}
              </Button>
            </>
          ) : canInstall ? (
            /* 声明了联网权限的模组，装之前先停一下把话说明白：装完再发现就晚了。
               其余模组照旧一步装好，不给常规安装多加一次点击 */
            netPerms.length > 0 ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={task !== undefined}>
                    安装 · {formatMB(mod.sizeMB)}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      「{mod.name}」会主动发起对外连接
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      它声明的权限是 {permLine}。启用后它会主动连接外部地址，来源不明时先确认再装。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={onInstall}>仍然安装</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button onClick={onInstall} disabled={task !== undefined}>
                安装 · {formatMB(mod.sizeMB)}
              </Button>
            )
          ) : (
            <Button disabled>审核中，暂不可安装</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
