import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Clipboard, ClipboardPaste, RotateCw } from "lucide-react"

import { t } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/** 右键那一刻的上下文：选中的文本、以及正在编辑的输入框（粘贴要插回它的光标处） */
interface Ctx {
  x: number
  y: number
  selection: string
  field: HTMLInputElement | HTMLTextAreaElement | null
}

/** 菜单大约多宽多高：只用来把它卡在窗口里，不让它被右边缘切掉 */
const MENU_W = 148
const MENU_H = 96

/** 能粘贴的输入框：文本 / 搜索 / 密码类，以及多行文本域 */
function editableField(node: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (node instanceof HTMLTextAreaElement) return node
  if (!(node instanceof HTMLInputElement)) return null
  const type = node.type
  const textish = ["text", "search", "url", "tel", "email", "password", "number", "date", "time"]
  return textish.includes(type) ? node : null
}

/** 右键时选中的文本：优先输入框内的选区，其次页面上选中的文字 */
function selectionOf(field: Element | null): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? 0
    if (end > start) return field.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ""
}

/** 写剪贴板：Clipboard API 优先，被拒（权限 / 非安全上下文）时退回 execCommand("copy") */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 兜底：临时 textarea + 选区 + execCommand，WebView2 里这条通常还是通的
    const scratch = document.createElement("textarea")
    scratch.value = text
    scratch.setAttribute("readonly", "")
    scratch.style.position = "fixed"
    scratch.style.left = "-9999px"
    document.body.appendChild(scratch)
    scratch.select()
    let ok = false
    try {
      ok = document.execCommand("copy")
    } catch {
      ok = false
    }
    scratch.remove()
    return ok
  }
}

/**
 * 粘贴进输入框：用 execCommand("insertText") 是为了**保住 React 的受控状态与撤销栈** ——
 * 直接改 value 不会触发 onChange，界面上的值会跟 DOM 对不上。
 * 失败才退回「改值 + 手动派发 input 事件」。
 */
function pasteInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  field.focus()
  const caret = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? caret
  try {
    field.setSelectionRange(caret, end)
    if (document.execCommand("insertText", false, text)) return true
  } catch {
    // 下面走兜底
  }
  try {
    const next = field.value.slice(0, caret) + text + field.value.slice(end)
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
    setter?.call(field, next)
    field.setSelectionRange(caret + text.length, caret + text.length)
    field.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  } catch {
    return false
  }
}

/**
 * 启动器窗口里的右键菜单：只留**刷新 / 复制 / 粘贴**三项（2026-09-30 用户要求）。
 *
 * 为什么要自己画：WebView2 默认那套右键菜单（另存为 / 打印 / 重新加载 / 检查…）里的功能
 * 对一个游戏启动器来说全是噪音，而 Tauri 没有「只留几项」的开关 —— 页面里把 contextmenu
 * 的默认行为挡掉，原生菜单就不会弹，剩下的交给这里。
 */
export function AppContextMenu() {
  const [menu, setMenu] = useState<Ctx | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // 挡掉原生菜单：不 preventDefault 的话 WebView2 那套会盖在我们的菜单上
      event.preventDefault()
      const active = document.activeElement
      setMenu({
        x: Math.min(event.clientX, Math.max(0, window.innerWidth - MENU_W)),
        y: Math.min(event.clientY, Math.max(0, window.innerHeight - MENU_H)),
        selection: selectionOf(active),
        field: editableField(active),
      })
    }
    window.addEventListener("contextmenu", onContextMenu)
    return () => window.removeEventListener("contextmenu", onContextMenu)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    // 点别处 / 滚轮 / 改窗口大小 / 窗口失焦都收起来。
    // 这里**不能**挂 contextmenu：右键时先跑「打开」那条监听、再跑这条，菜单会被自己关掉；
    // 在菜单开着时再右键，改为由「打开」那条直接换坐标（setMenu 覆盖）。
    window.addEventListener("mousedown", close)
    window.addEventListener("wheel", close, { passive: true })
    window.addEventListener("resize", close)
    window.addEventListener("blur", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("wheel", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("blur", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [menu])

  const act = useCallback(
    (run: () => void) => (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setMenu(null)
      run()
    },
    []
  )

  if (!menu) return null

  const copy = async () => {
    const text = menu.selection
    if (!text) {
      toast.info(t("没有选中文字，先选中再复制"))
      return
    }
    const done = await writeClipboard(text)
    if (!done) toast.warning(t("复制失败，请用 Ctrl+C"))
  }

  const paste = async () => {
    const field = menu.field
    if (!field) {
      toast.info(t("请先点进要粘贴的输入框"))
      return
    }
    field.focus()
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        if (!pasteInto(field, text)) toast.warning(t("粘贴失败，请用 Ctrl+V"))
        return
      }
    } catch {
      // 浏览器不给读剪贴板：退回原生 paste 命令（能用就直接写进去）
      try {
        if (document.execCommand("paste")) return
      } catch {
        // 两条都不行，下面如实报一句
      }
    }
    toast.warning(t("读不到剪贴板内容，请用 Ctrl+V 粘贴"))
  }

  const item = "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-secondary focus:bg-secondary [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

  return (
    <div
      ref={menuRef}
      role="menu"
      data-evejs-app-menu="1"
      style={{ left: menu.x, top: menu.y }}
      className={cn(
        "fixed z-[100] min-w-[9rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      )}
    >
      <button type="button" role="menuitem" className={item} onMouseDown={act(() => window.location.reload())}>
        <RotateCw />
        {t("刷新")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(item, !menu.selection && "opacity-50")}
        onMouseDown={act(() => void copy())}
      >
        <Clipboard />
        {t("复制")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(item, !menu.field && "opacity-50")}
        onMouseDown={act(() => void paste())}
      >
        <ClipboardPaste />
        {t("粘贴")}
      </button>
    </div>
  )
}
