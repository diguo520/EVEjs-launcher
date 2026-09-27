<#
冷启动与内存基线测量（S0 口径，新旧外壳同脚本可比）。

口径：
  - 启动耗时：从 CreateProcess 到**主窗口可见**（毫秒）。
    判定方式是按标题精确定位（默认 "EvEJS 启动器"），而不是 Process.MainWindowHandle ——
    后者会先撞上 tauri-plugin-single-instance 的隐藏窗口（标题 com.evejs.launcher-siw），
    把「启动耗时」测成「单实例插件建窗口的耗时」，偏乐观。
  - 常驻内存（**两个口径都给**）：
      · memXs(MB)  = 整棵进程树 WorkingSet64 求和 —— 跨外壳可比，但共享页会被逐进程重复计入
        （Chromium/WebView2 的共享 DLL 页），所以数值偏大；
      · privXs(MB) = 整棵进程树 PrivateMemorySize64 求和 —— 贴近任务管理器「内存」列的量级。
    （Electron 会算上 GPU/renderer 子进程；Tauri 会算上 msedgewebview2 子进程）。

进程树的取法（两级，先精确后降级）：
  1) 首选 CIM（Win32_Process 的 ParentProcessId，真正的父子关系）——
     但 CIM 在某些受限环境/沙箱里会**永久挂起**，所以放在带超时的子作业里跑；
  2) 超时或失败则降级为「同名 + 启动时间不早于根进程」的近似口径
     （会漏掉改名子进程，也可能误收同时间启动的其它 WebView2/Node 进程）。
  哪一级生效会打印出来，避免把近似值当精确值用。

用法：
  pwsh -File scripts/measure-startup.ps1 -Exe "artifacts\EvEJSLauncher-Tauri-0.2.0\EvEJSLauncher.exe" -Label "Tauri"
  pwsh -File scripts/measure-startup.ps1 -Exe "E:\...\release\win-unpacked\EvEJSLauncher.exe" -Label "Electron" ``
      -WindowTitle "EVEJS COMMAND // 启动器" -UserDataDir ".parity-out\measure-userdata"
  pwsh -File scripts/measure-startup.ps1 -Exe "E:\...\release\EvEJSLauncher.exe" -Label "Electron" -SampleSeconds 10

-UserDataDir（S5 新增）：给子进程设 EVEJS_USER_DATA_DIR，用**隔离的运行时数据目录**测量。
  不设的话，现役版会读真实用户设置，可能按用户自己的偏好自动拉起主服务/市场服务，
  于是「内存 60 s」里混进了服务进程（本机实测出现过 1441 MB / 8 进程的脏数据）。
  两个外壳都认这个环境变量，所以跨外壳对比时务必两边都带上。
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Label = "",
    [int]$Iterations = 3,
    [int[]]$SampleSeconds = @(10, 60),
    [int]$TimeoutSeconds = 30,
    [string]$WindowTitle = "EvEJS 启动器",
    [string]$UserDataDir = "",
    [string]$WorkingDirectory = "",
    [string]$OutFile = "",
    [string]$JsonOut = "",
    # 传给被测进程的额外参数。S6 双入口（--ui=react|legacy）之后，同一个 exe 就能演两个渲染层，
    # 不必再像早先那样「改 frontendDist → 重新构建 → 复制 exe」才能对比页面开销。
    [string[]]$AppArguments = @()
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到可执行文件：$Exe" }
if ([string]::IsNullOrWhiteSpace($Label)) { $Label = [System.IO.Path]::GetFileNameWithoutExtension($Exe) }

# 按标题找「属于指定 PID 的可见顶层窗口」（不用 Process.MainWindowHandle，原因见文件头）
if (-not ("WinScan" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinScan {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    // 按标题列出所有可见顶层窗口的**拥有者 PID**。
    // 为什么不是「指定 PID 的窗口」：便携版单 exe（NSIS）会解压后另起子进程，
    // 真正的主窗口属于**子进程**，用根 PID 去找永远找不到（会把启动耗时测成 -1）。
    public static uint[] FindPidsByTitle(string title) {
        System.Collections.Generic.List<uint> pids = new System.Collections.Generic.List<uint>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) { return true; }
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            if (sb.ToString() != title) { return true; }
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (!pids.Contains(owner)) { pids.Add(owner); }
            return true;
        }, IntPtr.Zero);
        return pids.ToArray();
    }
}
'@
}

