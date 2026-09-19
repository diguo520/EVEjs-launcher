import { useEffect, useMemo, useState } from "react";
import type { CheckItem, EnvReport, ServiceInfo } from "../types";

export type CardStatus = "idle" | "ready" | "warn" | "error";

export interface ServiceCardAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
}

export interface ServiceCardData {
  id: string;
  title: string;
  subtitle: string;
  status: CardStatus;
  detail: string;
  port?: string;
  action?: ServiceCardAction | null;
}

function envStatusOf(items: CheckItem[]): CardStatus {
  if (items.length === 0) return "idle";
  if (items.every((i) => i.ok)) return "ready";
  if (items.some((i) => !i.ok && !i.warn)) return "error";
  return "warn";
}

function envDetailOf(items: CheckItem[]): string {
  return items.map((i) => (i.ok ? i.message : `✗ ${i.message}`)).join("；");
}

/** 环境自检（idle 基准） + 运行时服务状态（running/starting/error…）合并为卡片状态 */
export function useServices(report: EnvReport | null) {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => window.api.onServicesChanged(setServices), []);
  useEffect(() => {
    void window.api.servicesList().then(setServices).catch(() => undefined);
  }, []);

  const run = (id: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    void fn().finally(() => setBusy((b) => ({ ...b, [id]: false })));
  };
  const start = (id: string) => run(id, () => window.api.serviceStart(id));
  const stop = (id: string) => run(id, () => window.api.serviceStop(id));
  const restart = (id: string) => run(id, () => window.api.serviceRestart(id));

  const anyBusy = Object.values(busy).some(Boolean);
  const anyActive = services.some((s) => s.state === "running" || s.state === "starting" || s.state === "stopping");

  const cards: ServiceCardData[] = useMemo(() => {
    const byId = new Map(services.map((s) => [s.id, s]));
    const base: ServiceCardData[] = [
      { id: "mainServer", title: "主服务器", subtitle: "Node · autostart", status: "idle", detail: "尚未自检", port: "26000 · 26001 · 26002" },
      { id: "marketServer", title: "市场服务", subtitle: "Rust · release", status: "idle", detail: "尚未自检", port: "40110" },
      { id: "client", title: "游戏客户端", subtitle: "EVE · exefile", status: "idle", detail: "尚未自检" }
    ];

    if (report) {
      const find = (key: string) => report.checks.filter((c) => c.key === key);
      base[0].status = envStatusOf([...find("node"), ...find("serverDeps"), ...find("localDb")]);
      base[0].detail = envDetailOf([...find("node"), ...find("serverDeps"), ...find("localDb")]);
      base[1].status = envStatusOf([...find("market"), ...find("rust"), ...find("vsBuildTools")]);
      base[1].detail = envDetailOf([...find("market"), ...find("rust"), ...find("vsBuildTools")]);
      base[2].status = envStatusOf([...find("clientPath"), ...find("caCert")]);
      base[2].detail = envDetailOf([...find("clientPath"), ...find("caCert")]);
    }

    return base.map((b) => {
      const svc = byId.get(b.id);
      const st = svc?.state;
      let status = b.status;
      let detail = b.detail;
      if (st === "running") status = "ready";
      else if (st === "starting" || st === "stopping" || st === "checking") status = "warn";
      else if (st === "error") status = "error";
      if (svc?.message) detail = svc.message;

      let action: ServiceCardAction | null = null;
      const disabled = !!busy[b.id];
      if (st === "running") {
        action = { label: "停止", onClick: () => stop(b.id), disabled };
      } else if (st === "starting" || st === "stopping") {
        action = { label: st === "starting" ? "启动中…" : "停止中…", disabled: true };
      } else if (st === "error") {
        action = { label: "重启", onClick: () => restart(b.id), disabled };
      } else {
        action = { label: "启动", onClick: () => start(b.id), disabled };
      }
      return { ...b, status, detail, action };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, services, busy]);

  return { cards, services, anyActive, anyBusy, start, stop, restart };
}
