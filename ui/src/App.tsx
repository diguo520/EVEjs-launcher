import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  LauncherVersionProvider,
  useLauncherVersionState,
} from "@/components/shell/launcher-version"
import { TopBar } from "@/components/shell/top-bar"
import { SideNav } from "@/components/shell/side-nav"
import { AppContextMenu } from "@/components/shell/app-menu"
import { BootSplash } from "@/components/shell/boot-splash"
import { LegalNoticeDialog } from "@/components/shell/legal-notice-dialog"
import { useLocale } from "@/components/shell/locale-provider"
import { StatusBar } from "@/components/shell/status-bar"
import type { NavBadges, ViewId } from "@/components/shell/nav-config"
import { useLauncher } from "@/hooks/use-launcher"
import { useLauncherAccounts } from "@/hooks/use-launcher-accounts"
import { useEnvCheck } from "@/hooks/use-env-check"
import { callOr, hasIpc, type RawModList } from "@/lib/ipc"
import { markLegalNoticeSeen, needsLegalNotice } from "@/lib/legal-notice"
import { DashboardPage } from "@/pages/dashboard-page"
import { ConsolePage } from "@/pages/console-page"
import { GameConfigPage } from "@/pages/game-config-page"
import { StaticDataPage } from "@/pages/static-data-page"
import { AccountsPage } from "@/pages/accounts-page"
import { CommandsPage } from "@/pages/commands-page"
import { DatabasePage } from "@/pages/database-page"
import { MarketPage } from "@/pages/market-page"
import { ModulesPage } from "@/pages/modules-page"
import { ConfigPage } from "@/pages/config-page"
import { SettingsPage } from "@/pages/settings-page"

/**
 * 开机画面：窗口一显示就盖在整屏上，等后端第一次握手回来（或到点兜底）再淡出。
 *
 * 最少亮 BOOT_MIN_MS，让动画走完一遍（数据到早了也不闪一下就没）；
 * 最多等 BOOT_MAX_MS，后端忙也不能一直盖着；淡出时长跟 index.css 的 .boot-splash 对齐。
 */
const BOOT_MIN_MS = 900
const BOOT_MAX_MS = 2400
const BOOT_FADE_MS = 400

/**
 * 侧栏徽标的计数：账号数来自账号库，模组数来自后端 mods:list。
 * 原型里这两个数字（3 / 6）是写死的演示值 —— 这里一律用真数据，读不到就不画。
 */
function useNavBadges(accountCount: number): NavBadges {
  const [modCount, setModCount] = useState(0)

  useEffect(() => {
    if (!hasIpc()) return
    let alive = true
    void callOr<RawModList>("modsList", null).then((reply) => {
      if (alive && reply && Array.isArray(reply.mods)) setModCount(reply.mods.length)
    })
    return () => {
      alive = false
    }
  }, [])

  return useMemo(
    () => ({ accounts: accountCount, modules: modCount }),
    [accountCount, modCount]
  )
}

/**
 * 启动器外壳：顶栏（服务状态 + 时钟）/ 侧栏（八页导航）/ 内容区 / 状态栏。
 * 服务与日志状态提升到这里，供主控台、服务器日志、顶栏、状态栏共用。
 */
