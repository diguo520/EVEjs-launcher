import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

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
import { Label } from "@/components/ui/label"
import { AUTHOR_NAME_PLACEHOLDER, signatureDraft } from "@/lib/mod-logic"
import type { RawTokenCheck, RawTokenStatus } from "@/lib/ipc"
import { cn, copyText } from "@/lib/utils"

/** 毫秒时间戳 → 2026/4/18 21:07，跟身份创建那一栏的写法一致 */
function formatStamp(ms: number): string {
  if (!ms || ms <= 0) return "—"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`
}

export interface ModAuthorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前署名（真值来自 author:get） */
  name: string
  /** 作者标识（author:get.id），只读 */
  authorId: string
  /** 密钥指纹（author:get.keyId），只读 */
  keyId: string
  /** 本机是否有可用的签名私钥 */
  privateKeyExists: boolean
  /** identity 数据目录（author:get.dataDir） */
  dataDir: string
  /** 身份创建时间（毫秒） */
  since: number
  /** GitHub 令牌落盘状态（老用户升级过来时，这里直接是「已保存」） */
  tokenStatus: RawTokenStatus | null
  onSaveName: (name: string) => void
  onSaveToken: (token: string) => Promise<{ ok: boolean; encrypted: boolean; reason?: string }>
  onClearToken: () => void
  onCheckToken: () => Promise<RawTokenCheck>
  onExportKey: () => void
  onImportKey: () => void
  onOpenKeyFolder: () => void
}

/**
 * 本地作者身份。署名是给人看的名字，改它不影响认人——真正认人的是只读的
 * 作者标识与密钥指纹，这两项从密钥算出来，界面上改不了。
 *
 * 发布用的 GitHub 令牌也放在这里，但存储位置跟签名私钥分开：私钥承诺永不外传，
 * 令牌每次发布都得发给 GitHub，两者的保证不一样，混在一个目录里会让承诺失效。
 *
 * **老启动器用户注意**：以前在 Electron 版里配好的身份 key 与 GitHub 令牌，
 * 首次启动新启动器时会自动接管过来（见设置页「老启动器数据接管」），
 * 这里会直接显示为已配置，不需要重新填一遍。
 */
export function ModAuthorDialog({
  open,
  onOpenChange,
  name,
  authorId,
  keyId,
  privateKeyExists,
  dataDir,
  since,
  tokenStatus,
  onSaveName,
  onSaveToken,
  onClearToken,
  onCheckToken,
  onExportKey,
  onImportKey,
  onOpenKeyFolder,
}: ModAuthorDialogProps) {
  // 草稿从「真署名」起手：后端给没填过的身份留的默认名不算填过
  const [draft, setDraft] = useState(() => signatureDraft(name))
  /** 令牌草稿永远从空开始：已保存的不回填明文，粘贴新的就覆盖 */
  const [tokenDraft, setTokenDraft] = useState("")
  const [busy, setBusy] = useState<"token" | "check" | null>(null)
  /** 最近一次校验的结论：登录名或失败原因 */
  const [check, setCheck] = useState<RawTokenCheck | null>(null)

  // 每次打开都按当前身份铺一遍，改到一半关掉再打开不会留着没保存的残留
  useEffect(() => {
    if (open) {
      setDraft(signatureDraft(name))
      setTokenDraft("")
      setCheck(null)
      setBusy(null)
    }
  }, [open, name])

  async function copyId() {
    const ok = await copyText(authorId)
    if (ok) toast.success("作者标识已复制")
    else toast.error("复制失败，请手动选择文本")
  }

  function save() {
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error("署名不能为空", {
        description: "署名会印在模组的作者栏和你发表的评价上。",
      })
      return
    }
    // 跟输入框里真正显示的那份比：占位提示不算改动
    if (trimmed === signatureDraft(name)) {
      toast("署名没有改动", { description: "改完再点保存。" })
      return
    }
    onSaveName(trimmed)
    toast.success(`署名已改为「${trimmed}」`, {
      description: "之后新建的模组与发表的评价都会用这个署名。",
    })
  }

  async function saveToken() {
    const trimmed = tokenDraft.trim()
    if (!trimmed) {
      toast.error("先粘贴令牌", {
        description: "在 GitHub 设置里建一个只授权自己仓库的细粒度令牌，别用全权限的。",
      })
      return
    }
    setBusy("token")
    const reply = await onSaveToken(trimmed)
    setBusy(null)
    if (!reply.ok) {
      toast.error("令牌没能保存", { description: reply.reason ?? "写入失败" })
      return
    }
    setTokenDraft("")
    setCheck(null)
    toast.success("GitHub 令牌已保存", {
      description: reply.encrypted
        ? "已用当前 Windows 账户加密落盘，跟老启动器同一份存储格式。"
        : "已落盘（未加密：本机 DPAPI 不可用）。",
    })
  }

  async function verifyToken() {
    setBusy("check")
    const reply = await onCheckToken()
    setBusy(null)
    setCheck(reply)
    if (reply.ok) {
      toast.success("令牌可用", {
        description: reply.login ? `已通过 GitHub 校验，登录名 ${reply.login}` : "已通过 GitHub 校验。",
      })
    } else {
      toast.error("令牌不可用", { description: reply.reason ?? "GitHub 拒绝了这次校验" })
    }
  }

  function clearCredential() {
    onClearToken()
    setTokenDraft("")
    setCheck(null)
    toast("GitHub 令牌已清除", {
      description: "之后发布模组需要重新配置令牌。",
    })
  }

  const hasToken = tokenStatus?.hasToken === true

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 加了发布凭据之后比矮窗口还高，限高滚动，免得顶部说明被顶出屏幕 */}
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2">
            <span className="tabular text-[10px] font-semibold tracking-[0.18em] text-primary/85">
              // AUTHOR
            </span>
            <span>作者身份</span>
          </DialogTitle>
          {/* 先把「哪个能改、哪个不能改」说清楚，免得有人想改指纹 */}
          <DialogDescription className="rounded-md border border-border border-l-2 border-l-primary/60 bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-tertiary">
            署名只是给人看的名字；真正认人靠下面的作者标识与密钥指纹。签名私钥只存在本地{" "}
            <code className="tabular">_launcher/data/mod-keys/</code>
            ，永不外传、永不打包；发布用的 GitHub 令牌另存一处，见下方。
          </DialogDescription>
        </DialogHeader>

        {/* 四个字段两列并排：上排是名字与标识，下排是密钥与创建时间 */}
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="author-name">署名</Label>
            <Input
              id="author-name"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={AUTHOR_NAME_PLACEHOLDER}
            />
            {/* 发布前有两道硬门槛，署名是其中之一，在这儿就说清楚 */}
            <p className="text-[10px] leading-relaxed text-tertiary">
              署名会印在模组的作者栏和你发表的评价上，发布模组前必须填；
              输入框里那串「{AUTHOR_NAME_PLACEHOLDER}」只是提示，不是替你填好的名字。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="author-id">作者标识</Label>
            {/* 输入框 + 复制按钮并排，复制按钮跟输入框一样高 */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Input
                id="author-id"
                value={authorId || "—"}
                readOnly
                className="tabular"
              />
              <Button
                variant="outline"
                className="border-primary/45 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/20"
                onClick={copyId}
                disabled={!authorId}
              >
                复制
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="author-key">密钥指纹（keyId）</Label>
            {/* 显示短形式；私钥在不在盘上决定这枚徽章 */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Input
                id="author-key"
                value={keyId || "—"}
                readOnly
                title={privateKeyExists ? "签名私钥在本机" : "本机找不到签名私钥"}
                className="tabular"
              />
              <span
                className={cn(
                  "grid h-9 shrink-0 place-items-center rounded-md border px-3 text-[11px] font-semibold tracking-[0.08em]",
                  privateKeyExists
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-warning/40 bg-warning/10 text-warning"
                )}
                title={
                  privateKeyExists
                    ? "密钥可用，提交模组时会用它签名"
                    : "本机没有私钥，提交模组会失败"
                }
              >
                {privateKeyExists ? "KEY OK" : "缺私钥"}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="author-since">身份创建于</Label>
            <Input
              id="author-since"
              value={formatStamp(since)}
              readOnly
              className="tabular"
            />
          </div>
        </div>

        {/* 发布凭据单独一块：令牌必须外传给 GitHub，跟「永不外传」的私钥不是一回事 */}
        <div className="space-y-2 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="panel-label text-tertiary">发布凭据</span>
            <span className="text-[12px] font-semibold text-foreground">GitHub 令牌</span>
            <span
              className={cn(
                "grid h-5 shrink-0 place-items-center rounded-sm border px-1.5 text-[10px] font-semibold tracking-[0.08em]",
                hasToken
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-border bg-secondary/50 text-tertiary"
              )}
            >
              {hasToken ? (tokenStatus?.encrypted ? "已保存 · 加密" : "已保存") : "未配置"}
            </span>
            <div className="min-w-2 flex-1" />
            {hasToken ? (
              <>
                <Button variant="outline" onClick={verifyToken} disabled={busy !== null}>
                  {busy === "check" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  校验令牌
                </Button>
                <Button variant="outline" onClick={clearCredential}>
                  清除令牌
                </Button>
              </>
            ) : null}
          </div>

          {hasToken ? (
            /* 已配置：只报状态与来源，不回填任何明文 */
            <p className="text-[11px] leading-relaxed text-tertiary">
              令牌已在本机落盘（
              <code className="tabular break-all">{tokenStatus?.path || "—"}</code>
              ）。不显示明文；要换一把，直接粘贴新的覆盖即可。
            </p>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Input
                id="author-token"
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="粘贴 GitHub 令牌 ghp_… / github_pat_…"
                className="tabular"
              />
              <Button variant="outline" onClick={saveToken} disabled={busy !== null}>
                {busy === "token" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                保存
              </Button>
            </div>
          )}

          {check ? (
            <p
              className={cn(
                "text-[11px] leading-relaxed",
                check.ok ? "text-success" : "text-warning"
              )}
            >
              最近一次校验：
              {check.ok
                ? `通过${check.login ? `，登录名 ${check.login}` : ""}`
                : check.reason ?? "未通过"}
            </p>
          ) : null}

          <p className="text-[11px] leading-relaxed text-tertiary">
            令牌跟签名私钥分开放，也不进「导出密钥」的包。只在发布模组时发给 GitHub，
            其余时间只在本机使用。老启动器里配好的令牌会在首次启动时自动接管，
            不需要在这里重填。
          </p>
        </div>

        {/* 四个动作等宽铺满一行：保存是主操作，其余三个都是密钥管理 */}
        <DialogFooter className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button variant="outline" onClick={onOpenKeyFolder} disabled={!dataDir}>
            密钥目录
          </Button>
          <Button variant="outline" onClick={onImportKey}>
            导入密钥
          </Button>
          <Button variant="outline" onClick={onExportKey} disabled={!privateKeyExists}>
            导出密钥
          </Button>
          <Button onClick={save} disabled={!authorId}>
            保存署名
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
