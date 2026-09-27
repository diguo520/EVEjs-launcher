<#
L6 进程树验收（计划 §7）：停服后不留孤儿。

两层断言，缺一不可：
  ① Rust 侧（src-tauri/src/process.rs 的 #[ignore] 测试 l6_stop_kills_whole_process_tree）：
     真起 `node → node` 两级进程，走生产同一条 taskkill /PID <pid> /T /F，要求 0 残留 —— 这层证明**因果**；
  ② 本脚本：跑测试前后各拉一次系统进程快照，断言「没有新增 node / exefile / market-server」，
     并断言四个服务端口（26000/26001/26002/40110）空闲 —— 这层就是判据原文，证明**全局无残留**。

为什么不用 IPC 起真服务来做这件事：沙箱里的 server/ 是占位目录（没有更好的 fixture），
起服务必然失败；而「停服收不收干净」取决于 taskkill 的语义与 PID 归属，用真父子进程测是同一条代码路径。

用法：
  pwsh -File scripts/check-process-residue.ps1
#>
param(
    [string]$OutDir = ".parity-out"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $toolchainBin = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
    if (Test-Path $toolchainBin) {
        $env:PATH = "$toolchainBin;$env:PATH"
        $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
    }

    # 判据里的三类进程名（exefile = 游戏客户端，market-server = 市场服务二进制）
    $targets = '^(node|exefile|market-server)$'
    $ports = 26000, 26001, 26002, 40110

    function Get-Residue {
        @(
            Get-Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessName -match $targets } |
                ForEach-Object { "$($_.ProcessName):$($_.Id)" } |
                Sort-Object
        )
    }

    function Get-BusyPorts {
        $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        @($listeners | Where-Object { $ports -contains $_.Port } | ForEach-Object { $_.Port } | Sort-Object -Unique)
    }

    $before = Get-Residue
    $beforeBusy = Get-BusyPorts
    Write-Host "=== L6 进程树验收：停服后无残留" -ForegroundColor Cyan
    Write-Host "跑测试前已在运行的同类进程：$(if ($before) { $before -join ', ' } else { '无' })"

    Push-Location src-tauri
    $output = & cargo test --lib -- --ignored --nocapture l6_stop 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $output | ForEach-Object { Write-Host $_ }

    $after = Get-Residue
    $afterBusy = Get-BusyPorts
    $new = @($after | Where-Object { $before -notcontains $_ })
    $summary = $output | Where-Object { $_ -match '^\[L6\]' } | Select-Object -Last 1
    $leftover = -1
    if ($summary -and ($summary -match '停后残留\s+(\d+)')) { $leftover = [int]$Matches[1] }

    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    $result = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        exitCode    = $code
        passed      = ($code -eq 0)
        treeLeftover = $leftover
        newProcesses = $new
        busyPorts    = $afterBusy
        summary      = if ($summary) { $summary.Trim() } else { "" }
    }
    $jsonPath = Join-Path $OutDir "process-tree.json"
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding utf8
    Write-Host ""
    Write-Host "产物：$jsonPath" -ForegroundColor Green

    if ($code -ne 0) { throw "L6 未通过：Rust 侧进程树测试失败（退出码 $code）" }
    if ($leftover -ne 0) { throw "L6 未通过：停服后残留 $leftover 个后代进程" }
    if ($new.Count -gt 0) { throw "L6 未通过：系统里多出残留进程 $($new -join ', ')" }
    if ($afterBusy.Count -gt 0) { throw "L6 未通过：端口仍被占用 $($afterBusy -join ', ')" }
    Write-Host "L6 进程树验收通过：停服 0 残留、无新增同类进程、四个服务端口空闲" -ForegroundColor Green
}
finally {
    Pop-Location
}