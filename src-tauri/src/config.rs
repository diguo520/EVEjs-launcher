//! 配置读写：对齐现役版 src/main/configStore.ts 的语义（EvEJSConfig.bat / config/server.json / 设置文件）。
use serde::{Deserialize, Serialize};

/// 事件与探活的端口默认值（**单一来源**）。
///
/// 现役版把 26000/26001/26002/40110 散落在 configStore / healthChecker / metrics / ipc 四处；
/// 新工程集中在这里定义，其它模块一律引用常量（`scripts/audit-dedup.mjs` 会把再次出现的字面量判为重复）。
pub const DEFAULT_GAME_PORT: u16 = 26000;
pub const DEFAULT_IMAGES_PORT: u16 = 26001;
pub const DEFAULT_GATEWAY_PORT: u16 = 26002;
/// 客户端（游戏 exe）直连端口：现役版 healthChecker.ts 的第四个探活目标。
pub const DEFAULT_MARKET_PORT: u16 = 40110;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub client_path: String,
    pub client_exe: String,
    pub ca_pem: String,
    pub proxy_url: String,
    pub safe_graphics: String,
    pub safe_windowed: String,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigPorts {
    pub game: u16,
    pub images: u16,
    pub gateway: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub ports: ServerConfigPorts,
    pub source_file: String,
}