export function App() {
  // LocaleProvider 由 main.tsx 挂在最外层，这里能直接取当前语言与 `t()`
  const { t } = useLocale()
  const launcher = useLauncher()
  const launcherVersion = useLauncherVersionState()
  /** 账号与角色：到游戏里建号要等客户端几秒，状态挂在外壳上，切页也不会丢 */
  const accounts = useLauncherAccounts()
  /** 服务端根目录：默认取后端 app:info（不再用原型里那串写死的路径），配置中心改过就用改过的 */
  const [rootOverride, setRootOverride] = useState<string | null>(null)
  const serverRoot = rootOverride ?? launcherVersion.repoRoot
  // 自检与修复都走后端（env:check / init:run），不再吃原型那套演示状态
  const env = useEnvCheck()
  const [view, setView] = useState<ViewId>("dashboard")
  const navBadges = useNavBadges(accounts.accounts.length)

  /** 开机画面：最短展示时间走完 + 第一次握手有回音，才放它淡出 */
  const [bootMinPassed, setBootMinPassed] = useState(false)
  const [bootReady, setBootReady] = useState(() => !hasIpc())
  const [splashMounted, setSplashMounted] = useState(true)

  /**
   * 法律声明：第一次启动自动弹一次；关掉之后缩成状态栏底部的一个入口，之后随时能再打开。
   * `legalAcknowledged` 既决定还要不要自动弹，也决定底部入口出不出现。
   */
  const [legalAcknowledged, setLegalAcknowledged] = useState(() => !needsLegalNotice())
  const [legalOpen, setLegalOpen] = useState(false)

  function closeLegalNotice() {
    setLegalOpen(false)
    if (legalAcknowledged) return
    markLegalNoticeSeen()
    setLegalAcknowledged(true)
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setBootMinPassed(true), BOOT_MIN_MS)
    return () => window.clearTimeout(timer)
  }, [])

  // 等开机画面收掉再弹：盖在开机画面底下弹出来，看着像没弹
  useEffect(() => {
    if (splashMounted || legalAcknowledged) return
    setLegalOpen(true)
  }, [splashMounted, legalAcknowledged])

  // 第一次握手：app:info 回来就算接上；纯浏览器里没有 IPC，一上来就算就绪
  useEffect(() => {
    if (bootReady) return
    if (!hasIpc() || launcherVersion.repoRoot) setBootReady(true)
  }, [bootReady, launcherVersion.repoRoot])

  // 后端迟迟不回也不能一直盖着
  useEffect(() => {
    const timer = window.setTimeout(() => setBootReady(true), BOOT_MAX_MS)
    return () => window.clearTimeout(timer)
  }, [])

  const booting = splashMounted && !(bootReady && bootMinPassed)

  useEffect(() => {
    if (booting) return
    const timer = window.setTimeout(() => setSplashMounted(false), BOOT_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [booting])

  function inspectService(name: string) {
    const svc = launcher.services.find((s) => s.name === name)
    if (!svc) return
    toast.info(t("{name} · {desc}", { name: t(svc.name), desc: t(svc.desc) }), {
      description: t("端口 {port} · {state} · PID {pid}", {
        port: svc.port,
        state:
          svc.state === "running"
            ? t("运行中")
            : svc.state === "starting"
              ? t("启动中")
              : svc.state === "stopping"
                ? t("正在停止…")
                : t("未启动"),
        pid: svc.pid ?? "—",
      }),
    })
  }

  function renderView() {
    switch (view) {
      case "dashboard":
        return <DashboardPage launcher={launcher} env={env} />
      case "console":
        return <ConsolePage launcher={launcher} />
      case "gameconfig":
        return <GameConfigPage />
      case "staticdata":
        return <StaticDataPage />
      case "accounts":
        return <AccountsPage store={accounts} />
      case "commands":
        return <CommandsPage />
      case "database":
        return <DatabasePage />
      case "market":
        return <MarketPage />
      case "modules":
        return <ModulesPage serverRoot={serverRoot} onNavigate={setView} />
      case "config":
        return (
          <ConfigPage
            serverRoot={serverRoot}
            onRootSaved={(root) => {
              setRootOverride(root)
              // 根目录换了，自检结论跟配置清单全都得重来一遍
              env.recheck()
            }}
          />
        )
      case "settings":
        return <SettingsPage />
    }
  }

  return (
    <LauncherVersionProvider value={launcherVersion}>
      <TooltipProvider delayDuration={180}>
        {/* data-evejs-renderer="react"：G1 运行时自检（src-tauri/src/ipc/smoke.rs）靠它判定 React
            渲染层真的挂载了（要求该节点有子元素）。属性不可改名、不可删除。 */}
        <div
          data-evejs-renderer="react"
          className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground"
        >
          {/* 环境光与参考网格：低光指挥室里唯一的装饰层 */}
          <div
            className="mission-glow pointer-events-none fixed inset-0 z-0"
            aria-hidden="true"
          />
          <div
            className="mission-grid pointer-events-none fixed inset-0 z-0"
            aria-hidden="true"
          />

          {/* 右键只留 刷新 / 复制 / 粘贴：原生那套 WebView2 菜单在启动器里全是噪音 */}
          <AppContextMenu />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <TopBar onInspectService={inspectService} services={launcher.services} />

            <div className="flex min-h-0 flex-1">
              <SideNav
                active={view}
                onNavigate={setView}
                metrics={launcher.metrics}
                badges={navBadges}
              />
              <main className="min-w-0 flex-1 overflow-y-auto p-5">
                {renderView()}
              </main>
            </div>

            <StatusBar
              env={env}
              services={launcher.services}
              session={launcher.session}
              onOpenLegalNotice={legalAcknowledged ? () => setLegalOpen(true) : undefined}
            />
          </div>

          <LegalNoticeDialog
            open={legalOpen}
            onOpenChange={(next) => (next ? setLegalOpen(true) : closeLegalNotice())}
          />

          {/* 开机画面：纯前端覆盖层，G1 自检认的那个根节点原样不动 */}
          {splashMounted ? (
            <BootSplash
              visible={booting}
              status={bootReady ? "指挥台就绪" : "正在接入本地服务"}
            />
          ) : null}
        </div>

        <Toaster />
      </TooltipProvider>
    </LauncherVersionProvider>
  )
}

export default App