$CIM_TIMEOUT_SECONDS = 15

function Get-ProcessTreeViaCim {
    param([int]$RootId)
    $job = Start-Job -ScriptBlock {
        Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, WorkingSetSize, PrivatePageCount |
            Select-Object ProcessId, ParentProcessId, WorkingSetSize, PrivatePageCount
    }
    try {
        if (-not (Wait-Job $job -Timeout $CIM_TIMEOUT_SECONDS)) { return $null }
        $all = Receive-Job $job
        if (-not $all) { return $null }
    }
    catch { return $null }
    finally { Remove-Job $job -Force -ErrorAction SilentlyContinue }

    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $all) {
            if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) {
                [void]$ids.Add([int]$item.ProcessId)
                $changed = $true
            }
        }
    }
    $sum = 0
    $priv = 0
    $count = 0
    foreach ($item in $all) {
        if ($ids.Contains([int]$item.ProcessId)) {
            $sum += [int64]$item.WorkingSetSize
            $priv += [int64]$item.PrivatePageCount
            $count += 1
        }
    }
    return [pscustomobject]@{ Bytes = $sum; Priv = $priv; Count = $count; Mode = "cim" }
}

function Get-ProcessTreeByName {
    param([int]$RootId, [datetime]$StartedAt)
    $root = Get-Process -Id $RootId -ErrorAction SilentlyContinue
    if (-not $root) { return [pscustomobject]@{ Bytes = 0; Priv = 0; Count = 0; Mode = "name(已退出)" } }
    $names = @($root.ProcessName, "msedgewebview2", "node", "conhost", "evejs-updater", "EvEJSLauncher")
    $cutoff = $StartedAt.AddSeconds(-3)
    $matched = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        if ($_.Id -eq $RootId) { return $true }
        if ($names -notcontains $_.ProcessName) { return $false }
        try { $_.StartTime -ge $cutoff } catch { $false }
    })
    $sum = 0
    $priv = 0
    foreach ($item in $matched) { $sum += [int64]$item.WorkingSet64; $priv += [int64]$item.PrivateMemorySize64 }
    return [pscustomobject]@{ Bytes = $sum; Priv = $priv; Count = $matched.Count; Mode = "name" }
}

function Get-ProcessTree {
    param([int]$RootId, [datetime]$StartedAt)
    $exact = Get-ProcessTreeViaCim -RootId $RootId
    if ($null -ne $exact) { return $exact }
    return Get-ProcessTreeByName -RootId $RootId -StartedAt $StartedAt
}

Write-Host "测量目标：$Exe"
$samplePoints = ($SampleSeconds | Sort-Object)
# `pwsh -File s.ps1 -SampleSeconds 10,60` 会被参数绑定成**单个整数 1060**（-File 下数组绑定不生效），
# 采样点于是变成「17 分钟后」—— 表现为脚本像挂死、一个数都拿不出来（本机实测踩过）。
# 这里直接判上界：不合法就立刻失败，别静默睡过去。
$badPoints = @($samplePoints | Where-Object { $_ -le 0 -or $_ -gt 600 })
if ($samplePoints.Count -eq 0 -or $badPoints.Count -gt 0) {
    Write-Host ("采样点不合法：{0}（允许 1..600 秒）" -f ($samplePoints -join ", ")) -ForegroundColor Red
    Write-Host "  命令行用 -File 传多个采样点时数组绑定不生效（10,60 会变成 1060）：请用默认值，或从 PowerShell 内部以数组调用。" -ForegroundColor Yellow
    exit 4
}
Write-Host "标签：$Label    轮次：$Iterations    采样点：$($samplePoints -join ' s / ') s    主窗口标题：$WindowTitle"
if (-not [string]::IsNullOrWhiteSpace($UserDataDir)) {
    $resolvedUserData = [System.IO.Path]::GetFullPath($UserDataDir)
    New-Item -ItemType Directory -Force -Path $resolvedUserData | Out-Null
    $env:EVEJS_USER_DATA_DIR = $resolvedUserData
    Write-Host "运行时数据目录（隔离）：$resolvedUserData"
}
else {
    Remove-Item Env:\EVEJS_USER_DATA_DIR -ErrorAction SilentlyContinue
    Write-Host "运行时数据目录：未隔离（会读真实用户设置）" -ForegroundColor Yellow
}
Write-Host ""

