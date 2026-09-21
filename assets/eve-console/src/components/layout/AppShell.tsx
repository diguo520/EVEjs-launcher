import type { ReactNode } from "react"
import { SideNav } from "./SideNav"
import { TopBar } from "./TopBar"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="hud-backdrop flex h-screen overflow-hidden bg-background text-foreground">
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="hud-scroll min-w-0 flex-1 overflow-y-auto px-5 py-5">{children}</main>
      </div>
    </div>
  )
}
