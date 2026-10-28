//! 测试用的临时目录（B1，2026-10-29）。
//!
//! `updater` / `mods::pkg` / `seed` / `mods::scaffold` / `sidecar` 各定义了一份 `fn temp_dir`，
//! 五份写法几乎一样、又各带一点差异：有的先清目录、有的不清；`sidecar` 那份**只按 label 命名、
//! 没有唯一后缀**，并行测试会撞名（撞了就是另一条测试的目录被清掉）。
//!
//! 收成一份：**命名空间 + tag + 进程内唯一后缀**。各测试文件保留同名局部函数做转发，
//! 所以那 ~30 处调用点一行都不用动。

use std::path::PathBuf;

/// 建一个本次运行内唯一的测试目录：`<temp>/evejs-<scope>-<tag>-<唯一后缀>`。
/// 目录已存在会先清空（调用方默认它是干净的）。
pub(crate) fn temp_dir(scope: &str, tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "evejs-{scope}-{tag}-{}",
        crate::mods::pkg::temp_suffix()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("应能建测试临时目录");
    dir
}
