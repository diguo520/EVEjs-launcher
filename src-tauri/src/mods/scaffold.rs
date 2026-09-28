//! 模组脚手架：对齐现役版 `src/main/modScaffold.ts`，外加 `modManager.ts` 里
//! 「内置制作规范文档」那一节（`ensureModAuthoringDoc` / `readModAuthoringDocText`）。
//!
//! 两个关键约定（现役版注释里专门写过的）：
//!   - 唯一基准是已跑通的 `mods/welcome-mod`（= `MOD_AUTHORING.md` §6 骨架），
//!     `loader.js` 的三处写法（进程身份校验 / 不提前 require 大模块 / `unref`）一个都不能少；
//!   - 先写到 `_launcher/temp/scaffold-<id>/`，用真正的扫描器校验通过后才整体移入
//!     `mods/<id>` —— 不留下半个模组。
//!
//! 骨架正文（100+ 行 JS）在 `scaffold_loader.rs`，由 `scripts/extract-loader-skeleton.mjs`
//! 从现役版源码抽取，逐字节一致。
use super::scan::{self, MANIFEST_NAME};
use crate::runtime::RuntimePaths;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/* ------------------------------ 模板 ------------------------------ */

pub struct ScaffoldTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    /// 生成的文件（相对模组根）
    pub files: &'static [&'static str],
    pub category: &'static str,
    pub requires_restart: bool,
    pub tags: &'static [&'static str],
    /// 默认功能要点（填进 README）
    pub highlights: &'static [&'static str],
}

const TEMPLATE_FILES: &[&str] = &[
    "evejs-launcher.mod.json",
    "loader.js",
    "README.md",
    "CHANGELOG.md",
];

pub const SCAFFOLD_TEMPLATES: &[ScaffoldTemplate] = &[
    ScaffoldTemplate {
        id: "broadcast",
        name: "Welcome Broadcast (Example)",
        desc: "加载模组后会在游戏本地聊天框看到一条「欢迎回来，飞行员」的信息。",
        files: TEMPLATE_FILES,
        category: "玩法",
        requires_restart: true,
        tags: &["聊天", "新手"],
        highlights: &[
            "玩家上线后在其本地聊天频道发送欢迎消息",
            "只改运行内存，不修改 server/ 下任何文件",
            "骨架已内置进程身份校验与 require.cache 等待，不会提前拉起大依赖",
        ],
    },
    ScaffoldTemplate {
        id: "blank",
        name: "Blank Skeleton",
        desc: "同样的加载骨架，业务逻辑留空，适合从零写起",
        files: TEMPLATE_FILES,
        category: "玩法",
        requires_restart: true,
        tags: &[],
        highlights: &[
            "保留全部 loader 加载要点（身份校验 / require.cache 等待 / unref）",
            "业务钩子集中在 loader.js 的 start() 里，改这一处即可",
        ],
    },
];

fn template_json(template: &ScaffoldTemplate) -> Value {
    json!({
        "id": template.id,
        "name": template.name,
        "desc": template.desc,
        "files": template.files,
        "fileCount": template.files.len(),
        "sizeBytes": template_size_bytes(template),
        "category": template.category,
        "requiresRestart": template.requires_restart,
        "tags": template.tags,
        "highlights": template.highlights,
    })
}

/// 模板骨架的参考体积（字节）：用一份固定的示例 draft 走真实生成管线，
/// 把四个文件按落盘时的字节数相加。
///
/// 真实创建时 id / 显示名 / 简介的长度由作者决定，几百字节的浮动免不了，
/// 所以界面上按「约」展示；这里取一份长度适中的示例，量级与实际一致。
fn template_size_bytes(template: &ScaffoldTemplate) -> u64 {
    let draft = json!({
        "id": "your-mod-id",
        "displayName": "Your Mod Name",
        "version": "1.0.0",
        "description": template.desc,
        "templateId": template.id,
        "requiresRestart": template.requires_restart,
    });
    // 示例身份：把 author 块也算进体积（真实创建时作者身份通常已存在）
    let sample = crate::author::AuthorIdentity {
        id: "au-sample000000".to_string(),
        name: "Sample Author".to_string(),
        key_id: "0123456789ab".to_string(),
        public_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY0123".to_string(),
    };
    let manifest_text = format!(
        "{}\n",
        manifest_from(&draft, template, "0.12.8", Some(&sample))
    );
    let mut total = manifest_text.len() as u64;
    total += loader_from(&draft, template).len() as u64;
    total += readme_from(&draft, template).len() as u64;
    total += changelog_from(&draft).len() as u64;
    total
}

/// `mods:templates`
pub fn templates_json() -> Value {
    json!({
        "ok": true,
        "templates": SCAFFOLD_TEMPLATES.iter().map(template_json).collect::<Vec<_>>(),
    })
}

/// 找不到就回退第一个模板（对齐现役版 `findTemplate(...) || SCAFFOLD_TEMPLATES[0]`）
pub fn find_template(id: &str) -> &'static ScaffoldTemplate {
    SCAFFOLD_TEMPLATES
        .iter()
        .find(|template| template.id == id)
        .unwrap_or(&SCAFFOLD_TEMPLATES[0])
}

/* ------------------------------ id 规则 ------------------------------ */

const ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789-._";
const SLUG_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._";