$header = "{0,-6} {1,12}" -f "轮次", "启动(ms)"
foreach ($point in $samplePoints) { $header += ("{0,14}" -f ("内存 " + $point + "s(MB)")) }
foreach ($point in $samplePoints) { $header += ("{0,17}" -f ("私有 " + $point + "s(MB)")) }
$header += ("{0,8} {1,-10} {2,-6}" -f "进程数", "口径", "窗口")
Write-Host $header

$rows = @()
$treeMode = ""
for ($i = 1; $i -le $Iterations; $i++) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $startedAt = Get-Date
    $startArgs = @{ FilePath = $Exe; PassThru = $true }
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $startArgs["WorkingDirectory"] = $WorkingDirectory }
    if ($AppArguments.Count -gt 0) { $startArgs["ArgumentList"] = $AppArguments }
    $proc = Start-Process @startArgs

    # 找主窗口：标题精确匹配 + 拥有者进程的启动时间不早于本次启动（排除上一轮残留的同名窗口）。
    # 不能只认根 PID：便携版单 exe（NSIS）会把主窗口交给解压后另起的子进程。
    $windowPid = 0
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        Start-Sleep -Milliseconds 15
        foreach ($candidate in [WinScan]::FindPidsByTitle($WindowTitle)) {
            $owner = Get-Process -Id $candidate -ErrorAction SilentlyContinue
            if (-not $owner) { continue }
            try { $startedOk = $owner.StartTime -ge $startedAt.AddSeconds(-1) } catch { $startedOk = $false }
            if ($startedOk) { $windowPid = [int]$candidate; break }
        }
        if ($windowPid -ne 0) { break }
    }
    $proc.Refresh()
    $startupMs = if ($windowPid -ne 0) { [int]$watch.Elapsed.TotalMilliseconds } else { -1 }

    # 进程树锚点：根进程还活着就用根（覆盖全部子进程）；根已退出（便携版包装）改用窗口拥有者
    $treeRootId = if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) { $proc.Id } elseif ($windowPid -ne 0) { $windowPid } else { $proc.Id }
    $samples = @{}
    $privs = @{}
    $procs = 0
    foreach ($point in $samplePoints) {
        $elapsed = [math]::Floor($watch.Elapsed.TotalSeconds)
        if ($point -gt $elapsed) { Start-Sleep -Seconds ($point - $elapsed) }
        $tree = Get-ProcessTree -RootId $treeRootId -StartedAt $startedAt
        $samples[$point] = [math]::Round($tree.Bytes / 1MB, 1)
        $privs[$point] = [math]::Round($tree.Priv / 1MB, 1)
        $procs = $tree.Count
        $treeMode = $tree.Mode
    }

    $windowOwner = if ($windowPid -eq 0) { "-" } elseif ($windowPid -eq $proc.Id) { "root" } else { "child" }
    $line = "{0,-6} {1,12}" -f $i, $startupMs
    foreach ($point in $samplePoints) { $line += ("{0,14}" -f $samples[$point]) }
    foreach ($point in $samplePoints) { $line += ("{0,17}" -f $privs[$point]) }
    $line += ("{0,8} {1,-10} {2,-6}" -f $procs, $treeMode, $windowOwner)
    Write-Host $line
    $rows += [pscustomobject]@{ Run = $i; StartupMs = $startupMs; Samples = $samples; Privs = $privs; Procs = $procs; WindowPid = $windowPid; WindowOwner = $windowOwner }

    taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    if ($windowPid -ne 0 -and $windowPid -ne $proc.Id) { taskkill /PID $windowPid /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 3
}

