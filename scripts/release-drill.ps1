<#
L8 升级 / 回滚演练（计划 §7）：旧版 → 新版 → 旧版，两个方向都真跑。

为什么是「本机演练」而不是「≥30 台灰度机器池」：现在没有发布通道与用户群，制造 30 台机器
只能得到 30 份同样的本机结果。这个脚本把**可验证的部分**做扎实：
  验签 → 平台资产 → 下载 + SHA256 → 替换目标 exe（真跑 vendor/updater 的 Go 更新器）
  → 拉起新版（`--updated`）→ 回滚到旧版位（把旧版包再推一次）；
「≥30 台次的成功率」与「真实灰度」登记为 S7 的发布前置条件（见 docs/S7-发布与回滚-实施记录.md）。

关键机制（都是实测确认过的）：
  - 清单走 `EVEJS_UPDATE_MANIFEST_URL=file://…` + `EVEJS_UPDATE_ALLOW_LOCAL=1`（A1 只放行 https，
    本地清单需要这个开关）；验签用**演练固定密钥**（scripts/gen-drill-manifest.mjs），内置公钥不动；
  - `EVEJS_UPDATE_TARGET_PATH` 指向演练目录里的副本，绝不碰真实安装；
  - 更新器重启目标时带 `--updated`（vendor/updater/main.go），**不带** `--self-test`，
    所以重启出来的进程不会重跑场景脚本 —— 演练不会自我循环，收尾只需把它终止；
  - `EVEJS_USER_DATA_DIR` / TMP 全部指向演练目录，跑完不污染真实用户数据。

用法：
  pwsh -File scripts/release-drill.ps1                 # 3 轮 × 2 方向
  pwsh -File scripts/release-drill.ps1 -Rounds 1       # 快速自检
  pwsh -File scripts/release-drill.ps1 -Configuration release
#>
param(
    [int]$Rounds = 3,
    [ValidateSet("debug", "release")]
    [string]$Configuration = "debug",
    [string]$OutDir = ".parity-out",
    [switch]$KeepWork
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$originalVersion = $null
$savedEnv = @{}
$envKeys = @(
    "EVEJS_UPDATE_MANIFEST_URL", "EVEJS_UPDATE_ALLOW_LOCAL", "EVEJS_UPDATE_KEY_ID", "EVEJS_UPDATE_PUBKEY",
    "EVEJS_UPDATE_TARGET_PATH", "EVEJS_UPDATER_DIR", "EVEJS_E2E_SCENARIO", "EVEJS_SELF_TEST_OUT",
    "EVEJS_USER_DATA_DIR", "TMP", "TEMP", "TMPDIR"
)
foreach ($key in $envKeys) { $savedEnv[$key] = [System.Environment]::GetEnvironmentVariable($key) }

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    # 目标 exe 可能正被更新器/新进程占用（读共享一般没问题，但 Windows 偶尔拒绝）：
    # 这里返回空串让调用方的 Wait-For 再轮询一次，别让一次瞬时占用把整条演练打断。
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    catch { return "" }
}

function Wait-For([scriptblock]$Probe, [int]$TimeoutSec, [int]$PollMs = 200) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Probe) { return $true }
        Start-Sleep -Milliseconds $PollMs
    }
    return [bool](& $Probe)
}

