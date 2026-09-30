#!/usr/bin/env node
/**
 * 发布通道工具（S7 §2.2 方案 #2「固定 tag」）——把 Tauri 通道与老 Electron 通道彻底隔开。
 *
 * 背景（S7 §2.1 实测）：现役 Electron 0.1.28 的默认清单地址
 *   https://github.com/<repo>/releases/latest/download/update-manifest.json
 * 与本外壳原本**完全相同**，而旧更新器只核 sha256、**不认 zip**：`releases/latest`
 * 一旦指向 Tauri 的便携 zip 清单，老更新器会把 zip 当 exe 替换主程序 → 用户启动器报废。
 *
 * 双轨因此定成：
 *   · Tauri 侧读 `.../releases/download/stable/update-manifest.json`（见 updater.rs 的
 *     DEFAULT_MANIFEST_URL，本脚本负责把新清单推到这个滚动 `stable` release）；
 *   · `releases/latest` 由本脚本钉在旧 Electron 通道（默认 `v0.1.28`），永远不再指向 Tauri。
 *
 * 用法：
 *   node scripts/release-channel.mjs status                       # 看当前双轨状态
 *   node scripts/release-channel.mjs publish --version 0.2.6      # 发版后推 stable 清单
 *   node scripts/release-channel.mjs verify  --version 0.2.6      # 核对 stable 与 latest 隔离
 *   node scripts/release-channel.mjs pin-legacy --tag v0.1.28     # 把 releases/latest 钉到旧通道
 *
 * 令牌：`--token` → `GH_TOKEN` / `GITHUB_TOKEN` → `git credential fill`（github.com）。
 * 提示：本机 Node 若有 TLS 代理，跑之前加 `--use-system-ca`（例 `node --use-system-ca ...`）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function value(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const STABLE_TAG = "stable";
const DEFAULT_REPO = "diguo520/EVEjs-launcher";
const DEFAULT_LEGACY_TAG = "v0.1.28";
const CHANNEL_ASSET = "update-manifest.json";
const API = "https://api.github.com";

const REPO = (() => {
  const explicit = value("--repo");
  if (explicit) return explicit;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    /* 没有远端就用默认仓库 */
  }
  return DEFAULT_REPO;
})();

const ok = (text) => console.log("  \u2713 " + text);
const info = (text) => console.log("  · " + text);
const warn = (text) => console.log("  ! " + text);
function fail(text) {
  console.error("  \u2717 " + text);
  process.exit(1);
}

function readToken() {
  const explicit = value("--token") ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      cwd: ROOT,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const match = out.match(/^password=(.+)$/m);
    if (match && match[1].trim()) return match[1].trim();
  } catch {
    /* 落到下面的报错 */
  }
  return fail("没有 GitHub 令牌：传 --token、设 GH_TOKEN，或先让 git 存好 github.com 的凭据");
}

let TOKEN = "";

