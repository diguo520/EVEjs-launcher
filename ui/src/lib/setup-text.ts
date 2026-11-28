import { t } from "@/lib/i18n"

/**
 * 服务端脚本（SetupPreflight.ps1 / Setup-EvEJS.ps1）输出的是英文详情。
 * 这里把已知的英文原文映射成中文源 key，再交给 `t()` 翻到当前语言；
 * 不认识的文本原样返回（英文兜底，不会显示 key）。
 */
const DEPLOY_DETAILS: Record<string, string> = {
  "Node.js is not available yet": "Node.js 尚未可用",
  "Setup packages match the lockfile": "安装包与锁文件一致",
  "Setup packages are missing or the lockfile changed": "安装包缺失或锁文件已变化",
  "configure an EveJS client copy first": "请先配置一份 EveJS 客户端副本",
  "CA rotation required: missing, expired or unconstrained per-install CA":
    "需要轮换 CA：缺少、过期或未约束的每次安装 CA",
  "the local certificate authority has not been created yet": "本地证书颁发机构（CA）尚未创建",
  "the chat (XMPP) certificate is missing or was not signed by the local CA":
    "聊天（XMPP）证书缺失，或未由本地 CA 签发",
  "the loopback or DNS gateway certificate is missing or out of date":
    "回环或 DNS 网关证书缺失或已过期",
  "static game data needs to be generated": "需要生成静态游戏数据",
  "the runtime game database has not been created yet": "运行时游戏数据库尚未创建",
  "moon composition pack has not been generated yet": "月球产物包尚未生成",
  "market.sqlite is built": "market.sqlite 已构建",
  "not built (optional -- you can log in and play without it)":
    "未构建（可选——没有它也能登录并游玩）",
  "no market database -- the server cannot start without one":
    "没有市场数据库——缺少它服务端无法启动",
  "Rust and Microsoft C++ Build Tools were found.": "已找到 Rust 与 Microsoft C++ 生成工具。",
  "Install Rust, Microsoft C++ Build Tools, and a Windows SDK. Then recheck, or select No standalone market.":
    "请安装 Rust、Microsoft C++ 生成工具和 Windows SDK，然后重新检查，或选择「无独立市场」。",
  "Setup will offer to install Rust and the Microsoft C++ build tools.":
    "安装时会提示安装 Rust 与 Microsoft C++ 生成工具。",
  "The Rust and C++ tools installer is missing. Restore tools\\InstallRustForMarket.bat or use -SkipMarket.":
    "Rust 与 C++ 工具安装器缺失。请恢复 tools\\InstallRustForMarket.bat，或使用 -SkipMarket。",
  "Could not reach the archive from this terminal. First setup needs access to developers.eveonline.com or a cached archive.":
    "此终端无法访问该归档。首次安装需要访问 developers.eveonline.com 或使用已缓存的归档。",
  "Install 64-bit Python 3.10 or later, reopen the setup wizard, and recheck.":
    "请安装 64 位 Python 3.10 或更高版本，重新打开安装向导并重新检查。",
  "Install Windows Node.js and npm to extract records on this PC, or supply an export in the configured records folder.":
    "请在此电脑上安装 Windows 版 Node.js 与 npm 以提取记录，或在配置的记录目录中提供导出。",
  "game data in the evejs-data volume needs setup": "evejs-data 卷中的游戏数据需要初始化",
  "the Compose init image is available": "Compose 初始化镜像可用",
  "Compose will build the image from these release files, reusing cached layers":
    "Compose 将使用这些发布文件构建镜像，并复用缓存层",
  "market and server are healthy": "市场与服务端运行正常",
  "the containers are not running or not healthy yet": "容器尚未运行或尚未就绪",
  "a valid CA is not yet available to the Docker server": "Docker 服务端尚无有效的 CA",
}

