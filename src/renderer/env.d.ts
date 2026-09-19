import type {
  AccountInfo,
  AccountOpResult,
  AppInfo,
  ClientConfig,
  ConfigBundle,
  EnvReport,
  HealthResult,
  InitState,
  ServerLogResult,
  ServiceActionResult,
  ServiceInfo
} from "./types";

export {};

declare global {
  interface Window {
    api: {
      appInfo(): Promise<AppInfo>;
      envCheck(): Promise<EnvReport>;
      healthCheck(): Promise<HealthResult>;
      metricsGet(): Promise<{ cpuPercent: number; memUsedGB: number; memTotalGB: number; diskUsedGB: number; diskTotalGB: number; netBytesPerSec: number }>;
      readServerLog(): Promise<ServerLogResult>;
      initRun(key: string): Promise<{ ok: boolean; reason?: string }>;
      initState(): Promise<InitState>;
      updateCheck(): Promise<{ ok: boolean; available: boolean; currentVersion: string; latestVersion?: string; size?: number; date?: string; channel?: string; changelog?: Array<{ type: string; text: string }>; manifestUrl?: string; targetPath?: string; reason?: string }>;
      updateState(): Promise<{ state: string; currentVersion: string; latestVersion?: string; channel?: string; size?: number; downloaded?: number; percent?: number; speed?: number; message?: string }>;
      updateDownload(): Promise<{ ok: boolean; path?: string; reason?: string }>;
      updateApply(): Promise<{ ok: boolean; reason?: string }>;
      updateCancel(): void;
      onUpdateChanged(cb: (state: { state: string; currentVersion: string; latestVersion?: string; channel?: string; size?: number; downloaded?: number; percent?: number; speed?: number; message?: string }) => void): () => void;
      openExternal(url: string): Promise<boolean>;
      getConfig(): Promise<ConfigBundle>;
      settingsGet(): Promise<Record<string, unknown>>;
      settingsSet(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
      serviceStart(id: string): Promise<ServiceActionResult>;
      serviceStop(id: string): Promise<ServiceActionResult>;
      serviceRestart(id: string): Promise<ServiceActionResult>;
      servicesList(): Promise<ServiceInfo[]>;
      engageStart(): Promise<ServiceActionResult>;
      engageStop(): Promise<ServiceActionResult>;
      accountsList(): Promise<AccountOpResult>;
      accountsCreate(user: string, password: string, isGM: boolean): Promise<AccountOpResult>;
      accountsDelete(target: string, apply: boolean): Promise<AccountOpResult>;
      accountsCheckRunning(): Promise<{ running: boolean; ports: number[] }>;
      accountsVerify(user: string, password: string): Promise<{ ok: boolean; reason?: string }>;
      accountsSetPassword(user: string, oldPw: string, newPw: string): Promise<AccountOpResult>;
      loginStart(user: string, password: string): Promise<AccountOpResult>;
      configSetClient(patch: Record<string, string>): Promise<{ ok: boolean; client?: ClientConfig; reason?: string }>;
      configSetRepoRoot(repoRoot: string): Promise<{ ok: boolean; path?: string; repoRoot?: string; reason?: string }>;
      terminalInput(tabId: string, data: string): void;
      terminalResize(tabId: string, cols: number, rows: number): void;
      windowMinimize(): void;
      windowToggleMaximize(): void;
      windowClose(): void;
      onTerminalData(cb: (tabId: string, data: string) => void): () => void;
      onTerminalExit(cb: (tabId: string, code: number) => void): () => void;
      onServicesChanged(cb: (list: ServiceInfo[]) => void): () => void;
      onInitChanged(cb: (s: InitState) => void): () => void;
    };
  }
}