function Get-LauncherPids {
    @(Get-Process -Name EvEJSLauncher -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Stop-Launcher([int]$ProcessId) {
    try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch { }
}

function Wait-UpdaterIdle {
    # 更新器（Go 助手）是除启动器外唯一会写 install\EvEJSLauncher.exe 的进程；
    # 上一轮结束后它可能还没退干净（它在替换成功后先拉起新版再自己退出）。
    param([int]$TimeoutSec = 20)
    Wait-For { @(Get-Process -Name "evejs-updater" -ErrorAction SilentlyContinue).Count -eq 0 } $TimeoutSec 200 | Out-Null
}

function Stop-StrayLaunchers {
    # 上一轮被杀掉的启动器刚释放镜像文件映射时，Windows 会短暂拒绝覆盖它的 exe（下述重试兜住剩下的情况）。
    foreach ($procId in Get-LauncherPids) { Stop-Launcher $procId }
    Wait-For { (Get-LauncherPids).Count -eq 0 } 10 200 | Out-Null
}

function Set-InstallPayload {
    # 为什么必须重试：这与 Go 更新器里的 renameWithRetry / copyWithRetry 是同一类瞬时共享冲突
    # （旧进程刚释放镜像、或杀软正在扫描新写入的 exe）。2026-09-26 实测：3 轮 × 2 方向里第 3 轮
    # 起点的复位复制偶发拿到「文件正被另一进程使用」，直接把整条构建门禁打红 ——
    # 一次瞬时冲突不等于演练失败，但重试耗尽后必须报出占位嫌疑进程，否则现场没法查。
    param([string]$Source, [string]$Target, [int]$Attempts = 25, [int]$DelayMs = 200)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
            return $true
        }
        catch {
            if ($attempt -eq $Attempts) {
                $holders = @()
                foreach ($name in @("EvEJSLauncher", "evejs-updater")) {
                    $holders += @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { "$name($($_.Id))" })
                }
                $who = if ($holders.Count -gt 0) { $holders -join ", " } else { "无（可能是杀软/索引器在扫描）" }
                Write-Host "  [错误] 复制 $Target 重试 $Attempts 次仍失败：$($_.Exception.Message)" -ForegroundColor Red
                Write-Host "        仍存活的嫌疑进程：$who" -ForegroundColor Red
                return $false
            }
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $false
}

function Write-Json([string]$Path, $Object) {
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    # 用 ConvertTo-Json 而不是 System.Text.Json：这个脚本可能在 Windows PowerShell 5.1 下被调度
    # （登录任务/计划任务里没有 pwsh），.NET Framework 里没有 System.Text.Json。
    $Object | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding utf8
}

function New-ScenarioFile([string]$Path, [string[]]$Channels) {
    $steps = @()
    $index = 0
    foreach ($channel in $Channels) {
        $index += 1
        $steps += [ordered]@{ id = "$channel-$index"; channel = $channel; args = @() }
    }
    $scenario = [ordered]@{ name = "release-drill"; steps = $steps }
    $scenario | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
    return $Path
}

function Set-DrillEnv([hashtable]$Values) {
    foreach ($key in $Values.Keys) {
        [System.Environment]::SetEnvironmentVariable($key, [string]$Values[$key])
    }
}

function Invoke-DrillDirection {
    param(
        [string]$Label,
        [int]$Round,
        [string]$ManifestPath,
        [string]$ExpectedSha,
        [string]$InstallExe,
        [string]$Work,
        [int]$PhaseTimeoutSec = 120
    )
    $result = [ordered]@{
        label                 = $Label
        round                 = $Round
        ok                    = $false
        reason                = ""
        available             = $false
        downloadOk            = $false
        downloadedSha         = ""
        swapped               = $false
        targetShaAfter        = ""
        restartedPid          = 0
        restartAliveAfter3s   = $false
        applyMs               = 0
        updaterLog            = ""
    }

    $manifestUrl = ([System.Uri]::new((Resolve-Path -LiteralPath $ManifestPath).Path)).AbsoluteUri
    Set-DrillEnv @{
        EVEJS_UPDATE_MANIFEST_URL = $manifestUrl
        EVEJS_UPDATE_ALLOW_LOCAL  = "1"
        EVEJS_UPDATE_KEY_ID       = "evejs-parity-fixture"
        EVEJS_UPDATE_PUBKEY       = "fDkGYSbWJoAYFSHj/TRjZm3NXx+7Rr4scyJLPN/5mdc="
        EVEJS_UPDATE_TARGET_PATH  = $InstallExe
        EVEJS_UPDATER_DIR         = (Join-Path $Work "updater")
        EVEJS_USER_DATA_DIR       = (Join-Path $Work "userdata")
        TMP                       = (Join-Path $Work "temp")
        TEMP                      = (Join-Path $Work "temp")
        TMPDIR                    = (Join-Path $Work "temp")
    }

    # ---- 阶段 A：检查 + 下载（应用自己写报告，可自证） ----
    $scenarioA = New-ScenarioFile (Join-Path $Work "scenarios\r$Round-$Label-a.json") @("update:check", "update:download")
    $outA = Join-Path $Work "out\r$Round-$Label-a.json"
    if (Test-Path -LiteralPath $outA) { [System.IO.File]::Delete($outA) }
    [System.Environment]::SetEnvironmentVariable("EVEJS_E2E_SCENARIO", $scenarioA)
    [System.Environment]::SetEnvironmentVariable("EVEJS_SELF_TEST_OUT", $outA)
    $procA = Start-Process -FilePath $InstallExe -ArgumentList "--self-test" -PassThru -WindowStyle Hidden
    Wait-For { Test-Path -LiteralPath $outA } $PhaseTimeoutSec 200 | Out-Null
    $summaryA = $null
    if (Test-Path -LiteralPath $outA) {
        try { $summaryA = Get-Content -LiteralPath $outA -Raw -Encoding utf8 | ConvertFrom-Json } catch { $summaryA = $null }
    }
    if (-not $procA.HasExited) { Stop-Launcher $procA.Id }
    Wait-For { (Get-LauncherPids).Count -eq 0 } 15 200 | Out-Null

    if (-not $summaryA -or $summaryA.results.Count -lt 2) {
        $result.reason = "阶段 A 没拿到两条回包"
        Attach-UpdaterLog $result $Work
        return $result
    }
    $check = $summaryA.results[0].reply
    $download = $summaryA.results[1].reply
    $result.available = [bool]$check.available
    $result.downloadOk = [bool]$download.ok
    if (-not $result.available) {
        $result.reason = "检查更新没报「有更新」：$($check.reason)"
        Attach-UpdaterLog $result $Work
        return $result
    }
    if (-not $result.downloadOk) {
        $result.reason = "下载失败：$($download.reason)"
        Attach-UpdaterLog $result $Work
        return $result
    }
    $result.downloadedSha = Get-Sha256 ([string]$download.path)
    if ($result.downloadedSha -ne $ExpectedSha) {
        $result.reason = "下载产物哈希不符：$($result.downloadedSha) ≠ $ExpectedSha"
        Attach-UpdaterLog $result $Work
        return $result
    }

    # ---- 阶段 B：检查 + 下载 + 应用（替换 exe 后应用会自退，改由外部观测） ----
    $scenarioB = New-ScenarioFile (Join-Path $Work "scenarios\r$Round-$Label-b.json") @("update:check", "update:download", "update:apply")
    $outB = Join-Path $Work "out\r$Round-$Label-b.json"
    if (Test-Path -LiteralPath $outB) { [System.IO.File]::Delete($outB) }
    [System.Environment]::SetEnvironmentVariable("EVEJS_E2E_SCENARIO", $scenarioB)
    [System.Environment]::SetEnvironmentVariable("EVEJS_SELF_TEST_OUT", $outB)
    $before = Get-LauncherPids
    $started = Get-Date
    $procB = Start-Process -FilePath $InstallExe -ArgumentList "--self-test" -PassThru -WindowStyle Hidden
    $result.swapped = Wait-For { (Get-Sha256 $InstallExe) -eq $ExpectedSha } 180 250
    $result.applyMs = [int]((Get-Date) - $started).TotalMilliseconds
    if (-not $result.swapped) {
        $nowSha = Get-Sha256 $InstallExe
        $result.reason = "180 s 内目标 exe 没有换成新版字节（当前 $nowSha）"
        if (-not $procB.HasExited) { Stop-Launcher $procB.Id }
        Start-Sleep -Seconds 2
        Attach-UpdaterLog $result $Work
        return $result
    }
    $result.targetShaAfter = Get-Sha256 $InstallExe
    if (-not $procB.HasExited) { Stop-Launcher $procB.Id }

    # 更新器会带 `--updated` 拉起新版（不带 --self-test，不会重跑场景）。
    # 演练期间会短暂出现一个真实启动器窗口，3 秒后由本脚本关闭。
    Wait-For { @((Get-LauncherPids) | Where-Object { $before -notcontains $_ }).Count -gt 0 } 60 200 | Out-Null
    $newPids = @((Get-LauncherPids) | Where-Object { $before -notcontains $_ })
    if ($newPids.Count -eq 0) {
        $result.reason = "替换成功但 60 s 内没有拉起新版进程"
        return $result
    }
    $result.restartedPid = $newPids[0]
    Start-Sleep -Seconds 3
    $result.restartAliveAfter3s = (Get-LauncherPids) -contains $newPids[0]
    foreach ($procId in $newPids) { Stop-Launcher $procId }
    Wait-For { (Get-LauncherPids).Count -eq 0 } 20 200 | Out-Null
    if ((Get-LauncherPids).Count -gt 0) {
        $result.reason = "收尾失败：仍有启动器进程未退出"
        return $result
    }
    if (-not $result.restartAliveAfter3s) {
        $result.reason = "新版进程起来后 3 秒内就退出了（升级后启动失败）"
        Attach-UpdaterLog $result $Work
        return $result
    }
    $result.ok = $true
    return $result
}

function Attach-UpdaterLog($Result, [string]$Work) {
    # 失败时必须留下证据：Go 更新器把自己每一步写进 TMP/EveJS-Launcher-Updater/updater.log。
    # 没它就只能看到「文件没换」，看不到卡在哪一步（copy / backup rename / replace / restart）。
    $log = Join-Path $Work "temp\EveJS-Launcher-Updater\updater.log"
    if (-not (Test-Path -LiteralPath $log)) {
        $Result.updaterLog = "(没有更新器日志：$log)"
        return
    }
    $text = Get-Content -LiteralPath $log -Raw -Encoding utf8
    if ($text.Length -gt 6000) { $text = "..." + $text.Substring($text.Length - 6000) }
    $Result.updaterLog = $text
}
try {
    $toolchainBin = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
    if (Test-Path $toolchainBin) {
        $env:PATH = "$toolchainBin;$env:PATH"
        $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
    }
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { throw "演练需要 node（生成签名清单 / 同步版本号）" }

    $pkg = Get-Content -LiteralPath "package.json" -Raw -Encoding utf8 | ConvertFrom-Json
    $originalVersion = $pkg.version
    $parts = $originalVersion.Split(".")
    if ($parts.Count -ne 3) { throw "package.json 的版本不是 x.y.z：$originalVersion" }
    $patch = [int]$parts[2]
    $bumped = "$($parts[0]).$($parts[1]).$($patch + 1)"
    $rollbackVersion = "$($parts[0]).$($parts[1]).$($patch + 2)"

    $work = Join-Path $root "$OutDir\release-drill"
    # 上一次演练若中途失败会保留现场（-KeepWork 自动置位），清理前先确保没有残留进程握着里面的 exe。
    Stop-StrayLaunchers
    Wait-UpdaterIdle 20
    if ([System.IO.Directory]::Exists($work)) {
        try { [System.IO.Directory]::Delete($work, $true) }
        catch {
            Write-Host "上一次的演练目录删不掉（$work）：$($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  仍有进程占着旧文件；本次演练可能受影响，必要时手动清理该目录。" -ForegroundColor Yellow
        }
    }
    foreach ($sub in @("install", "payloads", "manifests", "scenarios", "out", "temp", "userdata", "updater")) {
        [System.IO.Directory]::CreateDirectory((Join-Path $work $sub)) | Out-Null
    }

    $targetExe = Join-Path $root "src-tauri\target\$Configuration\EvEJSLauncher.exe"
    $installExe = Join-Path $work "install\EvEJSLauncher.exe"

    Write-Host "=== L8 升级/回滚演练：$Rounds 轮 × 2 方向（$Configuration）" -ForegroundColor Cyan
    Write-Host "[1/4] 构建当前版本 $originalVersion 的载荷…"
    $buildArgs = @("build", "--quiet")
    if ($Configuration -eq "release") { $buildArgs += "--release" }
    Push-Location (Join-Path $root "src-tauri")
    & cargo @buildArgs
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "当前版本构建失败（退出码 $code）" }
    if (-not (Test-Path -LiteralPath $targetExe)) { throw "找不到产物：$targetExe" }

    $oldPayload = Join-Path $work "payloads\old-$originalVersion.exe"
    $newPayload = Join-Path $work "payloads\new-$bumped.exe"
    Copy-Item -LiteralPath $targetExe -Destination $oldPayload -Force

    Write-Host "[2/4] 构建演练用的新版 $bumped（跑完会还原成 $originalVersion 并重建）…"
    & node scripts/sync-version.mjs --set $bumped | Out-Host
    Push-Location (Join-Path $root "src-tauri")
    & cargo @buildArgs
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "新版构建失败（退出码 $code）" }
    Copy-Item -LiteralPath $targetExe -Destination $newPayload -Force
    & node scripts/sync-version.mjs --set $originalVersion | Out-Host
    Push-Location (Join-Path $root "src-tauri")
    & cargo @buildArgs
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "还原版本后重建失败（退出码 $code）" }

    $oldSha = Get-Sha256 $oldPayload
    $newSha = Get-Sha256 $newPayload
    if ($oldSha -eq $newSha) { throw "新旧载荷字节相同，演练无意义" }

    Write-Host "[3/4] 生成已签名清单（演练固定密钥）与更新器副本…"
    $upgradeManifest = Join-Path $work "manifests\upgrade.json"
    $rollbackManifest = Join-Path $work "manifests\rollback.json"
    & node scripts/gen-drill-manifest.mjs --payload $newPayload --version $bumped --out $upgradeManifest --notes-zh "演练：升级到 $bumped" | Out-Host
    & node scripts/gen-drill-manifest.mjs --payload $oldPayload --version $rollbackVersion --out $rollbackManifest --notes-zh "演练：回滚到 $originalVersion" | Out-Host
    Copy-Item -LiteralPath (Join-Path $root "vendor\updater\bin\evejs-updater.exe") -Destination (Join-Path $work "updater\evejs-updater.exe") -Force

    Write-Host "[4/4] 开始 $Rounds 轮升级 + 回滚…"
    $roundResults = @()
    $failures = @()

    for ($round = 1; $round -le $Rounds; $round++) {
        Write-Host ""
        Write-Host "--- 第 $round/$Rounds 轮 ---" -ForegroundColor Cyan
        Stop-StrayLaunchers
        Wait-UpdaterIdle 20
        if (-not (Set-InstallPayload -Source $oldPayload -Target $installExe)) {
            throw "第 $round 轮起点复位失败：$oldPayload → $installExe（文件被占用；上面已列出嫌疑进程，现场保留在 $work）"
        }
        [System.IO.Directory]::Delete((Join-Path $work "temp"), $true)
        [System.IO.Directory]::CreateDirectory((Join-Path $work "temp")) | Out-Null

        $upgrade = Invoke-DrillDirection -Label "升级" -Round $round -ManifestPath $upgradeManifest `
            -ExpectedSha $newSha -InstallExe $installExe -Work $work
        $rollback = Invoke-DrillDirection -Label "回滚" -Round $round -ManifestPath $rollbackManifest `
            -ExpectedSha $oldSha -InstallExe $installExe -Work $work

        foreach ($result in @($upgrade, $rollback)) {
            if (-not $result.ok) { $failures += "第 $round 轮 $($result.label)：$($result.reason)" }
        }
        $roundResults += [ordered]@{ round = $round; upgrade = $upgrade; rollback = $rollback }
    }

    $total = $Rounds * 2
    $passed = 0
    foreach ($entry in $roundResults) {
        if ($entry.upgrade.ok) { $passed += 1 }
        if ($entry.rollback.ok) { $passed += 1 }
    }
    $summary = [ordered]@{
        generatedAt     = (Get-Date).ToString("o")
        configuration   = $Configuration
        rounds          = $Rounds
        directions      = $total
        passed          = $passed
        successRate     = if ($total -gt 0) { [math]::Round($passed / $total, 4) } else { 0 }
        oldVersion      = $originalVersion
        newVersion      = $bumped
        oldSha256       = $oldSha
        newSha256       = $newSha
        failures        = $failures
        details         = $roundResults
        note            = "本机演练：验签/下载/SHA256/替换/重启/回滚全链；≥30 台灰度成功率见 S7 发布前置条件"
    }
    $jsonPath = Join-Path $root "$OutDir\release-drill.json"
    Write-Json $jsonPath $summary

    Write-Host ""
    Write-Host "产物：$jsonPath" -ForegroundColor Green
    if ($failures.Count -gt 0) { throw "L8 演练未通过：$($failures -join '；')" }
    Write-Host "L8 升级/回滚演练通过：$passed/$total 次（升级 $Rounds 次 + 回滚 $Rounds 次，成功率 100%）" -ForegroundColor Green
}
finally {
    foreach ($key in $envKeys) {
        [System.Environment]::SetEnvironmentVariable($key, $savedEnv[$key])
    }
    if ($originalVersion) {
        $now = (Get-Content -LiteralPath "package.json" -Raw -Encoding utf8 | ConvertFrom-Json).version
        if ($now -ne $originalVersion) {
            Write-Host "还原版本号 $now → $originalVersion 并重建…" -ForegroundColor Yellow
            & node scripts/sync-version.mjs --set $originalVersion | Out-Host
            Push-Location (Join-Path $root "src-tauri")
            $restoreArgs = @("build", "--quiet")
            if ($Configuration -eq "release") { $restoreArgs += "--release" }
            & cargo @restoreArgs
            Pop-Location
        }
    }
    foreach ($pidValue in Get-LauncherPids) { Stop-Launcher $pidValue }
    $workDir = Join-Path $root "$OutDir\release-drill"
    if ($failures -and $failures.Count -gt 0 -and -not $KeepWork) {
        Write-Host "有失败项：保留现场供排查 $workDir" -ForegroundColor Yellow
        $KeepWork = $true
    }
    if (-not $KeepWork) {
        if ([System.IO.Directory]::Exists($workDir)) {
            try { [System.IO.Directory]::Delete($workDir, $true) } catch { Write-Host "演练目录删除失败（可手动清理）：$workDir" -ForegroundColor Yellow }
        }
    } else {
        Write-Host "演练现场：$workDir" -ForegroundColor Yellow
    }
}