//! 窗口几何持久化：对齐现役版 src/main/index.ts 的 saveWindowBounds / scheduleBoundsSave。
//!
//! 存放位置与现役版一致 —— `launcher-settings.json` 的 `windowBounds` 字段
//! （**不是** 独立文件，避免双份真相）；节流 400 ms，关闭时强制落盘。
use crate::config;
use crate::AppState;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

const SAVE_THROTTLE: Duration = Duration::from_millis(400);
/// 恢复时的最小可用尺寸：防止把窗口恢复到屏幕外的坏值（现役版无此校验，属有意的防御性偏差）
const MIN_WIDTH: u32 = 800;
const MIN_HEIGHT: u32 = 600;

/// 最近一次「非最大化」几何；对齐 Electron `getNormalBounds()`
/// （最大化状态下也要记住还原后的尺寸，否则退出会丢掉正常尺寸）
static LAST_NORMAL: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None);
static LAST_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

/// 现役版把 windowBounds 写在设置文件里，同路径同结构，便于新旧版互读
const BOUNDS_KEY: &str = "windowBounds";

fn settings_file<R: Runtime>(window: &WebviewWindow<R>) -> Option<PathBuf> {
    window
        .try_state::<AppState>()
        .map(|state| state.runtime.settings_file())
}

fn read_bounds(file: &Path) -> Option<Value> {
    config::read_settings(file).get(BOUNDS_KEY).cloned()
}

/// 记录「非最大化」几何（最大化时不覆盖）
pub fn track<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let mut guard = match LAST_NORMAL.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    *guard = Some((position.x, position.y, size.width, size.height));
}

pub fn save_bounds<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(file) = settings_file(window) else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);

    let tracked = LAST_NORMAL.lock().ok().and_then(|guard| *guard);
    let (x, y, width, height) = match tracked {
        Some(bounds) => bounds,
        None => {
            let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
                return;
            };
            (position.x, position.y, size.width, size.height)
        }
    };

    let mut patch = Map::new();
    patch.insert(
        BOUNDS_KEY.to_string(),
        json!({ "x": x, "y": y, "width": width, "height": height, "maximized": maximized }),
    );
    config::write_settings(&file, &patch);
}

/// 节流保存：resize/move 事件高频触发，对齐现役版 setTimeout 400 ms 合并
pub fn save_bounds_throttled<R: Runtime>(window: &WebviewWindow<R>) {
    track(window);
    let now = Instant::now();
    let due = match LAST_SAVE.lock() {
        Ok(mut guard) => {
            let due = guard
                .map(|last| now.duration_since(last) >= SAVE_THROTTLE)
                .unwrap_or(true);
            if due {
                *guard = Some(now);
            }
            due
        }
        Err(_) => true,
    };
    if due {
        save_bounds(window);
    }
}

/// 启动时恢复上次几何与最大化状态（对齐现役版 `savedWindow?.maximized` 后再 show）
pub fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(file) = settings_file(window) else {
        return;
    };
    let Some(bounds) = read_bounds(&file) else {
        return;
    };

    let number = |key: &str| bounds.get(key).and_then(|value| value.as_i64());
    let (Some(x), Some(y)) = (number("x"), number("y")) else {
        return;
    };
    let width = number("width").unwrap_or(0).clamp(0, u32::MAX as i64) as u32;
    let height = number("height").unwrap_or(0).clamp(0, u32::MAX as i64) as u32;

    if width >= MIN_WIDTH && height >= MIN_HEIGHT {
        let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    if bounds
        .get("maximized")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bounds_from_settings_shape() {
        let dir = std::env::temp_dir().join("evejs-window-bounds-test");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        let file = dir.join("launcher-settings.json");
        let mut patch = Map::new();
        patch.insert(
            BOUNDS_KEY.to_string(),
            json!({ "x": 10, "y": 20, "width": 1360, "height": 860, "maximized": false }),
        );
        config::write_settings(&file, &patch);

        let bounds = read_bounds(&file).expect("应读到 windowBounds");
        assert_eq!(bounds["x"], json!(10));
        assert_eq!(bounds["width"], json!(1360));
        assert_eq!(bounds["maximized"], json!(false));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn missing_bounds_is_none() {
        let dir = std::env::temp_dir().join("evejs-window-bounds-missing");
        std::fs::create_dir_all(&dir).expect("应能建测试目录");
        assert!(read_bounds(&dir.join("launcher-settings.json")).is_none());
    }
}