async function gh(method, endpoint, body) {
  const url = endpoint.startsWith("http") ? endpoint : API + endpoint;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      "User-Agent": "evejs-release-channel",
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function downloadAssetBuffer(apiAssetUrl) {
  const response = await fetch(apiAssetUrl, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      "User-Agent": "evejs-release-channel",
      Accept: "application/octet-stream",
    },
  });
  if (!response.ok) throw new Error(`下载资产失败：${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function uploadAsset(releaseId, name, filePath) {
  const buffer = fs.readFileSync(filePath);
  const response = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN,
        "User-Agent": "evejs-release-channel",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.length),
      },
      body: buffer,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`上传 ${name} 失败：${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** 用内置维护者公钥验签（复用发版签名工具，避免在这里重写一套规范化逻辑）。 */
function isSignedByUs(manifestPath) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/gen-update-key.mjs"), "--verify", manifestPath], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function localManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    fail(`找不到清单：${manifestPath}（先跑 pwsh -File scripts/package.ps1）`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

const win32 = (manifest) => manifest?.platforms?.["win32-x64"] ?? null;

/** 比对线上清单与本地产物：版本 + 资产 pin（sha256/size）都要一致。 */
function assertMatchesLocal(remote, local, expectedVersion, label) {
  if (!remote) fail(`${label} 读不到清单`);
  if (remote.version !== expectedVersion) {
    fail(`${label} 版本是 ${remote.version}，期望 ${expectedVersion}`);
  }
  const remotePin = win32(remote);
  const localPin = win32(local);
  if (!remotePin || !localPin) fail(`${label} 缺少 platforms["win32-x64"]`);
  if (remotePin.sha256 !== localPin.sha256 || remotePin.size !== localPin.size) {
    fail(
      `${label} 的 pin 与本地不一致：\n      线上 ${remotePin.sha256} (${remotePin.size})\n      本地 ${localPin.sha256} (${localPin.size})`,
    );
  }
  ok(`${label} = ${remote.version}，pin 与本地产物一致（${String(localPin.sha256).slice(0, 16)}…, ${localPin.size} 字节）`);
}

async function fetchChannelManifest() {
  const release = await gh("GET", `/repos/${REPO}/releases/tags/${STABLE_TAG}`);
  if (!release) fail(`远端还没有 \`${STABLE_TAG}\` release：先跑 publish（或让它自己建）`);
  const asset = (release.assets || []).find((item) => item.name === CHANNEL_ASSET);
  if (!asset) fail(`\`${STABLE_TAG}\` release 里没有 ${CHANNEL_ASSET}`);
  return JSON.parse((await downloadAssetBuffer(asset.url)).toString("utf8"));
}

/**
 * 隔离的核心断言：`releases/latest` 下发的东西**不能**是我们签名过的清单。
 * 旧 Electron 只核 sha256，所以它读到自家清单最安全；而新外壳 fail closed，
 * 读到旧清单只会「检查更新失败」，绝不会把 Electron 的 exe 装到自己身上。
 */
async function assertLatestIsNotOurs() {
  const latest = await gh("GET", `/repos/${REPO}/releases/latest`);
  if (!latest) fail("读不到 releases/latest");
  info(`releases/latest = ${latest.tag_name}（draft=${latest.draft} prerelease=${latest.prerelease}）`);

  const asset = (latest.assets || []).find((item) => item.name === CHANNEL_ASSET);
  if (!asset) {
    ok("latest 没有 update-manifest.json → 旧更新器 404 拿到空结果，不会误装");
    return;
  }
  const tmpPath = path.join(ROOT, ".parity-out", "latest-manifest.json");
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  fs.writeFileSync(tmpPath, await downloadAssetBuffer(asset.url));

  if (isSignedByUs(tmpPath)) {
    fail(
      `releases/latest（${latest.tag_name}）正在下发**我们签名过的**清单 —— 旧 Electron 用户会被替换成 Tauri 产物。\n` +
        `    立即跑：node scripts/release-channel.mjs pin-legacy --tag ${DEFAULT_LEGACY_TAG}`,
    );
  }
  ok(`latest（${latest.tag_name}）下发的清单不是我们签的 → 双轨安全（新外壳会拒绝，旧更新器只认自家通道）`);
}

async function ensureStableRelease() {
  const existing = await gh("GET", `/repos/${REPO}/releases/tags/${STABLE_TAG}`);
  if (existing) {
    info(`已存在 \`${STABLE_TAG}\` release（id ${existing.id}）`);
    return existing;
  }
  info(`创建 \`${STABLE_TAG}\` release（make_latest=false，绝不抢 releases/latest）`);
  const created = await gh("POST", `/repos/${REPO}/releases`, {
    tag_name: STABLE_TAG,
    target_commitish: value("--target", "main"),
    name: "stable 通道清单 / stable channel manifest",
    body:
      "这个 release 只承载**滚动的新框架自更新清单**（`update-manifest.json`），不提供二进制下载。\n\n" +
      "· 新框架启动器固定读 `releases/download/stable/update-manifest.json`；\n" +
      "· 真正的下载包请到对应版本号（`v0.2.x`）的 release 取，清单里的链接也指向那里；\n" +
      "· `releases/latest` 被刻意钉在旧 Electron 通道，**不指向这里**（否则老用户会被误伤）。\n\n" +
      "This release only carries the rolling manifest for the new (Tauri) launcher channel. " +
      "Grab the actual downloads from the versioned `v0.2.x` releases.",
    draft: false,
    prerelease: false,
    make_latest: "false",
  });
  return created;
}

async function replaceChannelAsset(releaseId, filePath) {
  const assets = await gh("GET", `/repos/${REPO}/releases/${releaseId}/assets`);
  for (const asset of (assets || []).filter((item) => item.name === CHANNEL_ASSET)) {
    await gh("DELETE", `/repos/${REPO}/releases/assets/${asset.id}`);
    info(`已删除旧 ${CHANNEL_ASSET}（asset ${asset.id}）`);
  }
  const uploaded = await uploadAsset(releaseId, CHANNEL_ASSET, filePath);
  info(`已上传新 ${CHANNEL_ASSET}（${uploaded.size} 字节）`);
}

/** 把 `stable` tag 移到 v<version> 指向的提交（面子上让通道 tag 贴着已发布的代码）。 */
async function moveStableTag(version) {
  const ref = await gh("GET", `/repos/${REPO}/git/ref/tags/v${version}`);
  if (!ref) {
    warn(`找不到 tag v${version}，跳过 ${STABLE_TAG} tag 移动`);
    return;
  }
  let sha = ref.object.sha;
  if (ref.object.type === "tag") {
    const annotated = await gh("GET", `/repos/${REPO}/git/tags/${sha}`);
    sha = annotated.object.sha;
  }
  await gh("PATCH", `/repos/${REPO}/git/refs/tags/${STABLE_TAG}`, { sha, force: true });
  info(`${STABLE_TAG} tag -> ${sha.slice(0, 7)}（跟随 v${version}）`);
}

async function publish() {
  const manifestPath = path.resolve(value("--manifest", path.join(ROOT, "artifacts/update-manifest.json")));
  const local = localManifest(manifestPath);
  const version = value("--version", local.version);
  if (local.version !== version) fail(`清单版本 ${local.version} 与 --version ${version} 不一致`);

  if (!isSignedByUs(manifestPath)) {
    fail(`清单没过内置公钥验签，拒绝推到 stable 通道（先跑 gen-update-key --sign）`);
  }
  ok(`本地清单已验签：v${version}`);

  if (flag("--dry-run")) {
    warn("--dry-run：只做本地校验，不碰远端");
    return;
  }

  const release = await ensureStableRelease();
  await replaceChannelAsset(release.id, manifestPath);
  await moveStableTag(version);

  console.log("");
  await assertLatestIsNotOurs();
  await verifyChannel(version, local, manifestPath);
}

async function verifyChannel(version, local, manifestPath) {
  const remote = await fetchChannelManifest();
  assertMatchesLocal(remote, local, version, "stable 通道清单");
  if (!isSignedByUs(manifestPath)) fail("本地清单验签失败");
}

async function verify() {
  const manifestPath = path.resolve(value("--manifest", path.join(ROOT, "artifacts/update-manifest.json")));
  const local = localManifest(manifestPath);
  const version = value("--version", local.version);
  await verifyChannel(version, local, manifestPath);
  console.log("");
  await assertLatestIsNotOurs();
  console.log("");
  ok("通道隔离核对通过：stable 通道 = 新外壳，releases/latest = 旧 Electron 通道");
}

async function pinLegacy() {
  const tag = value("--tag", DEFAULT_LEGACY_TAG);
  const release = await gh("GET", `/repos/${REPO}/releases/tags/${tag}`);
  if (!release) fail(`找不到旧通道 release：${tag}`);
  if (isOursByManifest(release)) {
    fail(`${tag} 看起来是 Tauri 通道的 release，拒绝把 releases/latest 钉到它上面`);
  }
  await gh("PATCH", `/repos/${REPO}/releases/${release.id}`, { make_latest: "true" });
  ok(`releases/latest 已钉到 ${tag}`);

  const latest = await gh("GET", `/repos/${REPO}/releases/latest`);
  if (latest?.tag_name !== tag) fail(`钉完 latest 却是 ${latest?.tag_name}`);
  console.log("");
  await assertLatestIsNotOurs();
}

/** 粗判：release 的资产名像不像 Tauri 通道（有 EvEJSLauncher.exe / portable zip）。 */
function isOursByManifest(release) {
  const names = (release.assets || []).map((item) => item.name);
  return names.some((name) => /^EvEJSLauncher(\.exe|-Tauri-)/i.test(name));
}

async function status() {
  const latest = await gh("GET", `/repos/${REPO}/releases/latest`);
  info(`releases/latest = ${latest?.tag_name ?? "(none)"}`);
  const stable = await gh("GET", `/repos/${REPO}/releases/tags/${STABLE_TAG}`);
  if (!stable) {
    warn("还没有 stable release —— 跑 publish 建立");
  } else {
    const asset = (stable.assets || []).find((item) => item.name === CHANNEL_ASSET);
    info(`stable release id ${stable.id}，清单资产 ${asset ? asset.size + " 字节" : "缺失"}`);
    if (asset) {
      const manifest = JSON.parse((await downloadAssetBuffer(asset.url)).toString("utf8"));
      info(`stable 通道清单版本 = ${manifest.version}`);
    }
  }
  console.log("");
  await assertLatestIsNotOurs();
}

/** 取出位置参数（跳过选项与它们的值），只认白名单子命令：否则 `--version 0.2.6` 的值会被当成子命令。 */
const VALUE_OPTIONS = new Set(["--version", "--manifest", "--token", "--tag", "--repo", "--target"]);
function positionals(list) {
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (VALUE_OPTIONS.has(item)) {
      index += 1;
      continue;
    }
    if (item.startsWith("-")) continue;
    out.push(item);
  }
  return out;
}

const KNOWN = { status, publish, verify, "pin-legacy": pinLegacy };
const command = positionals(args)[0] ?? "status";
if (!Object.hasOwn(KNOWN, command)) {
  fail(`未知子命令：${command}（可用：${Object.keys(KNOWN).join(" / ")}）`);
}
const runner = KNOWN[command];

TOKEN = readToken();
try {
  await runner();
} catch (error) {
  fail(error?.message ?? String(error));
}