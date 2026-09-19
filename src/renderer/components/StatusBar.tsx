import type { AppInfo, EnvReport, ServiceInfo } from "../types";

interface Props {
  appInfo: AppInfo | null;
  report: EnvReport | null;
  checking: boolean;
  services: ServiceInfo[];
}

export default function StatusBar({ appInfo, report, checking, services }: Props) {
  const pass = report?.passCount ?? 0;
  const total = report?.totalCount ?? 0;
  const allReady = report ? report.checks.every((c) => c.ok) : false;

  const has = (st: string) => services.some((s) => s.state === st);
  const runningCount = services.filter((s) => s.state === "running").length;

  let machine: string;
  let machineTone: "idle" | "ready" | "warn" | "error" = "idle";
  if (checking) {
    machine = "CHECKING";
    machineTone = "warn";
  } else if (has("starting")) {
    machine = "STARTING";
    machineTone = "warn";
  } else if (has("stopping")) {
    machine = "STOPPING";
    machineTone = "warn";
  } else if (has("error")) {
    machine = "ERROR";
    machineTone = "error";
  } else if (has("running")) {
    machine = `RUNNING ${runningCount}/3`;
    machineTone = "ready";
  } else if (!report) {
    machine = "IDLE";
  } else if (allReady) {
    machine = "READY";
    machineTone = "ready";
  } else {
    machine = "READY · WARN";
    machineTone = "warn";
  }

  return (
    <footer className="statusbar">
      <span className="status-item">
        <span className={`status-dot st-${machineTone}`} />
        {checking ? "环境自检中..." : `环境自检 ${pass}/${total}`}
      </span>
      <span className="status-item status-machine">{machine}</span>
      <span className="status-item status-right">
        {appInfo ? `${appInfo.name} v${appInfo.version} · ${appInfo.repoRoot}` : "..."}
      </span>
      <span className="status-item status-brand">B站的波坤太叔</span>
    </footer>
  );
}
