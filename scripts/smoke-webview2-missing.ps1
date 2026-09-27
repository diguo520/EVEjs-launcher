<#
G4 冒烟：模拟「机器上没装 WebView2」，验证引导流程真的会弹中文对话框（而不是静默退出/闪退）。

做法：给进程注入 EVEJS_SIMULATE_NO_WEBVIEW2=1（见 src-tauri/src/webview2.rs 的模块文档），
预检会强制判为「未装」→ 弹出 MessageBoxW → 进程挂在那里等用户选择。
脚本断言：① 进程存活（不是静默退出）；② 顶层窗口标题就是那句 WebView2 指引；
③ 没有出现主窗口（说明确实在创建窗口之前就拦住了）。最后 KILL，不点任何按钮。

用法：
  pwsh -File scripts/smoke-webview2-missing.ps1
  pwsh -File scripts/smoke-webview2-missing.ps1 -Exe "artifacts\EvEJSLauncher-Tauri-0.2.0\EvEJSLauncher.exe"
#>
param(
    [string]$Exe = "src-tauri\target\release\EvEJSLauncher.exe",
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = if ([System.IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $root $Exe }
if (-not (Test-Path -LiteralPath $exePath)) { throw "找不到产物：$exePath（先跑 scripts/build.ps1）" }

# 对话框标题（必须与 webview2.rs::ensure_installed 里的 caption 一致）
$dialogTitle = "EvEJS 启动器 · 缺少 WebView2 运行时"
$mainTitle = "EvEJS 启动器"

Write-Host "自检目标：$exePath"
$env:EVEJS_SIMULATE_NO_WEBVIEW2 = "1"
$proc = Start-Process -FilePath $exePath -PassThru
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$title = ""
$found = $false

try {
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $proc.Refresh()
        if ($proc.HasExited) { break }
        $title = $proc.MainWindowTitle
        if ($title -eq $dialogTitle) { $found = $true; break }
    }

    Write-Host ""
    Write-Host "断言："
    $checks = @(
        @{ name = "进程存活（在等用户点按钮，不是静默退出）"; ok = (-not $proc.HasExited) },
        @{ name = "顶层窗口标题 = 中文 WebView2 指引"; ok = $found },
        @{ name = "未创建主窗口（确实在创建窗口前拦下）"; ok = ($title -ne $mainTitle -and $title -ne "") }
    )
    $failed = @()
    foreach ($c in $checks) {
        $mark = if ($c.ok) { "OK  " } else { "FAIL" }
        Write-Host ("  [{0}] {1}" -f $mark, $c.name)
        if (-not $c.ok) { $failed += $c.name }
    }
    Write-Host ""
    Write-Host ("实际标题：'{0}'" -f $title)
    Write-Host ("退出码：{0}" -f $(if ($proc.HasExited) { $proc.ExitCode } else { "未退出（预期）" }))

    if ($failed.Count -gt 0) {
        Write-Host ("G4 冒烟失败：{0}" -f ($failed -join " / ")) -ForegroundColor Red
        exit 1
    }
    Write-Host "G4 冒烟通过：未装 WebView2 时会给出中文引导并停住等用户选择" -ForegroundColor Green
}
finally {
    if (-not $proc.HasExited) {
        taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    }
    Remove-Item Env:\EVEJS_SIMULATE_NO_WEBVIEW2 -ErrorAction SilentlyContinue
}