/// 把「不在字母表里的连续段」压成一个 `-`（等价 JS 的 `/[...]+/g` 替换）
fn squash_runs(raw: &str, alphabet: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_run = false;
    for ch in raw.chars() {
        if ch.is_ascii() && alphabet.contains(&(ch as u8)) {
            in_run = false;
            out.push(ch);
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

/// id 安全化：只留 `[a-z0-9-_.]`，与 modManager 的文件夹规则保持一致
pub fn normalize_mod_id(raw: &str) -> String {
    squash_runs(&raw.to_lowercase(), ID_ALPHABET)
        .trim_matches(|ch| ch == '-' || ch == '_' || ch == '.')
        .chars()
        .take(64)
        .collect()
}

/// 从模组名推 id（中文名推不出拉丁字符时返回空串，由调用方兜底）
pub fn slugify_mod_id(name: &str) -> String {
    normalize_mod_id(&squash_runs(name, SLUG_ALPHABET))
}

/* ------------------------------ draft 读取 ------------------------------ */

fn draft_str(draft: &Value, key: &str) -> String {
    draft
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn draft_strings(draft: &Value, key: &str) -> Vec<String> {
    draft
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
/* ------------------------------ 生成正文 ------------------------------ */

fn readme_from(draft: &Value, template: &ScaffoldTemplate) -> String {
    let highlights = {
        let from_draft = draft_strings(draft, "highlights");
        if from_draft.is_empty() {
            template
                .highlights
                .iter()
                .map(|item| item.to_string())
                .collect()
        } else {
            from_draft
        }
    };
    render_readme(
        &draft_str(draft, "displayName"),
        &draft_str(draft, "description"),
        &highlights,
        &draft_str(draft, "readme"),
    )
}

/// README 版式（单一来源）：新建骨架与「编辑信息」都走这里，改一处两边一起变。
/// 空段落直接不写 —— 作者把功能要点清空时，README 里就不该再留着那一段。
fn render_readme(
    display_name: &str,
    description: &str,
    highlights: &[String],
    readme: &str,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("# {display_name}"));
    lines.push(String::new());
    lines.push(description.to_string());
    lines.push(String::new());

    if !highlights.is_empty() {
        lines.push("## 功能要点".to_string());
        lines.push(String::new());
        for item in highlights {
            lines.push(format!("- {item}"));
        }
        lines.push(String::new());
    }

    if !readme.trim().is_empty() {
        lines.push("## 详细介绍".to_string());
        lines.push(String::new());
        lines.push(readme.trim().to_string());
        lines.push(String::new());
    }

    lines.push("## 安装与启用".to_string());
    lines.push(String::new());
    lines.push("1. 启动器 → 模组 / 插件 → 打开 mods 目录，确认本目录已在其中".to_string());
    lines.push("2. 在模组列表里启用它（会把 `loader.js.disabled` 改名为 `loader.js`）".to_string());
    lines.push("3. 重启主服务器（本模组 `restart: game_server`）".to_string());
    lines.push(String::new());
    lines.push(
        "> 本模组不修改 `server/` 下任何文件，通过 `NODE_OPTIONS=--require` 注入运行内存。"
            .to_string(),
    );
    lines.push(String::new());
    lines.join("\n")
}

fn changelog_from(draft: &Value) -> String {
    let version = {
        let raw = draft_str(draft, "version");
        if raw.is_empty() {
            "1.0.0".to_string()
        } else {
            raw
        }
    };
    // 现役版用 `new Date().toISOString().slice(0, 10)`：UTC 日期
    let today: String = crate::process::iso_timestamp().chars().take(10).collect();
    [
        "# 更新日志".to_string(),
        String::new(),
        format!("## {version} - {today}"),
        String::new(),
        "- 首个版本".to_string(),
        String::new(),
    ]
    .join("\n")
}

/// `loader.js` 骨架：进程身份校验 + require.cache 等待 + 业务钩子
fn loader_from(draft: &Value, template: &ScaffoldTemplate) -> String {
    let id = {
        let raw = draft_str(draft, "id");
        if raw.is_empty() {
            "mod".to_string()
        } else {
            raw
        }
    };
    let display_name = draft_str(draft, "displayName");
    let fill = |line: &str| {
        line.replace("@DISPLAY_NAME@", &display_name)
            .replace("@ID@", &id)
    };

    let biz: &[&str] = if template.id == "blank" {
        super::scaffold_loader::LOADER_BIZ_BLANK
    } else {
        super::scaffold_loader::LOADER_BIZ_BROADCAST
    };
    let mut lines: Vec<String> = Vec::new();
    lines.extend(
        super::scaffold_loader::LOADER_HEAD
            .iter()
            .map(|line| fill(line)),
    );
    lines.extend(biz.iter().map(|line| fill(line)));
    lines.extend(
        super::scaffold_loader::LOADER_TAIL
            .iter()
            .map(|line| fill(line)),
    );
    lines.join("\n")
}

/// 清单的序列化形状：字段顺序照抄现役版 `JSON.stringify(manifest, null, 2)` 的插入顺序。
/// 为什么不用 `Value`：serde_json 的 Map 默认按字母序输出，而清单是模组的身份文件，
/// 新旧启动器为同一个 draft 建出来的骨架应当能直接 diff 对齐，键顺序也不能漂。
#[derive(serde::Serialize)]
struct ScaffoldManifest<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    id: &'a str,
    #[serde(rename = "displayName")]
    display_name: &'a str,
    version: &'a str,
    description: &'a str,
    kind: &'a str,
    #[serde(rename = "supportedBackends")]
    supported_backends: [&'a str; 2],
    activation: ScaffoldActivation,
    restart: &'a str,
    category: &'a str,
    tags: &'a [String],
    conflicts: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<ScaffoldAuthor<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility: Option<ScaffoldCompatibility<'a>>,
}

#[derive(serde::Serialize)]
struct ScaffoldActivation {
    strategy: &'static str,
}

#[derive(serde::Serialize)]
struct ScaffoldAuthor<'a> {
    id: &'a str,
    name: &'a str,
    #[serde(rename = "keyId")]
    key_id: &'a str,
    #[serde(rename = "publicKey")]
    public_key: &'a str,
}

#[derive(serde::Serialize)]
struct ScaffoldCompatibility<'a> {
    #[serde(rename = "evejsVersions")]
    evejs_versions: [&'a str; 1],
}

/// 生成清单正文（不含末尾换行，落盘时由调用方补一个 `\n`）
fn manifest_from(
    draft: &Value,
    template: &ScaffoldTemplate,
    evejs_version: &str,
    author: Option<&crate::author::AuthorIdentity>,
) -> String {
    let category = {
        let raw = draft_str(draft, "category");
        if raw.is_empty() {
            template.category.to_string()
        } else {
            raw
        }
    };
    let tags = {
        let from_draft = draft_strings(draft, "tags");
        if from_draft.is_empty() {
            template.tags.iter().map(|item| item.to_string()).collect()
        } else {
            from_draft
        }
    };
    let version = {
        let raw = draft_str(draft, "version");
        if raw.is_empty() {
            "1.0.0".to_string()
        } else {
            raw
        }
    };

    // 现役版：`draft.requiresRestart === false ? "none" : "game_server"`
    let restart = if draft.get("requiresRestart").and_then(Value::as_bool) == Some(false) {
        "none"
    } else {
        "game_server"
    };

    // publicKey 必须一起发布：市场索引里带上它，下载方才能验证作者签名
    // （否则只能报「签名密钥不在信任列表」）。读不到身份就先不写 author 块
    // —— 与现役版 `getAuthor()` 的差别：这里只读，不顺手生成密钥（S2-D11）。
    let author_block = author.map(|identity| ScaffoldAuthor {
        id: &identity.id,
        name: &identity.name,
        key_id: &identity.key_id,
        public_key: &identity.public_key,
    });
    // 现役版 `/^\d+\.\d+/`：版本号不像样就整块不写
    let compatibility = if is_version_like(evejs_version) {
        Some(ScaffoldCompatibility {
            evejs_versions: [evejs_version],
        })
    } else {
        None
    };

    let manifest = ScaffoldManifest {
        schema_version: 3,
        id: &draft_str(draft, "id"),
        display_name: &draft_str(draft, "displayName"),
        version: &version,
        description: &draft_str(draft, "description"),
        kind: "loader",
        supported_backends: ["native", "docker"],
        activation: ScaffoldActivation {
            strategy: "loader_rename",
        },
        restart,
        category: &category,
        tags: &tags,
        conflicts: &draft_strings(draft, "conflicts"),
        author: author_block,
        compatibility,
    };
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

/// 现役版 `/^\d+\.\d+/`：开头是「数字.数字」就认为能拿来写兼容性声明
fn is_version_like(value: &str) -> bool {
    let mut parts = value.split('.');
    let major = parts.next().unwrap_or_default();
    let minor = parts.next().unwrap_or_default();
    !major.is_empty()
        && !minor.is_empty()
        && major.chars().all(|ch| ch.is_ascii_digit())
        && minor.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

/// 现役版 `/^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.\-]+)?$/`
fn is_semver_like(value: &str) -> bool {
    let (head, tail) = match value.find(['-', '+']) {
        Some(index) => (&value[..index], Some(&value[index + 1..])),
        None => (value, None),
    };
    if head.is_empty() {
        return false;
    }
    if !head
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return false;
    }
    match tail {
        None => true,
        Some(tail) => {
            !tail.is_empty()
                && tail
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
        }
    }
}
/* ------------------------------ 创建模组 ------------------------------ */

/// `mods:create`：校验 → 写临时目录 → 整体移入 `mods/<id>` → 可选签名 / 启用
pub fn create_mod(
    repo_root: &Path,
    draft: &Value,
    evejs_version: &str,
    runtime: &RuntimePaths,
) -> Value {
    let template_id = {
        let raw = draft_str(draft, "templateId");
        if raw.is_empty() {
            "broadcast".to_string()
        } else {
            raw
        }
    };
    let template = find_template(&template_id);
    let id = normalize_mod_id(&draft_str(draft, "id"));
    if id.is_empty() {
        return json!({
            "ok": false,
            "reason": "标识（id）必须是字母 / 数字 / - _ . 组成的非空文本"
        });
    }
    if draft_str(draft, "displayName").trim().is_empty() {
        return json!({ "ok": false, "reason": "模组名不能为空" });
    }
    let version = {
        let raw = draft_str(draft, "version");
        if raw.is_empty() {
            "1.0.0".to_string()
        } else {
            raw
        }
    };
    if !is_semver_like(&version) {
        return json!({ "ok": false, "reason": "版本号格式必须像 1.0.0" });
    }

    let root = crate::mods::mods_root(repo_root);
    // B1：id 来自用户输入，拼路径前做组件级包含判定（同时挡掉 `..`/盘符/分隔符）
    let Some(target) = crate::mods::join_within(&root, &id) else {
        return json!({ "ok": false, "reason": "模组 ID 非法" });
    };
    if target.exists() {
        return json!({ "ok": false, "reason": format!("mods/ 下已经存在同名目录：{id}") });
    }

    let stage = runtime
        .temp
        .join(format!("scaffold-{id}-{}", super::pkg::epoch_ms()));
    let written = (|| -> std::io::Result<()> {
        fs::create_dir_all(&stage)?;
        // 清单里的 id 用规范化后的值（现役版是 `manifestFrom({...draft, id}, ...)`）
        let mut effective = draft.clone();
        if let Some(map) = effective.as_object_mut() {
            map.insert("id".to_string(), json!(id));
        }
        let author = crate::author::read_identity_at(runtime).ok();
        let text = manifest_from(&effective, template, evejs_version, author.as_ref());
        fs::write(stage.join(MANIFEST_NAME), format!("{text}\n"))?;
        // loader / README / CHANGELOG 用原始 draft（与现役版一致）
        fs::write(
            stage.join(scan::LOADER_DISABLED),
            loader_from(draft, template),
        )?;
        fs::write(stage.join("README.md"), readme_from(draft, template))?;
        fs::write(stage.join("CHANGELOG.md"), changelog_from(draft))?;
        Ok(())
    })();
    if let Err(err) = written {
        super::pkg::cleanup_path(&stage);
        return json!({ "ok": false, "reason": format!("写入临时目录失败: {err}") });
    }

    // 先用真正的扫描器校验一遍，不合格就不落地
    let probe = scan::read_mod_dir(&id, &stage);
    if !probe.valid {
        super::pkg::cleanup_path(&stage);
        return json!({
            "ok": false,
            "reason": format!("生成的清单没通过校验: {}", probe.error)
        });
    }

    let moved = (|| -> std::io::Result<()> {
        fs::create_dir_all(&root)?;
        fs::rename(&stage, &target)
    })();
    if let Err(err) = moved {
        super::pkg::cleanup_path(&stage);
        return json!({ "ok": false, "reason": format!("移动到 mods/ 失败: {err}") });
    }

    let mut result = Map::new();
    result.insert("ok".to_string(), json!(true));
    result.insert("folder".to_string(), json!(id));
    result.insert("dir".to_string(), json!(target.to_string_lossy()));
    result.insert("files".to_string(), json!(template.files));
    result.insert("signed".to_string(), json!(false));

    if draft.get("sign").and_then(Value::as_bool) == Some(true) {
        let signed = super::plan::sign_mod_folder(repo_root, &id, runtime);
        if signed.get("ok").and_then(Value::as_bool) == Some(true) {
            result.insert("signed".to_string(), json!(true));
            if let Some(key_id) = signed.get("keyId") {
                result.insert("keyId".to_string(), key_id.clone());
            }
        } else {
            result.insert(
                "reason".to_string(),
                json!(format!(
                    "模组已创建，但签名失败：{}",
                    signed.get("reason").and_then(Value::as_str).unwrap_or("")
                )),
            );
        }
    }

    // 默认禁用（loader.js.disabled）；只有明确勾了「立即启用」才改名。
    // 改名失败不吞：勾了「立即启用」却落成 loader.js.disabled，用户看到的就是
    // 「明明勾了还生成 .disabled」——这种失败必须把原因带回渲染层（2026-09-28 报障）。
    if draft.get("enabled").and_then(Value::as_bool) == Some(true) {
        let disabled = target.join(scan::LOADER_DISABLED);
        let enabled = target.join(scan::LOADER_ENABLED);
        if let Err(err) = fs::rename(&disabled, &enabled) {
            // 报错但文件其实已就位（杀软短暂占用之类）不算失败，先确认结果再下结论
            if !enabled.is_file() {
                let note = format!("模组已创建，但启用失败（{err}），文件仍是 loader.js.disabled");
                let previous = result
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let merged = if previous.is_empty() {
                    note
                } else {
                    format!("{previous}；{note}")
                };
                result.insert("reason".to_string(), json!(merged));
            }
        }
    }

    Value::Object(result)
}

/* ------------------------------ 内置制作规范文档 ------------------------------ */

/// 支持中/英两份：zh → `MOD_AUTHORING.md`，其它语言 → `MOD_AUTHORING.en.md`
pub const DOC_LANGS: [&str; 2] = ["zh", "en"];

/// 正文直接内嵌进二进制：现役版是从 `dist/renderer/` 读文件，
/// 内嵌后没有「文件丢了 → 文档打不开」这条路径，也不会随打包漏拷。
const DOC_ZH: &str = include_str!("../../../ui/web/MOD_AUTHORING.md");
const DOC_EN: &str = include_str!("../../../ui/web/MOD_AUTHORING.en.md");

/// 现役版 `normalizeDocLang`：只有 "zh" 走中文，其余（含缺省）都算英文
fn normalize_doc_lang(lang: Option<&str>) -> &'static str {
    match lang {
        Some(value) if value.to_lowercase() == "zh" => "zh",
        _ => "en",
    }
}

fn doc_file_name(lang: Option<&str>) -> &'static str {
    if normalize_doc_lang(lang) == "zh" {
        "MOD_AUTHORING.md"
    } else {
        "MOD_AUTHORING.en.md"
    }
}

fn doc_source(lang: Option<&str>) -> &'static str {
    if normalize_doc_lang(lang) == "zh" {
        DOC_ZH
    } else {
        DOC_EN
    }
}

/// 释放目标：`_launcher/mods/MOD_AUTHORING.md`（文件名保持 ASCII）
pub fn mod_authoring_doc_path(runtime: &RuntimePaths, lang: Option<&str>) -> PathBuf {
    runtime.root.join("mods").join(doc_file_name(lang))
}

/// `mods:authoringDoc`：把内置规范写到 `_launcher/mods/`。
/// 内容一致时不写盘，避免每次启动都产生磁盘写入。
pub fn ensure_mod_authoring_doc(runtime: &RuntimePaths, lang: Option<&str>) -> Value {
    let target = mod_authoring_doc_path(runtime, lang);
    let source = doc_source(lang);
    let outcome = (|| -> std::io::Result<bool> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::read_to_string(&target).unwrap_or_default() == source {
            return Ok(false);
        }
        fs::write(&target, source)?;
        Ok(true)
    })();
    match outcome {
        Ok(written) => json!({
            "ok": true,
            "path": target.to_string_lossy(),
            "written": written
        }),
        Err(err) => json!({
            "ok": false,
            "path": target.to_string_lossy(),
            "written": false,
            "reason": err.to_string()
        }),
    }
}

