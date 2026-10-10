//! 便携单文件版：把随包的侧车文件在启动时释放到 `<exe 同级>/_launcher/`。
//!
//! 为什么需要这一层：Node CLI（账号 / 数据库）与自更新器都是**必须落盘才能执行**的东西
//! （CLI 走 `node <脚本>` 子进程，自更新器直接 CreateProcess 那个 .exe）。
//! 便携 zip 里它们本来就是明文文件；单文件 exe 只能把它们嵌进二进制，运行时释放出来。
//!
//! 落点与查找顺序对齐 `sidecar::script_candidates` / `updater::updater_helper_path`：
//!   `<exe 同级>/_launcher/cli/<name>`、`<exe 同级>/_launcher/updater/evejs-updater.exe`
//! 注意**不能**写进 `runtime.root`：`EVEJS_USER_DATA_DIR` 会把 runtime.root 指到别处，
//! 而那两个查找函数认的是 exe 同级目录。
//!
//! 只在内容不一致时写：先比长度再比字节，每次启动的代价是毫秒级读盘，
//! 也不会反复刷新文件时间戳；便携包里的文件被手工改坏时还能自动纠正回来。
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 随包 Node CLI 脚本：仓库里就有，直接嵌
const CLI_SCRIPTS: &[(&str, &[u8])] = &[
    (
        "account-cli.js",
        include_bytes!("../../vendor/cli/account-cli.js"),
    ),
    (
        "database-cli.js",
        include_bytes!("../../vendor/cli/database-cli.js"),
    ),
    (
        "game-config-cli.js",
        include_bytes!("../../vendor/cli/game-config-cli.js"),
    ),
    (
        "market-cli.js",
        include_bytes!("../../vendor/cli/market-cli.js"),
    ),
    (
        "store-cli.js",
        include_bytes!("../../vendor/cli/store-cli.js"),
    ),
];

/// 自更新器：由 `build.rs` 拷进 OUT_DIR（vendor/updater/bin 被 .gitignore 排除，
/// 干净 clone 与 CI runner 上没有这个文件，那种情况下 OUT_DIR 里放的是**空占位**，
/// 构建照常通过、只是不嵌）。发布产物由 `scripts/build.ps1` 保证先 go build 再 cargo build。
const UPDATER_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/evejs-updater.exe"));

/// 当前 exe 所在目录（找不到就返回 None，调用方跳过释放，不阻断启动）
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 释放全部随包侧车；返回**这次真正写入**的路径（已存在且内容一致的不算）。
pub fn ensure_bundled_sidecars(exe_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for (name, bytes) in CLI_SCRIPTS {
        let path = exe_dir.join("_launcher").join("cli").join(name);
        if write_if_different(&path, bytes)? {
            written.push(path);
        }
    }
    if !UPDATER_BYTES.is_empty() {
        let path = exe_dir
            .join("_launcher")
            .join("updater")
            .join(crate::updater::UPDATER_NAME);
        if write_if_different(&path, UPDATER_BYTES)? {
            written.push(path);
        }
    }
    Ok(written)
}

/// 内容一致就什么都不做；内容不同（或被改坏）就整份覆盖
fn write_if_different(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    if let Ok(existing) = fs::read(path) {
        if existing.len() == bytes.len() && existing == bytes {
            return Ok(false);
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, bytes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("evejs-seed-{tag}-{}", crate::mods::pkg::epoch_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn releases_sidecars_next_to_the_exe_and_is_idempotent() {
        let dir = temp_dir("release");
        let written = ensure_bundled_sidecars(&dir).unwrap();
        // 至少两个 CLI 一定嵌在里面（自更新器在某些构建里可以是空占位）
        assert!(written.len() >= CLI_SCRIPTS.len(), "{written:?}");

        let account = dir.join("_launcher").join("cli").join("account-cli.js");
        let database = dir.join("_launcher").join("cli").join("database-cli.js");
        assert!(account.is_file());
        assert!(database.is_file());
        assert_eq!(fs::read(&account).unwrap(), CLI_SCRIPTS[0].1);

        // 第二次调用：内容一致 → 一个都不写
        let again = ensure_bundled_sidecars(&dir).unwrap();
        assert!(again.is_empty(), "重复启动不应重写：{again:?}");
    }

    #[test]
    fn repairs_a_corrupted_sidecar() {
        let dir = temp_dir("repair");
        ensure_bundled_sidecars(&dir).unwrap();
        let account = dir.join("_launcher").join("cli").join("account-cli.js");
        fs::write(&account, "// 被改坏了").unwrap();
        let written = ensure_bundled_sidecars(&dir).unwrap();
        assert_eq!(written, vec![account.clone()]);
        assert_eq!(fs::read(&account).unwrap(), CLI_SCRIPTS[0].1);
    }
}
