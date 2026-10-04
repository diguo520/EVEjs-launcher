<#
冷启动测量（S5 / L7 续做）：测「重启登录后第一次启动」的真实开销，并给出冷热曲线。

为什么必须单独一个脚本：`measure-startup.ps1` 只能测「此刻」的启动耗时，而文件缓存一旦热了，
冷启动的代价就再也测不出来。这里用**一次性登录任务**解决：

  pwsh -File scripts/measure-cold-start.ps1 -RegisterAtLogon   # 注册任务，然后重启机器
  （重启登录后脚本自动开跑：三个目标各 1 轮冷启动 + 2 轮热启动）
  pwsh -File scripts/measure-cold-start.ps1                    # 也可以在重启后手动跑
  pwsh -File scripts/measure-cold-start.ps1 -Unregister        # 反悔：删掉任务

口径（与 measure-startup.ps1 完全一致）：启动 = CreateProcess → 按标题匹配的可见主窗口；
内存 = 启动后 N 秒对整棵进程树 WorkingSet64 求和（CIM 精确父子关系）。
三个目标共用**同一个隔离 userdata** 与**同一个 launcher.config.json 工作目录**（指向 parity fixture 仓库根，
不碰真实安装目录），三者可比。

三个目标（用户实际会双击的形态都在里面）：

  1. `tauri`              Tauri 2.0.0 目录版（zip 解压即用）
  2. `electron-unpacked`  Electron 0.1.24 目录版（与上面同为「目录形态」，换外壳的同形态对比）
  3. `electron-portable`  Electron 0.1.24 **便携单 exe**（现役对外分发的形态：NSIS 自解压到 temp）

为什么三个都要：现役版用户实际双击的是第 3 个，它的启动耗时里含着「解压 73 MB」这段
（本机实测热缓存下就要 10.6 s），而 Tauri 交付的是 zip 解压即用的目录，没有这段。

