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
import {
  AUTHOR_NAME_PLACEHOLDER,
  DEVICE_TOKEN_TTL_MS,
  credentialLabel,
  isCredentialLive,
  keyIdOf,
  makeDeviceCode,
  makeDeviceToken,
  minutesLeft,
  type PublishCredential,
} from "@/lib/mod-logic"
import { MOD_AUTHOR } from "@/lib/mock"
import { cn, copyText } from "@/lib/utils"

/** 2026-04-18 21:07:33 → 2026/4/18 21:07:33，跟身份创建那一栏的写法一致 */
function formatStamp(value: string): string {
  const [date, time] = value.split(" ")
  const [year, month, day] = date.split("-")
  if (!year || !month || !day) return value
  return `${year}/${Number(month)}/${Number(day)}${time ? ` ${time}` : ""}`
}

/**
 * 本地作者身份。署名是给人看的名字，改它不影响认人——真正认人的是只读的
 * 作者标识与密钥指纹，这两项从密钥算出来，界面上改不了。
 *
 * 发布用的 GitHub 凭据也放在这里，但存储位置跟签名私钥分开：私钥承诺永不外传，
 * 令牌每次发布都得发给 GitHub，两者的保证不一样，混在一个目录里会让承诺失效。
 *
 * 凭据有两条路：设备授权换一把一小时后失效的临时令牌（本机不留长期东西，推荐），
 * 或者手动粘一个长期令牌。界面上要说清这两条路的差别，别让人以为它们一样。
 */
