/* eslint-disable react-refresh/only-export-components -- 本文件同时导出组件与其配套常量/hook（或直出 radix 原语），拆成多文件只会让引用变碎。 */
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "@/lib/utils"

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 p-0.5",
        className,
      )}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 font-mono text-xs uppercase tracking-[0.12em] whitespace-nowrap transition-colors",
        "text-muted-foreground hover:text-foreground",
        "data-[state=active]:bg-primary/15 data-[state=active]:text-primary",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: TabsPrimitive.TabsContentProps) {
  return (
    <TabsPrimitive.Content
      className={cn("focus-visible:outline-none", className)}
      {...props}
    />
  )
}
