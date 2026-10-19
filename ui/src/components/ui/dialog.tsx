import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // 只做淡入：backdrop-blur 在 WebView2 上会先铺一层模糊/阴影，再等内容合成，
      // 看起来就是「先出阴影、详情后到」。遮罩保持轻量，不参与模糊合成。
      "fixed inset-0 z-50 bg-background/70",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // [&>*]:min-w-0 是必须的：容器是 grid，隐式那一列是 auto —— 子元素的 min-content
        // 会把整条轨道撑宽，于是所有子元素一起冲出 max-w-* 的边框（2026-10-01 报障：
        // 切到 ru/de/nl/fr 后模组详情的字段与底部按钮全跑到框外）。把子元素的 min-width
        // 压到 0，轨道就老实待在面板宽度里，装不下的文字由各自的 truncate 收尾。
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-card p-5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.9)] [&>*]:min-w-0",
        // 不能用 animate-in / zoom-in-95 / slide-in-*：tailwindcss-animate 的 enter 关键帧
        // 会覆盖 -translate-x/y-1/2，弹窗先出现在偏右下再跳回中心。这里只做透明度动画，
        // transform 始终留给居中定位（见 index.css 的 dialog-content-motion）。
        "dialog-content-motion",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus:shadow-focus disabled:pointer-events-none">
        <X className="size-4" />
        <span className="sr-only">关闭</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // flex-wrap：外语按钮文案比中文长得多（Опубликовать новую версию / Neue Version
      // veröffentlichen），一行放不下就换行，不能顶出弹窗。
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end", className)}
      {...props}
    />
  )
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-foreground", className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-xs leading-relaxed text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
