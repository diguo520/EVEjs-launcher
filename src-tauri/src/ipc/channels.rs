//! 由 scripts/gen-contract.mjs 生成 —— 请勿手改。源: contract/ipc-channels.json
//! 抽取源: E:\Games\EveJS-v0.12.8\launcher\launcher
//! 生成时间: 2026-09-27T23:13:19.159Z

#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Invoke,
    Send,
    Event,
}

#[derive(Debug, Clone, Copy)]
pub struct ChannelSpec {
    pub channel: &'static str,
    pub api: &'static str,
    pub kind: ChannelKind,
}

pub const REQUEST_COUNT: usize = 82;
pub const EVENT_COUNT: usize = 7;

#[rustfmt::skip]
pub const CHANNELS: &[ChannelSpec] = &[
    ChannelSpec { channel: "accounts:checkRunning", api: "accountsCheckRunning", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:create", api: "accountsCreate", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:delete", api: "accountsDelete", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:launch", api: "accountsLaunch", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:list", api: "accountsList", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:setPassword", api: "accountsSetPassword", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "accounts:verify", api: "accountsVerify", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "app:info", api: "appInfo", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "author:exportKey", api: "authorExportKey", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "author:get", api: "authorGet", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "author:importKey", api: "authorImportKey", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "author:openKeyFolder", api: "authorOpenKeyFolder", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "author:setName", api: "authorSetName", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "config:get", api: "getConfig", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "config:repairClientDisplay", api: "configRepairClientDisplay", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "config:setClient", api: "configSetClient", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "config:setRepoRoot", api: "configSetRepoRoot", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:backup", api: "databaseBackup", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:backups", api: "databaseBackups", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:delete", api: "databaseDeleteRow", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:insert", api: "databaseInsertRow", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:overview", api: "databaseOverview", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:restore", api: "databaseRestore", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:save", api: "databaseSaveRow", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "database:table", api: "databaseTable", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "engage:start", api: "engageStart", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "engage:stop", api: "engageStop", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "env:check", api: "envCheck", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "health:check", api: "healthCheck", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "health:ping", api: "healthPing", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "init:run", api: "initRun", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "init:state", api: "initState", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "log:read", api: "readServerLog", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "login:start", api: "loginStart", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "metrics:get", api: "metricsGet", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:authoringDoc", api: "modsAuthoringDoc", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:authoringDocText", api: "modsAuthoringDocText", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:create", api: "modsCreate", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:createFolder", api: "modsCreateFolder", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:githubTokenCheck", api: "modsGithubTokenCheck", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:githubTokenClear", api: "modsGithubTokenClear", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:githubTokenSave", api: "modsGithubTokenSave", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:githubTokenStatus", api: "modsGithubTokenStatus", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:importZip", api: "modsImportZip", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:list", api: "modsList", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:marketInstall", api: "modsMarketInstall", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:marketList", api: "modsMarketList", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:myMods", api: "modsMyMods", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:mySubmissions", api: "modsMySubmissions", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:openAuthoringDoc", api: "modsOpenAuthoringDoc", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:openFolder", api: "modsOpenFolder", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:openModFolder", api: "modsOpenModFolder", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:plan", api: "modsPlan", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:publishOwnRepo", api: "modsPublishOwnRepo", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:readme", api: "modsReadme", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:registerSource", api: "modsRegisterSource", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:revealSubmissionZip", api: "modsRevealSubmissionZip", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:saveText", api: "modsSaveText", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:setEnabled", api: "modsSetEnabled", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:setOrder", api: "modsSetOrder", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:sign", api: "modsSign", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:submitGithub", api: "modsSubmitGithub", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:submitPrepare", api: "modsSubmitPrepare", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:templates", api: "modsTemplates", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "mods:uninstall", api: "modsUninstall", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "service:restart", api: "serviceRestart", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "service:start", api: "serviceStart", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "service:stop", api: "serviceStop", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "services:list", api: "servicesList", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "settings:get", api: "settingsGet", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "settings:set", api: "settingsSet", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "shell:openExternal", api: "openExternal", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "terminal:input", api: "terminalInput", kind: ChannelKind::Send },
    ChannelSpec { channel: "terminal:resize", api: "terminalResize", kind: ChannelKind::Send },
    ChannelSpec { channel: "update:apply", api: "updateApply", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "update:cancel", api: "updateCancel", kind: ChannelKind::Send },
    ChannelSpec { channel: "update:check", api: "updateCheck", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "update:download", api: "updateDownload", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "update:state", api: "updateState", kind: ChannelKind::Invoke },
    ChannelSpec { channel: "window:close", api: "windowClose", kind: ChannelKind::Send },
    ChannelSpec { channel: "window:minimize", api: "windowMinimize", kind: ChannelKind::Send },
    ChannelSpec { channel: "window:toggleMaximize", api: "windowToggleMaximize", kind: ChannelKind::Send },
    ChannelSpec { channel: "init:changed", api: "onInitChanged", kind: ChannelKind::Event },
    ChannelSpec { channel: "mod:downloadProgress", api: "onModDownloadProgress", kind: ChannelKind::Event },
    ChannelSpec { channel: "mod:publishProgress", api: "onModPublishProgress", kind: ChannelKind::Event },
    ChannelSpec { channel: "services:changed", api: "onServicesChanged", kind: ChannelKind::Event },
    ChannelSpec { channel: "terminal:data", api: "onTerminalData", kind: ChannelKind::Event },
    ChannelSpec { channel: "terminal:exit", api: "onTerminalExit", kind: ChannelKind::Event },
    ChannelSpec { channel: "update:changed", api: "onUpdateChanged", kind: ChannelKind::Event },
];

/// 按通道名查规范（线性扫描即可，通道数量级为百）
pub fn spec(channel: &str) -> Option<&'static ChannelSpec> {
    CHANNELS.iter().find(|item| item.channel == channel)
}

pub fn is_known(channel: &str) -> bool {
    spec(channel).is_some()
}

/// 需要回包或仅触发的请求通道（不含主进程 -> 渲染层的事件通道）
pub fn is_request(channel: &str) -> bool {
    matches!(spec(channel), Some(item) if item.kind != ChannelKind::Event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_channel_count_matches_generated_total() {
        let requests = CHANNELS
            .iter()
            .filter(|i| i.kind != ChannelKind::Event)
            .count();
        assert_eq!(requests, REQUEST_COUNT, "请求通道数量与契约不一致");
    }

    #[test]
    fn event_channel_count_matches_generated_total() {
        let events = CHANNELS
            .iter()
            .filter(|i| i.kind == ChannelKind::Event)
            .count();
        assert_eq!(events, EVENT_COUNT, "事件通道数量与契约不一致");
    }

    #[test]
    fn every_request_channel_is_looked_up() {
        for item in CHANNELS.iter().filter(|i| i.kind != ChannelKind::Event) {
            assert!(
                is_request(item.channel),
                "{} 应被识别为请求通道",
                item.channel
            );
        }
    }

    #[test]
    fn unknown_channel_is_rejected() {
        assert!(!is_known("not:a-real-channel"));
    }
}
