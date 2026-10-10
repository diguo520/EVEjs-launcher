import { ShieldAlert, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * 法律声明正文：五条，各自独立成目录条目，方便在七种外语里逐条对照翻译。
 * 中文是母版，其它语言在 `ui/src/locales/*.json`，翻译桥按当前界面语言取。
 */
const NOTICE_ITEMS = [
  "EVE Online 及其名称、美术、剧情、音频、数据等知识产权归 Fenris Creations 所有；本项目与 Fenris Creations 无任何关联，也未获得其授权、认可或支持。",
  "禁止使用本项目架设面向公众或半公开的「私服」，禁止对外提供游戏服务、商业运营、收费、引流或以任何形式获利。",
  "上述行为可能构成对他人著作权的侵害，并可能违反所在国家或地区有关著作权、计算机与网络、电信业务、经营性互联网信息服务等法律法规；由此产生的全部法律责任由行为人自行承担。",
  "请勿公开传播服务端程序、客户端资源或其它可能侵犯他人权利的内容。",
  "如不同意本声明，请立即停止使用并删除本软件。",
]

/**
 * 法律声明弹窗：第一次启动时自动弹一次，关掉之后由状态栏底部的入口随时重新打开。
 * 只负责画，不管「看过没有」——那部分在 `lib/legal-notice.ts` 与外壳里。
 */
export function LegalNoticeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2">
            <span className="tabular text-[10px] font-semibold tracking-[0.18em] text-warning/85">
              // LEGAL NOTICE
            </span>
            <span>法律声明</span>
          </DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            本启动器与 EveJS 服务端源码仅供个人学习、研究与技术交流使用。请在使用前完整阅读以下声明，继续使用即视为已知晓并同意。
          </DialogDescription>
        </DialogHeader>

        {/* 五条声明正文：长文本可滚动，不把弹窗撑出屏幕 */}
        <div className="max-h-[46vh] overflow-y-auto rounded-md border border-warning/35 bg-warning/[0.06] px-3 py-2.5">
          <ol className="space-y-2">
            {NOTICE_ITEMS.map((item, index) => (
              <li
                key={item}
                className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground"
              >
                <span className="tabular mt-[1px] shrink-0 text-[11px] font-semibold text-warning">
                  {index + 1}
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ol>
        </div>

        <DialogFooter>
          <div className="hidden flex-1 items-center gap-1.5 text-[11px] text-tertiary sm:flex">
            <ShieldAlert className="size-3.5 shrink-0 text-warning" />
            关闭后会缩到窗口底部，随时可以再看。
          </div>
          <Button onClick={() => onOpenChange(false)}>
            <ShieldCheck />
            我已阅读并知晓
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
