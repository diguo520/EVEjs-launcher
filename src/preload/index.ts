import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

interface ServiceInfoShape {
  id: string;
  name: string;
  state: string;
  pid?: number;
  message?: string;
}

/**
 * contextBridge 安全桥：渲染层只能通过 window.api 访问白名单能力。
 */
const api = {
  appInfo: () => ipcRenderer.invoke("app:info"),
  envCheck: () => ipcRenderer.invoke("env:check"),
  healthCheck: () => ipcRenderer.invoke("health:check"),
  metricsGet: () => ipcRenderer.invoke("metrics:get"),
  readServerLog: () => ipcRenderer.invoke("log:read"),
  initRun: (key: string) => ipcRenderer.invoke("init:run", key),
  initState: () => ipcRenderer.invoke("init:state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateApply: () => ipcRenderer.invoke("update:apply"),
  updateCancel: () => ipcRenderer.send("update:cancel"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  getConfig: () => ipcRenderer.invoke("config:get"),
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:set", patch),
  databaseOverview: () => ipcRenderer.invoke("database:overview"),
  databaseTable: (table: string, limit = 100, offset = 0) =>
    ipcRenderer.invoke("database:table", table, limit, offset),
  databaseSaveRow: (table: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke("database:save", table, values),
  databaseInsertRow: (table: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke("database:insert", table, values),
  databaseDeleteRow: (table: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke("database:delete", table, values),
  databaseBackup: () => ipcRenderer.invoke("database:backup"),
  databaseBackups: () => ipcRenderer.invoke("database:backups"),
  databaseRestore: (name: string) => ipcRenderer.invoke("database:restore", name),
  serviceStart: (id: string) => ipcRenderer.invoke("service:start", id),
  serviceStop: (id: string) => ipcRenderer.invoke("service:stop", id),
  serviceRestart: (id: string) => ipcRenderer.invoke("service:restart", id),
  servicesList: () => ipcRenderer.invoke("services:list"),
  engageStart: () => ipcRenderer.invoke("engage:start"),
  engageStop: () => ipcRenderer.invoke("engage:stop"),
  accountsList: () => ipcRenderer.invoke("accounts:list"),
  accountsCreate: (user: string, password: string, isGM: boolean) =>
    ipcRenderer.invoke("accounts:create", user, password, isGM),
  accountsDelete: (target: string, apply: boolean) =>
    ipcRenderer.invoke("accounts:delete", target, apply),
  accountsCheckRunning: () => ipcRenderer.invoke("accounts:checkRunning"),
  accountsVerify: (user: string, password: string) =>
    ipcRenderer.invoke("accounts:verify", user, password),
  accountsSetPassword: (user: string, oldPw: string, newPw: string) =>
    ipcRenderer.invoke("accounts:setPassword", user, oldPw, newPw),
  accountsLaunch: (user: string, characterId?: string | number) =>
    ipcRenderer.invoke("accounts:launch", user, characterId),
  loginStart: (user: string, password: string, remember = false, characterId?: string | number) =>
    ipcRenderer.invoke("login:start", user, password, remember, characterId),
  configSetClient: (patch: Record<string, string>) => ipcRenderer.invoke("config:setClient", patch),
  configSetRepoRoot: (repoRoot: string) => ipcRenderer.invoke("config:setRepoRoot", repoRoot),
  terminalInput: (tabId: string, data: string) => ipcRenderer.send("terminal:input", tabId, data),
  terminalResize: (tabId: string, cols: number, rows: number) => ipcRenderer.send("terminal:resize", tabId, cols, rows),
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
  windowClose: () => ipcRenderer.send("window:close"),
  onServicesChanged: (cb: (list: ServiceInfoShape[]) => void) => {
    const h = (_e: IpcRendererEvent, list: ServiceInfoShape[]) => cb(list);
    ipcRenderer.on("services:changed", h);
    return () => ipcRenderer.removeListener("services:changed", h);
  },
  onTerminalData: (cb: (tabId: string, data: string) => void) => {
    const h = (_e: IpcRendererEvent, tabId: string, data: string) => cb(tabId, data);
    ipcRenderer.on("terminal:data", h);
    return () => ipcRenderer.removeListener("terminal:data", h);
  },
  onTerminalExit: (cb: (tabId: string, code: number) => void) => {
    const h = (_e: IpcRendererEvent, tabId: string, code: number) => cb(tabId, code);
    ipcRenderer.on("terminal:exit", h);
    return () => ipcRenderer.removeListener("terminal:exit", h);
  },
  onUpdateChanged: (cb: (state: { state: string; currentVersion: string; latestVersion?: string; channel?: string; size?: number; downloaded?: number; percent?: number; speed?: number; message?: string }) => void) => {
    const h = (_e: IpcRendererEvent, state: { state: string; currentVersion: string; latestVersion?: string; channel?: string; size?: number; downloaded?: number; percent?: number; speed?: number; message?: string }) => cb(state);
    ipcRenderer.on("update:changed", h);
    return () => ipcRenderer.removeListener("update:changed", h);
  },
  onInitChanged: (
    cb: (s: { busy: boolean; key: string | null; label: string; progress: number | null }) => void
  ) => {
    const h = (
      _e: IpcRendererEvent,
      s: { busy: boolean; key: string | null; label: string; progress: number | null }
    ) => cb(s);
    ipcRenderer.on("init:changed", h);
    return () => ipcRenderer.removeListener("init:changed", h);
  }
};

contextBridge.exposeInMainWorld("api", api);
