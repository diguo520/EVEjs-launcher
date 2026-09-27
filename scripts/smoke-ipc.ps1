<#
G1 运行时自检（真实 WebView，端到端）：
  启动 EvEJSLauncher.exe --self-test → 页面里逐条 invoke 安全通道 →
  结果写进窗口标题 → 本脚本读标题判定后关闭进程。

覆盖全部只读通道 + 全部待实现通道（待实现通道统一回 {ok:false}）；
剩余写通道（window:*、settings:set、config:set*、service:*、engage:*、accounts:create/
delete/setPassword/launch、login:start、init:run、database:save/insert/delete/restore/backup）
有副作用，故意不自动执行。

A4 渲染隔离断言是**双入口自适应**的（见 src-tauri/src/ipc/smoke.rs）：
  - legacy 页面：断言「构建期内联脚本被放行」（CSP 哈希没漏）
  - React 页面：断言「#root 有子树」+「全程零 CSP 违规」
两条路的门禁强度等价，但都不再依赖对方的专属全局。

用法：
  pwsh -File scripts/smoke-ipc.ps1                     # 默认渲染层（当前为 react）
  pwsh -File scripts/smoke-ipc.ps1 -Ui legacy          # 显式跑旧渲染层
  pwsh -File scripts/smoke-ipc.ps1 -Exe "src-tauri\target\release\EvEJSLauncher.exe" -TimeoutSeconds 90
#>
param(
    [string]$Exe = "src-tauri\target\release\EvEJSLauncher.exe",
    [int]$TimeoutSeconds = 90,
    [ValidateSet("react", "legacy")]
    [string]$Ui = "",
    [switch]$KeepOpen
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = if ([System.IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $root $Exe }
if (-not (Test-Path -LiteralPath $exePath)) { throw "找不到产物：$exePath（先跑 scripts/build.ps1）" }

Write-Host "自检目标：$exePath"
$resultFile = Join-Path ([System.IO.Path]::GetTempPath()) "evejs-self-test.json"
if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
$env:EVEJS_SELF_TEST_OUT = $resultFile

$arguments = @("--self-test")
if ($Ui) { $arguments += "--ui=$Ui" }
$proc = Start-Process -FilePath $exePath -ArgumentList $arguments -PassThru
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$summary = $null

try {
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $proc.Refresh()
        if (Test-Path -LiteralPath $resultFile) {
            try { $summary = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $summary = $null }
            if ($summary) { break }
        }
        if ($proc.HasExited -and -not $summary) { throw "进程提前退出（exit code $($proc.ExitCode)）且未产出结果文件" }
    }
}
finally {
    if (-not $KeepOpen) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
}

if (-not $summary) {
    Write-Error "未在 $TimeoutSeconds 秒内拿到自检结果（$resultFile 未生成）"
    exit 2
}

Write-Host ""
$ok = [int]$summary.ok
$total = [int]$summary.total
$fails = @($summary.fails)

Write-Host ("覆盖 {0}/{1} 个请求通道（总契约 82，另有 {2} 个写通道不自动执行）" -f $ok, $total, (82 - $total))
if ($fails.Count -gt 0) {
    Write-Host "失败通道：" -ForegroundColor Red
    $fails | ForEach-Object { Write-Host (("  " + [char]0x2717 + " ") + $_) -ForegroundColor Red }
}

# A4 渲染隔离：真机断言（CSP 拦注入脚本、无全局 __TAURI__、事件订阅往返、渲染层已挂载）
$securityFails = @($summary.securityFails)
$security = $summary.security
if ($security) {
    Write-Host ""
    Write-Host ("A4 渲染隔离断言（渲染层 = {0}）：" -f $summary.renderer)
    foreach ($property in $security.PSObject.Properties) {
        if ($property.Name -eq "renderer") { continue }
        $value = $property.Value
        $mark = if ($value -eq $true) { [char]0x2713 } else { [char]0x2717 }
        $color = if ($value -eq $true) { "Green" } else { "Red" }
        Write-Host ("  {0} {1} = {2}" -f $mark, $property.Name, $value) -ForegroundColor $color
    }
}
# 红灯必须自证：把「页面自身 CSP 违规」的指令名列出来，否则只能靠猜
$pageViolations = @($summary.pageCspViolations)
if ($pageViolations.Count -gt 0) {
    Write-Host ("  页面自身 CSP 违规 {0} 条：{1}" -f $pageViolations.Count, ($pageViolations -join ", ")) -ForegroundColor Red
}
if ($securityFails.Count -gt 0) {
    Write-Host ("A4 未通过：{0}" -f ($securityFails -join ", ")) -ForegroundColor Red
}

if ($fails.Count -gt 0 -or $ok -ne $total -or $securityFails.Count -gt 0) {
    Write-Host "G1 运行时自检失败" -ForegroundColor Red
    exit 1
}
Write-Host "G1 运行时自检通过：全部通道均有回包，A4 渲染隔离断言全绿" -ForegroundColor Green