import { useRef, type ChangeEvent, type KeyboardEvent } from "react"
import { X } from "lucide-react"

import { t } from "@/lib/i18n"
import { parseIdList, parseTags } from "@/lib/mod-logic"
import { cn } from "@/lib/utils"

interface ChipInputProps {
  id: string
  value: string[]
  draft: string
  onValueChange: (next: string[]) => void
  onDraftChange: (next: string) => void
  placeholder: string
  describedBy?: string
  disabled?: boolean
  /** 提交一个 chip 时使用的归一化器；标签最多 5 个，关联 id 不设上限。 */
  parse: (raw: string) => string[]
  /** 删除 chip 的无障碍文案由调用方按字段语义提供。 */
  removeLabel?: (item: string) => string
}

/**
 * chip 输入基座：逗号、中文逗号或空白一落下就变成可删除的标签。
 * 最后一个未提交的草稿由表单保存时一起解析，所以点「保存」前不需要先按回车。
 */
function ChipInput({
  id,
  value,
  draft,
  onValueChange,
  onDraftChange,
  placeholder,
  describedBy,
  disabled = false,
  parse,
  removeLabel = (item) => t("删除标签「{tag}」", { tag: item }),
}: ChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  function commit(raw: string) {
    onValueChange(parse([...value, raw].join(" ")))
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
      onValueChange(parse([...value, ...committed].join(" ")))
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
      {value.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded-sm border border-input bg-background/40 px-1.5 py-0.5 text-[10px] text-tertiary"
        >
          {item}
          <button
            type="button"
            aria-label={removeLabel(item)}
            title={removeLabel(item)}
            disabled={disabled}
            className="rounded-sm text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none"
            onClick={(event) => {
              event.stopPropagation()
              onValueChange(value.filter((entry) => entry !== item))
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
          const staysInside =
            next instanceof Node && event.currentTarget.parentElement?.contains(next)
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

/** 标签 chip 输入：逗号、中文逗号或空白分隔，去空去重，最多 5 个。 */
export function TagInput(props: Omit<ChipInputProps, "parse" | "removeLabel">) {
  return <ChipInput {...props} parse={parseTags} />
}

/** 关联模组 id：和标签同样的 chip 交互，但支持任意数量，逗号或空白分隔。 */
export function ModIdInput(props: Omit<ChipInputProps, "parse" | "removeLabel">) {
  return (
    <ChipInput
      {...props}
      parse={parseIdList}
      removeLabel={(item) => t("删除关联模组「{id}」", { id: item })}
    />
  )
}
