<#
便携版打包（S4 / G4）。

产物（全部落在 artifacts/，已 gitignore）：
  1) EvEJSLauncher-Tauri-<version>/            便携版目录（exe + _launcher/cli + _launcher/updater + 说明）
  2) EvEJSLauncher-Tauri-<version>-portable.zip  绿色版压缩包（给想要「目录版」的人）
  3) update-manifest.json                        自更新清单（指向单文件 exe，可 -SignKey 签名）
  4) EvEJSLauncher-Tauri-<version>-setup.exe     NSIS 安装包（-Nsis 时；由 tauri CLI 产出后改名）

用法：
  pwsh -File scripts/package.ps1                 # release 构建 + 便携版 + 清单
  pwsh -File scripts/package.ps1 -SkipBuild      # 复用已有产物（迭代打包用）
  pwsh -File scripts/package.ps1 -Nsis           # 额外出 NSIS 安装包
  pwsh -File scripts/package.ps1 -SignKey .keys/update-key.pem -KeyId evejs-release-2026-09-28
#>
param(
    [switch]$SkipBuild,
    [switch]$Nsis,
    [string]$SignKey = "",
    [string]$KeyId = "",
    [string]$UrlBase = "",
    [string]$NotesZh = "",
    [string]$NotesEn = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

# 与 build.ps1 同一套规避：rustup 垫片解析 rust-toolchain.toml 会在本机挂死，
# 直接用已安装的工具链目录（tauri CLI 内部也会调 cargo，所以这条必须在 npx 之前生效）。
$toolchainBin = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
if (Test-Path $toolchainBin) {
    $env:PATH = "$toolchainBin;$env:PATH"
    $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
}

try {
    $version = (node -p "require('./package.json').version").Trim()
    node scripts/sync-version.mjs | Out-Null
    Write-Host "打包版本：$version" -ForegroundColor Cyan

    if (-not $SkipBuild) {
        & pwsh -File scripts/build.ps1
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 失败（退出码 $LASTEXITCODE）" }
    }

    $releaseDir = Join-Path $root "src-tauri\target\release"
    $exe = Join-Path $releaseDir "EvEJSLauncher.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 release 产物：$exe（先跑 build.ps1）" }
    foreach ($required in @("_launcher\cli\account-cli.js", "_launcher\cli\database-cli.js", "_launcher\updater\evejs-updater.exe")) {
        if (-not (Test-Path -LiteralPath (Join-Path $releaseDir $required))) {
            throw "缺少随包资源：$required（build.ps1 的第 7/8 步负责拷贝）"
        }
    }

    $artifacts = Join-Path $root "artifacts"
    $stageName = "EvEJSLauncher-Tauri-$version"
    $stage = Join-Path $artifacts $stageName
    if (Test-Path -LiteralPath $stage) { [System.IO.Directory]::Delete($stage, $true) }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage "EvEJSLauncher.exe")
    # 只搬「构建产物」，**不搬运行态**（2026-09-26 修）。
    # `target/release/_launcher` 在跑过自检/parity/e2e/演练之后会多出这些东西：
    #   data/author.json + data/mod-keys/*.key  —— 模组作者身份与本机私钥（DPAPI 密文）；
    #       `author.rs:5` 明确写着「只落在 _launcher/data/mod-keys/，永不上传、永不打包」，
    #       而原来的整目录拷贝正好违反了这条不变量。
    #   data/launcher-settings.json —— 含窗口位置（用户会继承测试窗口位置），还可能含账号凭据密文；
    #   cache/mod-index.json       —— 市场索引 TTL 缓存（会让用户首启读到过期索引，而不是自己拉一次）；
    #   crash/ logs/ temp/         —— 运行目录。
    # 它们都是每台机器**首次运行时由应用自己创建**的，所以白名单只放构建产出的 cli / updater。
    foreach ($part in @("cli", "updater")) {
        $from = Join-Path $releaseDir "_launcher\$part"
        if (-not (Test-Path -LiteralPath $from)) { throw "缺少随包资源：_launcher\$part（build.ps1 第 8/9 步负责生成）" }
        $target = Join-Path $stage "_launcher\$part"
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        # 这里必须用 -Path（支持通配符）：-LiteralPath 不会展开 "*"，会报 path not exist
        Copy-Item -Path (Join-Path $from "*") -Destination $target -Recurse -Force
    }
    # 防回归：暂存目录里出现任何运行态目录都算打包失败（这批文件一旦发出去就收不回来）
    foreach ($banned in @("data", "cache", "crash", "logs", "temp", "mods")) {
        $suspect = Join-Path $stage "_launcher\$banned"
        if (Test-Path -LiteralPath $suspect) {
            throw "打包产物里混进了运行态目录：_launcher\$banned（白名单只允许 cli / updater；见 package.ps1 注释）"
        }
    }

    $readme = @"
EvEJS 启动器（Tauri 2 便携版）v$version
================================================

怎么用
------
1. 解压到任意目录（路径不要带特殊符号），双击 EvEJSLauncher.exe。
2. 首次使用请把启动器放到你的 EvEJS 服务端根目录旁边（目录里有 server/ 与 config/），
   或在启动器里设置仓库根目录。
3. 目录结构（不要只拷 exe，_launcher 必须一起拷）：
     EvEJSLauncher.exe
     _launcher\cli\account-cli.js        账号 / 数据库 CLI（服务端依赖 Node）
     _launcher\updater\evejs-updater.exe 自更新器（替换 exe 后自动重启）

