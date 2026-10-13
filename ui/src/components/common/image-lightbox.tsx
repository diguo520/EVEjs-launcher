import * as DialogPrimitive from "@radix-ui/react-dialog"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { t } from "@/lib/i18n"
import { cn } from "@/lib/utils"

export interface LightboxImage {
  url: string
  alt?: string
}

/**
 * 大图查看器：左右箭头翻页、右上角叉关闭、底部圆点跳转，跟随启动器主题。
 *
 * 为什么用裸的 Radix 原语而不是 `ui/dialog.tsx` 的 `DialogContent`：那个组件**自带**
 * 一个右上角的关闭按钮，这里要的是自己的大号叉 + 全屏无内边距的版式，两个叉会并排出现。
 * 借用 Radix 的 Root/Overlay/Content 只为拿到它白送的那几件事：Esc 关闭、打开时锁滚动、
 * 焦点陷阱与关闭后焦点归位。
 *
 * 交互约定（与游戏内看图一致）：左右键翻页、首尾**循环**、点遮罩关闭、点图本身不关、
 * 只有一张图时不显示箭头。
 */
export function ImageLightbox({
  images,
  startIndex = 0,
  onClose,
}: {
  images: LightboxImage[]
  startIndex?: number
  onClose: () => void
}) {
  const total = images.length
  const [index, setIndex] = useState(() => clamp(startIndex, total))
  const closeRef = useRef<HTMLButtonElement>(null)

  const go = useCallback(
    (delta: number) => {
      if (total <= 0) return
      setIndex((prev) => (prev + delta + total) % total)
    },
    [total],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        go(-1)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        go(1)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [go])

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  if (total === 0) return null
  const current = images[index]

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[60] bg-background/95 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // 点遮罩关闭：事件落在内容层但不在图片/按钮上时才算
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
          className={cn(
            "fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 p-6",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("第 {n} 张，共 {total} 张", { n: index + 1, total })}
          </DialogPrimitive.Title>

          <img
            src={current.url}
            alt={current.alt ?? ""}
            draggable={false}
            className="max-h-[78vh] max-w-[88vw] rounded-lg border border-border bg-card object-contain shadow-lg"
          />

          <DialogPrimitive.Close
            ref={closeRef}
            className={cn(
              "absolute right-4 top-4 flex size-9 items-center justify-center rounded-full",
              "border border-border bg-card/80 text-muted-foreground transition-colors",
              "hover:bg-secondary hover:text-foreground focus:outline-none focus:shadow-focus",
            )}
            aria-label={t("关闭")}
          >
            <X className="size-4" />
          </DialogPrimitive.Close>

          {total > 1 ? (
            <>
              <ArrowButton side="left" onClick={() => go(-1)} />
              <ArrowButton side="right" onClick={() => go(1)} />
              <div className="flex items-center gap-1.5" role="tablist" aria-label={t("切换截图")}>
                {images.map((image, at) => (
                  <button
                    key={image.url + at}
                    type="button"
                    role="tab"
                    aria-selected={at === index}
                    aria-label={t("第 {n} 张，共 {total} 张", { n: at + 1, total })}
                    onClick={() => setIndex(at)}
                    className={cn(
                      "h-1.5 rounded-pill transition-all focus:outline-none focus:shadow-focus",
                      at === index ? "w-5 bg-primary" : "w-1.5 bg-border hover:bg-muted-foreground",
                    )}
                  />
                ))}
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ArrowButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? t("上一张") : t("下一张")}
      className={cn(
        "absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full",
        "border border-border bg-card/80 text-muted-foreground transition-colors",
        "hover:bg-secondary hover:text-foreground focus:outline-none focus:shadow-focus",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      <Icon className="size-5" />
    </button>
  )
}

function clamp(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(0, Math.trunc(value)), total - 1)
}