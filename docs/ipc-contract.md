# IPC 契约（自动生成）

> 由 scripts/gen-contract.mjs 生成 —— 请勿手改。源: contract/ipc-channels.json
> 抽取源：`E:\Games\EveJS-v0.12.8\launcher\launcher`
> 生成时间：2026-09-27T21:52:08.459Z

## 计数

| 项 | 数量 |
| --- | --- |
| invoke（有回包） | 76 |
| send（无回包） | 6 |
| 请求通道合计 | 82 |
| 事件通道（主进程 → 渲染层） | 7 |
| window.api 入口合计 | 89 |
| ipc.ts 注册数 | 82 |

## 交叉校验

- 注册未暴露：无
- 暴露未注册：init:changed, mod:downloadProgress, mod:publishProgress, services:changed, terminal:data, terminal:exit, update:changed（事件通道不经 ipcMain 注册，属预期）
- 动态注册点：0

## 请求通道（82）

| window.api | 通道 | 类型 | 参数 |
| --- | --- | --- | --- |
| `accountsCheckRunning` | `accounts:checkRunning` | invoke | `-` |
| `accountsCreate` | `accounts:create` | invoke | `user: string, password: string, isGM: boolean` |
| `accountsDelete` | `accounts:delete` | invoke | `target: string, apply: boolean` |
| `accountsLaunch` | `accounts:launch` | invoke | `user: string, characterId?: string | number` |
| `accountsList` | `accounts:list` | invoke | `-` |
| `accountsSetPassword` | `accounts:setPassword` | invoke | `user: string, oldPw: string, newPw: string` |
| `accountsVerify` | `accounts:verify` | invoke | `user: string, password: string` |
| `appInfo` | `app:info` | invoke | `-` |
| `authorExportKey` | `author:exportKey` | invoke | `-` |
| `authorGet` | `author:get` | invoke | `-` |
| `authorImportKey` | `author:importKey` | invoke | `-` |
| `authorOpenKeyFolder` | `author:openKeyFolder` | invoke | `-` |
| `authorSetName` | `author:setName` | invoke | `name: string` |
| `getConfig` | `config:get` | invoke | `-` |
| `configRepairClientDisplay` | `config:repairClientDisplay` | invoke | `-` |
| `configSetClient` | `config:setClient` | invoke | `patch: Record<string, string>` |
| `configSetRepoRoot` | `config:setRepoRoot` | invoke | `repoRoot: string` |
| `databaseBackup` | `database:backup` | invoke | `-` |
| `databaseBackups` | `database:backups` | invoke | `-` |
| `databaseDeleteRow` | `database:delete` | invoke | `table: string, values: Record<string, unknown>` |
| `databaseInsertRow` | `database:insert` | invoke | `table: string, values: Record<string, unknown>` |
| `databaseOverview` | `database:overview` | invoke | `-` |
| `databaseRestore` | `database:restore` | invoke | `name: string` |
| `databaseSaveRow` | `database:save` | invoke | `table: string, values: Record<string, unknown>` |
| `databaseTable` | `database:table` | invoke | `table: string, limit = 100, offset = 0` |
| `engageStart` | `engage:start` | invoke | `-` |
| `engageStop` | `engage:stop` | invoke | `-` |
| `envCheck` | `env:check` | invoke | `-` |
| `healthCheck` | `health:check` | invoke | `-` |
| `healthPing` | `health:ping` | invoke | `-` |
| `initRun` | `init:run` | invoke | `key: string` |
| `initState` | `init:state` | invoke | `-` |
| `readServerLog` | `log:read` | invoke | `-` |
| `loginStart` | `login:start` | invoke | `user: string, password: string, remember = false, characterId?: string | number` |
| `metricsGet` | `metrics:get` | invoke | `-` |
| `modsAuthoringDoc` | `mods:authoringDoc` | invoke | `-` |
| `modsAuthoringDocText` | `mods:authoringDocText` | invoke | `lang?: string` |
| `modsCreate` | `mods:create` | invoke | `draft: Record<string, unknown>` |
| `modsCreateFolder` | `mods:createFolder` | invoke | `-` |
| `modsGithubTokenCheck` | `mods:githubTokenCheck` | invoke | `token?: string` |
| `modsGithubTokenClear` | `mods:githubTokenClear` | invoke | `-` |
| `modsGithubTokenSave` | `mods:githubTokenSave` | invoke | `token: string` |
| `modsGithubTokenStatus` | `mods:githubTokenStatus` | invoke | `-` |
| `modsImportZip` | `mods:importZip` | invoke | `-` |
| `modsList` | `mods:list` | invoke | `-` |
| `modsMarketInstall` | `mods:marketInstall` | invoke | `entry: Record<string, unknown>` |
| `modsMarketList` | `mods:marketList` | invoke | `force?: boolean` |
| `modsMyMods` | `mods:myMods` | invoke | `-` |
| `modsMySubmissions` | `mods:mySubmissions` | invoke | `-` |
| `modsOpenAuthoringDoc` | `mods:openAuthoringDoc` | invoke | `-` |
| `modsOpenFolder` | `mods:openFolder` | invoke | `-` |
| `modsOpenModFolder` | `mods:openModFolder` | invoke | `folder: string` |
| `modsPlan` | `mods:plan` | invoke | `-` |
| `modsPublishOwnRepo` | `mods:publishOwnRepo` | invoke | `id: string, version: string, repo: string, giteeUrl?: string` |
| `modsReadme` | `mods:readme` | invoke | `folder: string` |
| `modsRegisterSource` | `mods:registerSource` | invoke | `id: string, version: string` |
| `modsRevealSubmissionZip` | `mods:revealSubmissionZip` | invoke | `zipPath: string` |
| `modsSaveText` | `mods:saveText` | invoke | `defaultName: string, content: string` |
| `modsSetEnabled` | `mods:setEnabled` | invoke | `folder: string, enabled: boolean` |
| `modsSetOrder` | `mods:setOrder` | invoke | `folders: string[]` |
| `modsSign` | `mods:sign` | invoke | `folder: string` |
| `modsSubmitGithub` | `mods:submitGithub` | invoke | `id: string, version: string` |
| `modsSubmitPrepare` | `mods:submitPrepare` | invoke | `input: Record<string, unknown>` |
| `modsTemplates` | `mods:templates` | invoke | `-` |
| `modsUninstall` | `mods:uninstall` | invoke | `folder: string` |
| `serviceRestart` | `service:restart` | invoke | `id: string` |
| `serviceStart` | `service:start` | invoke | `id: string` |
| `serviceStop` | `service:stop` | invoke | `id: string` |
| `servicesList` | `services:list` | invoke | `-` |
| `settingsGet` | `settings:get` | invoke | `-` |
| `settingsSet` | `settings:set` | invoke | `patch: Record<string, unknown>` |
| `openExternal` | `shell:openExternal` | invoke | `url: string` |
| `terminalInput` | `terminal:input` | send | `tabId: string, data: string` |
| `terminalResize` | `terminal:resize` | send | `tabId: string, cols: number, rows: number` |
| `updateApply` | `update:apply` | invoke | `-` |
| `updateCancel` | `update:cancel` | send | `-` |
| `updateCheck` | `update:check` | invoke | `-` |
| `updateDownload` | `update:download` | invoke | `-` |
| `updateState` | `update:state` | invoke | `-` |
| `windowClose` | `window:close` | send | `-` |
| `windowMinimize` | `window:minimize` | send | `-` |
| `windowToggleMaximize` | `window:toggleMaximize` | send | `-` |

## 事件通道（7）

| window.api | 通道 |
| --- | --- |
| `onInitChanged` | `init:changed` |
| `onModDownloadProgress` | `mod:downloadProgress` |
| `onModPublishProgress` | `mod:publishProgress` |
| `onServicesChanged` | `services:changed` |
| `onTerminalData` | `terminal:data` |
| `onTerminalExit` | `terminal:exit` |
| `onUpdateChanged` | `update:changed` |