export function ModAuthorDialog({
  open,
  onOpenChange,
  name,
  onSaveName,
  credential,
  onSaveCredential,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前署名 */
  name: string
  onSaveName: (name: string) => void
  /** 已配好的发布凭据，null 表示还没配 */
  credential: PublishCredential | null
  onSaveCredential: (credential: PublishCredential | null) => void
}) {
  const [draft, setDraft] = useState(name)
  /** 令牌草稿永远从空开始：已保存的不回填明文，粘贴新的就覆盖 */
  const [tokenDraft, setTokenDraft] = useState("")
  /** 非空表示正在等浏览器里确认，值是那串一次性授权码 */
  const [authCode, setAuthCode] = useState<string | null>(null)
  /** 临时凭据按分钟走，剩余时间得跟着走，不能停在打开对话框那一刻 */
  const [now, setNow] = useState(() => Date.now())

  // 每次打开都按当前身份铺一遍，改到一半关掉再打开不会留着没保存的残留
  useEffect(() => {
    if (open) {
      setDraft(name)
      setTokenDraft("")
      setAuthCode(null)
      setNow(Date.now())
    }
  }, [open, name])

  // 授权等待期间走一遍「浏览器里确认 → 换到临时凭据」，原型里用定时器代替轮询
  useEffect(() => {
    if (!open || authCode === null) return
    const timer = window.setTimeout(() => {
      onSaveCredential({
        kind: "device",
        token: makeDeviceToken(),
        expiresAt: Date.now() + DEVICE_TOKEN_TTL_MS,
      })
      setAuthCode(null)
      setNow(Date.now())
      toast.success("已授权发布凭据", {
        description: "换到的是一小时后失效的临时令牌，本机不留长期令牌。",
      })
    }, 3200)
    return () => window.clearTimeout(timer)
  }, [open, authCode, onSaveCredential])

  // 剩余时间每分钟都在变，隔一会儿刷一次，免得显示的是过期前的数字
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 20000)
    return () => window.clearInterval(timer)
  }, [open])

  async function copyId() {
    const ok = await copyText(MOD_AUTHOR.id)
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
    if (trimmed === name) {
      toast("署名没有改动", { description: "改完再点保存。" })
      return
    }
    onSaveName(trimmed)
    toast.success(`署名已改为「${trimmed}」`, {
      description: "之后新建的模组与发表的评价都会用这个署名。",
    })
  }

  function saveToken() {
    const trimmed = tokenDraft.trim()
    if (!trimmed) {
      toast.error("先粘贴令牌", {
        description: "在 GitHub 设置里建一个只授权自己仓库的细粒度令牌，别用全权限的。",
      })
      return
    }
    onSaveCredential({ kind: "pat", token: trimmed, expiresAt: 0 })
    setTokenDraft("")
    toast.success("长期令牌已保存", {
      description: "会一直留在凭据目录里，直到你手动清除。",
    })
  }

  function clearCredential() {
    const wasDevice = credential?.kind === "device"
    onSaveCredential(null)
    setTokenDraft("")
    toast(wasDevice ? "已断开授权" : "长期令牌已清除", {
      description: "之后发布模组需要重新配置凭据。",
    })
  }

  const live = isCredentialLive(credential, now)
  const deviceExpired =
    credential?.kind === "device" && minutesLeft(credential, now) === 0

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
                value={MOD_AUTHOR.id}
                readOnly
                className="tabular"
              />
              <Button
                variant="outline"
                className="border-primary/45 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/20"
                onClick={copyId}
              >
                复制
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="author-key">密钥指纹（keyId）</Label>
            {/* 显示短形式；完整指纹挂在悬停提示里，需要核对时还能看到 */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Input
                id="author-key"
                value={keyIdOf(MOD_AUTHOR.fingerprint)}
                readOnly
                title={`完整指纹：${MOD_AUTHOR.fingerprint}`}
                className="tabular"
              />
              <span
                className="grid h-9 shrink-0 place-items-center rounded-md border border-success/40 bg-success/10 px-3 text-[11px] font-semibold tracking-[0.08em] text-success"
                title="密钥可用，提交模组时会用它签名"
              >
                KEY OK
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="author-since">身份创建于</Label>
            <Input
              id="author-since"
              value={formatStamp(MOD_AUTHOR.joinedAt)}
              readOnly
              className="tabular"
            />
          </div>
        </div>

        {/* 发布凭据单独一块：令牌必须外传给 GitHub，跟「永不外传」的私钥不是一回事 */}
        <div className="space-y-2 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="panel-label text-tertiary">发布凭据</span>
            <span className="text-[12px] font-semibold text-foreground">GitHub</span>
            <span
              className={cn(
                "grid h-5 shrink-0 place-items-center rounded-sm border px-1.5 text-[10px] font-semibold tracking-[0.08em]",
                authCode
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : live
                    ? "border-success/40 bg-success/10 text-success"
                    : deviceExpired
                      ? "border-warning/40 bg-warning/10 text-warning"
                      : "border-border bg-secondary/50 text-tertiary"
              )}
            >
              {authCode
                ? "授权中"
                : live
                  ? "已配置"
                  : deviceExpired
                    ? "已过期"
                    : "未配置"}
            </span>
          </div>

          {authCode ? (
            /* 等确认：把码亮出来，同时告诉人去哪儿输 */
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-[12px] text-foreground">
                  等待你在浏览器里确认…
                </span>
                <div className="min-w-2 flex-1" />
                <Button variant="outline" onClick={() => setAuthCode(null)}>
                  取消
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="panel-label text-tertiary">授权码</span>
                <span className="tabular rounded-sm border border-primary/40 bg-background/60 px-2 py-0.5 text-[13px] font-semibold tracking-[0.14em] text-primary">
                  {authCode}
                </span>
                <span className="text-[11px] text-tertiary">
                  在 github.com/login/device 输入这串码
                </span>
              </div>
            </div>
          ) : credential ? (
            /* 已配置：只报状态与来源，不回填任何明文 */
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <span
                className={cn(
                  "tabular grid h-9 items-center truncate rounded-md border bg-background/60 px-3 text-[12px]",
                  live ? "border-input text-foreground" : "border-warning/40 text-warning"
                )}
              >
                {credentialLabel(credential, now)}
              </span>
              <Button variant="outline" onClick={clearCredential}>
                {credential.kind === "device" ? "断开授权" : "清除令牌"}
              </Button>
            </div>
          ) : (
            /* 未配置：推荐走设备授权，手动粘长期令牌作为备选 */
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  className="border-primary/45 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/20"
                  onClick={() => setAuthCode(makeDeviceCode())}
                >
                  用 GitHub 授权
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  推荐 · 本机不留长期令牌
                </span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <Input
                  id="author-token"
                  type="password"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder="或粘贴长期令牌 ghp_…"
                  className="tabular"
                />
                <Button variant="outline" onClick={saveToken}>
                  保存
                </Button>
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-tertiary">
            单独存在 <code className="tabular">_launcher/data/credentials/</code>
            ，跟签名私钥分开放，也不进「导出密钥」的包。只在发布模组时发给 GitHub
            ，其余时间只在本机使用。
            {credential?.kind === "pat"
              ? "长期令牌会一直留着，想换成不留长期令牌的临时凭据，清除后改用授权。"
              : deviceExpired
                ? "临时凭据已过期，发布前重新授权一次即可。"
                : credential
                  ? "临时凭据一小时后失效，本机不留能长期用的东西。"
                  : "手动粘的令牌长期有效，会一直留在这里直到清除。"}
          </p>
        </div>

        {/* 四个动作等宽铺满一行：保存是主操作，其余三个都是密钥管理 */}
        <DialogFooter className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button
            variant="outline"
            onClick={() =>
              toast("已打开密钥目录", {
                description: "_launcher/data/mod-keys/ · 原型演示，不打开真实目录",
              })
            }
          >
            密钥目录
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast("导入密钥", {
                description: "选择已有的私钥文件接续身份。原型演示，不读取真实文件。",
              })
            }
          >
            导入密钥
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast("导出密钥", {
                description:
                  "只导出签名私钥，不含 GitHub 令牌。导出的私钥请自行保管，泄露等于身份被冒用。",
              })
            }
          >
            导出密钥
          </Button>
          <Button onClick={save}>保存署名</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