/** 把服务端英文详情 / 进度消息翻成当前语言；不认识的原文原样返回。 */
export function setupText(raw: string): string {
  const original = raw.trim()
  if (!original) return ""
  const text = original.replace(/\s+/g, " ")
  const exact = DEPLOY_DETAILS[text]
  if (exact) return t(exact)

  let m: RegExpMatchArray | null
  if ((m = text.match(/^Node\.js (v[\d.]+), npm ([\d.]+)$/))) {
    return t("Node.js {node}，npm {npm}", { node: m[1], npm: m[2] })
  }
  if ((m = text.match(/^Python is available to extract build (\d+) records\.$/))) {
    return t("Python 可用，可提取 build {build} 的游戏记录。", { build: m[1] })
  }
  if ((m = text.match(/^Found an export for build (\d+) in (.+?)\.$/))) {
    return t("在 {path} 找到 build {build} 的导出。", { build: m[1], path: m[2] })
  }
  if ((m = text.match(/^Use an EVE cache for build (\d+) to generate client records\.$/))) {
    return t("请使用 build {build} 的 EVE 缓存来生成客户端记录。", { build: m[1] })
  }
  if (
    (m = text.match(
      /^Game data generation requires an export for EVE build (\d+) in (.+?)\. See Manual Docker setup or Command-line setup in doc\\SETUP\.md\.$/
    ))
  ) {
    return t(
      "生成游戏数据需要 build {build} 的导出（位于 {path}）。参见 doc\\SETUP.md 中的手动 Docker 安装或命令行安装。",
      { build: m[1], path: m[2] }
    )
  }
  if ((m = text.match(/^Local ports ([0-9, ]+)(?:\..*)?$/))) {
    return t("本地端口 {ports}", { ports: m[1].trim() })
  }
  if ((m = text.match(/^Invalid listener port '(.+)'\. Check the server and Compose settings\.$/))) {
    return t("监听端口「{port}」无效。请检查服务端与 Compose 设置。", { port: m[1] })
  }
  if ((m = text.match(/^More than one service is configured for port\(s\) (.+)\.$/))) {
    return t("多个服务配置了相同端口：{ports}。", { ports: m[1] })
  }
  if (
    (m = text.match(
      /^Required ports are in use: (.+?)\. Free them or change the supported configurable ports, then retry\.$/
    ))
  ) {
    return t("所需端口已被占用：{ports}。请释放端口或修改支持的可配置端口后重试。", {
      ports: m[1],
    })
  }
  if ((m = text.match(/^The saved game cannot be checked: (.+)$/))) {
    return t("无法检查存档：{reason}", { reason: m[1] })
  }
  if (
    (m = text.match(
      /^Downloading the market snapshot \(~(.+?)\)\. If it does not change for a while, the network may be stuck\.$/
    ))
  ) {
    return t("正在下载市场快照（约 {size}）…长时间没有变化说明网络可能被卡住", {
      size: m[1],
    })
  }
  if ((m = text.match(/^Downloading the market snapshot (\d+)% \((.+?)\)\.$/))) {
    return t("正在下载市场快照 {percent}%（{progress}）", {
      percent: m[1],
      progress: m[2],
    })
  }
  if (
    (m = text.match(
      /^Market snapshot download stalled at (\d+)% \((.+?)\); no change for over a minute, the network may be stuck\.$/
    ))
  ) {
    return t("市场快照下载停滞在 {percent}%（{progress}）；超过 1 分钟没有变化，网络可能被卡住", {
      percent: m[1],
      progress: m[2],
    })
  }
  if ((m = text.match(/^Found Node\.js '(.+)'\. Setup requires Node\.js 26 LTS \(26\.13\.1 or later\)\. (.+)$/))) {
    return t("检测到 Node.js {version}；安装需要 Node.js 26 LTS（26.13.1 或更高）。{hint}", {
      version: m[1],
      hint: m[2],
    })
  }
  if (
    (m = text.match(
      /Client identity gate: refusing this install\. (.+?) must contain server = 127\.0\.0\.1/
    ))
  ) {
    return t(
      "这个目录不是已准备的 EVE 副本：{ini} 里缺少 server = 127.0.0.1 和 cryptoPack = Placebo。请不要使用正在运行的原始 EVE 客户端；先复制一份客户端，再安装。",
      { ini: m[1] }
    )
  }
  if (
    (m = text.match(
      /Client identity gate: missing (.+?)\. Run the EveJS client setup on a separate client copy\./
    ))
  ) {
    return t("这个目录不是已准备的 EVE 副本：缺少 {path}。请在一份单独的客户端副本上运行 EveJS 客户端安装。", {
      path: m[1],
    })
  }
  if (text.startsWith("Client identity gate: configure ")) {
    return t("还没有配置客户端路径：请先在配置面板填写 EVEJS_CLIENT_PATH（要指到 ...\\tq）。")
  }
  // 中文源 key（Rust 侧消息）交给 t()；未命中的英文原文（保留换行）原样返回
  return t(original)
}