本文件与 measure-startup.ps1 必须带 UTF-8 BOM：登录任务解释器兜底链的末端是 Windows
PowerShell 5.1，而 5.1 读**无 BOM** 的 .ps1 会按系统 ANSI（本机 GBK）解码，中文注释直接
被解成乱码并抛 ParseException —— 表现为「重启一次却什么都没测到」。
#>
param(
    [switch]$RegisterAtLogon,
    [switch]$Unregister,
    [switch]$FromTask,
    [switch]$Force,
    [int]$Iterations = 3,
    [int]$SampleSeconds = 10,
    [int]$TimeoutSeconds = 90,
    [int]$WarmUpGuardSeconds = 600,
    [string]$OutJson = "",
    [string]$OutMarkdown = "",
    [string]$Interpreter = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$parityOut = Join-Path $root ".parity-out"
$taskName = "EveJS-Launcher-ColdStart-Measure"
$measureScript = Join-Path $PSScriptRoot "measure-startup.ps1"
$workingDirectory = Join-Path $parityOut "measure-cwd"
$userDataDir = Join-Path $parityOut "measure-userdata"
$logFile = Join-Path $parityOut "cold-start.log"
if ([string]::IsNullOrWhiteSpace($OutJson)) { $OutJson = Join-Path $parityOut "cold-start.json" }
if ([string]::IsNullOrWhiteSpace($OutMarkdown)) { $OutMarkdown = Join-Path $parityOut "cold-start.md" }
$electronRoot = "E:\Games\EveJS-v0.12.8\launcher\launcher"

$targets = @(
    [pscustomobject]@{
        Id = "tauri"; Exe = (Join-Path $root "src-tauri\target\release\EvEJSLauncher.exe")
        Title = "EVEJS COMMAND"; Note = "Tauri 2.0.0 目录版（zip 解压即用）"
    },
    [pscustomobject]@{
        Id = "electron-unpacked"; Exe = (Join-Path $electronRoot "release\win-unpacked\EvEJSLauncher.exe")
        Title = "EVEJS COMMAND // 启动器"; Note = "Electron 0.1.24 目录版（同形态对比）"
    },
    [pscustomobject]@{
        Id = "electron-portable"; Exe = (Join-Path $electronRoot "release\EvEJS-启动器-便携版-0.1.24.exe")
        Title = "EVEJS COMMAND // 启动器"; Note = "Electron 0.1.24 便携单 exe（现役对外分发形态）"
    }
)

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    try {
        New-Item -ItemType Directory -Force -Path $parityOut | Out-Null
        [System.IO.File]::AppendAllText($logFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
}

function Get-PwshCandidates {
    $raw = New-Object System.Collections.Generic.List[string]
    $raw.Add("C:\Program Files\PowerShell\7\pwsh.exe")
    $raw.Add("C:\Program Files\PowerShell\7-preview\pwsh.exe")
    # 本机实测：PATH 上唯一的 PS7 来自非标准安装位置，用户在登录会话里看不到它。所以注册时把
    # Get-Command 解析到的**绝对路径**固化进 cmd 的兜底链，运行时再由 cmd 用 -Interpreter 回传给
    # 本脚本 —— 源码里因此不必出现任何机器专属路径（B7 门禁同样要求如此）。
    foreach ($item in @(Get-Command pwsh -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })) {
        if ($item) { $raw.Add([string]$item) }
    }
    $raw.Add("C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    $ordered = New-Object System.Collections.Generic.List[string]
    foreach ($item in $raw) { if ($item -and -not $ordered.Contains($item)) { $ordered.Add($item) } }
    return $ordered
}

function Get-PwshPath {
    foreach ($item in Get-PwshCandidates) { if (Test-Path -LiteralPath $item) { return $item } }
    return "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
}

function Get-UptimeSeconds {
    # .NET Framework（Windows PowerShell 5.1）里 Environment.TickCount64 **不存在**，而且取值是
    # $null 而不是抛异常 —— 所以不能只靠 try/catch：必须显式判空，否则 5.1 下会静默返回 0，
    # 「开机 X 分钟」写成 0 分钟、冷热守卫失效。兜底用约 24.9 天回绕的 TickCount。
    $ticks = $null
    try { $ticks = [System.Environment]::TickCount64 } catch { $ticks = $null }
    if ($null -eq $ticks) {
        $ticks = [double][System.Environment]::TickCount
        if ($ticks -lt 0) { $ticks += 4294967296.0 }
    }
    return [double]$ticks / 1000.0
}

function Unregister-ColdStartTask {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Log "已删除计划任务 $taskName" }
    catch { }
    try {
        Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name "EveJS-ColdStart" -ErrorAction Stop
        Write-Log "已删除 RunOnce 项 EveJS-ColdStart"
    }
    catch { }
}

# cmd 的兜底链若已选中解释器，会用 -Interpreter 回传：优先用它，保证父子进程用的是同一个。
$pwshPath = if (-not [string]::IsNullOrWhiteSpace($Interpreter) -and (Test-Path -LiteralPath $Interpreter)) { $Interpreter } else { Get-PwshPath }

if ($Unregister) { Unregister-ColdStartTask; exit 0 }

if ($RegisterAtLogon) {
    New-Item -ItemType Directory -Force -Path $parityOut | Out-Null
    $cmdPath = Join-Path $parityOut "cold-start.cmd"
    # cmd 里做**兜底链**：登录任务拿到的是用户登录环境（本机实测**不含** codex-runtimes 缓存目录），
    # 而本机没有 Program Files 版 pwsh —— 只烧一条绝对路径的话，缓存目录一旦被清理，任务就静默
    # 失败、白重启一次。所以按候选顺序逐个探测，全找不到时往日志写一行再以 9009 退出。
    $cmdLines = New-Object System.Collections.Generic.List[string]
    $cmdLines.Add("@echo off")
    $cmdLines.Add("chcp 65001 >nul")
    $cmdLines.Add("setlocal")
    $cmdLines.Add('set "PS="')
    foreach ($item in @(Get-PwshCandidates)) {
        $cmdLines.Add(('if not defined PS if exist "{0}" set "PS={0}"' -f $item))
    }
    $cmdLines.Add("if not defined PS goto :nointerp")
    $cmdLines.Add(('"%PS%" -NoProfile -ExecutionPolicy Bypass -File "{0}" -FromTask -Force -Interpreter "%PS%"' -f $PSCommandPath))
    $cmdLines.Add("exit /b %ERRORLEVEL%")
    $cmdLines.Add(":nointerp")
    $cmdLines.Add(('echo [cold-start] no PowerShell interpreter found; measurement not executed >> "{0}"' -f $logFile))
    $cmdLines.Add("exit /b 9009")
    $cmd = ($cmdLines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($cmdPath, $cmd, [System.Text.Encoding]::ASCII)

    $registered = ""
    try {
        $action = New-ScheduledTaskAction -Execute $cmdPath -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
            -Description "EvEJS 启动器冷启动测量（一次性，跑完自删）" | Out-Null
        $registered = "计划任务"
    }
    catch {
        Write-Log "注册计划任务失败（$($_.Exception.Message)），改用 HKCU RunOnce"
        Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name "EveJS-ColdStart" -Value ("`"$cmdPath`"")
        $registered = "HKCU RunOnce"
    }
    Write-Log "已注册（$registered）：下次登录自动跑冷启动测量。取消：pwsh -File scripts/measure-cold-start.ps1 -Unregister"
    Write-Host ""
    Write-Host "下一步：重启机器 → 登录后不要立刻操作，等约 3–5 分钟（会弹几次启动器窗口，属正常）→ 回来读 $OutJson" -ForegroundColor Green
    exit 0
}

$uptimeSeconds = Get-UptimeSeconds
if (-not $FromTask) {
    if ($uptimeSeconds -gt $WarmUpGuardSeconds -and -not $Force) {
        Write-Host ""
        Write-Warning ("本次开机已 {0:N1} 分钟，相关文件早已进系统缓存，测出来的**不是冷启动**。" -f ($uptimeSeconds / 60))
        Write-Host "  · 想要真实的冷启动：pwsh -File scripts/measure-cold-start.ps1 -RegisterAtLogon  → 重启"
        Write-Host "  · 只是想把脚本跑通：加 -Force"
        exit 3
    }
}

# 登录后可能 E: 还没就绪 / 桌面还没起来，给它一点时间
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $targets[0].Exe) -and (Get-Process explorer -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Force -Path $workingDirectory | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $workingDirectory "launcher.config.json"),
    ('{"repoRoot": "' + (Join-Path $parityOut "parity-repo") + '"}'),
    (New-Object System.Text.UTF8Encoding($false))
)
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null

$uptimeMinutes = [math]::Round(($uptimeSeconds / 60), 1)
$coldBoot = ($uptimeSeconds -le $WarmUpGuardSeconds)
$coldVerdict = if ($coldBoot) { "是" } else { "否（本次不是冷启动）" }
$bootTime = (Get-Date).AddSeconds(-1 * $uptimeSeconds).ToString("yyyy-MM-dd HH:mm:ss")
Write-Log ("开机时长 {0:N1} 分钟（估计开机时间 {1}），冷启动判定：{2}" -f $uptimeMinutes, $bootTime, $coldVerdict)
if (-not $coldBoot) {
    Write-Log "警告：本次不是冷启动 —— 若刚才是「关机再开机」，Windows 快速启动会保留内核会话、开机时长不清零，请改用「重启」。数字偏热，不可当冷启动用。"
}
Write-Log "开始冷启动测量：开机 $uptimeMinutes 分钟，轮次 $Iterations，采样 $SampleSeconds s"
Write-Host ""
$header = "{0,-4} {1,-20} {2,12} {3,14} {4,8} {5,-6}" -f "轮", "目标", "启动(ms)", "内存(MB)", "进程数", "窗口"
Write-Host $header

$results = @()
for ($round = 1; $round -le $Iterations; $round++) {
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target.Exe)) {
            Write-Host ("{0,-4} {1,-20} {2,12}" -f $round, $target.Id, "跳过：找不到 exe")
            continue
        }
        $jsonPath = Join-Path $parityOut ("cold-start-" + $target.Id + "-r" + $round + ".json")
        $label = "{0}-r{1}" -f $target.Id, $round
        # 绝对路径调用：登录任务环境的 PATH 里**没有** pwsh（实测），裸 `pwsh` 会直接 CommandNotFound
        # 把整轮测量打死。这里同时把子进程的输出与退出码收进日志，失败时重启不至于白跑。
        $childOut = & $pwshPath -NoProfile -ExecutionPolicy Bypass -File $measureScript -Exe $target.Exe -Label $label -Iterations 1 `
            -SampleSeconds $SampleSeconds -TimeoutSeconds $TimeoutSeconds -WindowTitle $target.Title `
            -WorkingDirectory $workingDirectory -UserDataDir $userDataDir -JsonOut $jsonPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log ("子测量退出码 {0}：{1}" -f $LASTEXITCODE, $label)
            foreach ($childLine in @($childOut | Select-Object -Last 10)) { Write-Log ("  > " + $childLine) }
        }
        if (-not (Test-Path -LiteralPath $jsonPath)) {
            Write-Host ("{0,-4} {1,-20} {2,12}" -f $round, $target.Id, "无结果")
            Write-Log "无结果：$($target.Id) 第 $round 轮"
            continue
        }
        $measured = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $row = $measured.rows[0]
        $memKey = "mem${SampleSeconds}sMB"
        $mem = if ($row.memory.PSObject.Properties.Name -contains $memKey) { $row.memory.$memKey } else { "" }
        $cold = if ($round -eq 1) { "冷" } else { "热" }
        Write-Host ("{0,-4} {1,-20} {2,12} {3,14} {4,8} {5,-6}" -f "$round($cold)", $target.Id, $row.startupMs, $mem, $row.procs, $row.windowOwner)
        $results += [pscustomobject]@{
            round = $round; cold = ($round -eq 1); target = $target.Id; note = $target.Note
            exe = $target.Exe; startupMs = $row.startupMs; procs = $row.procs
            windowOwner = $row.windowOwner; memoryMB = $mem
        }
    }
}

$payload = [pscustomobject]@{
    measuredAt   = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    uptimeMinutes = $uptimeMinutes
    uptimeSeconds = [math]::Round($uptimeSeconds, 1)
    coldBoot     = $coldBoot
    bootTime     = $bootTime
    machine      = "$env:COMPUTERNAME"
    iterations   = $Iterations
    sampleSeconds = $SampleSeconds
    workingDirectory = $workingDirectory
    userDataDir  = $userDataDir
    results      = $results
}
[System.IO.File]::WriteAllText($OutJson, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

$md = @()
$md += ""
$md += ("开机时长：{0:N1} 分钟；估计开机时间：{1}；冷启动判定：{2}" -f $uptimeMinutes, $bootTime, $coldVerdict)
$md += ""
$md += "| 目标 | 形态 | 冷启动(ms) | 热启动均值(ms) | 内存@${SampleSeconds}s(MB) | 进程数 |"
$md += "| --- | --- | --- | --- | --- | --- |"
foreach ($target in $targets) {
    $rows = @($results | Where-Object { $_.target -eq $target.Id })
    if ($rows.Count -eq 0) { continue }
    $coldRow = $rows | Where-Object { $_.cold } | Select-Object -First 1
    $warm = @($rows | Where-Object { -not $_.cold })
    $warmAvg = if ($warm.Count -gt 0) { [math]::Round((($warm | Measure-Object startupMs -Average).Average), 0) } else { "" }
    $md += ("| {0} | {1} | {2} | {3} | {4} | {5} |" -f $target.Id, $target.Note, $coldRow.startupMs, $warmAvg, $coldRow.memoryMB, $coldRow.procs)
}
[System.IO.File]::WriteAllText($OutMarkdown, (($md -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Log "完成：已写 $OutJson 与 $OutMarkdown"

if ($FromTask) {
    Unregister-ColdStartTask
    Write-Log "一次性任务已自删"
}