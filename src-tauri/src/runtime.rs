//! 运行时路径：对齐现役 Electron 版 src/main/runtimePaths.ts 的语义。
//!
//! 便携版设计：所有启动器自有可变数据都放在 exe 同级的 _launcher/ 下，
//! 因此「把 exe 丢进服务端根目录双击」即可运行，不写 AppData。
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub root: PathBuf,
    pub user_data: PathBuf,
    pub session_data: PathBuf,
    pub cache: PathBuf,
    pub temp: PathBuf,
    pub logs: PathBuf,
    pub crash_dumps: PathBuf,
}

fn env_path(key: &str) -> Option<PathBuf> {
    match std::env::var_os(key) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// 启动器所在目录：便携版用 PORTABLE_EXECUTABLE_DIR，打包版用 exe 所在目录，开发态用当前目录。
pub fn launcher_directory() -> PathBuf {
    if let Some(dir) = env_path("PORTABLE_EXECUTABLE_DIR") {
        return dir;
    }
    if cfg!(debug_assertions) {
        return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// EVEJS_USER_DATA_DIR 保留用于测试，会整体覆盖运行时根目录。
pub fn runtime_root() -> PathBuf {
    if let Some(dir) = env_path("EVEJS_USER_DATA_DIR") {
        return dir;
    }
    launcher_directory().join("_launcher")
}

impl RuntimePaths {
    /// 纯构造（不碰磁盘）：供兜底与测试注入使用
    pub fn from_root(root: PathBuf, legacy_override: bool) -> Self {
        Self {
            user_data: if legacy_override {
                root.clone()
            } else {
                root.join("data")
            },
            session_data: root.join("cache"),
            cache: root.join("cache"),
            temp: root.join("temp"),
            logs: root.join("logs"),
            crash_dumps: root.join("crash"),
            root,
        }
    }

    pub fn ensure() -> std::io::Result<Self> {
        let root = runtime_root();
        let legacy_override = std::env::var_os("EVEJS_USER_DATA_DIR").is_some();
        let paths = Self::from_root(root, legacy_override);
        for dir in [
            &paths.root,
            &paths.user_data,
            &paths.cache,
            &paths.temp,
            &paths.logs,
            &paths.crash_dumps,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(paths)
    }

    pub fn settings_file(&self) -> PathBuf {
        self.user_data.join("launcher-settings.json")
    }

    pub fn window_state_file(&self) -> PathBuf {
        self.user_data.join("launcher-window.json")
    }
}

/// 进程级活跃运行时路径：`lib.rs::run()` 启动时装入。
///
/// 为谁准备：模组签名 / 作者身份这类「拿不到 `AppState`」的纯函数（对齐现役版全局
/// `launcherRuntimePaths()` 的语义）。带参数的版本仍然存在，单测用它们做注入。
static ACTIVE: OnceLock<RuntimePaths> = OnceLock::new();

pub fn install_active(paths: RuntimePaths) {
    let _ = ACTIVE.set(paths);
}

pub fn active() -> &'static RuntimePaths {
    ACTIVE.get_or_init(|| {
        // 兜底：正常启动一定会先 install_active，这里只为单测/工具场景不至于 panic
        RuntimePaths::ensure().unwrap_or_else(|_| RuntimePaths::from_root(runtime_root(), false))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_root_honours_override() {
        let dir = std::env::temp_dir().join("evejs-runtime-test");
        std::env::set_var("EVEJS_USER_DATA_DIR", &dir);
        assert_eq!(runtime_root(), dir);
        let paths = RuntimePaths::ensure().expect("应能创建运行时目录");
        assert!(paths.root.exists());
        assert!(paths.logs.ends_with("logs"));
        std::env::remove_var("EVEJS_USER_DATA_DIR");
    }

    #[test]
    fn from_root_shapes_paths_without_touching_disk() {
        let paths = RuntimePaths::from_root(PathBuf::from("E:\\x\\_launcher"), false);
        assert!(paths.user_data.ends_with("data"));
        assert!(paths.settings_file().ends_with("launcher-settings.json"));
        // EVEJS_USER_DATA_DIR 覆盖时（现役版兼容模式）user_data 直接就是根目录
        let legacy = RuntimePaths::from_root(PathBuf::from("E:\\x\\_launcher"), true);
        assert_eq!(legacy.user_data, legacy.root);
    }
}