/// 候选配置文件：与现役版 findClientConfigFile 一致
pub fn find_client_config_file(repo_root: &Path) -> Option<PathBuf> {
    let candidates = [
        repo_root
            .join("tools")
            .join("ClientSETUP")
            .join("scripts")
            .join("EvEJSConfig.bat"),
        repo_root.join("EvEJSConfig.bat"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    let without_leading = trimmed.strip_prefix('"').unwrap_or(trimmed);
    without_leading
        .strip_suffix('"')
        .unwrap_or(without_leading)
        .to_string()
}

/// 解析 `set "KEY=VALUE"` 行；expand_root 用于替换 %EVEJS_REPO_ROOT%
pub fn parse_bat_vars(file: &Path, expand_root: Option<&str>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let raw = match fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(_) => return out,
    };
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r').trim_start();
        if line.len() < 4 {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("set ") {
            continue;
        }
        let rest = line[4..].trim();
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        let (key, value) = match rest.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        let key = key.trim().trim_end_matches('"').trim().to_string();
        if key.is_empty()
            || !key
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
        {
            continue;
        }
        let mut value = strip_quotes(value);
        if let Some(expand) = expand_root {
            value = value.replace("%EVEJS_REPO_ROOT%", expand);
        }
        out.insert(key, value);
    }
    out
}

/// 网关代理默认地址：端口与 [`DEFAULT_GATEWAY_PORT`] 同源，避免再抄一份字面量。
fn gateway_proxy_url() -> String {
    format!("http://127.0.0.1:{DEFAULT_GATEWAY_PORT}/")
}

pub fn read_client_config(repo_root: &Path) -> ClientConfig {
    let source_file = find_client_config_file(repo_root);
    let mut config = ClientConfig {
        client_path: String::new(),
        client_exe: String::new(),
        ca_pem: String::new(),
        proxy_url: gateway_proxy_url(),
        safe_graphics: "off".to_string(),
        safe_windowed: "off".to_string(),
        source_file: source_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    };
    let Some(file) = source_file else {
        return config;
    };
    let root_text = repo_root.to_string_lossy().to_string();
    let vars = parse_bat_vars(&file, Some(&root_text));
    let get = |key: &str, default: &str| {
        vars.get(key)
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    config.client_path = get("EVEJS_CLIENT_PATH", "");
    config.client_exe = get("EVEJS_CLIENT_EXE", "");
    config.ca_pem = get("EVEJS_CA_PEM", "");
    config.proxy_url = get("EVEJS_PROXY_URL", &gateway_proxy_url());
    config.safe_graphics = get("EVEJS_CLIENT_SAFE_GRAPHICS", "off");
    config.safe_windowed = get("EVEJS_CLIENT_SAFE_WINDOWED", "off");
    config
}

/// 只更新/新增指定键，保留其余行与注释；统一 CRLF 写出（对齐现役版 writeClientConfig）
pub fn write_client_config(
    repo_root: &Path,
    patch: &Map<String, Value>,
) -> Result<ClientConfig, String> {
    let file = find_client_config_file(repo_root)
        .ok_or_else(|| "未找到 EvEJSConfig.bat，无法回写配置".to_string())?;
    let raw = fs::read_to_string(&file).map_err(|err| err.to_string())?;
    let mut lines: Vec<String> = raw
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();

    let mapping = [
        ("clientPath", "EVEJS_CLIENT_PATH"),
        ("clientExe", "EVEJS_CLIENT_EXE"),
        ("caPem", "EVEJS_CA_PEM"),
        ("proxyUrl", "EVEJS_PROXY_URL"),
        ("safeWindowed", "EVEJS_CLIENT_SAFE_WINDOWED"),
        ("safeGraphics", "EVEJS_CLIENT_SAFE_GRAPHICS"),
    ];
    for (field, key) in mapping {
        let Some(value) = patch.get(field).and_then(|value| value.as_str()) else {
            continue;
        };
        let needle = format!("set \"{}\"=", key).to_ascii_lowercase();
        let needle_plain = format!("set {}=\"", key).to_ascii_lowercase();
        let replacement = format!("set \"{}={}\"", key, value);
        let mut replaced = false;
        for line in lines.iter_mut() {
            let lower = line.trim_start().to_ascii_lowercase();
            if lower.starts_with(&needle) || lower.starts_with(&needle_plain) {
                *line = replacement.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            lines.push(replacement);
        }
    }
    while lines
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        lines.pop();
    }
    let text = lines.join("\r\n") + "\r\n";
    fs::write(&file, text).map_err(|err| err.to_string())?;
    Ok(read_client_config(repo_root))
}

/// config/server.json：仅读端口（与现役版一致，不做回写）
pub fn read_server_config(repo_root: &Path) -> ServerConfig {
    let file = repo_root.join("config").join("server.json");
    let fallback = ServerConfig {
        ports: ServerConfigPorts {
            game: DEFAULT_GAME_PORT,
            images: DEFAULT_IMAGES_PORT,
            gateway: DEFAULT_GATEWAY_PORT,
        },
        source_file: file.to_string_lossy().to_string(),
    };
    let Ok(raw) = fs::read_to_string(&file) else {
        return fallback;
    };
    let cleaned = raw.trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<Value>(cleaned) else {
        return fallback;
    };

    let game = value
        .get("network")
        .and_then(|node| node.get("serverPort"))
        .and_then(|node| node.as_u64())
        .map(|port| port as u16)
        .unwrap_or(DEFAULT_GAME_PORT);
    let gateway = value
        .get("gateway")
        .and_then(|node| node.get("microservicesPort"))
        .and_then(|node| node.as_u64())
        .map(|port| port as u16)
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let images = value
        .get("images")
        .and_then(|node| node.get("imageServerUrl"))
        .and_then(|node| node.as_str())
        .and_then(|url| url.rsplit(':').next())
        .and_then(|port| {
            port.trim_matches(|c: char| !c.is_ascii_digit())
                .parse::<u16>()
                .ok()
        })
        .unwrap_or(DEFAULT_IMAGES_PORT);

    ServerConfig {
        ports: ServerConfigPorts {
            game,
            images,
            gateway,
        },
        source_file: file.to_string_lossy().to_string(),
    }
}

pub fn read_settings(settings_file: &Path) -> Map<String, Value> {
    let Ok(raw) = fs::read_to_string(settings_file) else {
        return Map::new();
    };
    let cleaned = raw.trim_start_matches('\u{feff}');
    match serde_json::from_str::<Value>(cleaned) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub fn write_settings(settings_file: &Path, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut next = read_settings(settings_file);
    for (key, value) in patch {
        next.insert(key.clone(), value.clone());
    }
    if let Some(parent) = settings_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&Value::Object(next.clone())) {
        let _ = fs::write(settings_file, text);
    }
    next
}

pub fn config_bundle(repo_root: &Path) -> Value {
    json!({
        "server": read_server_config(repo_root),
        "client": read_client_config(repo_root)
    })
}
