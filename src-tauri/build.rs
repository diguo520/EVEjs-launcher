use std::path::PathBuf;

fn main() {
    // 自更新器：vendor/updater/bin/*.exe 被 .gitignore 排除，干净 clone / CI runner 上不存在。
    // 为了让单文件 exe 能把它嵌进去，这里把它拷到 OUT_DIR 再 include_bytes!；
    // 文件不在时写一个空占位，保证 include_bytes! 永远能编过（seed.rs 里按空/非空判断）。
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest_dir
        .join("..")
        .join("vendor")
        .join("updater")
        .join("bin")
        .join("evejs-updater.exe");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target = out_dir.join("evejs-updater.exe");
    println!("cargo:rerun-if-changed=../vendor/updater/bin/evejs-updater.exe");
    if source.is_file() {
        if std::fs::copy(&source, &target).is_err() {
            let _ = std::fs::write(&target, []);
        }
    } else {
        let _ = std::fs::write(&target, []);
    }

    tauri_build::build();
}
