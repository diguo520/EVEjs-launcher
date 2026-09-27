import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 指挥台标准面板：一条 tag/标题/元数据/操作 的头部 + 内容区。
 * 全站所有信息块都走这个壳，保证节奏一致。
 */
export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  tag?: string
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  bodyClassName?: string
  /** 内容区去掉内边距（终端、表格等自带留白的内容用） */
  flush?: boolean
}

export function Panel({
  tag,
  title,
  meta,
  actions,
  className,
  bodyClassName,
  flush = false,
  children,
  ...props
}: PanelProps) {
  return (
    <section
      className={cn("flex flex-col rounded-lg border border-border bg-card", className)}
      {...props}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-input px-4 py-2.5">
        {tag ? (
          <span className="tabular text-[10px] tracking-[0.1em] text-tertiary">{tag}</span>
        ) : null}
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h3>
        <div className="min-w-2 flex-1" />
        {meta ? (
          <span className="tabular text-[11px] text-muted-foreground">{meta}</span>
        ) : null}
        {actions}
      </header>
      <div className={cn("min-h-0 flex-1", flush ? "" : "p-4", bodyClassName)}>
        {children}
      </div>
    </section>
  )
}

/** 视图级标题：竖条 + 中文名 + 等宽副标 */
export function SectionHeading({
  title,
  sub,
  actions,
  className,
}: {
  title: string
  sub?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <span className="h-4 w-[3px] shrink-0 rounded-sm bg-primary" />
      <h2 className="text-[18px] font-semibold text-foreground">{title}</h2>
      {sub ? (
        <span className="tabular text-[11px] tracking-[0.1em] text-tertiary">{sub}</span>
      ) : null}
      <div className="min-w-2 flex-1" />
      {actions}
    </div>
  )
}

/** 遥测数据瓦片：标签 + 大号等宽数值 + 单位 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  tone = "telemetry",
  className,
}: {
  label: string
  value: React.ReactNode
  unit?: string
  delta?: React.ReactNode
  tone?: "telemetry" | "primary" | "success" | "warning" | "destructive" | "foreground"
  className?: string
}) {
  const toneClass = {
    telemetry: "text-telemetry",
    primary: "text-primary",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    foreground: "text-foreground",
  }[tone]

  return (
    <div className={cn("rounded-lg border border-border bg-card p-3", className)}>
      <div className="panel-label">{label}</div>
      <div className={cn("tabular mt-1.5 text-2xl font-bold leading-none", toneClass)}>
        {value}
        {unit ? (
          <span className="ml-1.5 font-mono text-[11px] font-normal text-tertiary">
            {unit}
          </span>
        ) : null}
      </div>
      {delta ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">{delta}</div>
      ) : null}
    </div>
  )
}
