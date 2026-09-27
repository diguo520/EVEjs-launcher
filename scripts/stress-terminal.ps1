<#
L4 终端压测入口（计划 §7 / §12）：
  真 ConPTY 喷 100,000 行 → 断言「不丢行」+「单次卡顿 < 1000 ms」。
  断言本体在 Rust 侧（src-tauri/src/pty.rs 的 #[ignore] 测试），本脚本只负责
  挑好解释器、跑测试、把结论落成机器可读产物。

为什么不用外部脚本灌数据：PTY 的输出泵（reader 线程 → 事件 → 渲染层）正是要验的那段代码路径。
只测「我发得出去」没有意义，测「它一条不漏地读回来」才有。

用法：
  pwsh -File scripts/stress-terminal.ps1
  pwsh -File scripts/stress-terminal.ps1 -Lines 200000
#>
param(
    [int]$Lines = 100000,
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

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "压测需要一个能跑的 node（PTY 里执行的是 node -e）" }

    Write-Host "=== L4 终端压测：$Lines 行（真 ConPTY）" -ForegroundColor Cyan
    Push-Location src-tauri
    $output = & cargo test --lib -- --ignored --nocapture l4_terminal_stress 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $output | ForEach-Object { Write-Host $_ }

    $line = $output | Where-Object { $_ -match '^\[L4\]' } | Select-Object -Last 1
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    $result = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        lines       = $Lines
        exitCode    = $code
        passed      = ($code -eq 0)
        summary     = if ($line) { $line.Trim() } else { "" }
    }
    $jsonPath = Join-Path $OutDir "stress-terminal.json"
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding utf8
    Write-Host ""
    Write-Host "产物：$jsonPath" -ForegroundColor Green

    if ($code -ne 0) { throw "L4 压测未通过（退出码 $code）" }
    Write-Host "L4 终端压测通过：无丢行、单次卡顿在阈值内" -ForegroundColor Green
}
finally {
    Pop-Location
}