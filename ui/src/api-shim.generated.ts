/* 由 scripts/gen-contract.mjs 生成 —— 请勿手改。源: contract/ipc-channels.json */
/* 抽取源: E:\Games\EveJS-v0.12.8\launcher\launcher */
/* 生成时间: 2026-10-04T04:11:42.874Z */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Rust 侧单一分发命令（内部按通道名二次白名单校验） */
const DISPATCH_COMMAND = "launcher_invoke";

export type UnlistenFn = () => void;

function request(channel: string, args: unknown[]): Promise<unknown> {
  return invoke(DISPATCH_COMMAND, { channel, args });
}

/** 无回包通道：与 Electron 的 ipcRenderer.send 语义一致 */
function fire(channel: string, args: unknown[]): void {
  void invoke(DISPATCH_COMMAND, { channel, args });
}

/** 事件订阅：载荷统一为数组，按位置展开给回调（对齐 Electron 的多参数回调） */
function on(channel: string, cb: (...args: any[]) => void): UnlistenFn {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  void listen<unknown>(channel, (event) => {
    const payload = event.payload;
    return cb(...(Array.isArray(payload) ? payload : [payload]));
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

export const api = {
  accountsCheckRunning: (): Promise<unknown> => request("accounts:checkRunning", []),
  accountsCreate: (user: string, password: string, isGM: boolean): Promise<unknown> => request("accounts:create", [user, password, isGM]),
  accountsDelete: (target: string, apply: boolean): Promise<unknown> => request("accounts:delete", [target, apply]),
  accountsDeleteCharacter: (target: string, apply?: boolean): Promise<unknown> => request("accounts:deleteCharacter", [target, apply]),
  accountsLaunch: (user: string, characterId?: string | number): Promise<unknown> => request("accounts:launch", [user, characterId]),
  accountsList: (): Promise<unknown> => request("accounts:list", []),
  accountsLogotypes: (requests: Array<{ kind: "corporations" | "alliances"; id: number }>): Promise<unknown> => request("accounts:logotypes", [requests]),
  accountsSetPassword: (user: string, oldPw: string, newPw: string): Promise<unknown> => request("accounts:setPassword", [user, oldPw, newPw]),
  accountsVerify: (user: string, password: string): Promise<unknown> => request("accounts:verify", [user, password]),
  appInfo: (): Promise<unknown> => request("app:info", []),
  authorExportKey: (): Promise<unknown> => request("author:exportKey", []),
  authorGet: (): Promise<unknown> => request("author:get", []),
  authorImportKey: (): Promise<unknown> => request("author:importKey", []),
  authorOpenKeyFolder: (): Promise<unknown> => request("author:openKeyFolder", []),
  authorSetName: (name: string): Promise<unknown> => request("author:setName", [name]),
  configRepairClientDisplay: (): Promise<unknown> => request("config:repairClientDisplay", []),
  configSetClient: (patch: Record<string, string>): Promise<unknown> => request("config:setClient", [patch]),
  configSetRepoRoot: (repoRoot: string): Promise<unknown> => request("config:setRepoRoot", [repoRoot]),
  dangerClearCache: (): Promise<unknown> => request("danger:clearCache", []),
  dangerEraseWorld: (): Promise<unknown> => request("danger:eraseWorld", []),
  dangerResetConfig: (): Promise<unknown> => request("danger:resetConfig", []),
  databaseBackup: (): Promise<unknown> => request("database:backup", []),
  databaseBackups: (): Promise<unknown> => request("database:backups", []),
  databaseDeleteRow: (table: string, values: Record<string, unknown>): Promise<unknown> => request("database:delete", [table, values]),
  databaseInsertRow: (table: string, values: Record<string, unknown>): Promise<unknown> => request("database:insert", [table, values]),
  databaseOverview: (): Promise<unknown> => request("database:overview", []),
  databaseRestore: (name: string): Promise<unknown> => request("database:restore", [name]),
  databaseSaveRow: (table: string, values: Record<string, unknown>): Promise<unknown> => request("database:save", [table, values]),
  databaseTable: (table: string, limit = 100, offset = 0): Promise<unknown> => request("database:table", [table, limit, offset]),
  engageStart: (): Promise<unknown> => request("engage:start", []),
  engageStop: (): Promise<unknown> => request("engage:stop", []),
  envCheck: (): Promise<unknown> => request("env:check", []),
  gameConfigRead: (): Promise<unknown> => request("gameConfig:read", []),
  gameConfigSave: (patch: Record<string, unknown>): Promise<unknown> => request("gameConfig:save", [patch]),
  getConfig: (): Promise<unknown> => request("config:get", []),
  healthCheck: (): Promise<unknown> => request("health:check", []),
  healthPing: (): Promise<unknown> => request("health:ping", []),
  initRun: (key: string): Promise<unknown> => request("init:run", [key]),
  initState: (): Promise<unknown> => request("init:state", []),
  loginStart: (user: string, password: string, remember = false, characterId?: string | number): Promise<unknown> => request("login:start", [user, password, remember, characterId]),
  marketBook: (typeId: number): Promise<unknown> => request("market:book", [typeId]),
  marketCatalog: (): Promise<unknown> => request("market:catalog", []),
  marketOverview: (): Promise<unknown> => request("market:overview", []),
  marketTrades: (limit?: number): Promise<unknown> => request("market:trades", [limit]),
  metricsGet: (): Promise<unknown> => request("metrics:get", []),
  modsAuthoringDoc: (): Promise<unknown> => request("mods:authoringDoc", []),
  modsAuthoringDocText: (lang?: string): Promise<unknown> => request("mods:authoringDocText", [lang]),
  modsClaimCandidates: (opts?: { offset?: number; limit?: number; query?: string; scope?: "mine" | "all" }): Promise<unknown> => request("mods:claimCandidates", [opts]),
  modsClaimMod: (folder: string): Promise<unknown> => request("mods:claimMod", [folder]),
  modsCreate: (draft: Record<string, unknown>): Promise<unknown> => request("mods:create", [draft]),
  modsCreateFolder: (): Promise<unknown> => request("mods:createFolder", []),
  modsForgetSubmission: (id: string): Promise<unknown> => request("mods:forgetSubmission", [id]),
  modsGithubTokenCheck: (token?: string): Promise<unknown> => request("mods:githubTokenCheck", [token]),
  modsGithubTokenClear: (): Promise<unknown> => request("mods:githubTokenClear", []),
  modsGithubTokenSave: (token: string): Promise<unknown> => request("mods:githubTokenSave", [token]),
  modsGithubTokenStatus: (): Promise<unknown> => request("mods:githubTokenStatus", []),
  modsImportZip: (): Promise<unknown> => request("mods:importZip", []),
  modsList: (): Promise<unknown> => request("mods:list", []),
  modsMarketInstall: (entry: Record<string, unknown>): Promise<unknown> => request("mods:marketInstall", [entry]),
  modsMarketList: (force?: boolean): Promise<unknown> => request("mods:marketList", [force]),
  modsMyMods: (): Promise<unknown> => request("mods:myMods", []),
  modsMySubmissions: (): Promise<unknown> => request("mods:mySubmissions", []),
  modsOpenAuthoringDoc: (): Promise<unknown> => request("mods:openAuthoringDoc", []),
  modsOpenFolder: (): Promise<unknown> => request("mods:openFolder", []),
  modsOpenModFolder: (folder: string): Promise<unknown> => request("mods:openModFolder", [folder]),
  modsPlan: (): Promise<unknown> => request("mods:plan", []),
  modsPreflight: (opts?: { dryRun?: boolean }): Promise<unknown> => request("mods:preflight", [opts]),
  modsPublishOwnRepo: (id: string, version: string, repo: string, giteeUrl?: string): Promise<unknown> => request("mods:publishOwnRepo", [id, version, repo, giteeUrl]),
  modsReadme: (folder: string): Promise<unknown> => request("mods:readme", [folder]),
  modsRegisterSource: (id: string, version: string): Promise<unknown> => request("mods:registerSource", [id, version]),
  modsReplyRetract: (input: { modId: string; reviewId: string }): Promise<unknown> => request("mods:replyRetract", [input]),
  modsReplySubmit: (input: { modId: string; reviewId: string; body: string }): Promise<unknown> => request("mods:replySubmit", [input]),
  modsReportReview: (input: { modId: string; reviewId: string; reason: string }): Promise<unknown> => request("mods:reportReview", [input]),
  modsRevealSubmissionZip: (zipPath: string): Promise<unknown> => request("mods:revealSubmissionZip", [zipPath]),
  modsReviewRetract: (input: { modId: string }): Promise<unknown> => request("mods:reviewRetract", [input]),
  modsReviews: (modId: string, force?: boolean): Promise<unknown> => request("mods:reviews", [modId, force]),
  modsReviewSubmit: (input: { modId: string; version: string; pkgSha256: string; stars: number; body: string }): Promise<unknown> => request("mods:reviewSubmit", [input]),
  modsSaveText: (defaultName: string, content: string): Promise<unknown> => request("mods:saveText", [defaultName, content]),
  modsSetEnabled: (folder: string, enabled: boolean): Promise<unknown> => request("mods:setEnabled", [folder, enabled]),
  modsSetOrder: (folders: string[]): Promise<unknown> => request("mods:setOrder", [folders]),
  modsSign: (folder: string): Promise<unknown> => request("mods:sign", [folder]),
  modsSubmitGithub: (id: string, version: string): Promise<unknown> => request("mods:submitGithub", [id, version]),
  modsSubmitPrepare: (input: Record<string, unknown>): Promise<unknown> => request("mods:submitPrepare", [input]),
  modsTemplates: (): Promise<unknown> => request("mods:templates", []),
  modsUninstall: (folder: string): Promise<unknown> => request("mods:uninstall", [folder]),
  modsUpdateMeta: (folder: string, patch: Record<string, unknown>): Promise<unknown> => request("mods:updateMeta", [folder, patch]),
  openExternal: (url: string): Promise<unknown> => request("shell:openExternal", [url]),
  readServerLog: (): Promise<unknown> => request("log:read", []),
  serviceRestart: (id: string): Promise<unknown> => request("service:restart", [id]),
  servicesList: (): Promise<unknown> => request("services:list", []),
  serviceStart: (id: string): Promise<unknown> => request("service:start", [id]),
  serviceStop: (id: string): Promise<unknown> => request("service:stop", [id]),
  settingsGet: (): Promise<unknown> => request("settings:get", []),
  settingsSet: (patch: Record<string, unknown>): Promise<unknown> => request("settings:set", [patch]),
  sponsorsSnapshot: (force: boolean): Promise<unknown> => request("sponsors:snapshot", [force]),
  updateApply: (): Promise<unknown> => request("update:apply", []),
  updateCheck: (): Promise<unknown> => request("update:check", []),
  updateDownload: (): Promise<unknown> => request("update:download", []),
  updateState: (): Promise<unknown> => request("update:state", []),
  terminalInput: (tabId: string, data: string): void => fire("terminal:input", [tabId, data]),
  terminalResize: (tabId: string, cols: number, rows: number): void => fire("terminal:resize", [tabId, cols, rows]),
  updateCancel: (): void => fire("update:cancel", []),
  windowClose: (): void => fire("window:close", []),
  windowMinimize: (): void => fire("window:minimize", []),
  windowToggleMaximize: (): void => fire("window:toggleMaximize", []),
  onInitChanged: (cb: (...args: any[]) => void): UnlistenFn => on("init:changed", cb),
  onModDownloadProgress: (cb: (...args: any[]) => void): UnlistenFn => on("mod:downloadProgress", cb),
  onModPublishProgress: (cb: (...args: any[]) => void): UnlistenFn => on("mod:publishProgress", cb),
  onServicesChanged: (cb: (...args: any[]) => void): UnlistenFn => on("services:changed", cb),
  onTerminalData: (cb: (...args: any[]) => void): UnlistenFn => on("terminal:data", cb),
  onTerminalExit: (cb: (...args: any[]) => void): UnlistenFn => on("terminal:exit", cb),
  onUpdateChanged: (cb: (...args: any[]) => void): UnlistenFn => on("update:changed", cb),
};

export type LauncherApi = typeof api;

/** 注入 window.api：legacy 页面 (eve-launcher.html + launcher-bridge.js) 无需任何改动 */
export function installApiShim(target: Record<string, unknown> = window as unknown as Record<string, unknown>): LauncherApi {
  target.api = api;
  return api;
}
