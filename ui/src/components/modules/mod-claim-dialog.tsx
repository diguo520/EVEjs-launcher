import { useEffect, useMemo, useState } from "react"
import { t } from "@/lib/i18n"
import { toast } from "sonner"
import { KeyRound, Loader2, Search, ShieldCheck } from "lucide-react"

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
import type { RawClaimCandidates, RawClaimItem, RawClaimResult, RawTokenCheck } from "@/lib/ipc"
import { CLAIM_PAGE_SIZE, orderClaimItems, type ClaimQuery } from "@/lib/mod-claim"
import { cn } from "@/lib/utils"

export interface ModClaimDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 本机还有没有可用的签名私钥：有的话导入 .eve-key 就能回到原身份，不必认领 */
  privateKeyExists: boolean
  /**
   * 取一页候选（分页 + 搜索都在后端做）。
   * 候选是「本机装过多少别人署名的模组」的量级（上万条也常见），界面一次只要一页。
   */
  onLoad: (opts: ClaimQuery) => Promise<RawClaimCandidates | null>
  onClaim: (folder: string) => Promise<RawClaimResult>
  onCheckToken: () => Promise<RawTokenCheck>
  /** 去「令牌配置」（认领要核验仓库归属，没有令牌认不了） */
  onOpenToken: () => void
  onImportKey: () => void
}

/**
 * 找回旧模组：重装系统 / 换电脑之后本机换了身份，以前用旧身份发布的模组会被归属保护
 * 当成别人的（见 `src-tauri/src/mods/claim.rs`）。这里列出仓库仍归作者所有的模组，
 * 认领后就回到「我创建的」里，可以继续打包发布。
 *
 * 认领的判据是**后端**核验 GitHub 写权限，不是界面上这张列表说了算；界面只用登录名
 * 把「看起来是你的」排到前面。候选可能上万条，所以按页取、按关键字搜，不一次全渲染。
 */
