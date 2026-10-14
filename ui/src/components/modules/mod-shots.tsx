import { useMemo, useState } from "react"

import { ImageLightbox } from "@/components/common/image-lightbox"
import { t } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/**
 * 模组截图：**只在详情弹窗里显示**（卡片上不排图 —— 2026-10-14 维护者要求：
 * 卡片放图会把列表撑得很长，也白白多下几 MB；想看图的自然会点进详情）。
 *
 * 两条纪律：
 *   · **一张都没有就整块不渲染** —— 市场里绝大多数模组暂时没有图，不能留一行空白；
 *   · **加载失败的那张直接摘掉** —— 作者删库、改文件名、图床抽风都会让 URL 404，
 *     与其在界面上留个破图框，不如当它不存在；全挂光了就整块消失。
 */
export function ModShots({
  urls,
  alt,
  className,
}: {
  urls?: string[]
  /** 无障碍替代文本；一般传模组名 */
  alt: string
  className?: string
}) {
  const [broken, setBroken] = useState<string[]>([])
  const [openAt, setOpenAt] = useState<number | null>(null)

  const alive = useMemo(
    () => (urls ?? []).filter((url) => url !== "" && !broken.includes(url)),
    [urls, broken],
  )
  if (alive.length === 0) return null

  return (
    <>
      {/* 单行横向滚动，**不换行**：详情弹窗里还有概览 / 版本历史 / 评论，
          截图一旦自动换行就会连成九宫格，把后面的内容全顶到屏幕外 */}
      <div className={cn("flex gap-2 overflow-x-auto pb-1", className)}>
        {alive.map((url, at) => (
          <button
            key={url}
            type="button"
            onClick={() => setOpenAt(at)}
            aria-label={t("查看第 {n} 张截图", { n: at + 1 })}
            className="shrink-0 rounded-md focus:outline-none focus:shadow-focus"
          >
            <img
              src={url}
              alt={alt}
              loading="lazy"
              draggable={false}
              onError={() => setBroken((prev) => (prev.includes(url) ? prev : [...prev, url]))}
              className="h-16 w-28 rounded-md border border-border bg-card object-cover transition-opacity hover:opacity-85"
            />
          </button>
        ))}
      </div>
      {openAt !== null ? (
        <ImageLightbox
          key={openAt}
          startIndex={openAt}
          images={alive.map((url) => ({ url, alt }))}
          onClose={() => setOpenAt(null)}
        />
      ) : null}
    </>
  )
}
