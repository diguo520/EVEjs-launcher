import { useEffect, useState } from "react"
import { Minimize2, Power } from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { t } from "@/lib/i18n"
import { call, callOr, subscribe } from "@/lib/ipc"
import type { RawAck } from "@/lib/ipc"

/** 记住的选择写进设置文件的 `closeAction`（见 src-tauri/src/ipc/window.rs） */
type CloseAction = "tray" | "exit"

/**
 * 关窗提示：点窗口右上角的叉不再直接退出，先问一句「收进托盘继续跑」还是「退出程序」。
 *
 * 为什么不让 Rust 直接弹原生框：这个外壳没有引入 dialog 插件，而且原生框和启动器主题
 * 完全是两张皮。所以 Rust 侧在 CloseRequested 里 prevent_close 并发 `app:closeRequested`，
 * 这里接到就开一个启动器自己的框；把框关掉（叉 / Esc / 点遮罩）= 取消，窗口留着不动。
 *
 * 「记住我的选择」勾上之后，选择写进 `closeAction`，**下次关窗 Rust 直接照做、不再问**
 * （设置在设置中心的「通用」里，可以改回每次都问）。
 *
 * 为什么值得拦一下：主服务器与市场服务经常正在跑，直接退出会连带把它们杀掉；
 * 而窗口右上角那个叉是最容易误点的位置。
 */
export function ClosePrompt() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  // 订阅返回的就是 unlisten，直接当成 effect 的清理函数
  useEffect(() => subscribe("onAppCloseRequested", () => setOpen(true)), [])

  async function runAction(action: CloseAction) {
    setOpen(false)
    if (remember) {
      // 记不住也不影响这次动作照样执行 —— 写失败只意味着下次还得再问一遍
      await callOr<RawAck>("settingsSet", null, { closeAction: action })
      setRemember(false)
    }
    if (action === "tray") {
      void call("windowHideToTray").catch(() => undefined)
    } else {
      void call("appQuit").catch(() => undefined)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("关闭启动器？")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "主服务器或市场服务可能还在运行：收进托盘可以继续跑，退出程序会一并把它们关掉。"
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Checkbox
            checked={remember}
            onCheckedChange={(value) => setRemember(value === true)}
            aria-label={t("记住我的选择")}
          />
          {t("记住我的选择")}
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
          <Button variant="secondary" onClick={() => void runAction("tray")}>
            <Minimize2 />
            {t("最小化到托盘")}
          </Button>
          <Button variant="destructive" onClick={() => void runAction("exit")}>
            <Power />
            {t("退出程序")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}