$valid = $rows | Where-Object { $_.StartupMs -ge 0 }
if ($valid.Count -eq 0) {
    Write-Warning ("未观察到标题为 '" + $WindowTitle + "' 的可见主窗口：确认 exe 能正常启动、-WindowTitle 与真实标题一致，或调大 -TimeoutSeconds")
    exit 2
}

$avgStartup = [math]::Round(($valid | Measure-Object StartupMs -Average).Average, 0)
$minStartup = ($valid | Measure-Object StartupMs -Minimum).Minimum
$maxStartup = ($valid | Measure-Object StartupMs -Maximum).Maximum
Write-Host ""
$summary = "[{0}] 平均启动 {1} ms（最小 {2} / 最大 {3}）" -f $Label, $avgStartup, $minStartup, $maxStartup
foreach ($point in $samplePoints) {
    $avg = [math]::Round((($rows | ForEach-Object { $_.Samples[$point] }) | Measure-Object -Average).Average, 1)
    $summary += (" / 平均内存@$($point)s {0} MB" -f $avg)
}
foreach ($point in $samplePoints) {
    $avgPriv = [math]::Round((($rows | ForEach-Object { $_.Privs[$point] }) | Measure-Object -Average).Average, 1)
    $summary += (" / 平均私有@$($point)s {0} MB" -f $avgPriv)
}
Write-Host $summary
Write-Host ("进程树口径：{0}（cim = 真父子关系；name = 同名 + 启动时间的近似）" -f $treeMode)

if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $cells = ""
    foreach ($point in $samplePoints) {
        $avg = [math]::Round((($rows | ForEach-Object { $_.Samples[$point] }) | Measure-Object -Average).Average, 1)
        $cells += " $avg |"
    }
    foreach ($point in $samplePoints) {
        $avgPriv = [math]::Round((($rows | ForEach-Object { $_.Privs[$point] }) | Measure-Object -Average).Average, 1)
        $cells += " $avgPriv |"
    }
    Add-Content -LiteralPath $OutFile -Value "| $stamp | $Label | $avgStartup |$cells $($rows[0].Procs) |" -Encoding UTF8
    Write-Host "已追加到 $OutFile"
}

if (-not [string]::IsNullOrWhiteSpace($JsonOut)) {
    $jsonPath = [System.IO.Path]::GetFullPath($JsonOut)
    $jsonDir = Split-Path -Parent $jsonPath
    if ($jsonDir -and -not (Test-Path -LiteralPath $jsonDir)) { New-Item -ItemType Directory -Path $jsonDir -Force | Out-Null }
    # ConvertTo-Json 不接受「非字符串键的字典」，所以内存采样要转成字符串键
    $jsonRows = @()
    foreach ($row in $rows) {
        $memory = @{}
        foreach ($point in $samplePoints) { $memory["mem${point}sMB"] = $row.Samples[$point] }
        foreach ($point in $samplePoints) { $memory["priv${point}sMB"] = $row.Privs[$point] }
        $jsonRows += [pscustomobject]@{
            run         = $row.Run
            startupMs   = $row.StartupMs
            procs       = $row.Procs
            windowPid   = $row.WindowPid
            windowOwner = $row.WindowOwner
            memory      = $memory
        }
    }
    $payload = [pscustomobject]@{
        label            = $Label
        exe              = [System.IO.Path]::GetFullPath($Exe)
        windowTitle      = $WindowTitle
        workingDirectory = $WorkingDirectory
        userDataDir      = "$env:EVEJS_USER_DATA_DIR"
        iterations       = $Iterations
        sampleSeconds    = @($samplePoints)
        treeMode         = $treeMode
        avgStartupMs     = $avgStartup
        minStartupMs     = $minStartup
        maxStartupMs     = $maxStartup
        rows             = $jsonRows
    }
    [System.IO.File]::WriteAllText($jsonPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已写出机器可读结果 $jsonPath"
}