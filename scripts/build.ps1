<#
一键构建（对应 docs/Tauri2迁移执行计划.md 的 G1 → G4 门禁）。

步骤：
  1) 契约生成（extract → gen）
  2) 静态契约校验 + 版本一致性（verify-contract.mjs / sync-version.mjs --check）
  3) 静态安全审计 + 查重门禁 + parity 固定向量（audit-security.mjs / audit-dedup.mjs / tests/parity/run.mjs）
  4) 渲染层语法预检（check-renderer.mjs，防「点按钮没反应」）
  5) 同步 ui/dist
  6) S6 应用（ui/ 下 Vite+React）：类型检查 + 打包 + 发布到 ui/dist/react
  7) cargo build（默认 release；frontendDist 在编译期嵌入，所以必须排在 6 之后）
  8) 拷贝 Node 侧车脚本（account-cli.js / database-cli.js → _launcher/cli/）
  9) 拷贝自更新器（evejs-updater.exe → _launcher/updater/，缺则用 go 现场编译）
  10) 体积门禁（size-gate.mjs）
  11) parity 通道 golden（driver-tauri + diff.mjs，S5 / L2）
  12) parity 跨实现（driver-electron + diff-cross.mjs；没装现役 Electron 时打印跳过）
  13) L3 端到端沙箱（tests/e2e/run.mjs：快照 → 跑写通道场景 → 还原 → 复跑比对；-SkipE2E 可关）
  14) L4 终端压测（真 ConPTY 喷 10 万行，断言不丢行；-SkipHeavy 可关）
  15) L5 编码验收（代码页 936 中文 + ANSI；-SkipHeavy 可关）
  16) L6 进程树残留（真起两级进程 → taskkill /T /F → 0 残留 + 四级端口空闲；-SkipHeavy 可关）
  17) L8 升级/回滚演练（真跑 vendor/updater 替换 exe，3 轮 × 2 方向；-SkipHeavy 可关）

⚠️ 14–17 有真实副作用（起 ConPTY 子进程、弹启动器窗口、临时改版本号并重建、替换演练目录里的 exe），
   耗时与噪声都比前面几步大，所以给了 -SkipHeavy。**发布前必须全跑**（发布检查单见
   docs/S7-发布与回滚-实施记录.md §5.2）。
⚠️ 6 必须早于 7：`generate_context!` 在**编译期**读 tauri.conf.json 的 frontendDist 并嵌入资产，
   所以 React 产物没先落地到 ui/dist/react 的话，打出来的 exe 里根本没有新渲染层。

用法：
  pwsh -File scripts/build.ps1
  pwsh -File scripts/build.ps1 -DebugBuild -SkipSize
  pwsh -File scripts/build.ps1 -SkipParity
  pwsh -File scripts/build.ps1 -SkipHeavy      # 迭代用：跳过 L4/L5/L6/L8
