import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import {
  Bookmark,
  Check,
  FileText,
  FolderOpen,
  History,
  Link2,
  ListChecks,
  Pencil,
  Send,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react"

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
import { ModShots } from "@/components/modules/mod-shots"
import type { DownloadTask } from "@/hooks/use-mod-downloads"
import {
  formatCount,
  hasUpdate,
  isPublished,
  localFolderOf,
  marketVersionDiff,
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
import { resolveMarkdownHref } from "@/lib/markdown-link"
import { cn } from "@/lib/utils"
import { listSeparator, t } from "@/lib/i18n"

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-input bg-background/40 px-2.5 py-1.5">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-tertiary">
        {label}
      </span>
      {/* min-w-0：flex 项的 min-width 默认是 min-content，不写这一条 truncate 根本不生效，
          长值会把右边的值顶到行框外面去 */}
      <span className="tabular min-w-0 truncate text-[12px] font-semibold text-telemetry">
        {value}
      </span>
    </div>
  )
}

/**
 * Markdown 正文里的链接：**一律由启动器接管，绝不让 WebView 自己去导航**。
 *
 * 作者写的说明里常见 `NOTICE.md`、`docs/x.md` 这类相对路径 —— WebView 会按当前页面地址
 * （渲染层挂在 `react/` 下）把它当成应用资产去加载，点一下整页就变成
 * `asset not found: react/NOTICE.md`（2026-10-26 报障，用户以为启动器坏了）。
 *
 * 所以落点先在渲染层解析：绝对地址与「作者仓库里的文件」都交给系统浏览器打开，
 * 解析不出来就提示一句，**任何情况下都不放行导航**（见 `lib/markdown-link.ts`）。
 */
function MarkdownLink({
  href,
  repo,
  onOpenExternal,
  children,
}: {
  href?: string
  repo?: string
  onOpenExternal: (url: string) => void
  children?: ReactNode
}) {
  const target = resolveMarkdownHref(href, repo)
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (target.kind === "external" || target.kind === "repo") {
          onOpenExternal(target.url)
          return
        }
        if (target.kind === "anchor") {
          document.getElementById(target.id)?.scrollIntoView({ block: "nearest" })
          return
        }
        toast(t("没有可打开的地址"))
      }}
    >
      {children}
    </a>
  )
}