export function ModClaimDialog({
  open,
  onOpenChange,
  privateKeyExists,
  onLoad,
  onClaim,
  onCheckToken,
  onOpenToken,
  onImportKey,
}: ModClaimDialogProps) {
  const [login, setLogin] = useState("")
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState("")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<RawClaimItem[]>([])
  const [total, setTotal] = useState(0)
  const [skippedCount, setSkippedCount] = useState(0)
  const [needsToken, setNeedsToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 认领成功后重新拉当前这一页的触发器（那条会挪到「已认领」、总数也会变） */
  const [reload, setReload] = useState(0)

  // 每次打开都重新问一遍令牌里的登录名：中间可能刚换过令牌
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBusy("")
    setQuery("")
    setChecking(true)
    void onCheckToken()
      .then((reply) => {
        if (cancelled) return
        setLogin(reply.ok && typeof reply.login === "string" ? reply.login : "")
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, onCheckToken])

  // 打开时 / 换关键字后拉第一页；打字防抖 250ms，不必每敲一下都问一次后端
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(
      () => {
        void onLoad({ offset: 0, limit: CLAIM_PAGE_SIZE, query })
          .then((reply) => {
            if (cancelled || !reply) return
            const next = reply.items ?? []
            setItems(next)
            setTotal(typeof reply.total === "number" ? reply.total : next.length)
            setSkippedCount(reply.skippedCount ?? reply.skipped?.length ?? 0)
            setNeedsToken(reply.needsToken === true)
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      query ? 250 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, reload, onLoad])

  const ordered = useMemo(() => orderClaimItems(items, login), [items, login])
  /** 还有多少条没取回来（后端给的是搜索命中的总数，不是本页长度） */
  const remaining = Math.max(total - items.length, 0)

  async function loadMore() {
    setLoadingMore(true)
    try {
      const reply = await onLoad({ offset: items.length, limit: CLAIM_PAGE_SIZE, query })
      if (!reply) return
      const next = reply.items ?? []
      setItems((prev) => [...prev, ...next])
      setTotal(typeof reply.total === "number" ? reply.total : items.length + next.length)
    } finally {
      setLoadingMore(false)
    }
  }

  async function claim(item: RawClaimItem) {
    setBusy(item.folder)
    const reply = await onClaim(item.folder)
    setBusy("")
    if (reply.ok) {
      toast.success(t("已认领「{name}」，现在可以打包发布新版本了。", { name: item.displayName }), {
        description: reply.repo,
      })
      setReload((tick) => tick + 1)
      return
    }
    if (reply.needsToken) {
      toast.error(reply.reason ?? "认领要核验仓库归属", {
        action: { label: t("去配置令牌"), onClick: onOpenToken },
      })
      return
    }
    toast.error(t("认领失败：{reason}", { reason: reply.reason ?? "仓库归属核验没通过" }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2">
            <span className="tabular text-[10px] font-semibold tracking-[0.18em] text-primary/85">
              // CLAIM
            </span>
            <span>找回旧模组</span>
          </DialogTitle>
          <DialogDescription className="rounded-md border border-border border-l-2 border-l-primary/60 bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-tertiary">
            {t(
              "重装系统或换电脑之后本机身份会变，以前用旧身份发布的模组会被当成别人的。这里列出仓库仍归你所有的模组，认领之后就能接着更新。"
            )}
            <br />
            {t("认领的依据是你的 GitHub 令牌对这个仓库有写权限；核验不过就不会认领。")}
          </DialogDescription>
        </DialogHeader>

        {/* 令牌状态：没有令牌或令牌失效时先给一条出路，别让人在这儿反复点认领 */}
        {!checking && (needsToken || !login) ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            <KeyRound className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t(
                "还没配置 GitHub 令牌。认领要核验仓库归属：先在「令牌配置」里配好你自己的令牌。"
              )}
            </span>
            <Button variant="outline" onClick={onOpenToken}>
              去配置令牌
            </Button>
          </div>
        ) : null}

        {/* 还有私钥的人不用认领：导入当年导出的 .eve-key 就能直接用回原身份 */}
        {privateKeyExists ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-[11px] text-tertiary">
            <span className="min-w-0 flex-1">
              {t("当年导出过 .eve-key 的话，导入它就能直接用回原身份，不需要认领。")}
            </span>
            <Button variant="outline" onClick={onImportKey}>
              导入作者密钥
            </Button>
          </div>
        ) : null}

        {/* 候选可能上万条：搜索与分页都走通道，界面一次只拿一页 */}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("搜索模组名 / ID / 作者 / 标签")}
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          {total > 0 ? (
            <span className="tabular shrink-0 text-[10px] text-tertiary">
              {ordered.length} / {total}
            </span>
          ) : null}
        </div>

        {ordered.length === 0 ? (
          <p className="rounded-md border border-border bg-background/40 px-3 py-4 text-center text-[12px] text-tertiary">
            {loading ? "正在读取…" : query ? "没有匹配的模组" : "没有需要找回的模组"}
          </p>
        ) : (
          <ul className="space-y-2">
            {ordered.map((item) => (
              <li
                key={item.folder}
                className="space-y-1.5 rounded-md border border-border bg-background/40 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">
                    {item.displayName}
                  </span>
                  <span className="tabular shrink-0 text-[10px] text-tertiary">
                    {item.id} · v{item.version}
                  </span>
                  <div className="min-w-2 flex-1" />
                  {item.claimed ? (
                    <span className="grid h-5 shrink-0 place-items-center rounded-sm border border-success/40 bg-success/10 px-1.5 text-[10px] font-semibold tracking-[0.08em] text-success">
                      已认领
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      className="border-primary/45 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/20"
                      onClick={() => void claim(item)}
                      disabled={busy !== ""}
                    >
                      {busy === item.folder ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      {busy === item.folder ? "认领中…" : "认领"}
                    </Button>
                  )}
                </div>
                <div className="grid gap-x-3 gap-y-0.5 text-[10px] leading-relaxed text-tertiary sm:grid-cols-2">
                  <span className="min-w-0 truncate">
                    {t("原署名")}：{item.declaredAuthorName || "—"}
                    <span className="tabular"> {item.declaredAuthorId || "—"}</span>
                  </span>
                  <span className="min-w-0 truncate">
                    {t("仓库")}：
                    <span
                      className={cn("tabular", item.repo ? "text-foreground/80" : "text-warning")}
                      title={item.repo}
                    >
                      {item.repo || "仓库未知"}
                    </span>
                  </span>
                </div>
                {item.reason ? (
                  <p className="text-[10px] leading-relaxed text-warning">{item.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {remaining > 0 ? (
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("加载更多（还有 {count} 个）", { count: remaining })}
          </Button>
        ) : null}

        {skippedCount > 0 ? (
          <p className="text-[10px] leading-relaxed text-tertiary">
            {t("另有 {count} 个模组解析不出仓库地址，暂时无法认领。", {
              count: skippedCount,
            })}
          </p>
        ) : null}

        <DialogFooter className="flex-wrap items-center gap-2 sm:justify-between">
          <span className="flex items-center gap-1.5 text-[10px] text-tertiary">
            <ShieldCheck className="size-3.5 shrink-0" />
            {login ? t("令牌账号：{login}", { login }) : ""}
            {checking ? <Loader2 className="size-3 animate-spin" /> : null}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
