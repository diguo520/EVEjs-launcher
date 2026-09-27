import { useState } from "react"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  LauncherVersionProvider,
  useLauncherVersionState,
} from "@/components/shell/launcher-version"
import { TopBar } from "@/components/shell/top-bar"
import { SideNav } from "@/components/shell/side-nav"
import { StatusBar } from "@/components/shell/status-bar"
import type { ViewId } from "@/components/shell/nav-config"
import { useLauncher } from "@/hooks/use-launcher"
import { useLauncherAccounts } from "@/hooks/use-launcher-accounts"
import { useEnvCheck } from "@/hooks/use-env-check"
import { SERVER_CONFIG } from "@/lib/mock"
import { DashboardPage } from "@/pages/dashboard-page"
import { ConsolePage } from "@/pages/console-page"
import { AccountsPage } from "@/pages/accounts-page"
import { CommandsPage } from "@/pages/commands-page"
import { DatabasePage } from "@/pages/database-page"
import { ModulesPage } from "@/pages/modules-page"
import { ConfigPage } from "@/pages/config-page"
import { SettingsPage } from "@/pages/settings-page"

/**
 * 启动器外壳：顶栏（服务状态 + 时钟）/ 侧栏（八页导航）/ 内容区 / 状态栏。
 * 服务与日志状态提升到这里，供主控台、服务器日志、顶栏、状态栏共用。
 */
export function App() {
  const launcher = useLauncher()
  const launcherVersion = useLauncherVersionState()
  /** 账号与角色：到游戏里建号要等客户端几秒，状态挂在外壳上，切页也不会丢 */
  const accounts = useLauncherAccounts()
  /** 配置里的服务端根目录：配置中心改它，环境自检与模组页跟着变 */
  const [serverRoot, setServerRoot] = useState(SERVER_CONFIG.root)
  const env = useEnvCheck({
    serverRoot,
    launcherVersion: launcherVersion.version,
    onRestoreRoot: () => setServerRoot(SERVER_CONFIG.root),
  })
  const [view, setView] = useState<ViewId>("dashboard")

  function inspectService(name: string) {
    const svc = launcher.services.find((s) => s.name === name)
    if (!svc) return
    toast.info(`${svc.name} · ${svc.desc}`, {
      description: `端口 ${svc.port} · ${
        svc.state === "running" ? "运行中" : "未启动"
      } · PID ${svc.pid ?? "—"}`,
    })
  }

  function renderView() {
    switch (view) {
      case "dashboard":
        return <DashboardPage launcher={launcher} env={env} />
      case "console":
        return <ConsolePage launcher={launcher} />
      case "accounts":
        return <AccountsPage store={accounts} />
      case "commands":
        return <CommandsPage />
      case "database":
        return <DatabasePage />
      case "modules":
        return <ModulesPage serverRoot={serverRoot} onNavigate={setView} />
      case "config":
        return <ConfigPage serverRoot={serverRoot} onSaveRoot={setServerRoot} />
      case "settings":
        return <SettingsPage />
    }
  }

  return (
    <LauncherVersionProvider value={launcherVersion}>
      <TooltipProvider delayDuration={180}>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {/* 环境光与参考网格：低光指挥室里唯一的装饰层 */}
          <div
            className="mission-glow pointer-events-none fixed inset-0 z-0"
            aria-hidden="true"
          />
          <div
            className="mission-grid pointer-events-none fixed inset-0 z-0"
            aria-hidden="true"
          />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <TopBar onInspectService={inspectService} />

            <div className="flex min-h-0 flex-1">
              <SideNav active={view} onNavigate={setView} metrics={launcher.metrics} />
              <main className="min-w-0 flex-1 overflow-y-auto p-5">
                {renderView()}
              </main>
            </div>

            <StatusBar env={env} />
          </div>
        </div>

        <Toaster />
      </TooltipProvider>
    </LauncherVersionProvider>
  )
}

export default App
