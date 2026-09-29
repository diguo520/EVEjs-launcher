//! S1 通道台账：哪些通道已真实现、哪些留给后续阶段，以及未实现通道的统一回包。
//!
//! 门禁 G1 要求「82/82 请求通道都有回包」——未实现通道一律返回
//! `{ ok: false, reason }`（与现役版失败分支同形状），渲染层 await 不会挂死。
//! 本文件末尾的单测负责守住这条线。
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy)]
pub struct Planned {
    pub channel: &'static str,
    pub stage: &'static str,
    pub module: &'static str,
}

/// 已在 `ipc::dispatch` 中真实实现的请求通道（S1: 26 → S2 Batch D: 65 → E: 78 → F: 82 个，S2 收口）
pub const HANDLED: &[&str] = &[
    "accounts:checkRunning",
    "accounts:create",
    "accounts:delete",
    "accounts:launch",
    "accounts:list",
    "accounts:setPassword",
    "accounts:verify",
    "app:info",
    "author:exportKey",
    "author:get",
    "author:importKey",
    "author:openKeyFolder",
    "author:setName",
    "config:get",
    "config:repairClientDisplay",
    "config:setClient",
    "config:setRepoRoot",
    "database:backup",
    "database:backups",
    "database:delete",
    "database:insert",
    "database:overview",
    "database:restore",
    "database:save",
    "database:table",
    "engage:start",
    "engage:stop",
    "env:check",
    "health:check",
    "health:ping",
    "init:run",
    "init:state",
    "log:read",
    "login:start",
    "metrics:get",
    "mods:authoringDoc",
    "mods:authoringDocText",
    "mods:create",
    "mods:createFolder",
    "mods:importZip",
    "mods:list",
    "mods:openAuthoringDoc",
    "mods:openFolder",
    "mods:openModFolder",
    "mods:plan",
    "mods:readme",
    "mods:saveText",
    "mods:setEnabled",
    "mods:setOrder",
    "mods:sign",
    "mods:templates",
    "mods:uninstall",
    // 本工程扩展通道（现役版没有）：契约见 contract/extensions.json
    "mods:updateMeta",
    // 重装系统后找回旧模组（本工程扩展，契约见 contract/extensions.json）：
    // claimCandidates=列出本机由别的身份署名的模组；claimMod=核验仓库归属并落认领记录
    "mods:claimCandidates",
    "mods:claimMod",
    "service:restart",
    "service:start",
    "service:stop",
    "services:list",
    "settings:get",
    "settings:set",
    "shell:openExternal",
    "terminal:input",
    "terminal:resize",
    "update:state",
    "window:close",
    "window:minimize",
    "window:toggleMaximize",
    // ---- S2 Batch E：模组市场 / 提交 / GitHub 令牌（13 个，见 docs/S2-发布与市场-实施记录.md）----
    "mods:marketList",
    "mods:marketInstall",
    "mods:myMods",
    "mods:submitPrepare",
    "mods:submitGithub",
    "mods:publishOwnRepo",
    "mods:registerSource",
    "mods:mySubmissions",
    "mods:revealSubmissionZip",
    "mods:githubTokenStatus",
    "mods:githubTokenSave",
    "mods:githubTokenClear",
    "mods:githubTokenCheck",
    // ---- S2 Batch F：启动器自更新（4 个，见 docs/S2-更新器-实施记录.md）----
    "update:apply",
    "update:cancel",
    "update:check",
    "update:download",
];

/// 待实现通道（**0 个**）：S2 收口后 82 条请求通道全部真实现。
///
/// 这个数组与配套的 `Planned` / `planned()` / `not_implemented()` 保留下来，
/// 因为 `scripts/verify-contract.mjs` 的门禁就是「HANDLED + PLANNED == 82」——
/// 后续阶段（S4 打包 / S5 测试）若再新增通道，往这里加一条即可，门禁不用改。
pub const PLANNED: &[Planned] = &[];
pub fn planned(channel: &str) -> Option<&'static Planned> {
    PLANNED.iter().find(|item| item.channel == channel)
}

pub fn is_handled(channel: &str) -> bool {
    HANDLED.contains(&channel)
}

/// 未实现通道的统一回包（形状与现役版失败分支一致）
pub fn not_implemented(channel: &str) -> Value {
    match planned(channel) {
        Some(item) => json!({
            "ok": false,
            "channel": channel,
            "reason": format!("尚未实现：{channel}（计划 {} 阶段 {})", item.stage, item.module),
            "stage": item.stage,
            "module": item.module
        }),
        None => json!({
            "ok": false,
            "channel": channel,
            "reason": format!("尚未实现：{channel}")
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::channels;
    use std::collections::HashSet;

    #[test]
    fn request_channels_are_fully_covered() {
        let handled: HashSet<&str> = HANDLED.iter().copied().collect();
        let planned: HashSet<&str> = PLANNED.iter().map(|item| item.channel).collect();

        assert_eq!(handled.len(), HANDLED.len(), "HANDLED 存在重复通道");
        assert_eq!(planned.len(), PLANNED.len(), "PLANNED 存在重复通道");
        assert!(
            handled.is_disjoint(&planned),
            "同一通道不能既已实现又待实现"
        );
        assert_eq!(
            handled.len() + planned.len(),
            channels::REQUEST_COUNT,
            "G1 门禁：请求通道必须 82/82 有回包"
        );
    }

    #[test]
    fn every_listed_channel_is_a_request_channel() {
        for channel in HANDLED
            .iter()
            .copied()
            .chain(PLANNED.iter().map(|item| item.channel))
        {
            assert!(channels::is_request(channel), "{channel} 不是请求通道");
        }
    }

    #[test]
    fn unknown_channel_is_reported_not_implemented() {
        // S2 收口后 PLANNED 为空，兜底分支只服务「契约里出现但没登记」的通道
        assert!(!is_handled("no:suchChannel"));
        assert!(planned("no:suchChannel").is_none());
        let value = not_implemented("no:suchChannel");
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["channel"], json!("no:suchChannel"));
        assert_eq!(value["reason"], json!("尚未实现：no:suchChannel"));
    }
}
