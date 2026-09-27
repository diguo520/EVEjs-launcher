import { SectionHeading } from "@/components/common/panel"
import { ServiceCard } from "@/components/dashboard/service-card"
import { LaunchBanner } from "@/components/dashboard/launch-banner"
import { LiveConsole } from "@/components/dashboard/live-console"
import { EnvCheck } from "@/components/dashboard/env-check"
import type { LauncherState } from "@/hooks/use-launcher"
import type { EnvCheckState } from "@/hooks/use-env-check"

export function DashboardPage({
  launcher,
  env,
}: {
  launcher: LauncherState
  env: EnvCheckState
}) {
  const {
    services,
    logs,
    runningCount,
    busyId,
    launchAll,
    startService,
    stopService,
    restartService,
    clearLogs,
  } = launcher

  /**
   * 门禁：自检里缺了启动必需的东西就不放行，而不是拉起来再一个个失败。
   * 按钮那边也是同一个条件按死的，这里再判一次，免得以后多出别的入口绕过门禁。
   */
  function launch() {
    if (env.blockers.length > 0) return
    launchAll()
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="主控台"
        sub="// CORE SERVICE CONTROL"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            集群状态 {runningCount}/{services.length} RUNNING
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            busy={busyId === service.id || busyId === "all"}
            onStart={() => startService(service.id)}
            onStop={() => stopService(service.id)}
            onRestart={() => restartService(service.id)}
          />
        ))}
      </div>

      <LaunchBanner
        running={runningCount}
        total={services.length}
        busy={busyId === "all"}
        blockers={env.blockers}
        onLaunchAll={launch}
        onStopAll={() => services.forEach((s) => stopService(s.id))}
      />

      {/* 同一行内两块面板等高：日志只给最小高度（再多日志也只在框内滚），
          行高由内容较多的那块决定，另一块拉伸补齐，底边始终齐平 */}
      {/* [&>*]:min-w-0：格子的最小宽度默认跟着内容走，日志那类头部很宽的卡片会把窄窗顶破 */}
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <LiveConsole logs={logs} onClear={clearLogs} />
        <EnvCheck env={env} />
      </div>
    </div>
  )
}
