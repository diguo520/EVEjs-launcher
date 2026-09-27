import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Globe, Minus, Square, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LogoMark } from "@/components/shell/logo-mark"
import { ServiceChip } from "@/components/shell/service-chip"
import { useLauncherVersion } from "@/components/shell/launcher-version"
import { LAUNCHER_META, SERVICES } from "@/lib/mock"

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now.toLocaleTimeString("zh-CN", { hour12: false })
}

/**
 * 赞助渠道的收款码。两张图各自带说明文字，比例也不一样，所以统一按高度contain，
 * 底衬一块白板：二维码在深色底上会扫不出来，白底是功能需要不是配色选择。
 */
const SPONSOR_CODES = [
  { id: "wechat", label: "微信", src: "/sponsor-wechat.jpg", hint: "扫码赞赏" },
  { id: "paypal", label: "PayPal", src: "/sponsor-paypal.jpg", hint: "海外赞助" },
]

export function TopBar({ onInspectService }: { onInspectService: (name: string) => void }) {
  const clock = useClock()
  const { version } = useLauncherVersion()

  return (
    <header className="relative flex h-[58px] shrink-0 items-center gap-4 border-b border-border bg-card/85 px-4 backdrop-blur">
      {/* 底部一条青色信号线，标出「这是活动界面」 */}
      <span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

      <div className="flex min-w-[230px] items-center gap-3">
        <LogoMark className="size-8 shrink-0" />
        <div className="leading-none">
          <div className="text-[14px] font-bold tracking-[0.16em] text-foreground">
            EVEJS COMMAND
          </div>
          <div className="tabular mt-1 text-[10px] tracking-[0.2em] text-primary/85">
            SERVER LAUNCHER · {version}
          </div>
        </div>
      </div>

      <Separator orientation="vertical" className="h-8" />

      <div className="hidden items-center gap-2 xl:flex">
        {SERVICES.map((s) => (
          <ServiceChip
            key={s.id}
            service={s}
            onClick={() => onInspectService(s.name)}
          />
        ))}
      </div>

      <div className="flex-1" />

      <div className="hidden text-right leading-none sm:block">
        <div className="tabular text-[14px] font-semibold text-foreground">{clock}</div>
        <div className="tabular mt-1 text-[10px] tracking-[0.2em] text-tertiary">
          本地时间
        </div>
      </div>

      <Separator orientation="vertical" className="hidden h-8 sm:block" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Globe />
            <span className="hidden sm:inline">中文</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>界面语言</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => toast.info("原型仅提供中文界面")}>
            中文
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.info("原型仅提供中文界面")}>
            English
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hidden items-center gap-2.5 rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 transition-colors hover:border-telemetry/45 focus-visible:outline-none focus-visible:shadow-focus lg:flex"
          >
            <span className="grid size-6 place-items-center rounded-sm border border-telemetry/40 bg-telemetry/10 text-[10px] font-bold text-telemetry">
              TS
            </span>
            <span className="text-left leading-none">
              {/* 两行都不许折：顶栏挤的时候 flex 会把 TOKEN SPONSOR 拆成两行，很难看 */}
              <span className="block whitespace-nowrap text-[12px] text-foreground">
                {LAUNCHER_META.sponsorTitle}
              </span>
              <span className="mt-0.5 block whitespace-nowrap font-mono text-[10px] tracking-[0.14em] text-telemetry">
                TOKEN SPONSOR
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-3">
          <div className="flex items-baseline gap-2">
            <span className="panel-label">赞助渠道</span>
            <span className="text-[10px] text-tertiary">
              扫码即可，金额随意
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SPONSOR_CODES.map((channel) => (
              <div key={channel.id}>
                {/* 白板 + 原图自带的白底拼在一起，深色界面里不会剩一圈黑边 */}
                <div className="rounded-md border border-border bg-white p-1.5">
                  <img
                    src={channel.src}
                    alt={`${channel.label}收款码`}
                    className="h-40 w-full rounded-sm object-contain"
                  />
                </div>
                <div className="mt-1.5 flex items-baseline justify-center gap-1.5">
                  <span className="text-[11px] font-semibold text-foreground">
                    {channel.label}
                  </span>
                  <span className="text-[10px] text-tertiary">
                    {channel.hint}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-tertiary">
            启动器免费提供，赞助用于维持更新服务器开销。二维码来自{" "}
            {LAUNCHER_META.sponsor}，请核对收款人后再转账。
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="hidden h-8 lg:block" />

      <div className="hidden items-center gap-1 lg:flex">
        {[
          { icon: Minus, label: "最小化" },
          { icon: Square, label: "最大化" },
          { icon: X, label: "关闭" },
        ].map(({ icon: Icon, label }) => (
          <Button
            key={label}
            variant="ghost"
            size="icon-sm"
            title={label}
            onClick={() => toast.info(`${label}：原型演示，不控制真实窗口`)}
          >
            <Icon />
            <span className="sr-only">{label}</span>
          </Button>
        ))}
      </div>
    </header>
  )
}