/// `mods:authoringDocText`：英文文档缺失时回退中文，至少让用户看到内容
pub fn read_mod_authoring_doc_text(runtime: &RuntimePaths, lang: Option<&str>) -> Value {
    let mut doc = ensure_mod_authoring_doc(runtime, lang);
    if doc.get("ok").and_then(Value::as_bool) != Some(true) && normalize_doc_lang(lang) == "en" {
        doc = ensure_mod_authoring_doc(runtime, Some("zh"));
    }
    if doc.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "reason": doc.get("reason").cloned().unwrap_or(Value::Null),
            "path": doc.get("path").cloned().unwrap_or(Value::Null),
        });
    }
    let path = doc
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    match fs::read_to_string(&path) {
        Ok(text) => json!({ "ok": true, "text": text, "path": path }),
        Err(err) => json!({ "ok": false, "reason": err.to_string(), "path": path }),
    }
}

/// 启动时把中/英两份都释放到 `_launcher/mods/`（单份失败不影响启动）
pub fn ensure_all_mod_authoring_docs(runtime: &RuntimePaths) {
    for lang in DOC_LANGS {
        let _ = ensure_mod_authoring_doc(runtime, Some(lang));
    }
}

/// `mods:openAuthoringDoc`：先释放文档，再交给系统打开；
/// 系统没有 `.md` 关联程序时退化为「在资源管理器中选中该文件」。
pub fn open_authoring_doc(app: &AppHandle, runtime: &RuntimePaths) -> Value {
    let doc = ensure_mod_authoring_doc(runtime, None);
    let path = doc
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if doc.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "reason": doc.get("reason").cloned().unwrap_or(Value::Null),
            "path": path
        });
    }
    use tauri_plugin_opener::OpenerExt;
    if app.opener().open_path(&path, None::<&str>).is_ok() {
        return json!({ "ok": true, "path": path, "revealed": false });
    }
    match crate::shell::reveal_in_explorer(Path::new(&path)) {
        Ok(()) => {
            json!({ "ok": true, "path": path, "revealed": true, "reason": "系统没有打开 .md 的默认程序" })
        }
        Err(reason) => json!({ "ok": false, "reason": reason, "path": path }),
    }
}
/* ------------------------- 编辑已有模组的信息 ------------------------- */

