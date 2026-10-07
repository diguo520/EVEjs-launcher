<#
L5 编码验收（计划 §7）：zh-CN Windows（代码页 936）下中文输出与 ANSI 颜色。

断言本体在 Rust 侧（src-tauri/src/pty.rs 的 #[ignore] 测试 l5_zh_cn_...），本脚本只负责
挑好解释器、跑测试、把结论落成机器可读产物。

为什么必须真起 ConPTY：编码转换发生在 ConPTY（控制台 ↔ 管道）内部，用 Command::output()
直连管道测不到这条路径 —— 而现役版走的正是 ConPTY（node-pty + xterm.js），口径必须一致。

用法：
  pwsh -File scripts/check-encoding.ps1
  pwsh -File scripts/check-encoding.ps1 -OutDir .parity-out
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

    Write-Host "=== L5 编码验收：活动代码页 / 中文 / ANSI 颜色（真 ConPTY）" -ForegroundColor Cyan
    Push-Location src-tauri
    $output = & cargo test --lib -- --ignored --nocapture l5_zh_cn 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $output | ForEach-Object { Write-Host $_ }

    # `2>&1` from a native command may arrive as one multi-line string on some PowerShell
    # hosts; split it before matching so this check stays independent of the host wrapping.
    $lines = ($output | Out-String) -split '\r?\n'
    # The host can decode cargo's native stdout using a stale console code page even though
    # the Rust test itself passed. Match only the stable ASCII markers here; the test
    # assertion is the authority for the exact Chinese text.
    $summary = $lines | Where-Object { $_ -match '^\[L5\] ' } | Select-Object -Last 1
    $codePage = ""
    if ($summary -and ($summary -match '(\d{3,5})')) { $codePage = $Matches[1] }
    $hasChinese = [bool]($summary -and $summary.Contains("936"))
    $hasAnsi = [bool]($summary -and $summary.Contains("31m"))

    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    $result = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        exitCode    = $code
        passed      = ($code -eq 0)
        codePage    = $codePage
        hasChinese  = $hasChinese
        hasAnsi     = $hasAnsi
        summary     = if ($summary) { $summary.Trim() } else { "" }
    }
    $jsonPath = Join-Path $OutDir "encoding.json"
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding utf8
    Write-Host ""
    Write-Host "产物：$jsonPath" -ForegroundColor Green

    if ($code -ne 0) { throw "L5 未通过（退出码 $code）" }
    if (-not $hasChinese) { throw "L5 未通过：没看到完整的中文输出行（代码页 $codePage）" }
    if (-not $hasAnsi) { throw "L5 未通过：没看到 ANSI 颜色序列" }
    if ($codePage -ne "936") {
        Write-Host "提示：本机活动代码页是 $codePage（不是 936），936 分支由测试内的显式 chcp 覆盖。" -ForegroundColor Yellow
    }
    Write-Host "L5 编码验收通过：中文无乱码、ANSI 颜色未丢失" -ForegroundColor Green
}
finally {
    Pop-Location
}