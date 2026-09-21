/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export const Dropdown = DropdownPrimitive.Root
export const DropdownTrigger = DropdownPrimitive.Trigger

export function DropdownContent({
  children,
  align = "end",
  className,
}: {
  children: ReactNode
  align?: "start" | "center" | "end"
  className?: string
}) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={4}
        className={cn(
          "z-50 min-w-[168px] overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md",
          className,
        )}
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  )
}

export function DropdownItem({
  children,
  onSelect,
  tone = "default",
  disabled,
}: {
  children: ReactNode
  onSelect?: () => void
  tone?: "default" | "danger"
  disabled?: boolean
}) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-secondary",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        tone === "danger"
          ? "text-red-300 data-[highlighted]:text-red-200"
          : "text-popover-foreground",
      )}
    >
      {children}
    </DropdownPrimitive.Item>
  )
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" />
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownPrimitive.Label className="px-2 py-1 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </DropdownPrimitive.Label>
  )
}