#>
param(
    [switch]$SkipContract,
    [switch]$SkipSize,
    [switch]$SkipParity,
    [switch]$SkipE2E,
    [switch]$SkipApp,
    [switch]$SkipHeavy,
    [switch]$DebugBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 绕过 rustup 垫片：rust-toolchain.toml 的联网解析在本机能挂死（见执行计划「已知问题」）。
    # 直接用已安装的工具链目录，避免每次构建都去 static.rust-lang.org 解析 channel。
    $toolchainBin = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
    if (Test-Path $toolchainBin) {
        $env:PATH = "$toolchainBin;$env:PATH"
        $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
    }

    function Invoke-Step {
        param([string]$Index, [string]$Title, [scriptblock]$Body)
        Write-Host ""
        Write-Host "=== [$Index] $Title" -ForegroundColor Cyan
        & $Body
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
            throw "步骤 $Index 失败（退出码 $LASTEXITCODE）：$Title"
        }
    }

    if (-not $SkipContract) {
        Invoke-Step 1 "契约生成" { node scripts/extract-contract.mjs; node scripts/gen-contract.mjs }
    }
    Invoke-Step 2 "静态契约校验 + 版本一致性（G1）" { node scripts/verify-contract.mjs; node scripts/sync-version.mjs --check }
    Invoke-Step 3 "静态安全审计 + 查重门禁 + parity 固定向量" { node scripts/audit-security.mjs; node scripts/audit-dedup.mjs; node tests/parity/run.mjs }
    Invoke-Step 4 "渲染层语法预检" { node scripts/check-renderer.mjs }
    Invoke-Step 5 "同步 ui/dist" { node ui/scripts/build-ui.mjs }

    # S6 应用（ui/ 下的 Vite + React）：类型检查 + 生产打包 + 发布到 ui/dist/react。
    # 必须在 cargo build 之前 —— release 的资产是编译期嵌入的（见文件头 ⚠️）。
    # 未安装依赖时仍然是「跳过并提示」而不是硬失败（CI 上由 npm run check:app 单独兜）。
    if (-not $SkipApp) {
        if (Test-Path (Join-Path $root "ui\node_modules")) {
            Invoke-Step 6 "S6 应用（Vite+React）类型检查 + 打包 + 发布到 ui/dist/react" { node scripts/check-app.mjs }
        }
        else {
            Write-Host ""
            Write-Host "=== [6] S6 应用 —— 跳过（未安装 ui/node_modules）" -ForegroundColor Yellow
            Write-Host "  先跑：npm run ui:app:install"
            Write-Host "  ⚠️ 跳过会导致 ui/dist/react 缺失，打出来的 exe 用 --ui=react 会白屏" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host ""
        Write-Host "=== [6] S6 应用 —— 跳过（-SkipApp）" -ForegroundColor Yellow
    }

    Invoke-Step 7 "cargo build" {
        Push-Location src-tauri
        try {
            if ($DebugBuild) { cargo build } else { cargo build --release }
        }
        finally { Pop-Location }
    }

    Invoke-Step 8 "拷贝 Node 侧车脚本" {
        # accounts:* / database:* 继续用仓库自带的 Node CLI（见 docs/S2-后端直译-实施记录.md），
        # 便携版必须把它们放在 exe 同级的 _launcher/cli/ 下（sidecar::script_path 第 3 级查找）
        $profileName = if ($DebugBuild) { "debug" } else { "release" }
        $cliDir = Join-Path $root "src-tauri\target\$profileName\_launcher\cli"
        New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
        foreach ($name in @("account-cli.js", "database-cli.js")) {
            Copy-Item -LiteralPath (Join-Path $root "vendor\cli\$name") -Destination $cliDir -Force
        }
        Write-Host "已拷贝 2 个 CLI 脚本 -> $cliDir"
    }

    Invoke-Step 9 "拷贝自更新器" {
        # 自更新仍用现役版那个 Go 小程序（见 docs/S2-更新器-实施记录.md）：
        # 它与外壳框架无关，0 改动复用；便携版放在 exe 同级的 _launcher/updater/ 下
        # （updater::updater_helper_path 第 3 级查找）
        $profileName = if ($DebugBuild) { "debug" } else { "release" }
        $updaterDir = Join-Path $root "src-tauri\target\$profileName\_launcher\updater"
        New-Item -ItemType Directory -Force -Path $updaterDir | Out-Null
        $updaterExe = Join-Path $root "vendor\updater\bin\evejs-updater.exe"
        if (-not (Test-Path $updaterExe)) {
            $go = Get-Command go -ErrorAction SilentlyContinue
            if (-not $go) { throw "自更新器缺失且找不到 Go 工具链：vendor\updater\bin\evejs-updater.exe" }
            Push-Location (Join-Path $root "vendor\updater")
            try { & $go.Source build -trimpath -ldflags "-s -w" -o bin\evejs-updater.exe . }
            finally { Pop-Location }
        }
        if (-not (Test-Path $updaterExe)) { throw "自更新器编译失败：$updaterExe" }
        Copy-Item -LiteralPath $updaterExe -Destination $updaterDir -Force
        Write-Host "已拷贝自更新器 -> $updaterDir"
    }

    if (-not $SkipSize) {
        Invoke-Step 10 "体积门禁（G4 前置）" { node scripts/size-gate.mjs }
    }

    # parity 通道 golden（S5 / L2）：Tauri 侧自比冻结基线，再和现役 Electron 现役版跨实现对拍。
    # 基线是 release 口径，所以 debug 构建不跑；跨实现那一半需要现役安装目录，缺失时明确打印跳过
    # （CI runner 上没有现役版，见 .github/workflows/ci.yml 的说明）。
    if (-not $SkipParity) {
        if ($DebugBuild) {
            Write-Host ""
            Write-Host "=== [11] parity 通道 golden —— 跳过（debug 产物，基线是 release 口径）" -ForegroundColor Yellow
        }
        else {
            Invoke-Step 11 "parity 通道 golden（Tauri 侧 ↔ 冻结基线）" {
                node tests/parity/driver-tauri.mjs
                node tests/parity/diff.mjs
            }
            $referenceExe = "E:\Games\EveJS-v0.12.8\launcher\launcher\node_modules\electron\dist\electron.exe"
            if (Test-Path -LiteralPath $referenceExe) {
                Invoke-Step 12 "parity 跨实现（Electron 现役版 ↔ Tauri）" {
                    node tests/parity/driver-electron.mjs
                    node tests/parity/diff-cross.mjs
                }
            }
            else {
                Write-Host ""
                Write-Host "=== [12] parity 跨实现 —— 跳过" -ForegroundColor Yellow
                Write-Host "  未找到现役 Electron：$referenceExe"
                Write-Host "  需要在本机跑跨实现比对时：npm run parity:cross（或用 driver-electron.mjs --src 指定安装目录）"
            }
        }
    }

    # L3 端到端（S5）：真调写通道（建模组 / 启停 / 排序 / 卸载），全程落在可回滚沙箱里。
    # 与 parity 不同，这一步会短暂弹出启动器窗口，并且每次会把 fixture 模组丢进系统回收站
    # （见 tests/e2e/README.md §5），所以给了 -SkipE2E。
    if (-not $SkipE2E) {
        Invoke-Step 13 "L3 端到端沙箱（快照 → 跑 → 还原 → 复跑）" {
            # 两个场景都要跑：repo-mods（mods:* 全链）+ author-token（作者身份 + GitHub 令牌 DPAPI 落盘）。
            # 每轮自己快照/还原，所以顺序跑互不影响。
            $e2eScenarios = @("repo-mods", "author-token")
            foreach ($e2eScenario in $e2eScenarios) {
                $e2eArgs = @("tests/e2e/run.mjs", "--scenario", $e2eScenario)
                if ($DebugBuild) { $e2eArgs += "--debug" }
                node @e2eArgs
                if ($LASTEXITCODE -ne 0) { throw "L3 场景 $e2eScenario 失败（退出码 $LASTEXITCODE）" }
            }
        }
    }
    else {
        Write-Host ""
        Write-Host "=== [13] L3 端到端 —— 跳过（-SkipE2E）" -ForegroundColor Yellow
    }

    # L4/L5/L6/L8 重档门禁（S5 收口）。这三类压测的断言本体都在 Rust 侧（pty.rs / process.rs 的 #[ignore] 测试）
    # 或 Go 更新器里，脚本只负责「挑解释器 → 跑 → 落机器可读产物」，所以必须真跑，不能用单测替代：
    #   L4 验的是 PTY 输出泵（reader 线程 → 事件 → 渲染层）这条路径，纯单测测不到 ConPTY 的行为；
    #   L5 验的是 ConPTY 内部的代码页转换（Command::output() 直连管道测不到）；
    #   L6 验的是 taskkill /T 的 PID 归属语义，必须真有两级父子进程；
    #   L8 验的是「验签 → 下载 → 替换 → 重启」整链，只能真跑更新器。
    # 用当前宿主自己的可执行文件重新起 pwsh，避免 PATH 上没有 pwsh 时（Windows PowerShell 5.1 直跑）静默失败。
    if (-not $SkipHeavy) {
        $psExe = (Get-Process -Id $PID).Path
        Invoke-Step 14 "L4 终端压测（真 ConPTY 10 万行）" { & $psExe -NoProfile -File scripts/stress-terminal.ps1 }
        Invoke-Step 15 "L5 编码验收（代码页 936）" { & $psExe -NoProfile -File scripts/check-encoding.ps1 }
        Invoke-Step 16 "L6 进程树残留 + 四级端口" { & $psExe -NoProfile -File scripts/check-process-residue.ps1 }
        Invoke-Step 17 "L8 升级/回滚演练（3 轮 × 2 方向）" { & $psExe -NoProfile -File scripts/release-drill.ps1 }
    }
    else {
        Write-Host ""
        Write-Host "=== [14-17] L4/L5/L6/L8 重档门禁 —— 跳过（-SkipHeavy）" -ForegroundColor Yellow
        Write-Host "  发布前必须跑：scripts/stress-terminal.ps1 · check-encoding.ps1 · check-process-residue.ps1 · release-drill.ps1"
    }

    Write-Host ""
    Write-Host "构建完成。产物：src-tauri\target\release\EvEJSLauncher.exe" -ForegroundColor Green
}
finally {
    Pop-Location
}