/// 「编辑信息」：只改**非身份字段**，身份由签名保护。
///
/// 允许改：displayName / description / category / tags / conflicts / requiresRestart，
/// 以及 README.md（readme 正文 + highlights 功能要点；这两项由界面成对提交，
/// 只带其中一项时另一项按空处理 —— 直接调 IPC 的人要知道这一点）。
/// 一律不碰：id / version / kind / activation / author（署名）/ signature。
///
/// 为什么写完必须重签：清单参与签名，改一个字节旧签名就失效，模组会立刻变成
/// 「签名无效」（scan 会把它标成被篡改）。重签复用 `plan::sign_mod_folder` ——
/// 与手动点「签名」完全同一条路径，归属保护（不能替别人签名）也在那里面，
/// 所以这里不重复实现一遍。重签失败时把清单与 README 回滚成原样，
/// 绝不留下「改了一半又没签名」的模组。
pub fn update_mod_meta(
    repo_root: &Path,
    runtime: &RuntimePaths,
    folder: &str,
    patch: &Value,
) -> Value {
    let Some(dir) = crate::mods::join_within(&crate::mods::mods_root(repo_root), folder) else {
        return json!({ "ok": false, "reason": "模组目录名非法" });
    };
    let safe = crate::mods::safe_folder_name(folder);
    let manifest_path = dir.join(MANIFEST_NAME);
    if !manifest_path.is_file() {
        return json!({ "ok": false, "reason": format!("找不到 {MANIFEST_NAME}") });
    }
    let original_manifest = fs::read_to_string(&manifest_path).unwrap_or_default();
    let mut manifest = match scan::read_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    let Some(patch_object) = patch.as_object() else {
        return json!({ "ok": false, "reason": "没有要改的字段" });
    };

    // 显示名：给了就必须非空（列表里不该出现一张没有标题的卡片）
    if patch_object.contains_key("displayName") {
        let name = draft_str(patch, "displayName").trim().to_string();
        if name.is_empty() {
            return json!({ "ok": false, "reason": "模组名不能为空" });
        }
        manifest.insert("displayName".to_string(), json!(name));
    }
    for key in ["description", "category"] {
        if patch_object.contains_key(key) {
            manifest.insert(key.to_string(), json!(draft_str(patch, key)));
        }
    }
    // 数组字段做类型过滤（非字符串项丢掉），与脚手架读 draft 的口径一致
    for key in ["tags", "conflicts"] {
        if patch_object.contains_key(key) {
            manifest.insert(key.to_string(), json!(draft_strings(patch, key)));
        }
    }
    if patch_object.contains_key("requiresRestart") {
        // 与 manifest_from 同一套映射：false → none，其余（含缺省）→ game_server
        let restart = if patch.get("requiresRestart").and_then(Value::as_bool) == Some(false) {
            "none"
        } else {
            "game_server"
        };
        manifest.insert("restart".to_string(), json!(restart));
    }

    // 清单内容变了 → 旧签名失效，先摘掉（重签那一步会补回来）
    manifest.remove("signature");
    let updated = Value::Object(manifest);
    let text = serde_json::to_string_pretty(&updated).unwrap_or_default() + "\n";
    if let Err(error) = fs::write(&manifest_path, text) {
        return json!({ "ok": false, "reason": format!("清单写入失败: {error}") });
    }

    // README：补丁里带了正文或功能要点就整篇按版式重渲染。
    // 只带 description / displayName 时不动 README —— 否则「改个简介」会把功能要点整段抹掉。
    let readme_path = dir.join("README.md");
    let original_readme = fs::read_to_string(&readme_path).ok();
    let touched_readme =
        patch_object.contains_key("readme") || patch_object.contains_key("highlights");
    if touched_readme {
        let body = render_readme(
            &draft_str(&updated, "displayName"),
            &draft_str(&updated, "description"),
            &draft_strings(patch, "highlights"),
            &draft_str(patch, "readme"),
        );
        if let Err(error) = fs::write(&readme_path, body) {
            let _ = fs::write(&manifest_path, &original_manifest);
            return json!({ "ok": false, "reason": format!("README 写入失败: {error}") });
        }
    }

    let signed = super::plan::sign_mod_folder(repo_root, &safe, runtime);
    if signed.get("ok").and_then(Value::as_bool) != Some(true) {
        let _ = fs::write(&manifest_path, &original_manifest);
        match original_readme {
            Some(text) => {
                let _ = fs::write(&readme_path, text);
            }
            None => {
                let _ = fs::remove_file(&readme_path);
            }
        }
        let reason = signed
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("重新签名失败");
        return json!({ "ok": false, "reason": reason });
    }

    json!({
        "ok": true,
        "folder": safe,
        "manifestPath": manifest_path.to_string_lossy(),
        "readmeUpdated": touched_readme,
        "keyId": signed.get("keyId").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "evejs-mods-scaffold-{tag}-{}",
            super::super::pkg::epoch_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn runtime_at(root: &Path) -> RuntimePaths {
        let runtime = RuntimePaths::from_root(root.join("_launcher"), false);
        for dir in [&runtime.root, &runtime.temp] {
            fs::create_dir_all(dir).expect("建运行时目录");
        }
        runtime
    }

    fn draft(id: &str, display_name: &str) -> Value {
        json!({
            "id": id,
            "displayName": display_name,
            "version": "1.2.3",
            "description": "示例描述",
            "templateId": "broadcast"
        })
    }

    #[test]
    fn normalize_and_slugify_match_electron() {
        assert_eq!(normalize_mod_id(" My Mod! "), "my-mod");
        assert_eq!(normalize_mod_id("a..b"), "a..b");
        assert_eq!(normalize_mod_id("..a.."), "a");
        assert_eq!(normalize_mod_id("A_B.C-D"), "a_b.c-d");
        assert_eq!(normalize_mod_id("我的模组"), "");
        assert_eq!(normalize_mod_id(&"x".repeat(80)).len(), 64);
        // slugify 先压非拉丁段再规范化：中文名推不出 id
        assert_eq!(slugify_mod_id("Hello World"), "hello-world");
        assert_eq!(slugify_mod_id("我的模组 v2"), "v2");
        assert_eq!(slugify_mod_id(""), "");
    }

    #[test]
    fn version_guards_match_electron() {
        for good in [
            "1",
            "1.0.0",
            "0.1",
            "10.20.30",
            "1.0.0-beta.1",
            "1.0.0+build-7",
        ] {
            assert!(is_semver_like(good), "{good} 应通过");
        }
        for bad in ["", "v1.0.0", "1.0.0-", "1.0.0+", "1.0.0_beta", "1..0"] {
            assert!(!is_semver_like(bad), "{bad} 应被拒绝");
        }
        assert!(is_version_like("0.12.8"));
        assert!(is_version_like("0.12"));
        assert!(!is_version_like("v0.12"));
        assert!(!is_version_like("0."));
    }

    #[test]
    fn loader_skeleton_substitutes_placeholders() {
        let broadcast = loader_from(&draft("demo-mod", "示例模组"), find_template("broadcast"));
        assert!(broadcast.contains("const TAG = \"[demo-mod]\";"));
        assert!(broadcast.contains(" * 示例模组 —— EveJS 模组（kind: loader）"));
        assert!(broadcast.contains("chatHub.sendSystemMessage(session, MESSAGE);"));
        assert!(broadcast.contains("timer.unref()"));
        assert!(broadcast.contains("/(^|[\\\\/])index\\.js$/i.test(entry)"));
        assert!(!broadcast.contains("@ID@"));
        assert!(!broadcast.contains("@DISPLAY_NAME@"));

        let blank = loader_from(&draft("blank-one", "空白"), find_template("blank"));
        assert!(blank.contains("const TAG = \"[blank-one]\";"));
        assert!(blank.contains("业务逻辑写在这里"));
        // 空白骨架不含广播逻辑（TODO 注释里会提到 sendSystemMessage，这里查真正的实现标记）
        assert!(!blank.contains("const seen = new Set();"));
        assert!(blank.len() < broadcast.len());

        // 骨架正文的行数与抽取结果一致（防止有人手改 scaffold_loader.rs）
        assert_eq!(super::super::scaffold_loader::LOADER_HEAD.len(), 63);
        assert_eq!(super::super::scaffold_loader::LOADER_BIZ_BLANK.len(), 7);
        assert_eq!(
            super::super::scaffold_loader::LOADER_BIZ_BROADCAST.len(),
            59
        );
        assert_eq!(super::super::scaffold_loader::LOADER_TAIL.len(), 40);
        assert_eq!(broadcast.split('\n').count(), 63 + 59 + 40);
        assert_eq!(blank.split('\n').count(), 63 + 7 + 40);
    }

    #[test]
    fn create_mod_writes_a_valid_disabled_mod() {
        let root = temp_dir("create");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let result = create_mod(&repo, &draft("Demo Mod", "演示模组"), "0.12.8", &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["folder"], json!("demo-mod"), "id 应被规范化");
        assert_eq!(result["signed"], json!(false));
        assert!(result["reason"].is_null());

        let dir = repo.join("mods").join("demo-mod");
        assert!(dir.join(scan::MANIFEST_NAME).is_file());
        assert!(dir.join("README.md").is_file());
        assert!(dir.join("CHANGELOG.md").is_file());
        // 默认禁用
        assert!(dir.join(scan::LOADER_DISABLED).is_file());
        assert!(!dir.join(scan::LOADER_ENABLED).exists());

        let record = scan::read_mod_dir("demo-mod", &dir);
        assert!(
            record.valid,
            "生成的清单必须通过扫描器校验：{}",
            record.error
        );
        assert_eq!(record.id, "demo-mod");
        assert_eq!(record.display_name, "演示模组");
        assert_eq!(record.version, "1.2.3");
        assert_eq!(record.restart, "game_server");
        assert_eq!(record.category, "玩法");
        assert_eq!(record.tags, vec!["聊天".to_string(), "新手".to_string()]);
        // 骨架里的 require.resolve 目标会被启发式扫描识别出来（chatHub / sessionRegistry）
        assert_eq!(
            record.modules,
            vec!["chatHub.js".to_string(), "sessionRegistry.js".to_string()]
        );

        // 临时目录已清理
        let leftovers: Vec<String> = fs::read_dir(&runtime.temp)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("scaffold-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录应清理干净：{leftovers:?}");

        // 清单里带兼容性声明（evejsVersion 像版本号时）
        let manifest = fs::read_to_string(dir.join(scan::MANIFEST_NAME)).unwrap();
        assert!(manifest.contains("\"compatibility\""));
        assert!(manifest.contains("0.12.8"));
    }

    #[test]
    fn create_mod_rejects_bad_input_and_duplicates() {
        let root = temp_dir("create-bad");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let bad_id = create_mod(&repo, &draft("我的模组", "名字"), "0.12.8", &runtime);
        assert_eq!(bad_id["ok"], json!(false));
        assert!(bad_id["reason"].as_str().unwrap().contains("标识（id）"));

        let mut no_name = draft("ok-id", "名字");
        no_name["displayName"] = json!("   ");
        let empty_name = create_mod(&repo, &no_name, "0.12.8", &runtime);
        assert_eq!(empty_name["reason"], json!("模组名不能为空"));

        let mut bad_version = draft("ok-id", "名字");
        bad_version["version"] = json!("v1");
        let version = create_mod(&repo, &bad_version, "0.12.8", &runtime);
        assert_eq!(version["reason"], json!("版本号格式必须像 1.0.0"));

        assert_eq!(
            create_mod(&repo, &draft("ok-id", "名字"), "0.12.8", &runtime)["ok"],
            json!(true)
        );
        let again = create_mod(&repo, &draft("ok-id", "名字"), "0.12.8", &runtime);
        assert_eq!(again["ok"], json!(false));
        assert!(again["reason"]
            .as_str()
            .unwrap()
            .contains("已经存在同名目录"));
    }

    #[test]
    fn create_mod_enabled_and_sign_flags() {
        let root = temp_dir("create-flags");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let mut wanted = draft("instant-on", "立即启用");
        wanted["enabled"] = json!(true);
        let result = create_mod(&repo, &wanted, "0.12.8", &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        let dir = repo.join("mods").join("instant-on");
        assert!(dir.join(scan::LOADER_ENABLED).is_file());
        assert!(!dir.join(scan::LOADER_DISABLED).exists());

        // 本机没有作者身份时：模组照样建好，只把签名失败写进 reason
        let mut to_sign = draft("signed-one", "要签名");
        to_sign["sign"] = json!(true);
        let signed = create_mod(&repo, &to_sign, "0.12.8", &runtime);
        assert_eq!(signed["ok"], json!(true), "{signed}");
        assert_eq!(signed["signed"], json!(false));
        assert!(signed["reason"]
            .as_str()
            .unwrap()
            .starts_with("模组已创建，但签名失败："));

        // 空白模板 + 自定义冲突/标签/要点
        let mut custom = draft("blank-custom", "空白定制");
        custom["templateId"] = json!("blank");
        custom["conflicts"] = json!(["other-mod"]);
        custom["tags"] = json!(["工具"]);
        custom["highlights"] = json!(["要点 A"]);
        custom["readme"] = json!("  详细介绍正文  ");
        custom["requiresRestart"] = json!(false);
        let custom_result = create_mod(&repo, &custom, "v0.12", &runtime);
        assert_eq!(custom_result["ok"], json!(true), "{custom_result}");
        let custom_dir = repo.join("mods").join("blank-custom");
        let record = scan::read_mod_dir("blank-custom", &custom_dir);
        assert_eq!(record.restart, "none");
        assert_eq!(record.tags, vec!["工具".to_string()]);
        assert_eq!(record.conflicts, vec!["other-mod".to_string()]);
        let readme = fs::read_to_string(custom_dir.join("README.md")).unwrap();
        assert!(readme.contains("## 功能要点"));
        assert!(readme.contains("- 要点 A"));
        assert!(readme.contains("## 详细介绍"));
        assert!(readme.contains("详细介绍正文"));
        // evejsVersion 不像版本号 → 不写 compatibility
        let manifest = fs::read_to_string(custom_dir.join(scan::MANIFEST_NAME)).unwrap();
        assert!(!manifest.contains("compatibility"));
    }

    /// 界面默认是「立即启用 + 立即签名」两个勾都打上（DEFAULT_BUILD_OPTIONS），
    /// 所以这个组合必须单独钉住：先签名后改名的顺序不能反过来把启用弄丢。
    #[test]
    fn create_mod_enabled_and_signed_together() {
        let root = temp_dir("create-enabled-signed");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        // 先在「作者身份」建好身份（等价界面里已经建过身份的用户）
        let state = crate::author::get_state(&runtime);
        assert_eq!(state["ok"], json!(true));

        let mut both = draft("on-and-signed", "又启用又签名");
        both["enabled"] = json!(true);
        both["sign"] = json!(true);
        let result = create_mod(&repo, &both, "0.12.8", &runtime);
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["signed"], json!(true), "{result}");
        assert!(result["reason"].is_null(), "{result}");

        let dir = repo.join("mods").join("on-and-signed");
        assert!(dir.join(scan::LOADER_ENABLED).is_file());
        assert!(!dir.join(scan::LOADER_DISABLED).exists());

        // 签名块要覆盖「已经改名后的清单」，扫描器必须认它是有效的
        let record = scan::read_mod_dir("on-and-signed", &dir);
        assert!(record.valid, "{}", record.error);
        assert!(record.enabled);
        assert_eq!(
            record.signature_state, "valid",
            "{}",
            record.signature_error
        );
    }

    #[test]
    fn update_mod_meta_rewrites_fields_readme_and_resigns() {
        let root = temp_dir("update-meta");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        // 身份先备好：编辑信息复用「手动签名」那条路径，没有身份必须整份回滚
        let state = crate::author::get_state(&runtime);
        assert_eq!(state["ok"], json!(true), "{state}");

        let created = create_mod(&repo, &draft("edit-me", "改之前"), "0.12.8", &runtime);
        assert_eq!(created["ok"], json!(true), "{created}");
        let dir = repo.join("mods").join("edit-me");
        // 先用真身份签一次，模拟「已经签过名的模组」
        let signed = super::super::plan::sign_mod_folder(&repo, "edit-me", &runtime);
        assert_eq!(signed["ok"], json!(true), "{signed}");

        let patched = update_mod_meta(
            &repo,
            &runtime,
            "edit-me",
            &json!({
                "displayName": "改之后",
                "description": "新简介",
                "category": "经济",
                "tags": ["a", 1, "b"],
                "conflicts": ["other-mod"],
                "requiresRestart": false,
                "readme": "正文段落",
                "highlights": ["要点一", "要点二"],
            }),
        );
        assert_eq!(patched["ok"], json!(true), "{patched}");
        assert_eq!(patched["readmeUpdated"], json!(true));

        let record = scan::read_mod_dir("edit-me", &dir);
        assert!(
            record.valid,
            "编辑后的清单必须仍能通过校验：{}",
            record.error
        );
        assert_eq!(record.display_name, "改之后");
        assert_eq!(record.description, "新简介");
        assert_eq!(record.category, "经济");
        // 数组里的非字符串项被丢掉（与脚手架读 draft 的口径一致）
        assert_eq!(record.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(record.conflicts, vec!["other-mod".to_string()]);
        assert_eq!(record.restart, "none");
        // 身份字段一个都不能被碰
        assert_eq!(record.id, "edit-me");
        assert_eq!(record.version, "1.2.3");
        // 内容改了就必须重签，否则扫描器会判成「签名对不上」
        assert_eq!(
            record.signature_state, "valid",
            "{}",
            record.signature_error
        );

        let readme = fs::read_to_string(dir.join("README.md")).unwrap();
        assert!(readme.contains("# 改之后"), "{readme}");
        assert!(readme.contains("新简介"));
        assert!(readme.contains("- 要点一"));
        assert!(readme.contains("## 详细介绍"));
        assert!(readme.contains("正文段落"));
    }

    #[test]
    fn update_mod_meta_rejects_bad_patch_without_touching_files() {
        let root = temp_dir("update-meta-bad");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let created = create_mod(&repo, &draft("keep-me", "保持原样"), "0.12.8", &runtime);
        assert_eq!(created["ok"], json!(true), "{created}");
        let dir = repo.join("mods").join("keep-me");
        let manifest_path = dir.join(scan::MANIFEST_NAME);
        let before = fs::read_to_string(&manifest_path).unwrap();

        for bad in [json!({ "displayName": "   " }), json!(null), json!({})] {
            let reply = update_mod_meta(&repo, &runtime, "keep-me", &bad);
            assert_eq!(reply["ok"], json!(false), "{reply}");
            assert_eq!(
                fs::read_to_string(&manifest_path).unwrap(),
                before,
                "被拒绝的补丁不能改动清单"
            );
        }

        // 目录名非法 / 不存在的模组：明确报错而不是 panic
        let bad_folder =
            update_mod_meta(&repo, &runtime, "../escape", &json!({ "description": "x" }));
        assert_eq!(bad_folder["ok"], json!(false), "{bad_folder}");
        let missing = update_mod_meta(
            &repo,
            &runtime,
            "no-such-mod",
            &json!({ "description": "x" }),
        );
        assert_eq!(missing["ok"], json!(false), "{missing}");
    }

    #[test]
    fn update_mod_meta_refuses_another_authors_mod() {
        let root = temp_dir("update-meta-foreign");
        let runtime = runtime_at(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let state = crate::author::get_state(&runtime);
        assert_eq!(state["ok"], json!(true), "{state}");

        let created = create_mod(
            &repo,
            &draft("someone-else", "别人的模组"),
            "0.12.8",
            &runtime,
        );
        assert_eq!(created["ok"], json!(true), "{created}");
        let dir = repo.join("mods").join("someone-else");
        let manifest_path = dir.join(scan::MANIFEST_NAME);
        // 把署名改成别人的 id：编辑必须被拒（sign_mod_folder 的归属保护），且文件原样
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["author"] = json!({ "id": "au-someoneelse", "name": "别人", "keyId": "deadbeef" });
        let spoofed = serde_json::to_string_pretty(&manifest).unwrap() + "\n";
        fs::write(&manifest_path, &spoofed).unwrap();

        let reply = update_mod_meta(
            &repo,
            &runtime,
            "someone-else",
            &json!({ "description": "偷改" }),
        );
        assert_eq!(reply["ok"], json!(false), "{reply}");
        assert!(
            reply["reason"].as_str().unwrap().contains("不是本机作者"),
            "{reply}"
        );
        assert_eq!(
            fs::read_to_string(&manifest_path).unwrap(),
            spoofed,
            "拒绝后清单必须原样保留"
        );
    }

    #[test]
    fn templates_json_matches_contract_shape() {
        let value = templates_json();
        assert_eq!(value["ok"], json!(true));
        let list = value["templates"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], json!("broadcast"));
        assert_eq!(list[1]["id"], json!("blank"));
        assert_eq!(list[0]["requiresRestart"], json!(true));
        assert_eq!(list[0]["files"].as_array().unwrap().len(), 4);
        assert_eq!(list[0]["fileCount"], json!(4));
        // 体积是真算出来的：四个文件的骨架落在 1KB~64KB 这个量级里
        for item in list {
            let bytes = item["sizeBytes"].as_u64().unwrap();
            assert!((1024..65536).contains(&bytes), "模板体积不合理：{bytes}");
        }
        assert_eq!(find_template("nope").id, "broadcast");
    }

    #[test]
    fn authoring_docs_release_both_languages_idempotently() {
        let root = temp_dir("docs");
        let runtime = runtime_at(&root);

        ensure_all_mod_authoring_docs(&runtime);
        let zh_path = runtime.root.join("mods").join("MOD_AUTHORING.md");
        let en_path = runtime.root.join("mods").join("MOD_AUTHORING.en.md");
        assert!(zh_path.is_file());
        assert!(en_path.is_file());

        // 内容一致 → 不重复写盘
        let again = ensure_mod_authoring_doc(&runtime, Some("zh"));
        assert_eq!(again["written"], json!(false));
        assert_eq!(again["ok"], json!(true));

        // 文件被改坏 → 重新写回
        fs::write(&zh_path, "坏了").unwrap();
        let rewritten = ensure_mod_authoring_doc(&runtime, Some("zh"));
        assert_eq!(rewritten["written"], json!(true));

        let text = read_mod_authoring_doc_text(&runtime, Some("zh"));
        assert_eq!(text["ok"], json!(true));
        assert!(text["text"].as_str().unwrap().starts_with("# "));
        assert!(text["text"].as_str().unwrap().contains("EveJS"));

        // 缺省语言是英文（对齐现役版 normalizeDocLang：只有 "zh" 算中文）
        let default_doc = ensure_mod_authoring_doc(&runtime, None);
        assert!(default_doc["path"]
            .as_str()
            .unwrap()
            .ends_with("MOD_AUTHORING.en.md"));
        assert_eq!(
            mod_authoring_doc_path(&runtime, None),
            mod_authoring_doc_path(&runtime, Some("en"))
        );
        assert_eq!(
            mod_authoring_doc_path(&runtime, Some("ZH")),
            mod_authoring_doc_path(&runtime, Some("zh"))
        );
    }
}