环境要求
--------
- Windows 10 1809+ / Windows 11，64 位。
- 需要 Microsoft Edge WebView2 运行时（Win11 与较新的 Win10 已内置）。
  若提示缺少 WebView2：启动器会弹出中文指引，联网时点「是」打开官方下载页；
  离线时请先在别的机器下载 MicrosoftEdgeWebview2Setup.exe 拷过来安装。
- 服务端功能需要系统已装 Node.js（与现役 Electron 版一致）。

体积与安全
----------
- 主程序约 9.2 MB（现役 Electron 便携版约 73 MB）。
- 自更新只接受用内置维护者公钥签名过的清单（Ed25519）；未配置公钥时更新功能整体关闭。
"@
    Set-Content -LiteralPath (Join-Path $stage "README-便携版.txt") -Value $readme -Encoding UTF8

    $zip = Join-Path $artifacts "$stageName-portable.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
    Write-Host ("便携版：{0}（{1:N2} MB）" -f $zip, ((Get-Item $zip).Length / 1MB)) -ForegroundColor Green

    # 自更新资产必须是**单文件 exe**：清单的 url / sha256 / size 要指向发布时上传的那一个文件。
    # 指向 zip 的话，自更新器会把 zip 当 exe 去替换（现役 Electron 0.1.28 只核 sha256、不认 zip，
    # 这里的口径跟它保持一致才安全）。
    $manifestArgs = @("scripts/make-manifest.mjs", "--asset", (Join-Path $stage "EvEJSLauncher.exe"), "--version", $version)
    if ($UrlBase) { $manifestArgs += @("--url-base", $UrlBase) }
    if ($NotesZh) { $manifestArgs += @("--notes-zh", $NotesZh) }
    if ($NotesEn) { $manifestArgs += @("--notes-en", $NotesEn) }
    node @manifestArgs
    if ($LASTEXITCODE -ne 0) { throw "生成 update-manifest.json 失败" }
    $manifest = Join-Path $artifacts "update-manifest.json"

    # S4：出包后立刻用同一门禁复检（zip 此时已存在，缺失或超预算都算失败）
    node scripts/size-gate.mjs --require-zip
    if ($LASTEXITCODE -ne 0) { throw "体积门禁未通过（见上）" }

    if ($SignKey) {
        $signArgs = @("scripts/gen-update-key.mjs", "--sign", $manifest, "--key", $SignKey, "--out", $manifest)
        if ($KeyId) { $signArgs += @("--key-id", $KeyId) }
        node @signArgs
        if ($LASTEXITCODE -ne 0) { throw "签名 update-manifest.json 失败" }
        Write-Host "update-manifest.json 已签名" -ForegroundColor Green
    }
    else {
        Write-Host "提示：manifest 未签名（发布前用 -SignKey <私钥.pem> 签一次）" -ForegroundColor Yellow
    }

    if ($Nsis) {
        Write-Host "构建 NSIS 安装包（npx @tauri-apps/cli）…" -ForegroundColor Cyan
        Push-Location src-tauri
        try {
            npx --yes "@tauri-apps/cli@^2" build --bundles nsis
            if ($LASTEXITCODE -ne 0) { throw "tauri CLI 打包失败（退出码 $LASTEXITCODE）" }
        }
        finally { Pop-Location }
        $nsisDir = Join-Path $releaseDir "bundle\nsis"
        $setup = Get-ChildItem -LiteralPath $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $setup) { throw "没找到 NSIS 产物：$nsisDir" }
        $target = Join-Path $artifacts "$stageName-setup.exe"
        Copy-Item -LiteralPath $setup.FullName -Destination $target -Force
        Write-Host ("安装包：{0}（{1:N2} MB）" -f $target, ((Get-Item $target).Length / 1MB)) -ForegroundColor Green

        # tauri CLI 会「就地」给 target/release 的 exe 打上 nsis bundle 标记（体积与哈希都会变），
        # 于是它不再等同于干净的便携版。这里用已暂存的副本还原，保证便携版口径与
        # size-gate 的度量一致；安装包本体另存在 src-tauri/target/release/bundle/nsis。
        Copy-Item -LiteralPath (Join-Path $stage "EvEJSLauncher.exe") -Destination $exe -Force
        Write-Host "已还原干净的便携版 exe（target/release）" -ForegroundColor DarkGray
    }

    Write-Host ""
    # 发布护栏（S7 §2.1 实测结论）：现役 Electron 0.1.28 的默认清单地址与新外壳**完全相同**
    # （都是 <repo>/releases/latest/download/update-manifest.json），而旧版更新器只核 sha256、不认 zip，
    # 它会把下载到的包当成 exe 去替换 —— 把这个 zip 发到 releases/latest 等于静默毁掉现役用户的启动器。
    Write-Host "⚠️ 发布护栏：不要把 update-manifest.json + 便携 zip 发到 releases/latest。" -ForegroundColor Yellow
    Write-Host "   旧版 Electron（0.1.28）读的是同一个 latest 地址且不认 zip，会把 zip 当 exe 替换。" -ForegroundColor Yellow
    Write-Host "   双轨方案（stable tag / 第二仓库）与一次性动作清单见 docs/S7-发布与回滚-实施记录.md §2。" -ForegroundColor Yellow

    Write-Host ""
    Write-Host "打包完成，产物清单：" -ForegroundColor Green
    Get-ChildItem -LiteralPath $artifacts | Sort-Object Name | ForEach-Object {
        $kind = if ($_.PSIsContainer) { "DIR " } else { "FILE" }
        $sizeMb = if ($_.PSIsContainer) { 0 } else { $_.Length / 1MB }
        Write-Host ("  [{0}] {1,-46} {2,10:N2} MB" -f $kind, $_.Name, $sizeMb)
    }
}
finally {
    Pop-Location
}