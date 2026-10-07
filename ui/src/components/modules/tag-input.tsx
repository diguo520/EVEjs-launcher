import { useRef, type ChangeEvent, type KeyboardEvent } from "react"
import { X } from "lucide-react"

import { t } from "@/lib/i18n"
import { parseTags } from "@/lib/mod-logic"
import { cn } from "@/lib/utils"

/**
 * 标签 chip 输入：逗号、中文逗号或空白一落下就变成可删除的标签。
 * 最后一个未提交的草稿由表单保存时一起解析，所以点「保存」前不需要先按回车。
 */
export function TagInput({
  id,
  value,
  draft,
  onValueChange,
  onDraftChange,
  placeholder,
  describedBy,
  disabled = false,
}: {
  id: string
  value: string[]
  draft: string
  onValueChange: (next: string[]) => void
  onDraftChange: (next: string) => void
  placeholder: string
  describedBy?: string
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  function commit(raw: string) {
    onValueChange(parseTags([...value, raw].join(" ")))
    onDraftChange("")
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value
    if ((event.nativeEvent as InputEvent).isComposing) {
      onDraftChange(raw)
      return
    }
    const endsWithSeparator = /[,，\s]$/.test(raw)
    const parts = raw.split(/[,，\s]+/)
    const committed = endsWithSeparator ? parts : parts.slice(0, -1)
    if (committed.some((part) => part.trim())) {
      onValueChange(parseTags([...value, ...committed].join(" ")))
    }
    onDraftChange(endsWithSeparator ? "" : (parts.at(-1) ?? ""))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      commit(draft)
      return
    }
    if (event.key === "Backspace" && !draft && value.length > 0) {
      onValueChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background/60 px-2.5 py-1.5 transition-colors",
        "focus-within:border-primary/60 focus-within:shadow-focus",
        disabled && "cursor-not-allowed opacity-50"
      )}
      onClick={() => {
        if (!disabled) inputRef.current?.focus()
      }}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-sm border border-input bg-background/40 px-1.5 py-0.5 text-[10px] text-tertiary"
        >
          {tag}
          <button
            type="button"
            aria-label={t("删除标签「{tag}」", { tag })}
            title={t("删除标签「{tag}」", { tag })}
            disabled={disabled}
            className="rounded-sm text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none"
            onClick={(event) => {
              event.stopPropagation()
              onValueChange(value.filter((item) => item !== tag))
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          const next = event.relatedTarget
          const staysInside = next instanceof Node && event.currentTarget.parentElement?.contains(next)
          if (!staysInside && draft.trim()) commit(draft)
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        aria-describedby={describedBy}
        disabled={disabled}
        className="h-5 min-w-[7rem] flex-1 border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-tertiary disabled:cursor-not-allowed"
      />
    </div>
  )
}