/** 功能要点：一列能扫的短句，比整段正文先看得进去 */
function FeatureList({
  features,
  repo,
  onOpenExternal,
}: {
  features: string[]
  repo?: string
  onOpenExternal: (url: string) => void
}) {
  return (
    <ul className="space-y-1.5">
      {features.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
        >
          <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
          {/* 要点也走一行 Markdown：作者爱在要点里写 `代码` 或 **加粗**，不给它渲染就会露出符号。
              把 `p` 展平成片段，免得每一条要点都被包成一段、多出一圈上下外边距。 */}
          <span className="min-w-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <>{children}</>,
                a: ({ href, children }) => (
                  <MarkdownLink href={href} repo={repo} onOpenExternal={onOpenExternal}>
                    {children}
                  </MarkdownLink>
                ),
              }}
            >
              {item}
            </ReactMarkdown>
          </span>
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

/**
 * 一条关联声明：`id` 是作者写的原始 id，`mod` 是本地/市场里能对上号的那条；
 * 对不上号时值为 null，照样把 id 显示出来，不能默默吞掉。
 */
export interface ModRelation {
  id: string
  /** requires = 依赖（表单「关联模组 id」那一栏）→「依赖模组」小节；conflicts = 互斥（「冲突模组 id」）→「冲突模组」小节 */
  kind: "requires" | "conflicts"
  mod: ModEntry | null
}

/**
 * 模组关系一行（依赖或互斥，由所在小节的标题区分）。已知模组显示名字、版本和安装/启用状态；
 * 未知 id 只留原始 id 与「未找到」，让作者一眼看出自己是不是拼错了。多条时这几张卡按网格并排换行。
 */
function RelationCard({ id, mod: related }: ModRelation) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-input bg-background/40 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">
          {related ? related.name : id}
        </span>
        {related ? (
          <span className="tabular shrink-0 text-[10px] text-tertiary">
            {related.version}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {related ? (
          <>
            <span className="tabular min-w-0 truncate text-[10px] text-tertiary">
              {related.id}
            </span>
            {related.installed ? (
              <Badge variant={related.enabled ? "success" : "secondary"}>
                {related.enabled ? "已启用" : "已停用"}
              </Badge>
            ) : (
              <Badge variant="secondary">未安装</Badge>
            )}
          </>
        ) : (
          <span className="text-[10px] text-warning">{t("未找到")}</span>
        )}
      </div>
    </div>
  )
}

export interface ModDetailDialogProps {
  mod: ModEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
  task?: DownloadTask
  conflicts: ModEntry[]
  pendingConflicts: ModEntry[]
  relations: ModRelation[]
  onInstall: () => void
  onUpdate: () => void
  onUninstall: () => void
  /** 在资源管理器里定位这个模组的本地目录（没有本地目录的条目不会显示这个按钮） */
  onOpenFolder: () => void
  /**
   * 打开说明正文里的链接。相对路径（`NOTICE.md` 这类）由组件按作者仓库解析成仓库文件页，
   * 外壳只管把最终地址交给 `shell:openExternal` —— 组件自己不去碰桥。
   */
  onOpenExternal: (url: string) => void
  onEdit: () => void
  onDeleteDraft: () => void
  onSubmit: () => void
  onCancelDownload: () => void
  onResolveConflict: (other: ModEntry) => void
  onAddReview: (input: { body: string }) => void
  /** 本机身份有没有点过星；星标按钮的状态就是它 */
  starred: boolean
  starBusy?: boolean
  onToggleStar: () => void
  /** 本机收藏（书签），与服务端星标是两件事 */
  favorite: boolean
  onToggleFavorite: () => void
  onReply: (reviewId: string, body: string) => void
  onEditReply: (reviewId: string, body: string) => void
  onDeleteReply: (reviewId: string) => void
  onEditReview: (reviewId: string, input: { body: string }) => void
  onDeleteReview: (reviewId: string) => void
}

export function ModDetailDialog({
  mod,
  open,
  onOpenChange,
  task,
  conflicts,
  pendingConflicts,
  relations,
  onInstall,
  onUpdate,
  onUninstall,
  onOpenFolder,
  onOpenExternal,
  onEdit,
  onDeleteDraft,
  onSubmit,
  onCancelDownload,
  onResolveConflict,
  onAddReview,
  starred,
  starBusy,
  onToggleStar,
  favorite,
  onToggleFavorite,
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
  /**
   * 「打开所在目录」只对**本机真有这个目录**的条目有意义。
   *
   * 市场里还没装的条目既没有 folder 也没 installed —— 那种情况下点下去只会弹一句
   * 「目录不存在」，不如不画。目录名怎么取（folder 优先、回落 id）交给页面，
   * 与启用 / 卸载 / 签名那几条写通道同一口径。
   */
  const canRevealFolder = localFolderOf(mod) !== null
  /** 本地与市场不一样时的市场那一版（概览里并列两行，作者一眼看出市场收没收到） */
  const marketDiff = marketVersionDiff(mod)
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
  const permLine = mod.perms.map((perm) => t(permLabel(perm))).join(listSeparator())

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
            {/*
              星标：只有「金色的星 + 数字」，不放任何文字（标题行最右）。
              星色统一走 `--telemetry`（#FFB800），与卡片上的那一颗同色；
              文字标签只留给读屏（aria-label），肉眼看到的仍然只有星和数。

              对齐（这里是**布局**问题，不该靠行高去凑）：图标和数字各放进一个
              与图标同高的 `grid place-items-center` 盒子里 —— 两个盒子的中线严格重合，
              数字不会再随字体行高上下漂。盒子内部仍有字体上伸部带来的 ~1px 光学偏移
              （CJK 字体尤甚），所以数字额外 `translate-y-px` 压回星的中间；
              这个像素值就是唯一的调节旋钮，觉得偏高就 `-0.5px`、偏低就 `+0.5px`。
            */}
            <div className="ml-auto flex items-center gap-1.5 self-center">
              <button
                type="button"
                disabled={starBusy}
                aria-pressed={starred}
                aria-label={starred ? t("已星标") : t("星标")}
                title={starred ? t("已星标") : t("星标")}
                onClick={onToggleStar}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[3px] transition-colors focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60",
                  starred
                    ? "border-telemetry/60 bg-telemetry/10 text-foreground hover:bg-telemetry/15"
                    : "border-input bg-background/40 text-tertiary hover:border-telemetry/50 hover:bg-telemetry/10 hover:text-foreground"
                )}
              >
                <span className="grid size-3.5 shrink-0 place-items-center">
                  <Star
                    className="size-3.5 text-telemetry"
                    fill={starred ? "currentColor" : "none"}
                  />
                </span>
                <span className="grid size-3.5 shrink-0 place-items-center">
                  <span className="tabular translate-y-px text-[12px] font-normal leading-none">
                    {formatCount(mod.ratingCount)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={favorite}
                aria-label={favorite ? t("已收藏") : t("收藏")}
                title={favorite ? t("已收藏") : t("收藏")}
                onClick={onToggleFavorite}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                  favorite
                    ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/15"
                    : "border-input bg-background/40 text-tertiary hover:border-primary/50 hover:bg-primary/10 hover:text-foreground"
                )}
              >
                <Bookmark className="size-3.5" fill={favorite ? "currentColor" : "none"} />
                <span>{favorite ? t("已收藏") : t("收藏")}</span>
              </button>
            </div>
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

            <ModShots urls={mod.shots} alt={mod.name} />

            {task ? <DownloadProgress task={task} onCancel={onCancelDownload} /> : null}

            {mod.review === "reviewing" ? <ReviewStrip mod={mod} /> : null}

            {(mod.review === "rejected" || mod.review === "delisted") && mod.reviewNote ? (
              <div className="rounded-md border border-destructive/45 bg-destructive/10 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-destructive">
                  <TriangleAlert className="size-3.5" />
                  {mod.review === "delisted" ? "已下架" : "审核未通过"}
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
                <Readout label={marketDiff ? "本地版本" : "版本"} value={mod.version} />
                {marketDiff ? <Readout label="市场版本" value={marketDiff} /> : null}
                <Readout label="作者" value={mod.author} />
                <Readout label="分类" value={mod.cat} />
                <Readout
                  label="兼容服务端"
                  value={
                    mod.evejsVersions && mod.evejsVersions.length > 0
                      ? mod.evejsVersions.join(" / ")
                      : "—"
                  }
                />
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

            {/*
              作者声明的模组关系，**分两节**（2026-10-24 定案）：
                · 依赖（清单 `requires`，表单里那一栏叫「关联模组 id」）—— 缺了会被跳过，且排在我前面加载
                · 互斥（清单 `conflicts`，表单里那一栏叫「冲突模组 id」）—— 两边都启用时本模组被跳过
              原来两样都挤在一节里、标题还叫「关联模组」，于是**冲突**也显示在「关联」下面 ——
              名字和内容对不上正是这次误填的根源，所以标题也一起拆开。
              一条 id 可能对应本地/市场里的模组，也可能只是一串 id（对不上号的显示「未找到」）。
            */}
            {relations.some((relation) => relation.kind === "requires") ? (
              <Section
                icon={<Link2 className="size-3.5 text-tertiary" />}
                title={t("依赖模组")}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {relations
                    .filter((relation) => relation.kind === "requires")
                    .map((relation) => (
                      <RelationCard key={relation.id} {...relation} />
                    ))}
                </div>
              </Section>
            ) : null}

            {relations.some((relation) => relation.kind === "conflicts") ? (
              <Section
                icon={<Link2 className="size-3.5 text-warning" />}
                title={t("冲突模组")}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {relations
                    .filter((relation) => relation.kind === "conflicts")
                    .map((relation) => (
                      <RelationCard key={relation.id} {...relation} />
                    ))}
                </div>
              </Section>
            ) : null}

            {/* 作者没写要点（正文只有一句话）时整节不出现，不留一个空标题 */}
            {features.length > 0 ? (
              <Section
                icon={<ListChecks className="size-3.5 text-tertiary" />}
                title="功能要点"
              >
                <FeatureList
                  features={features}
                  repo={mod.repo}
                  onOpenExternal={onOpenExternal}
                />
              </Section>
            ) : null}

            <Section
              icon={<FileText className="size-3.5 text-tertiary" />}
              title="功能说明"
            >
              {paragraphs.length > 0 ? (
                /*
                 * 用 Markdown 渲染而不是逐段 `<p>`：作者写的正文里本来就可能带
                 * `**粗体**`、`` `代码` ``、`- 列表`、链接 —— 当纯文本显示时那些符号
                 * 原样露在用户眼前，读起来像乱码。
                 *
                 * 段落之间补空行再整体渲染（Markdown 靠空行分段）：逐段各渲染一次的话，
                 * 列表会被切成一个个独立的 `<ul>`，序号与缩进全丢。
                 *
                 * 安全：ReactMarkdown **默认不放行原始 HTML**（没装 rehype-raw），
                 * 模组作者塞的 `<script>` / `<img onerror>` 只会被当文本转义显示。
                 */
                <div className="md-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    // 链接一律走 MarkdownLink：相对路径按作者仓库解析，谁都不许把
                    // WebView 导航到 `react/NOTICE.md` 这种「应用资产」上去
                    components={{
                      a: ({ href, children }) => (
                        <MarkdownLink
                          href={href}
                          repo={mod.repo}
                          onOpenExternal={onOpenExternal}
                        >
                          {children}
                        </MarkdownLink>
                      ),
                    }}
                  >
                    {paragraphs.join("\n\n")}
                  </ReactMarkdown>
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
          {canRevealFolder ? (
            <Button variant="ghost" onClick={onOpenFolder}>
              <FolderOpen />
              打开所在目录
            </Button>
          ) : null}

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
