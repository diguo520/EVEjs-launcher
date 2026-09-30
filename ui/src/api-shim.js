/* 由 scripts/gen-contract.mjs 生成 —— 请勿手改。源: contract/ipc-channels.json */
/* 抽取源: E:\Games\EveJS-v0.12.8\launcher\launcher */
/* 注入方式: tauri.conf.json → withGlobalTauri:false + initialization_script */
/* 传输层对齐 @tauri-apps/api：invoke + transformCallback 都挂在 __TAURI_INTERNALS__ 上 */
(function () {
  "use strict";
  var DISPATCH = "launcher_invoke";
  function bridge() {
    var api = window.__TAURI_INTERNALS__;
    if (!api || typeof api.invoke !== "function" || typeof api.transformCallback !== "function") {
      throw new Error("window.__TAURI_INTERNALS__ 未注入：页面不在 Tauri WebView 中，或 Tauri 版本不兼容");
    }
    return api;
  }
  function request(channel, args) {
    return bridge().invoke(DISPATCH, { channel: channel, args: args });
  }
  /** 无回包通道：与 Electron ipcRenderer.send 语义一致 */
  function fire(channel, args) {
    request(channel, args).catch(function () {});
  }
  /** 解除监听：先清 JS 侧回调表再通知事件插件（对齐 @tauri-apps/api/event 的 unlisten） */
  function unlisten(channel, eventId) {
    var events = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    if (events && typeof events.unregisterListener === "function") events.unregisterListener(channel, eventId);
    bridge().invoke("plugin:event|unlisten", { event: channel, eventId: eventId }).catch(function () {});
  }
  /** 事件订阅：载荷统一是数组，按位置展开成多参数回调（对齐 Electron） */
  function on(channel, cb) {
    var api = bridge();
    var eventId = null;
    var disposed = false;
    api.invoke("plugin:event|listen", {
      event: channel,
      target: { kind: "Any" },
      handler: api.transformCallback(function (event) {
        var payload = event.payload;
        return cb.apply(null, Array.isArray(payload) ? payload : [payload]);
      })
    }).then(function (id) {
      if (disposed) unlisten(channel, id);
      else eventId = id;
    }).catch(function () {});
    return function () {
      disposed = true;
      if (eventId !== null) { var id = eventId; eventId = null; unlisten(channel, id); }
    };
  }
  var api = {
    accountsCheckRunning: function () { return request("accounts:checkRunning", []); },
    accountsCreate: function (user, password, isGM) { return request("accounts:create", [user, password, isGM]); },
    accountsDelete: function (target, apply) { return request("accounts:delete", [target, apply]); },
    accountsDeleteCharacter: function (target, apply) { return request("accounts:deleteCharacter", [target, apply]); },
    accountsLaunch: function (user, characterId) { return request("accounts:launch", [user, characterId]); },
    accountsList: function () { return request("accounts:list", []); },
    accountsLogotypes: function (requests) { return request("accounts:logotypes", [requests]); },
    accountsSetPassword: function (user, oldPw, newPw) { return request("accounts:setPassword", [user, oldPw, newPw]); },
    accountsVerify: function (user, password) { return request("accounts:verify", [user, password]); },
    appInfo: function () { return request("app:info", []); },
    authorExportKey: function () { return request("author:exportKey", []); },
    authorGet: function () { return request("author:get", []); },
    authorImportKey: function () { return request("author:importKey", []); },
    authorOpenKeyFolder: function () { return request("author:openKeyFolder", []); },
    authorSetName: function (name) { return request("author:setName", [name]); },
    configRepairClientDisplay: function () { return request("config:repairClientDisplay", []); },
    configSetClient: function (patch) { return request("config:setClient", [patch]); },
    configSetRepoRoot: function (repoRoot) { return request("config:setRepoRoot", [repoRoot]); },
    databaseBackup: function () { return request("database:backup", []); },
    databaseBackups: function () { return request("database:backups", []); },
    databaseDeleteRow: function (table, values) { return request("database:delete", [table, values]); },
    databaseInsertRow: function (table, values) { return request("database:insert", [table, values]); },
    databaseOverview: function () { return request("database:overview", []); },
    databaseRestore: function (name) { return request("database:restore", [name]); },
    databaseSaveRow: function (table, values) { return request("database:save", [table, values]); },
    databaseTable: function (table, limit, offset) { return request("database:table", [table, limit, offset]); },
    engageStart: function () { return request("engage:start", []); },
    engageStop: function () { return request("engage:stop", []); },
    envCheck: function () { return request("env:check", []); },
    getConfig: function () { return request("config:get", []); },
    healthCheck: function () { return request("health:check", []); },
    healthPing: function () { return request("health:ping", []); },
    initRun: function (key) { return request("init:run", [key]); },
    initState: function () { return request("init:state", []); },
    loginStart: function (user, password, remember, characterId) { return request("login:start", [user, password, remember, characterId]); },
    metricsGet: function () { return request("metrics:get", []); },
    modsAuthoringDoc: function () { return request("mods:authoringDoc", []); },
    modsAuthoringDocText: function (lang) { return request("mods:authoringDocText", [lang]); },
    modsClaimCandidates: function (opts) { return request("mods:claimCandidates", [opts]); },
    modsClaimMod: function (folder) { return request("mods:claimMod", [folder]); },
    modsCreate: function (draft) { return request("mods:create", [draft]); },
    modsCreateFolder: function () { return request("mods:createFolder", []); },
    modsGithubTokenCheck: function (token) { return request("mods:githubTokenCheck", [token]); },
    modsGithubTokenClear: function () { return request("mods:githubTokenClear", []); },
    modsGithubTokenSave: function (token) { return request("mods:githubTokenSave", [token]); },
    modsGithubTokenStatus: function () { return request("mods:githubTokenStatus", []); },
    modsImportZip: function () { return request("mods:importZip", []); },
    modsList: function () { return request("mods:list", []); },
    modsMarketInstall: function (entry) { return request("mods:marketInstall", [entry]); },
    modsMarketList: function (force) { return request("mods:marketList", [force]); },
    modsMyMods: function () { return request("mods:myMods", []); },
    modsMySubmissions: function () { return request("mods:mySubmissions", []); },
    modsOpenAuthoringDoc: function () { return request("mods:openAuthoringDoc", []); },
    modsOpenFolder: function () { return request("mods:openFolder", []); },
    modsOpenModFolder: function (folder) { return request("mods:openModFolder", [folder]); },
    modsPlan: function () { return request("mods:plan", []); },
    modsPublishOwnRepo: function (id, version, repo, giteeUrl) { return request("mods:publishOwnRepo", [id, version, repo, giteeUrl]); },
    modsReadme: function (folder) { return request("mods:readme", [folder]); },
    modsRegisterSource: function (id, version) { return request("mods:registerSource", [id, version]); },
    modsRevealSubmissionZip: function (zipPath) { return request("mods:revealSubmissionZip", [zipPath]); },
    modsSaveText: function (defaultName, content) { return request("mods:saveText", [defaultName, content]); },
    modsSetEnabled: function (folder, enabled) { return request("mods:setEnabled", [folder, enabled]); },
    modsSetOrder: function (folders) { return request("mods:setOrder", [folders]); },
    modsSign: function (folder) { return request("mods:sign", [folder]); },
    modsSubmitGithub: function (id, version) { return request("mods:submitGithub", [id, version]); },
    modsSubmitPrepare: function (input) { return request("mods:submitPrepare", [input]); },
    modsTemplates: function () { return request("mods:templates", []); },
    modsUninstall: function (folder) { return request("mods:uninstall", [folder]); },
    modsUpdateMeta: function (folder, patch) { return request("mods:updateMeta", [folder, patch]); },
    openExternal: function (url) { return request("shell:openExternal", [url]); },
    readServerLog: function () { return request("log:read", []); },
    serviceRestart: function (id) { return request("service:restart", [id]); },
    servicesList: function () { return request("services:list", []); },
    serviceStart: function (id) { return request("service:start", [id]); },
    serviceStop: function (id) { return request("service:stop", [id]); },
    settingsGet: function () { return request("settings:get", []); },
    settingsSet: function (patch) { return request("settings:set", [patch]); },
    updateApply: function () { return request("update:apply", []); },
    updateCheck: function () { return request("update:check", []); },
    updateDownload: function () { return request("update:download", []); },
    updateState: function () { return request("update:state", []); },
    terminalInput: function (tabId, data) { fire("terminal:input", [tabId, data]); },
    terminalResize: function (tabId, cols, rows) { fire("terminal:resize", [tabId, cols, rows]); },
    updateCancel: function () { fire("update:cancel", []); },
    windowClose: function () { fire("window:close", []); },
    windowMinimize: function () { fire("window:minimize", []); },
    windowToggleMaximize: function () { fire("window:toggleMaximize", []); },
    onInitChanged: function (cb) { return on("init:changed", cb); },
    onModDownloadProgress: function (cb) { return on("mod:downloadProgress", cb); },
    onModPublishProgress: function (cb) { return on("mod:publishProgress", cb); },
    onServicesChanged: function (cb) { return on("services:changed", cb); },
    onTerminalData: function (cb) { return on("terminal:data", cb); },
    onTerminalExit: function (cb) { return on("terminal:exit", cb); },
    onUpdateChanged: function (cb) { return on("update:changed", cb); },
  };
  window.api = api;
})();